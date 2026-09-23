/**
 * The step kernel: runs pi-agent-core's low-level loop for exactly one turn
 * (one model call plus the tool executions it requested) and translates the
 * events into dsh session-log events. pi turn == dsh step.
 *
 * The model call itself bridges back to dsh's `ctx.llm`, so the deployment's
 * adapters, credentials, retry, and token metering all stay in place; pi
 * contributes only the loop semantics. Tool execution bridges to dsh's tool
 * scheduler, so approval, guard, and post-execute plugins keep running.
 * @module @deepseek-ai/dsh-pi-agent-loop/pi-step
 */

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessageEvent,
  type AssistantMessage as PiAssistantMessage,
  type Model as PiModel,
  type StopReason as PiStopReason,
  type Usage as PiUsage,
} from '@earendil-works/pi-ai'
import { runAgentLoopContinue, type AgentEvent, type AgentLoopConfig, type AgentTool } from '@earendil-works/pi-agent-core'
import { TOOL_RUNTIME_SCHEDULER, type ToolExecutionInput, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { AssistantStreamRecord, ContentBlock, GenerateOptions, LlmCallConfig, LlmFailure, PreparedLlmCall, StreamChunk, TokenUsage, ToolCallId, ToolSchema } from '@deepseek-ai/dsh-llm'
import { AssistantStreamAccumulator, LlmError, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { dshMessagesToPi, piBlocksToDsh } from './translate.ts'

/** One step's driving inputs, fixed before pi's loop starts. */
export interface PiStepOptions {
  /** Loop context carrying the tool registry and LLM runtime. */
  readonly ctx: Context
  /** The driven session; every model-visible fact is appended here. */
  readonly session: Session
  readonly turn: number
  readonly step: number
  /**
   * The frozen, marked request the driver derived from the log at dispatch
   * time; exactly what the bridged streamFn dispatches.
   */
  readonly request: GenerateOptions
  /** Adapter-bound dispatch captured by `prepareCall`; falls back to `ctx.llm.stream`. */
  readonly preparedCall: PreparedLlmCall | undefined
  /** Tool schemas from the prompt assembly, already dsh-shaped. */
  readonly tools: readonly ToolSchema[]
  /** Rendered system prompt text for pi's own transcript bookkeeping. */
  readonly system: string
  /** Accepts tool-produced context for the next step boundary. */
  readonly acceptContext: (context: UserMessage) => void
  readonly signal: AbortSignal
}

/** Outcome of one pi turn, mirroring the official step result vocabulary. */
export interface PiStepOutcome {
  /** dsh finish classification for the step. */
  readonly finish:
    | { kind: 'stop' }
    | { kind: 'tool-calls' }
    | { kind: 'max-tokens' }
  /** Whether any bridged tool result declared the turn concluded. */
  readonly concluded: boolean
}

/**
 * Run one pi turn. `shouldStopAfterTurn` pins the loop to a single model call
 * plus its tool executions, so every dsh extension point (pre-step,
 * turn-stopping) stays in dsh's hands. Throws `LlmError` when the model call
 * failed; the driver's turn boundary classifies the abort case.
 */
export async function runPiStep(options: PiStepOptions): Promise<PiStepOutcome> {
  const { session, signal } = options

  // The log's tool/call events give the callId → tool name map pi result
  // messages require.
  const toolNames = new Map<string, string>()
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  for (const event of session.snapshotEvents()) {
    if (event.type === 'tool/call') toolNames.set(event.data.callId, event.data.name)
  }

  const state: StepState = {
    turn: options.turn,
    step: options.step,
    session,
    accumulator: new AssistantStreamAccumulator(),
    usage: undefined,
    stopReason: undefined,
    failure: undefined,
    concluded: false,
  }

  const bridgedTools = options.tools.map(schema => bridgeTool(schema, options, state))

  const piConfig: AgentLoopConfig = {
    // The model object is a carrier only: the bridged streamFn routes through
    // dsh's LLM runtime, which owns the real provider/model.
    model: stubModel(options.request),
    convertToLlm: messages => messages.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'),
    toolExecution: 'sequential',
    shouldStopAfterTurn: () => true,
  }

  await runAgentLoopContinue(
    {
      systemPrompt: options.system,
      messages: dshMessagesToPi(options.request.messages, toolNames),
      tools: bridgedTools,
    },
    piConfig,
    (event) => { processLoopEvent(event, state) },
    signal,
    piStreamFn(options, state),
  )

  if (state.failure !== undefined) {
    session.append('assistant/attempt', { turn: options.turn, step: options.step, stream: [...state.accumulator.snapshot()] as AssistantStreamRecord[] })
    throw new LlmError(state.failure.message, state.failure.code, state.failure)
  }
  if (state.stopReason === undefined) {
    session.append('assistant/attempt', { turn: options.turn, step: options.step, stream: [...state.accumulator.snapshot()] as AssistantStreamRecord[] })
    throw new LlmError('pi loop produced no assistant message', 'PI_LOOP')
  }
  if (signal.aborted) throw new LlmError('model call aborted', 'ABORTED')
  return {
    finish: mapStopReason(state.stopReason),
    concluded: state.concluded,
  }
}

/** Mutable per-step accumulation; one instance per runPiStep call. */
interface StepState {
  readonly turn: number
  readonly step: number
  readonly session: Session
  /** Compacts this attempt's timed chunks into the durable stream records. */
  readonly accumulator: AssistantStreamAccumulator
  usage: TokenUsage | undefined
  stopReason: PiStopReason | undefined
  failure: LlmFailure | undefined
  concluded: boolean
}

/** Translate one pi loop event into dsh session-log appends. */
function processLoopEvent(event: AgentEvent, state: StepState): void {
  if (event.type === 'message_end' && event.message.role === 'assistant') {
    const piMessage = event.message
    state.stopReason = piMessage.stopReason
    state.session.append('assistant/message', {
      turn: state.turn,
      step: state.step,
      message: createAssistantMessage({
        content: piBlocksToDsh(piMessage.content),
        source: { provider: piMessage.provider, model: piMessage.model },
      }),
      stream: [...state.accumulator.snapshot()] as AssistantStreamRecord[],
      ...state.usage === undefined ? {} : { usage: state.usage },
    }, { surfaceOp: 'append' })
  }
}

/** Map a pi stop reason to the dsh finish classification. */
function mapStopReason(reason: PiStopReason): PiStepOutcome['finish'] {
  if (reason === 'toolUse') return { kind: 'tool-calls' }
  if (reason === 'length') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/**
 * The bridged streamFn: dispatch the driver's marked request through the
 * prepared call (or the runtime directly), and re-emit the chunks as pi
 * events. pi's own transcript is bookkeeping only — the request messages are
 * byte-identical to the log reconstruction.
 */
function piStreamFn(
  options: PiStepOptions,
  state: StepState,
): (model: PiModel<Api>, context: unknown, opts?: unknown) => ReturnType<typeof createAssistantMessageEventStream> {
  return (_model, _context) => {
    const stream = createAssistantMessageEventStream()
    void (async () => {
      const assembler = new ChunkToPiAssembler()
      try {
        stream.push({ type: 'start', partial: assembler.snapshot() })
        const source = options.preparedCall?.stream(options.request) ?? options.ctx.llm.stream(options.request)
        for await (const chunk of source) {
          if (chunk.type === 'usage') {
            state.usage = chunk.usage
            continue
          }
          if (chunk.type === 'finish') {
            finishStepState(state, chunk)
            continue
          }
          state.accumulator.push({ time: Date.now(), chunk })
          for (const event of assembler.push(chunk)) stream.push(event)
        }
        if (state.failure !== undefined) {
          stream.push({ type: 'error', reason: state.stopReason === 'aborted' ? 'aborted' : 'error', error: piErrorMessage(options.request, state.failure) })
          return
        }
        stream.push({
          type: 'done',
          reason: state.stopReason === 'toolUse' || state.stopReason === 'length' ? state.stopReason : 'stop',
          message: assemblePiMessage(options.request, state.stopReason, assembler.piContent(), state.usage),
        })
      } catch (error: unknown) {
        const failure = error instanceof LlmError
          ? error.failure
          : { message: error instanceof Error ? error.message : String(error), code: 'PI_LOOP' }
        state.stopReason = options.signal.aborted ? 'aborted' : 'error'
        state.failure = failure
        stream.push({ type: 'error', reason: options.signal.aborted ? 'aborted' : 'error', error: piErrorMessage(options.request, failure) })
      }
    })()
    return stream
  }
}

/** Fold the finish chunk's classification into the step state. */
function finishStepState(state: StepState, chunk: Extract<StreamChunk, { type: 'finish' }>): void {
  if (chunk.reason.kind === 'aborted') {
    state.stopReason = 'aborted'
    state.failure = chunk.reason.failure
    return
  }
  if (chunk.reason.kind === 'error') {
    state.stopReason = 'error'
    state.failure = chunk.reason.failure
    return
  }
  state.stopReason = chunk.reason.kind === 'tool-calls' ? 'toolUse' : chunk.reason.kind === 'max-tokens' ? 'length' : 'stop'
}

/** Accumulates dsh stream chunks and emits the corresponding pi event sequence. */
class ChunkToPiAssembler {
  private readonly blocks = new Map<number, ContentBlock>()

  /** Translate one non-usage, non-finish dsh chunk into pi events. */
  push(chunk: Exclude<StreamChunk, { type: 'usage' } | { type: 'finish' }>): AssistantMessageEvent[] {
    switch (chunk.type) {
      case 'block-start': {
        const partial = this.snapshot()
        if (chunk.blockType === 'text') return [{ type: 'text_start', contentIndex: chunk.index, partial }]
        if (chunk.blockType === 'reasoning') return [{ type: 'thinking_start', contentIndex: chunk.index, partial }]
        return [{ type: 'toolcall_start', contentIndex: chunk.index, partial }]
      }
      case 'text-delta':
        return [{ type: 'text_delta', contentIndex: chunk.index, delta: chunk.text, partial: this.snapshot() }]
      case 'reasoning-delta':
        return [{ type: 'thinking_delta', contentIndex: chunk.index, delta: chunk.text, partial: this.snapshot() }]
      case 'tool-call-delta':
        return [{
          type: 'toolcall_delta',
          contentIndex: chunk.index,
          delta: chunk.argumentsDelta,
          partial: this.snapshot(),
        }]
      case 'block-end': {
        this.blocks.set(chunk.index, chunk.block)
        const partial = this.snapshot()
        const block = chunk.block
        if (block.type === 'text') return [{ type: 'text_end', contentIndex: chunk.index, content: block.text, partial }]
        if (block.type === 'reasoning') return [{ type: 'thinking_end', contentIndex: chunk.index, content: block.text, partial }]
        // Image and tool-result blocks never stream from adapters.
        if (block.type !== 'tool-call') return []
        return [{
          type: 'toolcall_end',
          contentIndex: chunk.index,
          toolCall: { type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) },
          partial,
        }]
      }
    }
  }

  /** The accumulated blocks in pi content shape, in arrival order. */
  piContent(): PiAssistantMessage['content'] {
    const out: PiAssistantMessage['content'] = []
    for (const block of this.blocks.values()) {
      switch (block.type) {
        case 'text': out.push({ type: 'text', text: block.text }); break
        case 'reasoning': out.push({ type: 'thinking', thinking: block.text }); break
        case 'tool-call': out.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) }); break
        default: break
      }
    }
    return out
  }

  /** Best-effort partial message from the blocks accumulated so far. */
  snapshot(): PiAssistantMessage {
    return {
      role: 'assistant',
      content: this.piContent(),
      api: 'dsh-bridge',
      provider: 'dsh-bridge',
      model: 'dsh-bridge',
      usage: emptyPiUsage(),
      stopReason: 'pending',
      timestamp: Date.now(),
    }
  }
}

/** Parse model tool-call arguments, preserving invalid JSON as an opaque value. */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : { input: parsed }
  } catch {
    return { raw }
  }
}

function emptyPiUsage(): PiUsage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function assemblePiMessage(config: LlmCallConfig, stopReason: PiStopReason | undefined, content: PiAssistantMessage['content'], usage: TokenUsage | undefined): PiAssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'dsh-bridge',
    provider: config.provider,
    model: config.model,
    usage: usage === undefined ? emptyPiUsage() : piUsageToDshInverse(usage),
    stopReason: stopReason ?? 'stop',
    timestamp: Date.now(),
  }
}

/** Recover pi-shaped usage from the dsh token accounting carried by the stream. */
function piUsageToDshInverse(usage: TokenUsage): PiUsage {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    totalTokens: usage.totalTokens ?? (usage.inputTokens + usage.outputTokens),
    ...usage.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function piErrorMessage(config: LlmCallConfig, failure: LlmFailure): PiAssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'dsh-bridge',
    provider: config.provider,
    model: config.model,
    usage: emptyPiUsage(),
    stopReason: 'error',
    errorMessage: failure.message,
    timestamp: Date.now(),
  }
}

/** Carrier model object; the bridged streamFn owns the real route. */
function stubModel(request: GenerateOptions): PiModel<Api> {
  return {
    id: request.model,
    name: request.model,
    api: 'dsh-bridge',
    provider: request.provider,
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  } as unknown as PiModel<Api>
}

/**
 * Wrap one dsh tool as a pi AgentTool. pi owns the call ordering; the wrapper
 * performs the dsh-side durable logging and the guarded scheduler execution
 * (pre-execute approval, guard, body, post-execute) per call.
 */
function bridgeTool(
  schema: ToolSchema,
  options: PiStepOptions,
  state: StepState,
): AgentTool {
  const { turn, step } = state
  return {
    name: schema.name,
    label: schema.name,
    description: schema.description,
    parameters: schema.parameters,
    async execute(toolCallId, params, runSignal) {
      const callId = toolCallId as ToolCallId
      const callSeq = state.session.append('tool/call', {
        turn, step,
        callId,
        name: schema.name,
        arguments: JSON.stringify(params),
      }).seq

      const agent = options.ctx.agents.requireInitiator()
      const exec: ToolExecutionInput = {
        callId,
        name: schema.name,
        arguments: params,
        agent,
        signal: runSignal ?? options.signal,
      }
      const scheduler = options.ctx.tools[TOOL_RUNTIME_SCHEDULER]
      const prepared = await scheduler.prepare(exec)
      let result: ToolExecutionResult
      let needsPost: boolean
      switch (prepared.kind) {
        case 'dispatch': {
          const outcome = await scheduler.dispatch(prepared.exec)
          result = outcome.result
          needsPost = outcome.kind === 'post-result'
          break
        }
        case 'post-result':
          result = prepared.result
          needsPost = true
          break
        case 'final-result':
          result = prepared.result
          needsPost = false
          break
      }
      const final = needsPost
        ? await scheduler.finalize(prepared.exec, result)
        : scheduler.finish(prepared.exec, result)

      state.session.append('tool/result', {
        turn, step,
        message: createToolResultMessage({
          callId,
          content: final.content,
          isError: final.isError,
        }),
        ...final.error?.info ? { error: final.error.info } : {},
        ...final.meta !== undefined ? { meta: final.meta } : {},
      }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })

      for (const context of final.additionalContexts ?? []) options.acceptContext(context)
      if (final.concludesTurn === true) state.concluded = true

      if (final.isError) {
        throw new Error(firstText(final.content) ?? 'tool call failed')
      }
      return {
        content: piContentOf(final.content),
        details: {},
      }
    },
  }
}

/** First text block of a result's content, for error message material. */
function firstText(content: readonly ContentBlock[]): string | undefined {
  for (const block of content) {
    if (block.type === 'text') return block.text
  }
  return undefined
}

/** dsh result content blocks to pi tool-result content (text only; images need the attachment service). */
function piContentOf(content: readonly ContentBlock[]): { type: 'text'; text: string }[] {
  const out: { type: 'text'; text: string }[] = []
  for (const block of content) {
    if (block.type === 'text') out.push({ type: 'text', text: block.text })
  }
  return out
}
