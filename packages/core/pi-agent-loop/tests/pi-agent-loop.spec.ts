import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

import PiAgentLoop, { freshSessionId } from '@deepseek-ai/dsh-pi-agent-loop'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

/** Committed events of the agent's session, newest last. */
function eventsOf(agent: Agent) {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return agent.session.snapshotEvents()
}

async function harness(adapter: MockAdapter): Promise<{ ctx: Context; registry: AgentRegistry }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(PiAgentLoop)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, registry: ctx.agents }
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

describe('pi agent loop', () => {
  it('drives one text turn through the ctx.agents factory seam', async () => {
    const adapter = new MockAdapter([textResponse('hello from the pi-driven driver')])
    const id1 = freshSessionId('pi')
    const { ctx, registry } = await harness(adapter)

    // The registry delegates to whichever factory registered — here PiAgentLoop.
    const handle = await registry.create({
      sessionId: id1,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = handle.agent
    expect(ctx.agentLoop).toBeInstanceOf(PiAgentLoop)
    expect(registry.get(id1)).toBe(agent)

    send(agent, 'hi')
    await agent.whenIdle()

    const types = eventsOf(agent).map(e => e.type)
    // The waking followup lands as a durable inbox splice before the driver opens the turn.
    expect(types[0]).toBe('agent/inbox/spliced')
    expect(types.indexOf('turn/start')).toBeGreaterThan(0)
    expect(types).toContain('step/start')
    expect(types).toContain('user/message')
    expect(types).toContain('system/message')
    expect(types).toContain('request/header')
    expect(types).toContain('assistant/message')
    expect(types.at(-1)).toBe('turn/end')
    const assistant = eventsOf(agent).find(e => e.type === 'assistant/message')
    expect(assistant && assistant.type === 'assistant/message' && assistant.data.message.content[0]).toMatchObject({ type: 'text', text: 'hello from the pi-driven driver' })
    // The committed message embeds the compact model stream.
    expect(assistant && assistant.type === 'assistant/message' && assistant.data.stream.length).toBeGreaterThan(0)

    // The bridged request derived its history from the log: the system prompt
    // travels as surface node 0, never as the request's `system` field.
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]!.provider).toBe('mock')
    expect(adapter.requests[0]!.system).toBeUndefined()
    const systemMessage = adapter.requests[0]!.messages[0]
    expect(systemMessage?.role).toBe('system')
    expect(systemMessage?.content.some(block => block.type === 'text' && block.text.includes('DeepSeek Harness'))).toBe(true)

    await handle.dispose()
    expect(registry.get(id1)).toBeUndefined()
  })

  it('bridges tool calls through the dsh scheduler and continues the turn', async () => {
    const id2 = freshSessionId('pi')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'ping' }, 'calling echo'),
      (options) => {
        // The follow-up request must derive the tool result from the log.
        const result = options.messages.find(m => m.content.some(b => b.type === 'tool-result'))
        expect(result).toBeDefined()
        return textResponse('done')
      },
    ])
    const { ctx, registry } = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo back',
      parameters: { text: { type: 'string' } },
      async execute(args) {
        return [{ type: 'text', text: `echo: ${args.text}` }]
      },
    }))

    const handle = await registry.create({
      sessionId: id2,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = handle.agent
    send(agent, 'use the tool')
    await agent.whenIdle()

    // Two model calls: the tool-call step, then the follow-up after the result.
    expect(adapter.requests).toHaveLength(2)
    const types = eventsOf(agent).map(e => e.type)
    expect(types.filter(t => t === 'step/start')).toHaveLength(2)
    expect(eventsOf(agent).some(e => e.type === 'tool/call')).toBe(true)
    expect(eventsOf(agent).some(e => e.type === 'tool/result')).toBe(true)
    const toolCall = eventsOf(agent).find(e => e.type === 'tool/call')
    expect(toolCall && toolCall.type === 'tool/call' && toolCall.data.name).toBe('echo')
    // Second step's messages derive the tool result from the log.
    const assistantEnd = eventsOf(agent).filter(e => e.type === 'assistant/message').at(-1)
    expect(assistantEnd && assistantEnd.type === 'assistant/message' && assistantEnd.data.message.content[0]).toMatchObject({ type: 'text', text: 'done' })
  })

  it('registers the turnBoundary projection readers depend on', async () => {
    const id3 = freshSessionId('pi')
    const adapter = new MockAdapter([textResponse('one turn')])
    const { ctx, registry } = await harness(adapter)
    const handle = await registry.create({
      sessionId: id3,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = handle.agent
    send(agent, 'count this turn')
    await agent.whenIdle()
    expect(ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')?.lastTurn).toBe(1)
  })

  it('closes the open turn as aborted when cancelled mid-stream', async () => {
    const id4 = freshSessionId('pi')
    const adapter = new MockAdapter(['hang'])
    const { registry } = await harness(adapter)
    const handle = await registry.create({
      sessionId: id4,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = handle.agent
    send(agent, 'cancel me')
    await new Promise(resolve => setTimeout(resolve, 30))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    const turnEnd = eventsOf(agent).find(e => e.type === 'turn/end')
    expect(turnEnd && turnEnd.type === 'turn/end' && turnEnd.data.reason.kind).toBe('aborted')
  })
})
