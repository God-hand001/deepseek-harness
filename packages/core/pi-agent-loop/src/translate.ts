/**
 * Bidirectional translations between the dsh LLM vocabulary and the pi-ai
 * vocabulary. The adapter drives pi-agent-core's loop, so the model-facing
 * transcript must exist in both shapes: dsh messages for the log-derived
 * request, pi messages for pi's own turn bookkeeping.
 * @module @deepseek-ai/dsh-pi-agent-loop/translate
 */

import type {
  AssistantMessage as PiAssistantMessage,
  Message as PiMessage,
  TextContent,
  Tool as PiTool,
  ToolCall as PiToolCall,
  ToolResultMessage as PiToolResultMessage,
  Usage as PiUsage,
} from '@earendil-works/pi-ai'
import type { AssistantMessage, ContentBlock, Message, ToolCallBlock, TokenUsage, ToolSchema, ToolCallId } from '@deepseek-ai/dsh-llm'

/**
 * Convert dsh history messages to pi transcript messages. Image blocks are
 * skipped: dsh image blocks reference the attachment service while pi wants
 * inline bytes, and the learning prototype covers the text/tool surface.
 * `toolNames` maps call ids to names (from the log's `tool/call` events),
 * because pi result messages must carry the tool name while dsh correlates by
 * call id only.
 */
export function dshMessagesToPi(messages: readonly Message[], toolNames: ReadonlyMap<string, string>): PiMessage[] {
  const out: PiMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    const [block] = message.content
    // dsh's ToolResultMessage specializes the shared message interface (role
    // 'user', one tool-result block), so the block type is the discriminator.
    if (message.role === 'user' && message.content.length === 1 && block?.type === 'tool-result') {
      out.push({
        role: 'toolResult',
        toolCallId: block.toolCallId,
        toolName: toolNames.get(block.toolCallId) ?? 'unknown',
        content: dshResultContentToPi(block.content),
        isError: block.isError === true,
        timestamp: Date.now(),
      })
      continue
    }
    if (message.role === 'assistant') {
      // The branch guard is the runtime check; dsh Message is a shared interface, not a union.
      out.push(piAssistantFromDsh(message as AssistantMessage))
      continue
    }
    out.push({
      role: 'user',
      content: message.content.flatMap(block => block.type === 'text' ? [{ type: 'text', text: block.text }] : []),
      timestamp: Date.now(),
    })
  }
  return out
}

function dshResultContentToPi(content: ContentBlock[]): (TextContent)[] {
  return content.flatMap(block => block.type === 'text' ? [{ type: 'text', text: block.text }] : [])
}

/** Convert one dsh assistant message to its pi transcript form. */
export function piAssistantFromDsh(message: AssistantMessage): PiAssistantMessage {
  const content: PiAssistantMessage['content'] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text': content.push({ type: 'text', text: block.text }); break
      case 'reasoning': content.push({ type: 'thinking', thinking: block.text }); break
      case 'tool-call': content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) }); break
      default: break
    }
  }
  return {
    role: 'assistant',
    content,
    api: 'dsh-bridge',
    provider: message.source.provider,
    model: message.source.model,
    usage: emptyPiUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
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

/** Convert pi assistant content blocks to dsh content blocks. */
export function piBlocksToDsh(content: PiAssistantMessage['content']): ContentBlock[] {
  const out: ContentBlock[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text': out.push({ type: 'text', text: block.text }); break
      case 'thinking': out.push({ type: 'reasoning', text: block.thinking }); break
      case 'toolCall': out.push(piToolCallToDsh(block)); break
      default: break
    }
  }
  return out
}

/** Convert one pi tool call to the dsh block, arguments re-serialized as the model produced them. */
export function piToolCallToDsh(call: PiToolCall): ToolCallBlock {
  return { type: 'tool-call', id: call.id as ToolCallId, name: call.name, arguments: JSON.stringify(call.arguments) }
}

/** Convert pi usage counters to the dsh token accounting. */
export function piUsageToDsh(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    ...usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning },
  }
}

/** Zero-cost pi usage used where dsh carries no provider cost model. */
export function emptyPiUsage(): PiUsage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/**
 * Convert a dsh tool schema to pi's tool shape. pi declares TypeBox schemas,
 * which are JSON Schema objects at runtime, so the dsh schema object passes
 * through unchanged from the provider's point of view.
 */
export function dshToolToPi(schema: ToolSchema): PiTool {
  return {
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
  }
}

/** Result materialization input the step driver passes back into pi's transcript. */
export interface PiToolResultInput {
  callId: string
  toolName: string
  content: (TextContent)[]
  isError: boolean
}

/** Build the pi toolResult message the loop appends after a bridged execution. */
export function piToolResultMessage(input: PiToolResultInput): PiToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: input.callId,
    toolName: input.toolName,
    content: input.content,
    isError: input.isError,
    timestamp: Date.now(),
  }
}
