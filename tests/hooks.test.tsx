import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'cost-router',
  component: 'Pane',
  requestId: 'cost-router',
  props: {
    title: 'Cost router',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// What the Agent tool would hand `agent.spawn` for a model-made spawn from the main chat.
const SPAWN = {
  tool_use_id: 't1',
  description: 'find logger imports',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
} as const

const HANDOFF = JSON.stringify({
  objective: 'Build the CSV export feature for the reports page',
  status: 'in_progress',
  acceptanceCriteria: ['pnpm test passes'],
  constraints: ['never push without asking'],
  nextSteps: ['run pnpm test'],
  files: [{ path: 'src/export.ts', why: 'the exporter' }],
})

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

let engine: Engine | undefined

/** The engine beneath the plugin, in memory: what it was sent, and what it answers. */
function world(on: On, $?: Engine) {
  engine = $
  const s = {
    tokens: 20_000,
    window: 200_000,
    files: new Map<string, string>(),
    commands: [] as string[],
    submitted: [] as string[],
    sent: [] as { model: string; effort?: string | number }[],
    usage: { input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 19_000, cache_creation_input_tokens: 0 } as Usage,
    clear: 'ok' as 'ok' | 'refuse',
    toolError: false,
    onFork: undefined as undefined | (() => Promise<void>),
    clock: mock.clock(on),
    /** The saved handoff's path as the plugin spells it (the engine hands hooks the platform's own spelling). */
    handoffPath: () => [...s.files.keys()].map(p => p.replace(/\\/g, '/')).find(p => p.includes('/.claude/cost-router/handoffs/')) ?? '',
    handoffText: () => [...s.files.entries()].find(([p]) => p.replace(/\\/g, '/').includes('/.claude/cost-router/handoffs/'))?.[1],
  }
  on('agent.spawn', () => ({ model: 'x', agentId: 'a1' }))
  mock.env(on, { USERPROFILE: 'C:\\Users\\t' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: 'answer' in e ? e.answer : '' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: false } }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: 'C:/proj' }))
  on('session.root', () => ({ value: 'C:/proj' }))
  on('session.version', () => ({ value: { version: '2.1.309', base: '2.1.309', builtAt: '2026-10-20' } }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: s.tokens, window: s.window, percent: Math.round((s.tokens / s.window) * 100) },
      rateLimits: [],
    },
  }))
  on('agent.list', () => ({ value: [] }))
  on('fs.write', (_, e) => {
    s.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const t = s.files.get(e.path)
    if (t === undefined) throw new Error('missing')
    return { value: t }
  })
  on('fs.exists', (_, e) => ({ value: s.files.has(e.path) }))
  on('turn.step', async function* (_, e) {
    s.sent.push({ model: e.model, ...(e.effort !== undefined ? { effort: e.effort } : {}) })
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: { model: e.model, ...s.usage } }
  })
  on('command.run', async (_, e) => {
    if (s.clear === 'refuse' && e.command === 'clear') throw new Error('not now')
    s.commands.push(e.command)
    // The engine ends the cleared conversation, as /clear does.
    if (e.command === 'clear') await engine?.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } } as never)
    return {}
  })
  on('prompt.submit', (_, e) => {
    s.submitted.push(e.text)
    return { text: e.text }
  })
  on('model.fork', async (_, e) => {
    await s.onFork?.()
    return { value: { isAnswered: true as const, text: e.prompt.includes('lacks') ? '{"answers": []}' : HANDOFF, usage: s.usage } }
  })
  on('model.complete', () => ({ value: { isAnswered: true as const, text: '{"nextAction": "run pnpm test", "missing": []}', usage: s.usage } }))
  on('tool.call', (_, e) =>
    s.toolError && String(e.tool) === 'Bash' ? ({ isError: true, text: 'FAIL', result: {} } as never) : { result: {} as never, text: 'ok' },
  )
  return s
}

/** One more model request inside a running turn. */
async function step($: Engine, turnId: string, index: number) {
  const s = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 + index })
  for await (const _ of s) void _
}

const failCheck = ($: Engine) =>
  ($.tool as unknown as { call: (input: { tool: string; command: string }) => Promise<unknown> }).call({ tool: 'Bash', command: 'pnpm test' })

const ORIGIN = { kind: 'composer' } as const

/** One main-chat turn as the engine runs it: the prompt, the turn's start, one model request, its end. */
async function turn($: Engine, n: number, text: string, answer = 'done') {
  await $.prompt.submit({ text, wait: false, origin: ORIGIN })
  await $.turn.start({ text, turnId: `t${n}` })
  const s = $.turn.step({ turnId: `t${n}`, index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 })
  for await (const _ of s) void _
  await $.turn.complete({ reason: 'answer', answer, durationMs: 1, isAborted: false, turnId: `t${n}` })
}

const routerReport = async ($: Engine) =>
  (await $.command.run({ command: 'router', args: '', origin: ORIGIN, presentation: { isFullscreen: false, columns: 100 } })).text ?? ''

test('a subagent is routed to the cheapest capable model, and told its depth', async ($, on) => {
  let seen: { model?: string; prompt: string } | undefined
  on('agent.spawn', (_, e) => {
    seen = { model: e.model, prompt: e.prompt }
    return { model: e.model ?? 'x', agentId: 'a1' }
  })
  await $.agent.spawn({ ...SPAWN, prompt: 'Find every file that imports the logger.' })
  expect(seen?.model).toBe('claude-haiku-5-5')
  expect(seen?.prompt).toMatch(/depth 1 of 2/)
})

test('nesting past the depth limit is refused', { options: { maxDepth: 0 } }, async ($, on) => {
  on('agent.spawn', () => ({ model: 'x', agentId: 'a1' }))
  const r = await $.agent.spawn({ ...SPAWN, prompt: 'Read README.md.' })
  expect(r.deny).toMatch(/depth limit/)
})

test('the pane shows estimated spend and savings on every surface', async $ => {
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Spent/ }))?.text).toBe('Spent ≈ $0.000 of $10.00 (estimate at API list prices); this chat ≈ $0.000')
    expect(await ui.find({ type: 'Text', text: /No routing decisions/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the main chat keeps its model; effort moves at turn boundaries, held by the cooldown', { options: { planner: false } }, async ($, on) => {
  const w = world(on, $)
  await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: false } as never)
  await turn($, 1, 'fix the typo in README')
  expect(w.sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'low' })
  await turn($, 2, 'Redesign the distributed cache to remove the race condition and the deadlock in eviction.')
  expect(w.sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  // A light ask right after: a cost-driven drop waits out the cooldown.
  await turn($, 3, 'fix the typo in README')
  expect(w.sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  expect(await routerReport($)).toMatch(/kept: inside the switch cooldown/)
})

test('an observed cache rebuild on an effort change makes later effort changes pay for it', { options: { planner: false, switchCooldownTurns: 0 } }, async ($, on) => {
  const w = world(on, $)
  w.tokens = 300_000
  await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: false } as never)
  await turn($, 1, 'Implement the export endpoint and add tests for it, covering pagination, errors and auth headers properly.')
  expect(w.sent.at(-1)?.effort).toBe('low')
  // The next request changes effort and the response shows the whole context written again.
  w.usage = { input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 299_000 }
  await turn($, 2, 'Redesign the distributed cache to remove the race condition and the deadlock in eviction.')
  expect(w.sent.at(-1)?.effort).toBe('high')
  expect(await routerReport($)).toMatch(/observed: an effort change on claude-opus-5-5 rebuilt the prompt cache/)
  // Now a drop back to low would rebuild 300k tokens: it stays.
  w.usage = { input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 299_000, cache_creation_input_tokens: 0 }
  await turn($, 3, 'fix the typo in README')
  expect(w.sent.at(-1)?.effort).toBe('high')
  expect(await routerReport($)).toMatch(/rebuilds the cache \(observed in this task/)
})

const HARD = 'Redesign the distributed cache to remove the race condition and the deadlock in eviction.'

test('checks that keep failing at the top route switch to Fable when the setting is auto', { options: { planner: false, fable: 'auto', escalateAfterErrors: 1 } }, async ($, on) => {
  const w = world(on, $)
  await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: false } as never)
  await $.prompt.submit({ text: HARD, wait: false, origin: ORIGIN })
  await $.turn.start({ text: HARD, turnId: 't1' })
  await step($, 't1', 0)
  expect(w.sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  w.toolError = true
  await failCheck($)
  await step($, 't1', 1)
  expect(w.sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' }) // effort first
  await failCheck($)
  await step($, 't1', 2)
  expect(w.sent.at(-1)).toEqual({ model: 'claude-fable-5-1', effort: 'high' }) // the top was not enough
  expect(await routerReport($)).toMatch(/claude-fable-5-1 enabled automatically \(setting\)/)
})

test('in ask mode Fable is used only when the person approves; no answer keeps the route', { options: { planner: false, escalateAfterErrors: 1 } }, async ($, on) => {
  const w = world(on, $)
  await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: false } as never)
  await $.prompt.submit({ text: HARD, wait: false, origin: ORIGIN })
  await $.turn.start({ text: HARD, turnId: 't1' })
  await step($, 't1', 0)
  w.toolError = true
  for (const i of [1, 2, 3]) {
    await failCheck($)
    await step($, 't1', i)
  }
  expect(w.sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' })
  expect(await routerReport($)).toMatch(/asked about claude-fable-5-1 .*not asked again this task/)
})

test('subagents share the task budget with the main chat', { options: { planner: false, budgetUsd: 0.01 } }, async ($, on) => {
  const w = world(on, $)
  w.usage = { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  await turn($, 1, 'fix the typo in README')
  const r = await $.agent.spawn({ ...SPAWN, prompt: 'Read README.md.' })
  expect(r.deny).toMatch(/budget/)
})

test('a spent budget hands off to a fresh chat with a new budget; stop mode refuses instead', { options: { planner: false, budgetUsd: 0.05 } }, async ($, on) => {
  const w = world(on, $)
  w.usage = { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: false } as never)
  await turn($, 1, 'Build the CSV export.')
  await w.clock.advance(200)
  expect(w.commands).toEqual(['clear'])
  expect(w.submitted.at(-1) ?? '').toMatch(/^\[cost-router handoff/)
  // The fresh chat has a new budget: a prompt is no longer refused.
  w.usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const r = await $.prompt.submit({ text: 'keep going', wait: false, origin: ORIGIN })
  expect(r.drop).toBeUndefined()
})

test('a spent budget stops running subagents, then hands off once the last one has finished', { options: { planner: false, budgetUsd: 0.05 } }, async ($, on) => {
  const w = world(on, $)
  const aborted: string[] = []
  on('turn.abort', (_, e) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })
  await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: false } as never)
  await $.prompt.submit({ text: 'Build the CSV export.', wait: false, origin: ORIGIN })
  await $.turn.start({ text: 'Build the CSV export.', turnId: 't1' })
  expect((await $.agent.spawn({ ...SPAWN, prompt: 'Read README.md.' })).deny).toBeUndefined()
  await $.turn.start({ text: 'Read README.md.', turnId: 'a1-t1', agentId: 'a1' } as never)
  // The main chat's request spends the budget (known once its usage lands); the agent's next request is aborted.
  w.usage = { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  await step($, 't1', 0)
  const s = $.turn.step({ turnId: 'a1-t1', index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1, agentId: 'a1' } as never)
  for await (const _ of s) void _
  await w.clock.advance(10)
  expect(aborted).toEqual(['a1-t1'])
  expect((await $.agent.spawn({ ...SPAWN, prompt: 'Read more.' })).deny).toMatch(/handoff/)
  await $.turn.complete({ reason: 'answer', answer: 'stopped', durationMs: 1, isAborted: true, turnId: 't1' })
  await w.clock.advance(200)
  expect(w.commands).toEqual([]) // the agent is still running: the handoff waits
  const held = await $.prompt.submit({ text: 'then add a header row', wait: false, origin: ORIGIN })
  expect(held.drop).toMatch(/once 1 agents have stopped/)
  await $.turn.complete({ reason: 'answer', answer: 'stopped', durationMs: 1, isAborted: true, turnId: 'a1-t1', agentId: 'a1' } as never)
  await w.clock.advance(200)
  expect(w.commands).toEqual(['clear'])
  expect(w.submitted.at(-1) ?? '').toContain('then add a header row')
})

test('in stop mode a spent budget refuses new prompts', { options: { planner: false, budgetUsd: 0.05, budgetSpent: 'stop' } }, async ($, on) => {
  const w = world(on, $)
  w.usage = { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  await turn($, 1, 'Build the CSV export.')
  await w.clock.advance(200)
  expect(w.commands).toEqual([])
  const r = await $.prompt.submit({ text: 'keep going', wait: false, origin: ORIGIN })
  expect(r.drop).toMatch(/budget/)
})

test('past the context threshold it saves a verified handoff, clears, continues, and confirms once', { options: { planner: false, handoffContextTokens: 50_000, handoffCostUsd: 0 } }, async ($, on) => {
  const w = world(on, $)
  const clock = w.clock
  let dropped = ''
  w.onFork = async () => {
    // The person types while the handoff runs: held for the fresh context, not run in the old one.
    const r = await $.prompt.submit({ text: 'also add a CSV header row', wait: false, origin: ORIGIN })
    dropped = r.drop ?? ''
  }
  await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: false } as never)
  await turn($, 1, 'Build the CSV export. Never push without asking.')
  expect(w.commands).toEqual([])
  w.tokens = 60_000
  await turn($, 2, 'keep going')
  await clock.advance(200)
  expect(dropped).toMatch(/handoff to a fresh context is in progress/)
  expect(w.commands).toEqual(['clear'])
  const text = w.submitted.at(-1) ?? ''
  const id = /^\[cost-router handoff (\w+)\]/.exec(text)?.[1] ?? ''
  expect(id).not.toBe('')
  const path = w.handoffPath()
  expect(w.handoffText()).toContain('Never push without asking.')
  for (const s of ['HANDOFF-ACK', 'Never push without asking.', 'never push without asking', 'also add a CSV header row', 'run pnpm test', path]) expect(text).toContain(s)

  // The fresh context: it reads the handoff and names the next action.
  w.tokens = 8_000
  await $.turn.start({ text, turnId: 't3' })
  const s = $.turn.step({ turnId: 't3', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 })
  for await (const _ of s) void _
  const tools = $.tool as unknown as { call: (input: { tool: string; file_path: string }) => Promise<unknown> }
  await tools.call({ tool: 'Read', file_path: path.replace(/\//g, '\\') })
  await $.turn.complete({ reason: 'answer', answer: `HANDOFF-ACK ${id}: run pnpm test`, durationMs: 1, isAborted: false, turnId: 't3' })
  expect(await routerReport($)).toMatch(/quality: context 60k ≥ 50k tokens → \d+ tokens via clear, continued/)
  // The same continuation again is a duplicate.
  const again = await $.prompt.submit({ text, wait: false, origin: { kind: 'plugin', name: 'cost-router' } })
  expect(again.drop).toMatch(/already delivered/)
  // No loop: the next turns stay put.
  await turn($, 4, 'run the tests')
  await clock.advance(200)
  expect(w.commands).toEqual(['clear'])
})

test('a fresh context that cannot read the saved handoff is reported, not retried; a missing ack is retried once', { options: { planner: false, handoffContextTokens: 50_000, handoffCostUsd: 0 } }, async ($, on) => {
  const w = world(on, $)
  await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: false } as never)
  await turn($, 1, 'Build the CSV export.')
  w.tokens = 60_000
  await turn($, 2, 'keep going')
  await w.clock.advance(200)
  const text = w.submitted.at(-1) ?? ''
  const id = /^\[cost-router handoff (\w+)\]/.exec(text)?.[1] ?? ''
  w.tokens = 8_000
  // No ack at all: resubmitted once.
  await $.turn.start({ text, turnId: 't3' })
  await $.turn.complete({ reason: 'error', answer: '', durationMs: 1, isAborted: false, turnId: 't3' })
  await w.clock.advance(200)
  expect(w.submitted.filter(s => s === text).length).toBe(2)
  // Acked, but the file read was refused: told, not retried.
  await $.turn.start({ text, turnId: 't4' })
  await $.turn.complete({ reason: 'answer', answer: `HANDOFF-ACK ${id}: run pnpm test`, durationMs: 1, isAborted: false, turnId: 't4' })
  await w.clock.advance(200)
  expect(w.submitted.filter(s => s === text).length).toBe(2)
  const r = await routerReport($)
  expect(r).toMatch(/unconfirmed \(the handoff file was not read; it has the text inline, but to let it read the file allow Read/)
  expect(r).toMatch(/continuation unconfirmed/)
})

test('a refused /clear keeps the chat and the checkpoint, and nothing is submitted', { options: { planner: false, handoffContextTokens: 50_000, handoffCostUsd: 0 } }, async ($, on) => {
  const w = world(on, $)
  const clock = w.clock
  w.clear = 'refuse'
  await $.session.start({ cwd: 'C:/proj', surface: null, isInteractive: false } as never)
  await turn($, 1, 'Build the CSV export.')
  w.tokens = 60_000
  const before = w.submitted.length
  await turn($, 2, 'keep going')
  await clock.advance(200)
  expect(w.submitted.length).toBe(before + 1) // only the person's own "keep going"
  expect(w.handoffText()).toContain('Build the CSV export.')
  const r = await routerReport($)
  expect(r).toMatch(/handoff skipped: \/clear was refused/)
  expect(r).toMatch(/Handoffs: none/)
})
