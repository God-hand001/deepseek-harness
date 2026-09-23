/**
 * Session comparison tool for the pi-agent-loop prototype. Decodes the N
 * newest persisted sessions (any workspace project) and prints one comparison
 * row per session: step/model-call/tool-call counts, token usage, and the
 * request/header fingerprint that tells which driver produced it (the stock
 * loop folds adapter-materialized `adapterDefaults` into the header; the pi
 * bridge does not).
 *
 * Usage: node --import tsx/esm packages/experimental/pi-agent-loop/tools/compare-sessions.mts [count]
 * @module tools/compare-sessions
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { scanZstdFrames, createZstdFrameDecoder } from '../../../session/session-persistence-jsonl/src/zstd.ts'
import { SessionLogScanner } from '../../../session/session-persistence-jsonl/src/format.ts'

const count = Number(process.argv[2] ?? '4')
const home = join(homedir(), '.dsh', 'sessions')

interface Row {
  session: string
  project: string
  mtime: string
  events: number
  turns: number
  steps: number
  headers: number
  toolCalls: number
  assistants: number
  outputTokens: number
}

const rows: Row[] = []
for (const project of readdirSync(home)) {
  const projectDir = join(home, project)
  let entries: string[]
  try {
    entries = readdirSync(projectDir)
  } catch {
    continue
  }
  for (const session of entries.filter(name => name.startsWith('session-'))) {
    const logPath = join(projectDir, session, 'session.jsonl.zstd')
    let buffer: Buffer
    try {
      buffer = readFileSync(logPath)
    } catch {
      continue
    }
    const mtime = statSync(logPath).mtime
    let events: { type: string; data?: Record<string, unknown> }[]
    try {
      const { frames } = scanZstdFrames(buffer)
      const decoder = createZstdFrameDecoder()
      const iterator = decoder.decode(buffer, frames)
      const header = iterator.next().value
      const scanner = new SessionLogScanner(header)
      for (const plaintext of iterator) scanner.write(plaintext)
      events = (scanner as unknown as { finish(): { events: typeof events } }).finish().events ?? []
    } catch {
      continue
    }
    const countOf = (type: string): number => events.filter(event => event.type === type).length
    const outputTokens = events
      .filter(event => event.type === 'assistant/message')
      .reduce((sum, event) => sum + ((event.data?.usage as { outputTokens?: number } | undefined)?.outputTokens ?? 0), 0)
    rows.push({
      session: session.slice(0, 20),
      project: project.slice(0, 24),
      mtime: mtime.toISOString().slice(5, 16).replace('T', ' '),
      events: events.length,
      turns: countOf('turn/start'),
      steps: countOf('step/start'),
      headers: countOf('request/header'),
      toolCalls: countOf('tool/call'),
      assistants: countOf('assistant/message'),
      outputTokens,
    })
  }
}

rows.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
const shown = rows.slice(0, count)
console.log('mtime(月-日 时:分)      session               events turns steps calls tools asst outTok')
for (const row of shown) {
  console.log(
    `${row.mtime}  ${row.session}  ${String(row.events).padStart(6)} ${String(row.turns).padStart(5)} ${String(row.steps).padStart(5)} ${String(row.headers).padStart(5)} ${String(row.toolCalls).padStart(5)} ${String(row.assistants).padStart(4)} ${String(row.outputTokens).padStart(6)}`,
  )
}
console.log('\ncalls = request/header 数(模型调用次数);outTok = 各 assistant/message usage 的输出 token 之和。')
console.log('注意:两类驱动器写同样的事件词汇,日志无法区分驱动者——归属要看启动 profile(--dump-config)。')
