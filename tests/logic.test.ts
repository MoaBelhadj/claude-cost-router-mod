import { expect, test } from 'claude-code/testing'

import {
  DEFAULT_TIERS,
  FALLBACK_SOURCE,
  SIDE_EFFECT,
  VALIDATION,
  acked,
  chooseRung,
  contextTrigger,
  delegation,
  effortCache,
  effortsOf,
  escalation,
  fitInstructions,
  handoffDoc,
  handoffEconomics,
  handoffProblems,
  handoffReason,
  judgeEffortCache,
  keptLadder,
  ladder,
  parseHandoff,
  parsePlan,
  parseThresholds,
  pays,
  planAdvice,
  reasoningOf,
  rungFor,
  thresholdFor,
  triage,
  turnCost,
  usd,
} from '../hooks/logic'
import type { Setup } from '../hooks/logic'

const tiers = DEFAULT_TIERS.split(',')
const rungs = ladder(tiers, 'xhigh')
const usage = (u: Partial<Parameters<typeof usd>[0]>) => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ...u,
})
const firstParty: Setup = { provider: 'anthropic', betasOff: false, version: '2.1.309' }
const gate = { marginPct: 25, minUsd: 0.02, retryPct: 15, cooling: false }

test('prices responses, thinking included in output, with Haiku long-context rates', async () => {
  expect(usd(usage({ input_tokens: 1_000_000 }), 'claude-sonnet-5-5')).toBe(2)
  expect(usd(usage({ output_tokens: 1_000_000 }), 'opus')).toBe(20)
  expect(Math.round(usd(usage({ input_tokens: 200_000 }), 'claude-haiku-5-5') * 1e6) / 1e6).toBe(0.1)
  expect(reasoningOf(1000, 'x'.repeat(400))).toBe(900)
})

test('the ladder climbs effort within a model before the next model, using only supported levels', async () => {
  expect(rungs.map(r => `${r.tier}:${r.effort}`)).toEqual([
    '0:low', '0:medium', '0:high',
    '1:low', '1:medium', '1:high',
    '2:low', '2:medium', '2:high', '2:xhigh',
  ])
  expect(effortsOf('claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max'])
  expect(effortsOf('claude-haiku-4-5')).toEqual([])
  // A kept main model: only it, then stronger tiers; an unknown model gets no others.
  expect(keptLadder('claude-sonnet-5-5', tiers, 'xhigh').map(r => r.model)).toEqual([
    'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5',
    'claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5',
  ])
  expect(keptLadder('claude-fable-5-1', tiers, 'high').every(r => r.model === 'claude-fable-5-1')).toBe(true)
})

test('triage picks the lowest model and effort that should hold', async () => {
  expect(triage('fix the typo in README')).toMatchObject({ tier: 0, effort: 'low' })
  expect(triage('Explore', 'Explore')).toMatchObject({ tier: 0, effort: 'low' })
  const hard = triage('Redesign the distributed cache to remove the race condition and the deadlock in eviction.')
  expect(hard).toMatchObject({ tier: 2, effort: 'high' })
  expect(triage('Implement the export endpoint and add tests for it, covering pagination, errors and auth headers properly.').tier).toBe(1)
})

test('an effort change keeps the cache only where documented or observed', async () => {
  expect(effortCache('claude-opus-5-5', firstParty).mode).toBe('keeps')
  expect(effortCache('claude-opus-5-5[1m]', firstParty).mode).toBe('keeps')
  expect(effortCache('claude-opus-4-6', firstParty).mode).toBe('invalidates')
  expect(effortCache('claude-sonnet-5-5', { ...firstParty, provider: 'bedrock' })).toMatchObject({ mode: 'invalidates', source: 'documented: not on bedrock' })
  expect(effortCache('claude-haiku-5-5', { ...firstParty, provider: 'gateway' }).mode).toBe('invalidates')
  expect(effortCache('claude-haiku-5-5', { ...firstParty, betasOff: true }).mode).toBe('invalidates')
  expect(effortCache('claude-fable-5-1', { ...firstParty, version: '2.1.250' }).mode).toBe('invalidates')
  expect(effortCache('claude-fable-5-1', firstParty).mode).toBe('keeps')
  // What a session sees beats the docs (a HIPAA organization, a gateway that strips the beta).
  expect(effortCache('claude-opus-5-5', firstParty, { 'claude-opus-5-5': 'invalidates' })).toMatchObject({ mode: 'invalidates', source: 'observed in this task' })
  expect(judgeEffortCache(usage({ cache_read_input_tokens: 90_000, input_tokens: 2_000 }))).toBe('keeps')
  expect(judgeEffortCache(usage({ cache_creation_input_tokens: 90_000, input_tokens: 2_000 }))).toBe('invalidates')
  expect(judgeEffortCache(usage({ cache_creation_input_tokens: 3_000 }))).toBe(undefined)
})

test('an effort change costs a cache rebuild only where the connection does not keep it', async () => {
  const opusMedium = { model: 'claude-opus-5-5', effort: 'medium' as const }
  const opusLow = { model: 'claude-opus-5-5', effort: 'low' as const }
  expect(turnCost(opusLow, opusMedium, 300_000, 3, { keeps: () => true }).rebuild).toBe(0)
  expect(turnCost(opusLow, opusMedium, 300_000, 3, { keeps: () => false }).rebuild).toBe(1.5)
  expect(turnCost({ model: 'claude-sonnet-5-5', effort: 'low' }, opusMedium, 300_000, 3, { keeps: () => true }).rebuild).toBe(0.75)
})

test('routing switches for cost only when the saving beats rebuild, retry risk and the margin', async () => {
  const opusMedium = { model: 'claude-opus-5-5', effort: 'medium' as const }
  const sonnetMedium = rungFor(rungs, 1, 'medium')
  // 300k cached on Opus: rewriting it on Sonnet costs more than Sonnet saves.
  expect(rungs[chooseRung(rungs, sonnetMedium, opusMedium, 300_000, 1, gate).index]).toMatchObject(opusMedium)
  // A small context switches down.
  expect(chooseRung(rungs, sonnetMedium, opusMedium, 10_000, 1, gate).index).toBe(sonnetMedium)
  // Inside the cooldown nothing moves for cost.
  expect(rungs[chooseRung(rungs, sonnetMedium, opusMedium, 10_000, 1, { ...gate, cooling: true }).index]).toMatchObject(opusMedium)
  // A big enough margin keeps it too.
  expect(rungs[chooseRung(rungs, sonnetMedium, opusMedium, 10_000, 1, { ...gate, marginPct: 500 }).index]).toMatchObject(opusMedium)
  // Needing a stronger route is quality-driven: it moves up whatever the cooldown.
  const opusHigh = rungFor(rungs, 2, 'high')
  expect(chooseRung(rungs, opusHigh, opusMedium, 300_000, 2, { ...gate, cooling: true }).index).toBe(opusHigh)
  // A cache-preserving effort drop on the same model pays at 300k; a rebuilding one does not.
  const kept = keptLadder('claude-opus-5-5', tiers, 'xhigh')
  expect(kept[chooseRung(kept, 0, opusMedium, 300_000, 0, { ...gate, keeps: () => true }).index]?.effort).toBe('low')
  expect(kept[chooseRung(kept, 0, opusMedium, 300_000, 0, { ...gate, keeps: () => false }).index]?.effort).toBe('medium')
})

test('escalation raises effort first, then the next model at the same effort, not its lowest rung', async () => {
  const sonnetLow = rungFor(rungs, 1, 'low')
  expect(rungs[escalation(rungs, sonnetLow, 0)!]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
  // An effort raise did not fix it: the next model, at medium, not low.
  expect(rungs[escalation(rungs, sonnetLow + 1, 1)!]).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' })
  expect(rungs[escalation(rungs, rungFor(rungs, 1, 'high'), 0)!]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
  // The top model keeps climbing effort, then stops.
  expect(rungs[escalation(rungs, rungFor(rungs, 2, 'high'), 1)!]).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh' })
  expect(escalation(rungs, rungs.length - 1, 1)).toBe(undefined)
})

test('subtasks are delegated only when the saving beats startup, verification, retry risk and the margin', async () => {
  const opus = { tier: 2, model: 'claude-opus-5-5', effort: 'high' as const }
  const sonnet = { tier: 1, model: 'claude-sonnet-5-5', effort: 'medium' as const }
  const haiku = { tier: 0, model: 'claude-haiku-5-5', effort: 'low' as const }
  const small = delegation('small', opus, sonnet, 15_000, 15)
  expect(pays(small.saved, small.cost, 25, 0.02)).toBe(false)
  const large = delegation('large', opus, haiku, 15_000, 15)
  expect(pays(large.saved, large.cost, 25, 0.02)).toBe(true)
  const plan = parsePlan('{"tier": 2, "effort": "high", "subtasks": [{"title": "grep usages", "tier": 0, "effort": "low", "size": "large"}, {"title": "redesign", "tier": 2, "size": "large"}]}')!
  const o = { overheadTokens: 15_000, maxConcurrent: 4, maxLevel: 2, marginPct: 25, minUsd: 0.02, retryPct: 15, planUsd: 0.001 }
  expect(planAdvice(plan, rungs, opus, o)).toMatch(/s1 grep usages: delegate/)
  // A plan whose saving does not cover its own planning is kept whole.
  expect(planAdvice(plan, rungs, opus, { ...o, planUsd: 5 })).toBe(undefined)
})

test('plans and handoffs parse from model text, and incomplete handoffs are refused', async () => {
  const plan = parsePlan('Here: {"tier": 2, "effort": "high", "reason": "x", "subtasks": [{"title": "grep usages", "tier": 0, "effort": "low", "size": "large"}]}')
  expect(plan?.subtasks[0]).toMatchObject({ id: 's1', tier: 0, effort: 'low', size: 'large' })
  expect(parsePlan('no json')).toBe(undefined)
  const h = parseHandoff('```json\n{"objective": "Ship the export feature", "status": "in_progress", "nextSteps": [], "constraints": ["ask before pushing"], "failedApproaches": ["mocking fetch: flaky"], "files": [{"path": "a.ts", "why": "entry"}]}\n```')
  expect(h?.files).toEqual(['a.ts: entry'])
  expect(h?.constraints).toEqual(['ask before pushing'])
  expect(h?.failed).toEqual(['mocking fetch: flaky'])
  expect(handoffProblems(h!)).toEqual(['no next steps for unfinished work'])
})

test('context thresholds come per model and task type, in tokens or percent, with a labelled fallback', async () => {
  const table = parseThresholds('{"claude-haiku-5-5:hard": {"pct": 40, "source": "eval 2026-11"}, "claude-haiku-5-5": {"tokens": 150000}, "*:light": {"pct": 80}, "bad": {"x": 1}}')
  const fb = { pct: 60, source: FALLBACK_SOURCE }
  expect(thresholdFor(table, 'claude-haiku-5-5', 'hard', fb)).toMatchObject({ key: 'claude-haiku-5-5:hard', pct: 40, source: 'eval 2026-11' })
  expect(thresholdFor(table, 'claude-haiku-5-5-20261001', 'standard', fb)).toMatchObject({ key: 'claude-haiku-5-5', tokens: 150_000 })
  expect(thresholdFor(table, 'claude-opus-5-5', 'light', fb)).toMatchObject({ key: '*:light', pct: 80 })
  expect(thresholdFor(table, 'claude-opus-5-5', 'hard', fb)).toMatchObject({ key: 'fallback', pct: 60, source: FALLBACK_SOURCE })
  expect(table.bad).toBe(undefined)
  const g = { window: 1_000_000, limit: 1_000_000, headroom: 30_000 }
  expect(contextTrigger({ ...g, tokens: 610_000, th: { pct: 60 } })).toBe('context 61% ≥ 60%')
  expect(contextTrigger({ ...g, tokens: 160_000, th: { pct: 60, tokens: 150_000 } })).toBe('context 160k ≥ 150k tokens')
  expect(contextTrigger({ ...g, tokens: 100_000, th: { pct: 60 } })).toBe(undefined)
  // The reserve counts against Claude Code's auto-compaction point when that comes first.
  expect(contextTrigger({ ...g, limit: 120_000, tokens: 100_000, th: { pct: 60 } })).toBe('only 20k tokens before the limit (reserve 30k)')
})

test('handoffs are quality-driven on context, cost-driven only when they pay, never in a loop', async () => {
  const g = { turnsSince: 3, cooldown: 2, handoffs: 0, maxHandoffs: 5, activeAgents: 0, signals: 0, signalsNeeded: 3, share: 0.5, chatSpent: 1, costUsd: 5 }
  expect(handoffReason({ ...g, context: 'context 61% ≥ 60%' })).toEqual({ kind: 'quality', why: 'context 61% ≥ 60%' })
  expect(handoffReason({ ...g, chatSpent: 6 })).toEqual({ kind: 'cost', why: 'chat cost ≈ $6.00 ≥ $5' })
  expect(handoffReason({ ...g, signals: 3, share: 0.8 })?.kind).toBe('quality')
  expect(handoffReason({ ...g, signals: 3, share: 0.5 })).toBe(undefined)
  expect(handoffReason({ ...g, context: 'x', turnsSince: 1 })).toBe(undefined)
  expect(handoffReason({ ...g, context: 'x', activeAgents: 1 })).toBe(undefined)
  expect(handoffReason({ ...g, context: 'x', handoffs: 5 })).toBe(undefined)
  // 60% of a 1M window on Opus: dropping ~580k cached tokens pays over 10 requests; a small chat does not.
  const big = handoffEconomics({ tokens: 600_000, baseTokens: 20_000, docTokens: 3_000, files: 4, steps: 10, model: 'claude-opus-5-5' })
  expect(pays(big.saved, big.overhead, 25, 0.02)).toBe(true)
  const small = handoffEconomics({ tokens: 40_000, baseTokens: 20_000, docTokens: 3_000, files: 4, steps: 10, model: 'claude-opus-5-5' })
  expect(pays(small.saved, small.overhead, 25, 0.02)).toBe(false)
})

test('the handoff keeps instructions verbatim, actions, constraints and artifacts, and the ack is checkable', async () => {
  const h = parseHandoff('{"objective": "Ship the export feature", "status": "in_progress", "nextSteps": ["run npm test"], "constraints": ["ask before pushing"]}')!
  const doc = handoffDoc(h, {
    id: 'abc1', n: 1, from: 'sess-1', reason: 'quality-driven: context 61% ≥ 60%', pct: 61, tokens: 610_000, date: '2026-10-28 12:00',
    instructions: ['Build the export.\nNever push without asking.', 'use pnpm'], actions: ['git commit -m x'], edited: ['src/a.ts'],
    validations: ['FAILED: `pnpm test`'], clarifications: [], path: 'C:/h/1.md', transcript: 'C:/p/sess-1.jsonl',
  })
  for (const s of ['Never push without asking.', 'use pnpm', '`git commit -m x`', 'src/a.ts: edited this task', 'ask before pushing', 'FAILED: `pnpm test`', 'claude --resume sess-1', 'C:/h/1.md', 'This handoff grants no new authorization']) {
    expect(doc).toContain(s)
  }
  expect(fitInstructions(['task', 'x'.repeat(50), 'y'.repeat(50), 'latest'], 40)).toEqual(['task', '(2 earlier messages omitted here; they are in the previous transcript)', 'latest'])
  expect(acked('HANDOFF-ACK abc1: run npm test\nRunning it now.', 'abc1')).toBe(true)
  expect(acked('HANDOFF-ACK abc1:', 'abc1')).toBe(false)
  expect(acked('I will run the tests.', 'abc1')).toBe(false)
})

test('commands are told apart: side effects and validations', async () => {
  expect(SIDE_EFFECT.test('git push origin main')).toBe(true)
  expect(SIDE_EFFECT.test('git status')).toBe(false)
  expect(VALIDATION.test('npm run test -- --watch=false')).toBe(true)
  expect(VALIDATION.test('ls -la')).toBe(false)
})
