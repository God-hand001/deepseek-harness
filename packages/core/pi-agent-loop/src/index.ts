/**
 * The pi-agent-core-backed agent-loop plugin: a minimal {@link AgentFactory}
 * that publishes {@link PiAgent} instances through `ctx.agents`. It registers
 * under the same `agentLoop` context key as the stock loop because shared
 * infrastructure (the tool-call scheduler) reads
 * `ctx.agentLoop.config.maxParallelToolCalls` from whichever factory owns the
 * process.
 *
 * @module @deepseek-ai/dsh-pi-agent-loop
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
  SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import {
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  inboxProjectionDefinition,
  turnBoundaryProjectionDefinition,
} from '@deepseek-ai/dsh-agent-loop'
import { brandString } from '@deepseek-ai/dsh-brand'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { interruptedTurnClosers, SessionLogOffset, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tools'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import z from '@deepseek-ai/schemastery'
import { PiAgent } from './driver.ts'

/** Reject an output-token cap that cannot be represented exactly on the request wire. */
function assertAgentOptions(options: AgentOptions): void {
  if (options.maxTokens !== undefined
    && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
    throw new TypeError('agent maxTokens must be a positive safe integer')
  }
}

/** Resolve the deployment-wide scheduler cap at the owning config boundary. */
function resolveMaxParallelToolCalls(value: number | undefined): number {
  const maxParallelToolCalls = value ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS
  if (!Number.isInteger(maxParallelToolCalls) || maxParallelToolCalls < 1) {
    throw new Error('maxParallelToolCalls must be a positive integer')
  }
  return maxParallelToolCalls
}

/** Live-agent teardown bookkeeping shared by every published lifecycle. */
class FactoryOwnership {
  private readonly live = new Set<() => Promise<void>>()

  /** Track one live agent's shared teardown until it has run. */
  track(dispose: () => Promise<void>): () => void {
    this.live.add(dispose)
    return () => { this.live.delete(dispose) }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.live].map(dispose => dispose()))
  }
}

/** One session's owned write handle plus the count of events already stored through it. */
interface StoredSession {
  readonly handle: SessionHandle
  storedCount: number
}

/** Prepared-but-unpublished agent resources sharing one memoized teardown. */
interface PreparedAgent {
  agent: PiAgent
  /** Enter registries, announce, and release the queued work. */
  publish(source: SessionStartSource): Promise<AgentHandle>
  /** Reverse teardown: stop the machine, close the write handle, unregister, unwind the scope. Memoized. */
  dispose(): Promise<void>
}

/**
 * Concrete agent factory and driver service backed by pi-agent-core.
 * Registered under the stock `agentLoop` context key; consumers keep reading
 * `ctx.agentLoop`.
 */
export class PiAgentLoop extends Service implements AgentFactory {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']

  /** Runtime schema for the loader entry. */
  static Config = z.object({
    maxParallelToolCalls: z.number().step(1).min(1).default(DEFAULT_MAX_PARALLEL_TOOL_CALLS),
  })

  /** Validated configuration owned by this service. */
  readonly config: { maxParallelToolCalls: number }

  private readonly ownership: FactoryOwnership
  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  private readonly runtime: { ctx: Context }

  constructor(ctx: Context, config: { maxParallelToolCalls?: number }) {
    super(ctx, 'agentLoop')
    this.config = { maxParallelToolCalls: resolveMaxParallelToolCalls(config.maxParallelToolCalls) }
    this.ownership = new FactoryOwnership()
    this.runtime = { ctx }
    ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
    ctx.sessionProjections.register(inboxProjectionDefinition)
    ctx.effect(() => () => this.ownership.dispose(), 'piAgentLoop.transactions()')
    ctx.effect(() => ctx.agents.setFactory(this), 'piAgentLoop.setFactory()')
    ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
    ctx.systemPrompt.variable('model', context => context.agent?.options.model)
    ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd)
  }

  /**
   * Construct the driver and one memoized reverse teardown for a new agent.
   * The teardown is registered with the factory and the owner fiber BEFORE
   * publication, so a mid-setup unload rolls everything back. Unlike the stock
   * loop, the caller's creation `signal` is not fused into setup awaits — this
   * prototype relies on the owner-fiber effect as its only setup cancellation
   * path; the signal only reaches the persistence operations.
   */
  private prepare(
    ownerCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    stored?: StoredSession,
    parentAgent?: Agent,
  ): PreparedAgent {
    assertAgentOptions(options)
    ownerCtx.fiber.assertActive()
    const loopCtx = this.runtime.ctx

    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    // Reverse teardown, memoized so every racing owner awaits one quiescence:
    // stop the machine, drain and close the session's write path, leave the
    // registries, unwind the scope, release bookkeeping.
    const dispose = (ownerTriggered = false): Promise<void> => (disposing ??= (async () => {
      try {
        agent.cancel({ kind: 'disposed' })
        await agent.whenIdle()
        await agent.scope.dispose()
      } finally {
        try {
          await stored?.handle.close()
        } finally {
          try {
            detachAgent?.()
            detachSession?.()
          } finally {
            untrack()
            if (!ownerTriggered) await unfollowOwner()
          }
        }
      }
    })())
    const untrack = this.ownership.track(dispose)
    const unfollowOwner = ownerCtx.effect(() => () => {
      // Owner disposal owns the same quiescence boundary. Its teardown skips
      // unregistering this already-running owner effect from inside itself.
      if (disposing !== undefined) return
      return dispose(true)
    }, `piAgentLoop.lifecycle(${id})`)

    const agent = new PiAgent(loopCtx, id, options, session)

    return {
      agent,
      publish: async (source) => {
        detachSession = agent.ctx.sessions.enter(session)
        detachAgent = loopCtx.agents.enter(agent, parentAgent)
        agent.ctx.sessions.announce(session)
        // Awaited serial `agent/created` listeners: creation resolves only
        // after every listener ran, and a listener rejection fails it.
        await loopCtx.agents.announce(agent, source)
        return { agent, dispose }
      },
      dispose,
    }
  }

  /**
   * Take a fresh session's write ownership when persistence is mounted.
   * Nothing is appended here: the constructor seed is stored by
   * `appendUnstoredSuffix` at the publication commit point, so a failed setup
   * closes an unmaterialized handle and leaves no stored residue.
   */
  private async createStoredSession(session: Session, signal?: AbortSignal): Promise<StoredSession | undefined> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    const handle = await persistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
      ...signal === undefined ? {} : { signal },
    })
    return { handle, storedCount: 0 }
  }

  /**
   * Durably store the session events appended since the last stored cursor.
   * Pre-publication appends (constructor seed markers, setup-window events)
   * never re-emit through `session/event`, so publication must flush them
   * through the handle before live events start routing into it.
   */
  private async appendUnstoredSuffix(stored: StoredSession | undefined, session: Session): Promise<void> {
    if (stored === undefined) return
    const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount))
    if (suffix.length > 0) await stored.handle.append(suffix)
    stored.storedCount += suffix.length
  }

  /** Prepare one Agent around an acquired Session, run setup, and publish it. */
  private async setupAndPublish(
    ownerCtx: Context,
    id: SessionId,
    preparation: SessionPreparation,
    agentOptions: AgentOptions,
    setup: AgentSetup | undefined,
    source: SessionStartSource,
    stored?: StoredSession,
    parentAgent?: Agent,
  ): Promise<AgentHandle> {
    using ownedPreparation = preparation
    const session = ownedPreparation.session
    let prepared: PreparedAgent
    try {
      prepared = this.prepare(ownerCtx, id, agentOptions, session, stored, parentAgent)
    } catch (error: unknown) {
      await stored?.handle.close().catch(() => {})
      throw error
    }
    try {
      return await prepared.agent.runMaintenance(async () => {
        try {
          const setupCommit = await setup?.(prepared.agent.ctx, prepared.agent)
          setupCommit?.commit()
          await this.appendUnstoredSuffix(stored, session)
          return await prepared.publish(source)
        } catch (error: unknown) {
          prepared.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
          throw error
        }
      })
    } catch (error: unknown) {
      // Rollback swallows a disposal rejection (a failing final handle close):
      // the setup failure is the primary error the caller must see.
      await prepared.dispose().catch(() => {})
      throw error
    }
  }

  /**
   * Create an agent and session under one caller-supplied identity.
   * @param ownerCtx - caller-bound context that owns the transaction and live handle.
   * @param options - agent/session identity, configuration, and optional setup.
   * @returns the published running agent.
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
      ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
    }))
    let stored: StoredSession | undefined
    try {
      stored = await this.createStoredSession(preparation.session, options.signal)
    } catch (error: unknown) {
      preparation[Symbol.dispose]()
      throw error
    }
    return this.setupAndPublish(
      ownerCtx,
      options.sessionId,
      preparation,
      options.agentOptions ?? {},
      options.setup,
      'startup',
      stored,
      options.parentAgent,
    )
  }

  /**
   * Resume an agent on a persisted session through the configured persistence service.
   * @param ownerCtx - caller-bound context that owns load, setup, and the live handle.
   * @param options - persisted identity, configuration, and optional setup.
   * @returns the published running agent.
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence: SessionPersistence | undefined = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    const id = options.resumeSessionId
    let handle: SessionHandle | undefined
    let preparation: SessionPreparation | undefined
    try {
      // Taking write ownership FIRST excludes a concurrent resume of the same
      // id; semantic crash repair appends synthetic closers for an interrupted
      // final turn before the session reconstructs.
      handle = await persistence.open(id, 'write', options.signal === undefined ? {} : { signal: options.signal })
      const coldRead = await handle.read(0, undefined, options.signal === undefined ? {} : { signal: options.signal })
      const persisted = coldRead.events
      const closers = interruptedTurnClosers(persisted)
      if (closers.length > 0) await handle.append(closers)
      preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(id, {
        seed: [...persisted, ...closers],
        meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount,
        eventState: coldRead.eventState,
      }))
      const stored: StoredSession = { handle, storedCount: persisted.length + closers.length }
      handle = undefined // ownership passes to setupAndPublish/prepare
      await this.appendUnstoredSuffix(stored, preparation.session)
      return await this.setupAndPublish(
        ownerCtx,
        id,
        preparation,
        options.agentOptions ?? {},
        options.setup,
        'resume',
        stored,
        options.parentAgent,
      )
    } finally {
      preparation?.[Symbol.dispose]()
      await handle?.close().catch(() => {})
    }
  }
}

/** Mint a session id in the stock loop's combined-id shape, for tests and callers without one. */
export function freshSessionId(label: string): SessionId {
  return brandString<SessionId>(`${label}-session-${randomUUID()}`)
}

export default PiAgentLoop
