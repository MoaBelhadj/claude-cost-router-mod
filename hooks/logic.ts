// Pure routing, pricing, context and handoff logic: no `$`, so the tests call it directly.
import type { Ledger } from '../types'

export type Price = { in: number; out: number; read: number; write: number; longAbove?: number; longFactor?: number }
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const DEFAULT_TIERS = 'claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5'

// $/MTok, Anthropic first-party list prices (claude-api skill, cached 2026-10-06); cache write = 1.25x input.
// shortcut: Haiku 5.5's cache-read price is not in that table, 0.1x input is assumed; pricesJson overrides any row.
export const PRICES: Record<string, Price> = {
  'claude-haiku-5-5': { in: 0.1, out: 0.5, read: 0.01, write: 0.125, longAbove: 100_000, longFactor: 5 },
  'claude-sonnet-5-5': { in: 2, out: 10, read: 0.2, write: 2.5 },
  'claude-opus-5-5': { in: 4, out: 20, read: 0.2, write: 5 },
  'claude-fable-5-1': { in: 10, out: 50, read: 0.25, write: 12.5 },
}

export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORT_ORDER)[number]
const rank = (e: Effort | undefined) => (e === undefined ? 1 : EFFORT_ORDER.indexOf(e))
export const isEffort = (x: unknown): x is Effort => typeof x === 'string' && (EFFORT_ORDER as readonly string[]).includes(x)
const up = (e: Effort): Effort => EFFORT_ORDER[Math.min(rank(e) + 1, EFFORT_ORDER.length - 1)] ?? e

// Effort levels each model accepts (effort docs, checked 2026-10-28). A model not listed is sent no effort at all.
export const EFFORTS: Record<string, readonly Effort[]> = {
  'claude-haiku-5-5': EFFORT_ORDER,
  'claude-sonnet-5-5': EFFORT_ORDER,
  'claude-opus-5-5': EFFORT_ORDER,
  'claude-fable-5-1': EFFORT_ORDER,
  'claude-opus-4-6': ['low', 'medium', 'high', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
}

// Rough output-token multiplier of each effort (thinking plus text) against medium; estimates only.
const EFFORT_OUT: Record<Effort, number> = { low: 0.5, medium: 1, high: 1.7, xhigh: 2.6, max: 4 }

const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable']

/** The table key a model id or alias stands for: the longest matching prefix (`claude-opus-5-5[1m]`), else, where `family` allows or it is a bare alias, its family's row. */
function keyOf(model: string, table: Record<string, unknown>, family: boolean): string | undefined {
  const m = model.toLowerCase()
  const keys = Object.keys(table).sort((a, b) => b.length - a.length)
  const prefix = keys.find(k => m.startsWith(k))
  if (prefix !== undefined || !(family || FAMILIES.includes(m))) return prefix
  const f = FAMILIES.find(x => m.includes(x))
  return f === undefined ? undefined : keys.find(k => k.includes(f))
}

export function priceOf(model: string, prices = PRICES): Price {
  const key = keyOf(model, prices, true)
  // An unknown model is priced as the dearest known one, so it is never chosen as "cheap".
  return (key && prices[key]) || Object.values(prices).reduce((a, b) => (b.out > a.out ? b : a))
}

export function effortsOf(model: string): readonly Effort[] {
  const key = keyOf(model, EFFORTS, false)
  return (key && EFFORTS[key]) || []
}

export const sameModel = (a: string, b: string, prices = PRICES) =>
  a === b || (keyOf(a, prices, true) ?? a) === (keyOf(b, prices, true) ?? b)

/** The key observations about a model are kept under: its id without a `[1m]`-style suffix. */
export const modelKey = (model: string) => model.toLowerCase().replace(/\[.*\]$/, '')

const factor = (p: Price, promptTokens: number) =>
  p.longAbove !== undefined && promptTokens > p.longAbove ? (p.longFactor ?? 1) : 1

/** What one response would cost at list prices, USD. Thinking tokens are billed as output, so they are inside `output_tokens`. */
export function usd(u: Usage, model: string, prices = PRICES): number {
  const p = priceOf(model, prices)
  const f = factor(p, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
  return (
    (f *
      (p.in * u.input_tokens +
        p.read * u.cache_read_input_tokens +
        p.write * u.cache_creation_input_tokens +
        p.out * u.output_tokens)) /
    1e6
  )
}

export const promptOf = (u: Usage) => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

export const tokensOf = (s: string) => Math.ceil(s.length / 4)

/** Output tokens a response spent thinking: its output minus what it visibly wrote. */
export const reasoningOf = (outputTokens: number, visible: string) => Math.max(0, outputTokens - tokensOf(visible))

export function parsePrices(json: string): Record<string, Price> {
  if (!json.trim()) return {}
  try {
    const raw = JSON.parse(json) as Record<string, Record<string, unknown> | null>
    return Object.fromEntries(
      Object.entries(raw)
        .filter(([, p]) => p !== null && typeof p === 'object' && ['in', 'out', 'read', 'write'].every(k => typeof p[k] === 'number'))
        .map(([k, p]) => [k.toLowerCase(), p as unknown as Price]),
    )
  } catch {
    return {}
  }
}

// --- What this connection supports ---

export type Provider = 'anthropic' | 'bedrock' | 'vertex' | 'foundry' | 'gateway'
export type Setup = { provider: Provider; betasOff: boolean; version: string }
export type CacheMode = 'keeps' | 'invalidates'

// Claude Code prompt-caching docs, checked 2026-10-28 against v2.1.309: an effort change keeps the cache on these
// models with an API key or a Claude subscription (Fable 5.1 only from v2.1.260). Every other model, Bedrock,
// Vertex, a gateway, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS and HIPAA organizations start the cache over.
const EFFORT_CACHED: Record<string, string> = {
  'claude-opus-5-5': '0',
  'claude-sonnet-5-5': '0',
  'claude-haiku-5-5': '0',
  'claude-fable-5-1': '2.1.260',
}

const atLeast = (v: string, min: string) => {
  const a = v.split(/[.-]/).map(Number)
  const b = min.split(/[.-]/).map(Number)
  for (let i = 0; i < b.length; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return true
}

/** Whether changing effort on `model` keeps the prompt cache: what this task observed first, else what the docs say. */
export function effortCache(model: string, s: Setup, observed: Record<string, CacheMode> = {}): { mode: CacheMode; source: string } {
  const seen = observed[modelKey(model)]
  if (seen) return { mode: seen, source: 'observed in this task' }
  const key = keyOf(model, EFFORT_CACHED, false)
  if (key === undefined) return { mode: 'invalidates', source: 'documented: no cache-preserving effort on this model' }
  if (s.provider !== 'anthropic') return { mode: 'invalidates', source: `documented: not on ${s.provider}` }
  if (s.betasOff) return { mode: 'invalidates', source: 'documented: experimental betas are off' }
  if (!atLeast(s.version, EFFORT_CACHED[key] ?? '0')) return { mode: 'invalidates', source: `documented: needs v${EFFORT_CACHED[key]}` }
  return { mode: 'keeps', source: 'documented: first-party, per-message effort' }
}

/** What the first response after an effort change says about it; undefined when it cannot tell (small prompt, mixed result). */
export function judgeEffortCache(u: Usage): CacheMode | undefined {
  const prompt = promptOf(u)
  if (prompt < 8_000) return undefined
  if (u.cache_read_input_tokens >= prompt * 0.5) return 'keeps'
  if (u.cache_creation_input_tokens + u.input_tokens >= prompt * 0.5) return 'invalidates'
  return undefined
}

// --- The ladder: every (model, effort) the router may use, cheapest first ---

export type Rung = { tier: number; model: string; effort?: Effort }
export type RouteLike = { model: string; effort?: Effort }

export const label = (r: RouteLike) => `${r.model.replace(/^claude-/, '')}${r.effort ? ` · ${r.effort}` : ''}`

export const sameRoute = (a: RouteLike, b: RouteLike, prices = PRICES) => sameModel(a.model, b.model, prices) && a.effort === b.effort

/**
 * A lower tier climbs effort only to `high` before the next model is tried (the docs advise comparing a stronger
 * model past that); the top tier climbs to `cap`. Only levels the model accepts are rungs.
 */
export function ladder(tiers: readonly string[], cap: Effort): Rung[] {
  return tiers.flatMap((model, tier) => {
    const limit = tier === tiers.length - 1 ? rank(cap) : Math.min(rank(cap), rank('high'))
    const efforts = effortsOf(model).filter(e => rank(e) <= limit)
    return efforts.length === 0 ? [{ tier, model }] : efforts.map(effort => ({ tier, model, effort }))
  })
}

/** The main chat's ladder when its model is kept: that model, then only stronger tiers (reached by escalation). */
export function keptLadder(model: string, tiers: readonly string[], cap: Effort, prices = PRICES): Rung[] {
  const t = tiers.findIndex(x => sameModel(x, model, prices))
  return ladder(t < 0 ? [model] : [model, ...tiers.slice(t + 1)], cap)
}

/** The first rung on `tier` at or above `effort`; the tier's top rung when it goes no higher. */
export function rungFor(rungs: readonly Rung[], tier: number, effort: Effort): number {
  const on = rungs.flatMap((r, i) => (r.tier === tier ? [{ r, i }] : []))
  const hit = on.find(({ r }) => r.effort === undefined || rank(r.effort) >= rank(effort))
  return (hit ?? on.at(-1))?.i ?? 0
}

/**
 * One escalation step, model and effort chosen together: the first step raises effort on the same model while it is
 * below `high`; once an effort raise has not fixed it (or effort is already high), the next model at the same effort
 * (at least medium), not back at its lowest rung. Undefined at the top.
 */
export function escalation(rungs: readonly Rung[], at: number, bumps: number): number | undefined {
  const cur = rungs[at]
  if (!cur) return undefined
  const same = rungs[at + 1]
  if (same && same.tier === cur.tier && bumps === 0 && rank(cur.effort) < rank('high')) return at + 1
  if (!rungs.some(r => r.tier === cur.tier + 1)) return same && same.tier === cur.tier ? at + 1 : undefined
  const effort = EFFORT_ORDER[Math.max(rank('medium'), Math.min(rank(cur.effort), rank('high')))] ?? 'medium'
  return rungFor(rungs, cur.tier + 1, effort)
}

// --- Triage: free, local, decides most routes alone ---

export type Triage = { tier: number; effort: Effort; reason: string; multi: boolean }
export const KINDS = ['light', 'standard', 'hard'] as const

const HARD =
  /\b(architect\w*|design\w*|refactor\w*|migrat\w*|race conditions?|deadlocks?|concurren\w*|secur\w*|vulnerab\w*|optimi[sz]\w*|performance|proofs?|prove|algorithms?|root cause|flaky|memory leaks?|distributed|crypto\w*|compilers?|parsers?|trade-?offs?)\b/gi
const STANDARD =
  /\b(implement\w*|build\w*|create\w*|add\w*|fix\w*|debug\w*|tests?|write|integrat\w*|endpoints?|components?|features?|scripts?|functions?)\b/gi
const LIGHT =
  /\b(rename\w*|typos?|format\w*|lint|list|find|search\w*|grep|locate|look up|read|summari[sz]\w*|explain\w*|what is|show|count|translate|convert|bump|commit message|status)\b/gi
export const READ_ONLY_AGENTS = /^(explore|statusline-setup|claude-code-guide)$/i

/** Capability level (0 light, 1 standard, 2 hard) and the lowest effort that should hold. */
export function triage(text: string, agentType = ''): Triage {
  if (READ_ONLY_AGENTS.test(agentType)) return { tier: 0, effort: 'low', reason: `${agentType}: read-only lookup`, multi: false }
  const hits = (re: RegExp) => text.match(re) ?? []
  const hard = hits(HARD)
  const standard = hits(STANDARD)
  const light = hits(LIGHT)
  const multi = (text.match(/^\s*(\d+[.)]|[-*•])\s+\S/gm)?.length ?? 0) >= 3
  const score =
    Math.min(hard.length, 3) * 2 +
    Math.min(standard.length, 3) -
    Math.min(light.length, 2) +
    (text.length > 1500 ? 1 : 0) +
    (text.length > 5000 ? 1 : 0)
  const tier = score <= 0 ? 0 : score <= 3 ? 1 : 2
  // Light work low, coding medium, hard high; one step up for multi-step or long work, one down for a short ask.
  const bump = (multi || text.length > 4000 ? 1 : 0) - (text.length < 160 && hard.length === 0 ? 1 : 0)
  const effort = EFFORT_ORDER[Math.max(0, Math.min(3, tier + bump))] ?? 'medium'
  const why = hard[0]
    ? `hard: ${hard[0].toLowerCase()}`
    : standard.length > 0
      ? 'standard coding'
      : light[0]
        ? `light: ${light[0].toLowerCase()}`
        : 'small ask'
  return { tier, effort, reason: multi ? `${why}, multi-step` : why, multi }
}

/** The person says the last answer failed. */
export const NEGATIVE =
  /\b(wrong|incorrect|(does|did)n'?t work|not working|still (fails|failing|broken|wrong)|try again|that'?s not|redo|regress\w*)\b/i

/** The person repeats an instruction: a warning signal of a forgotten constraint, not proof. */
export const FORGOT = /\b(i (already )?(told|said|asked)( you)?|as i said|i mentioned|you forgot|again,? (don'?t|do not|please))\b/i

/** A command whose failure is a failed validation (tests, builds, type checks, linters). */
export const VALIDATION =
  /\b((npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck)|pytest|jest|vitest|tsc|eslint|cargo\s+(test|build|check)|go\s+(test|build|vet)|mvn\s+(test|verify)|gradlew?\s+(test|build)|make\s+(test|check)|dotnet\s+(test|build)|ruff|mypy|claude(\.exe)?\s+plugin\s+(test|validate))\b/i

/** A command with effects outside the working tree, or that is not safe to run twice. */
export const SIDE_EFFECT =
  /\b(git\s+(push|commit|tag|merge|rebase|reset)|gh\s+(pr|release|issue)\s+(create|merge|close|edit)|(npm|pnpm|yarn)\s+publish|docker\s+push|kubectl\s+(apply|delete)|terraform\s+(apply|destroy)|curl\b.*-X\s*(POST|PUT|PATCH|DELETE)|rm\s+-[a-z]*r|deploy)\b/i

// --- Cost estimates (list prices, heuristic traffic shapes: estimates, never measurements) ---

const NEW_IN = 3_000 // fresh input a request adds (tool results, the prompt)
const OUT = 1_500 // output per request at medium effort
const STEPS = [3, 8, 20] // expected requests per turn: light, standard, hard

export type TurnCost = { work: number; rebuild: number }
export type CostOpts = { prices?: Record<string, Price>; keeps?: (model: string) => boolean }

/**
 * Expected cost of a turn of `steps` requests on `rung`, the context `tokens` long and cached for `current`.
 * `rebuild` is the first request writing the whole context again: another model always, another effort only
 * where this connection does not keep the cache across effort changes (`keeps`).
 */
export function turnCost(rung: RouteLike, current: RouteLike, tokens: number, steps: number, o: CostOpts = {}): TurnCost {
  const prices = o.prices ?? PRICES
  const p = priceOf(rung.model, prices)
  const f = factor(p, tokens)
  const otherModel = !sameModel(rung.model, current.model, prices)
  const switching = otherModel || (rung.effort !== current.effort && !(o.keeps?.(rung.model) ?? false))
  const reads = tokens * p.read * (switching ? steps - 1 : steps)
  const perStep = steps * (NEW_IN * p.write + OUT * EFFORT_OUT[rung.effort ?? 'medium'] * p.out)
  return { work: (f * (reads + perStep)) / 1e6, rebuild: switching ? (f * tokens * p.write) / 1e6 : 0 }
}

/** A cost-driven change goes ahead only when what it saves beats its overhead by the margin, and by `minUsd` at least. */
export const pays = (saved: number, overhead: number, marginPct: number, minUsd: number) =>
  saved - overhead >= Math.max(minUsd, (overhead * marginPct) / 100)

export type ChooseOpts = CostOpts & { marginPct: number; minUsd: number; retryPct: number; cooling: boolean }
export type Choice = { index: number; est: number; why: string }

const $3 = (n: number) => `$${n.toFixed(3)}`

/**
 * The route for a turn, at or above `start` (what the task needs). Moving up to `start` is quality-driven and always
 * allowed. Moving between adequate routes is cost-driven: only outside the cooldown, and only when the saving beats
 * the cache rebuild plus the retry risk of a weaker route by the margin.
 */
export function chooseRung(rungs: readonly Rung[], start: number, current: RouteLike, tokens: number, level: number, o: ChooseOpts): Choice {
  const steps = STEPS[Math.min(level, 2)] ?? 8
  const costs = rungs.map(r => turnCost(r, current, tokens, steps, o))
  const total = (i: number) => (costs[i] ? costs[i].work + costs[i].rebuild : Infinity)
  let best = Math.min(start, rungs.length - 1)
  for (let i = best; i < rungs.length; i++) if (total(i) < total(best)) best = i
  const cur = rungs.findIndex(r => sameRoute(r, current, o.prices))
  if (cur < 0) return { index: best, est: total(best), why: 'first route on this ladder' }
  if (cur < start) return { index: best, est: total(best), why: 'the task needs a stronger route' }
  if (best === cur) return { index: cur, est: total(cur), why: 'already the cheapest adequate route' }
  if (o.cooling) return { index: cur, est: total(cur), why: 'kept: inside the switch cooldown' }
  const a = rungs[cur]
  const b = rungs[best]
  const stay = total(cur)
  const weaker = a && b ? Math.max(0, a.tier - b.tier) + 0.25 * Math.max(0, rank(a.effort) - rank(b.effort)) : 0
  const retry = (weaker * o.retryPct * stay) / 100
  const saved = stay - (costs[best]?.work ?? 0)
  const overhead = (costs[best]?.rebuild ?? 0) + retry
  if (!pays(saved, overhead, o.marginPct, o.minUsd)) {
    return { index: cur, est: stay, why: `kept: switching saves ${$3(saved)} but costs ${$3(overhead)} (cache rebuild + retry risk) + ${o.marginPct}% margin` }
  }
  return { index: best, est: total(best), why: `switch saves ${$3(saved - overhead)} net of rebuild and retry risk` }
}

const WORK = { small: 8_000, medium: 40_000, large: 150_000 } as const
export type Size = keyof typeof WORK
const REPORT = 2_000 // the subagent's report the parent reads
const VERIFY = 3_000 // the parent checking that report

// $/MTok of agentic traffic: mostly cache re-reads, some fresh input, some output.
const agentRate = (r: Rung, prices: Record<string, Price>) => {
  const p = priceOf(r.model, prices)
  return 0.85 * p.read + 0.1 * p.write + 0.05 * EFFORT_OUT[r.effort ?? 'medium'] * p.out
}

/** What running a subtask on `child` instead of inline on `parent` saves, and what it costs: startup, report, verification, retry risk. */
export function delegation(size: Size, parent: Rung, child: Rung, overheadTokens: number, retryPct: number, prices = PRICES) {
  const saved = (WORK[size] * (agentRate(parent, prices) - agentRate(child, prices))) / 1e6
  const retry = (Math.max(0, parent.tier - child.tier) * retryPct * WORK[size] * agentRate(child, prices)) / 1e8
  const cost =
    (overheadTokens * priceOf(child.model, prices).write + REPORT * priceOf(parent.model, prices).in + VERIFY * agentRate(parent, prices)) / 1e6 +
    retry
  return { saved, cost }
}

// --- Planning ---

export type Subtask = { id: string; title: string; tier: number; effort: Effort; size: Size; deps: string[] }
export type Plan = { tier: number; effort: Effort; reason: string; subtasks: Subtask[] }

export const PLANNER_SYSTEM = `You plan cost-efficient work for a coding agent. Reply with JSON only.
Capability tiers: 0 = lookups, search, reading, small mechanical edits; 1 = ordinary coding, tests, moderate debugging; 2 = architecture, subtle or concurrent bugs, security, hard reasoning.
Effort is how hard the model thinks: low, medium, high, xhigh. Pick the lowest that will still get it right.
Shape: {"tier": 0-2, "effort": "...", "reason": "under 10 words", "subtasks": [{"id": "s1", "title": "...", "tier": 0-2, "effort": "...", "size": "small|medium|large", "deps": ["s0"]}]}
"tier" and "effort" are for coordinating the whole task. List subtasks only when the task has two or more separable parts; otherwise an empty list.`

export function extractJson(text: string): unknown {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return undefined
  try {
    return JSON.parse(text.slice(a, b + 1))
  } catch {
    return undefined
  }
}

const levelOf = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(2, Math.round(x))) : 1)
export const strings = (x: unknown, n = 20) =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.trim() !== '').slice(0, n) : []

export function parsePlan(text: string): Plan | undefined {
  const j = extractJson(text) as Record<string, unknown> | undefined
  if (!j || typeof j !== 'object') return undefined
  const raw = Array.isArray(j.subtasks) ? (j.subtasks as unknown[]) : []
  const subtasks = raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof (s as { title?: unknown }).title === 'string')
    .slice(0, 12)
    .map((s, i) => ({
      id: typeof s.id === 'string' ? s.id : `s${i + 1}`,
      title: String(s.title).slice(0, 200),
      tier: levelOf(s.tier),
      effort: isEffort(s.effort) ? s.effort : 'medium',
      size: typeof s.size === 'string' && s.size in WORK ? (s.size as Size) : 'medium',
      deps: strings(s.deps, 12),
    }))
  return {
    tier: levelOf(j.tier),
    effort: isEffort(j.effort) ? j.effort : 'medium',
    reason: typeof j.reason === 'string' ? j.reason.slice(0, 160) : 'planned',
    subtasks,
  }
}

export type AdviceOpts = { overheadTokens: number; maxConcurrent: number; maxLevel: number; marginPct: number; minUsd: number; retryPct: number; planUsd: number; prices?: Record<string, Price> }

/** The breakdown the model reads beside the prompt, or undefined when splitting would not pay for itself and the planning. */
export function planAdvice(plan: Plan, rungs: readonly Rung[], parent: Rung, o: AdviceOpts): string | undefined {
  const rows = plan.subtasks.map(s => {
    const tier = Math.min(s.tier, o.maxLevel)
    const child = rungs[rungFor(rungs, tier, s.effort)] ?? parent
    const d = tier < parent.tier ? delegation(s.size, parent, child, o.overheadTokens, o.retryPct, o.prices) : { saved: 0, cost: 0 }
    return { s, child, net: d.saved - d.cost, go: tier < parent.tier && pays(d.saved, d.cost, o.marginPct, o.minUsd) }
  })
  const net = rows.reduce((a, r) => a + (r.go ? r.net : 0), 0)
  if (!rows.some(r => r.go) || net < o.planUsd) return undefined
  return [
    '[cost-router] Suggested breakdown. Model and effort routing is applied automatically to you and to every subagent.',
    ...rows.map(
      ({ s, child, net, go }) =>
        `- ${s.id} ${s.title}: ${go ? `delegate to a subagent (routes to ${label(child)}, saves ~$${net.toFixed(3)} net)` : 'do it yourself'}${s.deps.length ? `; after ${s.deps.join(', ')}` : ''}`,
    ),
    `Start delegated subtasks whose dependencies are done in parallel, at most ${o.maxConcurrent} at once. Give each subagent a self-contained prompt with only the context it needs: paths, facts and how to check its result. Keep anything not listed here inline.`,
  ].join('\n')
}

/** Plan effort, one step up when the plan was asked for and did not come back (the task stays uncertain). */
export const uncertain = (e: Effort) => up(e)

// --- Context thresholds ---

export type Threshold = { pct?: number; tokens?: number; source?: string }
export const FALLBACK_SOURCE = 'unvalidated fallback, not a measured degradation point'

export function parseThresholds(json: string): Record<string, Threshold> {
  if (!json.trim()) return {}
  try {
    const raw = JSON.parse(json) as Record<string, Record<string, unknown> | null>
    return Object.fromEntries(
      Object.entries(raw)
        .filter(([, t]) => t !== null && typeof t === 'object' && (typeof t.pct === 'number' || typeof t.tokens === 'number'))
        .map(([k, t]) => [
          k.toLowerCase(),
          {
            ...(typeof t!.pct === 'number' ? { pct: t!.pct } : {}),
            ...(typeof t!.tokens === 'number' ? { tokens: t!.tokens } : {}),
            source: typeof t!.source === 'string' ? t!.source : 'configured',
          },
        ]),
    )
  } catch {
    return {}
  }
}

/** The threshold for `model` on `kind` work: `model:kind`, `model`, `*:kind`, `default`, then `fallback`. Model keys match by prefix. */
export function thresholdFor(table: Record<string, Threshold>, model: string, kind: string, fallback: Threshold): Threshold & { key: string } {
  const m = modelKey(model)
  const models = Object.keys(table)
    .map(k => k.split(':')[0] ?? '')
    .filter(k => k !== '' && k !== '*' && k !== 'default' && m.startsWith(k))
    .sort((a, b) => b.length - a.length)
  for (const key of [...models.flatMap(x => [`${x}:${kind}`, x]), `*:${kind}`, 'default']) {
    const t = table[key]
    if (t) return { ...t, key }
  }
  return { ...fallback, key: 'fallback' }
}

const k = (n: number) => `${Math.round(n / 1000)}k`

export type ContextGate = { tokens: number; window: number; limit: number; th: Threshold; headroom: number }

/** Why the context calls for a handoff now (a quality reason), or undefined. */
export function contextTrigger(g: ContextGate): string | undefined {
  if (g.th.tokens && g.tokens >= g.th.tokens) return `context ${k(g.tokens)} ≥ ${k(g.th.tokens)} tokens`
  const pct = g.window > 0 ? Math.round((g.tokens / g.window) * 100) : 0
  if (g.th.pct && g.window > 0 && pct >= g.th.pct) return `context ${pct}% ≥ ${g.th.pct}%`
  if (g.limit > 0 && g.limit - g.tokens < g.headroom) return `only ${k(g.limit - g.tokens)} tokens before the limit (reserve ${k(g.headroom)})`
  return undefined
}

/** How close to its trigger the context is, 0..1 and past it. */
export function contextShare(g: ContextGate): number {
  const shares = [g.th.tokens ? g.tokens / g.th.tokens : 0, g.th.pct && g.window > 0 ? (g.tokens / g.window) * (100 / g.th.pct) : 0]
  return Math.max(...shares)
}

// --- Handoff ---

export type Handoff = {
  objective: string
  status: 'in_progress' | 'done'
  acceptance: string[]
  constraints: string[]
  decisions: string[]
  completed: string[]
  files: string[]
  validation: string[]
  failed: string[]
  unresolved: string[]
  pending: string[]
  nextSteps: string[]
  dependencies: string[]
}

export const HANDOFF_PROMPT = `[cost-router] This conversation is about to be handed off to a fresh context. Write the handoff as JSON only, no prose:
{"objective": "the overall goal in one or two sentences",
 "status": "in_progress" or "done",
 "acceptanceCriteria": ["what done means, as the user stated it"],
 "constraints": ["user constraints and preferences, and permission boundaries: what needs approval, what the user refused or allowed"],
 "decisions": ["decision — why"],
 "completed": ["work finished, with paths"],
 "files": [{"path": "...", "why": "changed or relevant, and how"}],
 "validation": ["each check run and its latest result"],
 "failedApproaches": ["approach tried — why it failed"],
 "unresolved": ["open problems, failing tests, errors"],
 "pending": ["operations started and not finished: background jobs, servers, half-applied changes"],
 "nextSteps": ["ordered, concrete next actions"],
 "dependencies": ["ordering constraints between remaining steps, anything waited on"]}
Be specific: exact paths, commands, names and numbers. Drop nothing the user required. Leave out what a fresh chat can re-read from files. At most about 1200 words.`

export const RECEIVER_SYSTEM =
  'You are about to continue a software task in a fresh chat, with the repository and tools available, from a handoff alone.'

export const RECEIVER_ASK = `---
Using only the handoff above, reply with JSON only: {"nextAction": "the very next concrete action", "missing": ["information you need that is neither in the handoff nor recoverable by reading the listed files or running commands"]}. Use an empty list when nothing is missing.`

export const clarifyPrompt = (missing: readonly string[]) =>
  `[cost-router] A fresh chat will continue from your handoff but says it lacks:\n${missing.map(m => `- ${m}`).join('\n')}\nAnswer each item concisely from this conversation, as JSON only: {"answers": ["...", "..."]}`

export function parseHandoff(text: string): Handoff | undefined {
  const j = extractJson(text) as Record<string, unknown> | undefined
  if (!j || typeof j !== 'object' || typeof j.objective !== 'string') return undefined
  const files = (Array.isArray(j.files) ? (j.files as unknown[]) : [])
    .map(f => {
      if (typeof f === 'string') return f
      const o = f as { path?: unknown; why?: unknown } | null
      if (!o || typeof o.path !== 'string') return ''
      return typeof o.why === 'string' ? `${o.path}: ${o.why}` : o.path
    })
    .filter(Boolean)
    .slice(0, 40)
  return {
    objective: j.objective.trim(),
    status: j.status === 'done' ? 'done' : 'in_progress',
    acceptance: strings(j.acceptanceCriteria ?? j.requirements),
    constraints: strings(j.constraints),
    decisions: strings(j.decisions),
    completed: strings(j.completed, 40),
    files,
    validation: strings(j.validation),
    failed: strings(j.failedApproaches),
    unresolved: strings(j.unresolved),
    pending: strings(j.pending),
    nextSteps: strings(j.nextSteps),
    dependencies: strings(j.dependencies),
  }
}

export function handoffProblems(h: Handoff): string[] {
  const out: string[] = []
  if (h.objective.length < 10) out.push('no objective')
  if (h.status === 'in_progress' && h.nextSteps.length === 0) out.push('no next steps for unfinished work')
  return out
}

/** The person's prompts, verbatim, within `maxChars`: the first (the task) and the newest; the rest stay in the transcript. */
export function fitInstructions(list: readonly string[], maxChars = 12_000): string[] {
  const out: string[] = []
  let used = 0
  let dropped = 0
  for (const [i, x] of [...list.entries()].reverse()) {
    if (i === 0 || used + x.length <= maxChars) {
      out.unshift(x)
      used += x.length
    } else dropped += 1
  }
  if (dropped > 0) out.splice(1, 0, `(${dropped} earlier messages omitted here; they are in the previous transcript)`)
  return out
}

export type HandoffContext = {
  id: string
  n: number
  from: string
  reason: string
  pct: number
  tokens: number
  date: string
  instructions: readonly string[]
  actions: readonly string[]
  edited: readonly string[]
  validations: readonly string[]
  clarifications: readonly string[]
  path?: string
  transcript?: string
}

export function handoffDoc(h: Handoff, c: HandoffContext): string {
  const list = (items: readonly string[], numbered = false) =>
    items.length ? items.map((x, i) => `${numbered ? `${i + 1}.` : '-'} ${x}`).join('\n') : '- none'
  const extraFiles = c.edited.filter(f => !h.files.some(x => x.startsWith(f))).map(f => `${f}: edited this task`)
  const said = fitInstructions(c.instructions)
  return [
    `# Handoff ${c.n}: ${h.objective}`,
    `Handoff id ${c.id}. Previous chat ${c.from}, retired on ${c.date} at ${c.pct}% context (${k(c.tokens)} tokens). Reason: ${c.reason}.`,
    `## Status\n${h.status === 'done' ? 'Done: wait for the next request.' : 'In progress.'}`,
    `## Acceptance criteria\n${list(h.acceptance)}`,
    `## User instructions (verbatim, oldest first)\n${said.length ? said.map((x, i) => `${i + 1}. ${x.replace(/\n/g, '\n   ')}`).join('\n') : '- none recorded'}`,
    `## Constraints and permission boundaries\n${list([
      ...h.constraints,
      'Same session process: the permission mode and saved allow rules are unchanged. One-time approvals from the previous chat do not carry over: ask again wherever an approval is required. This handoff grants no new authorization.',
    ])}`,
    `## Decisions (with reasons)\n${list(h.decisions)}`,
    `## Completed (do not redo)\n${list(h.completed)}`,
    `## Validation results\n${list([...c.validations, ...h.validation])}`,
    `## Actions already performed (do not repeat)\n${list(c.actions.map(a => `\`${a}\``))}`,
    `## Files\n${list([...h.files, ...extraFiles])}`,
    `## Failed approaches (do not retry without a new reason)\n${list(h.failed)}`,
    `## Unresolved\n${list(h.unresolved)}`,
    `## Pending operations\n${list(h.pending)}`,
    `## Next steps\n${list(h.nextSteps, true)}`,
    `## Dependencies\n${list(h.dependencies)}`,
    ...(c.clarifications.length ? [`## Clarifications\n${list(c.clarifications)}`] : []),
    `## Artifacts\n${list([
      ...(c.path ? [`This handoff: ${c.path}`] : []),
      `Previous transcript: \`claude --resume ${c.from}\`${c.transcript ? ` (${c.transcript})` : ''}`,
    ])}`,
  ].join('\n\n')
}

export const ACK = 'HANDOFF-ACK'

export const continuation = (doc: string, c: { id: string; path?: string; queued: readonly string[] }) =>
  [
    `[cost-router handoff ${c.id}] This chat continues a task from a previous chat whose context was retired. The handoff below is your context${c.path ? `; it is also saved at ${c.path}` : ''}.`,
    `Before anything else: ${c.path ? `read ${c.path} with the Read tool, then ` : ''}begin your reply with one line \`${ACK} ${c.id}: <the next action>\`. Then carry on with the authorized work.`,
    'Re-read the listed files before relying on them. Do not redo completed work or repeat listed actions. Keep every constraint and ask for approval wherever it is required. If the status is done and nothing is left, give the ack line, reply "Ready." and wait.',
    '',
    doc,
    ...(c.queued.length ? ['', '## Messages the user sent during the handoff (answer these too)', ...c.queued.map(q => `- ${q}`)] : []),
  ].join('\n')

/** Whether a continuation's first answer acknowledged handoff `id` with a next action. */
export const acked = (answer: string, id: string) => new RegExp(`${ACK}\\s+${id}\\s*:\\s*\\S`).test(answer)

export type HandoffGate = {
  turnsSince: number
  cooldown: number
  handoffs: number
  maxHandoffs: number
  activeAgents: number
  context?: string
  signals: number
  signalsNeeded: number
  share: number
  chatSpent: number
  costUsd: number
}

export type HandoffWhy = { kind: 'quality' | 'cost'; why: string }

/** Why a handoff should run now, and whether to protect quality or save cost; undefined when it should not. */
export function handoffReason(g: HandoffGate): HandoffWhy | undefined {
  if (g.handoffs >= g.maxHandoffs) return undefined // loop guard
  if (g.turnsSince < g.cooldown) return undefined // never twice in a row; longer after a failed attempt
  if (g.activeAgents > 0) return undefined // running subagents report to this chat
  if (g.context) return { kind: 'quality', why: g.context }
  if (g.signalsNeeded > 0 && g.signals >= g.signalsNeeded && g.share >= 0.75) {
    return { kind: 'quality', why: `${g.signals} warning signals at ${Math.round(g.share * 100)}% of the context threshold` }
  }
  if (g.costUsd > 0 && g.chatSpent >= g.costUsd) return { kind: 'cost', why: `chat cost ≈ $${g.chatSpent.toFixed(2)} ≥ $${g.costUsd}` }
  return undefined
}

export type HandoffEstimate = { tokens: number; baseTokens: number; docTokens: number; files: number; steps: number; model: string; prices?: Record<string, Price> }

/** A handoff's estimated saving (re-reads it avoids over the next `steps` requests) and its overhead (summary, checks, new cache, re-reads). */
export function handoffEconomics(e: HandoffEstimate) {
  const p = priceOf(e.model, e.prices)
  const dropped = Math.max(0, e.tokens - e.baseTokens - e.docTokens)
  const saved = (e.steps * dropped * p.read) / 1e6
  const summary = e.tokens * p.read + 3_000 * p.out
  const checks = 2 * (e.docTokens * p.in + 800 * p.out)
  const fresh = (e.baseTokens + e.docTokens + Math.min(e.files, 5) * 3_000) * p.write
  return { saved, overhead: (summary + checks + fresh) / 1e6 }
}

// --- The ledger ---

export const OVERHEAD = ['planning', 'handoff', 'verification'] as const
export const INSIDE = ['agentStartup', 'retry'] as const

export function freshLedger(taskId: string, at: number): Ledger {
  return {
    taskId,
    startedAt: at,
    spent: 0,
    baseline: 0,
    overhead: 0,
    handoffSaved: 0,
    chatSpent: 0,
    savedTokens: 0,
    reasoningTokens: 0,
    reasoningUsd: 0,
    tokens: { in: 0, out: 0, read: 0, write: 0 },
    overheadBy: { planning: 0, handoff: 0, verification: 0, agentStartup: 0, retry: 0 },
    byRoute: {},
    decisions: [],
    signals: [],
    chatSignals: 0,
    instructions: [],
    actions: [],
    files: [],
    validations: [],
    handoffs: [],
    effortCache: {},
  }
}

export function savings(l: Ledger) {
  const routing = l.baseline - (l.spent - l.overhead)
  return { routing, handoff: l.handoffSaved, overhead: l.overhead, net: routing + l.handoffSaved - l.overhead }
}

// Small amounts keep a third decimal, so cheap-model overhead does not read as zero.
const $$ = (n: number) => `$${n.toFixed(Math.abs(n) < 1 ? 3 : 2)}`
const kt = (n: number) => `${Math.round(n / 100) / 10}k`

export type Lines = { route: string; context: string; tokens: string; spend: string; saved: string; overhead: string; signals: string; routes: string }

export function summaryLines(l: Ledger, budget: number): Lines {
  const s = savings(l)
  const o = l.overheadBy
  const c = l.ctx
  const routes = Object.entries(l.byRoute).sort((a, b) => b[1] - a[1])
  return {
    route: l.route ? `Route: ${l.route}` : 'Route: not routed yet',
    context: c
      ? `Context ${kt(c.tokens)} / ${kt(c.window)} (${c.window ? Math.round((c.tokens / c.window) * 100) : 0}%) · handoff at ${c.threshold}${c.categories ? ` · ${c.categories}` : ''}`
      : 'Context: no response measured yet',
    tokens: `Reported tokens: in ${kt(l.tokens.in)}, out ${kt(l.tokens.out)}, cache read ${kt(l.tokens.read)}, cache write ${kt(l.tokens.write)}`,
    spend: `Spent ≈ ${$$(l.spent)}${budget > 0 ? ` of ${$$(budget)}` : ''} (estimate at API list prices); this chat ≈ ${$$(l.chatSpent)}${l.plan ? ` · plan meter: ${l.plan}` : ''}`,
    saved: `Net saving ≈ ${$$(s.net)}: routing ${$$(s.routing)} + handoffs ${$$(s.handoff)} − extra calls ${$$(s.overhead)}`,
    overhead: `Extra calls: planning ${$$(o.planning)}, handoff ${$$(o.handoff)}, verification ${$$(o.verification)} · inside spend: agent startup ${$$(o.agentStartup)}, retries ${$$(o.retry)}`,
    signals: l.signals.length ? `Warning signals (not proof): ${l.signals.slice(-3).map(x => x.text).join('; ')}` : 'Warning signals: none',
    routes: `By route: ${routes.map(([r, x]) => `${r} ${$$(x)}`).join(', ') || 'none yet'}`,
  }
}

export const ASSUMPTIONS = [
  'Dollar figures are estimates at Anthropic list prices from a fixed table (2026-10); they are not a measure of Claude subscription allowance. The plan meter, when shown, is the API-reported rate-limit window.',
  'Token counts are what the API reported for the requests this mod sees (model turns, subagents, its own planner, handoff and check calls).',
  'Routing savings compare the same token traffic priced on the model that would have run without the router; cache rebuilt by a switch is priced as a cache read there.',
  'Handoff savings are the context a handoff removed, priced as a cache read on every later main request; its overhead is the summary, checks and new cache.',
  'Agent startup is each subagent’s first request; retries are requests made while a loop had unresolved failures.',
]

export function report(l: Ledger, budget: number): string {
  const s = summaryLines(l, budget)
  return [
    `Cost router · task ${l.taskId}`,
    s.route,
    s.context,
    s.tokens,
    s.spend,
    s.saved,
    s.overhead,
    s.routes,
    s.signals,
    `Handoffs: ${
      l.handoffs
        .map(h => `${h.kind}: ${h.why} → ${h.docTokens} tokens via ${h.method}${h.confirmed === undefined ? '' : h.confirmed ? ', continued' : ', continuation unconfirmed'}`)
        .join('; ') || 'none'
    }`,
    'Recent decisions:',
    ...l.decisions.slice(-12).map(d => `  ${d.text}`),
    'Assumptions:',
    ...ASSUMPTIONS.map(a => `  - ${a}`),
    'Commands: /router handoff · /router pin <model|auto> · /router calibration · /router reset · settings in /config.',
  ].join('\n')
}

// --- Calibration: what each handoff looked like, to tune thresholds from ---

export type CalibrationRow = {
  at: number
  model: string
  kind: string
  tokens: number
  pct: number
  threshold: string
  reason: 'quality' | 'cost'
  signals: number
  missing: number
  clarified: boolean
  outcome: 'confirmed' | 'unconfirmed' | 'skipped'
}

export function calibrationSummary(rows: readonly CalibrationRow[]): string {
  if (rows.length === 0) return 'No handoffs recorded yet.'
  const groups = new Map<string, CalibrationRow[]>()
  for (const r of rows) groups.set(`${modelKey(r.model)}:${r.kind}`, [...(groups.get(`${modelKey(r.model)}:${r.kind}`) ?? []), r])
  return [...groups.entries()]
    .map(([key, rs]) => {
      const done = rs.filter(r => r.outcome !== 'skipped')
      const ok = done.filter(r => r.outcome === 'confirmed').length
      const pcts = done.map(r => r.pct).sort((a, b) => a - b)
      const median = pcts[Math.floor(pcts.length / 2)] ?? 0
      const missing = done.reduce((a, r) => a + r.missing, 0)
      return `${key}: ${done.length} handoffs (${ok} confirmed), median ${median}% context, ${missing} items the receiver lacked, ${rs.length - done.length} skipped`
    })
    .join('\n')
}
