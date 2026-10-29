import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, TurnStepResult } from 'claude-code'

import type { Ledger } from '../types'
import {
  ACK,
  DEFAULT_TIERS,
  EFFORT_ORDER,
  FALLBACK_SOURCE,
  FORGOT,
  HANDOFF_PROMPT,
  KINDS,
  NEGATIVE,
  PLANNER_SYSTEM,
  PRICES,
  READ_ONLY_AGENTS,
  RECEIVER_ASK,
  RECEIVER_SYSTEM,
  SIDE_EFFECT,
  VALIDATION,
  acked,
  calibrationSummary,
  chooseRung,
  clarifyPrompt,
  contextShare,
  contextTrigger,
  continuation,
  effortCache,
  escalation,
  extractJson,
  freshLedger,
  handoffDoc,
  handoffEconomics,
  handoffProblems,
  handoffReason,
  isEffort,
  judgeEffortCache,
  keptLadder,
  label,
  ladder,
  modelKey,
  parseHandoff,
  parsePlan,
  parsePrices,
  parseThresholds,
  pays,
  planAdvice,
  priceOf,
  promptOf,
  reasoningOf,
  report,
  rungFor,
  sameModel,
  sameRoute,
  savings,
  strings,
  summaryLines,
  thresholdFor,
  tokensOf,
  triage,
  uncertain,
  usd,
} from './logic'
import type { CalibrationRow, ContextGate, Effort, HandoffWhy, Plan, Price, Provider, Rung, RouteLike, Setup, Threshold, Usage } from './logic'

const PANE = 'cost-router'
// Change the tag when Ledger's fields change: it declines what an earlier version stored.
const ledgerAtom = atom({ plugin: 'cost-router', key: 'ledger' } as const, freshLedger('', 0), { shape: 'ledger-2' })

/** One model loop's route: the main chat, or a subagent by its id. */
type Loop = {
  ladder: Rung[]
  rung: number
  depth: number
  /** Failure points since the last passing check. */
  fails: number
  /** Effort escalations since the last passing check. */
  bumps: number
  name: string
  /** The model that would have run without the router. */
  baseline: string
  /** light, standard or hard: the task type thresholds are looked up by. */
  kind: string
  /** The next request rebuilds the cache (another model, or an effort change this connection does not cache). */
  switched: boolean
  /** The last request's route, to notice effort changes. */
  sent?: { model: string; effort?: Effort; at: number }
  /** The main turn of the last route change: the cooldown counts from it. */
  changedTurn: number
  tokens: number
  /** Its first request is still to come: agent startup. */
  first: boolean
  warned?: boolean
}
type Route = { level: number; effort: Effort; reason: string; quality: boolean; rung: number; escalate?: boolean; floorTier?: number }

const newId = () => Date.now().toString(36)
const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5)
const kt = (n: number) => `${Math.round(n / 1000)}k`
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

let prices: Record<string, Price> = PRICES
let tiers: string[] = DEFAULT_TIERS.split(',')
let cap: Effort = 'xhigh'
let rungs: Rung[] = ladder(tiers, cap)
let maxLevel = 2
let cfg = {
  budget: 10,
  budgetSpent: 'handoff',
  softPct: 80,
  pin: '',
  mainModel: 'keep',
  planner: true,
  plannerMin: 400,
  overheadTokens: 15_000,
  maxConcurrent: 4,
  maxDepth: 2,
  escalateAfter: 3,
  marginPct: 25,
  minUsd: 0.02,
  cooldownTurns: 3,
  retryPct: 15,
  handoff: true,
  handoffPct: 60,
  handoffTokens: 0,
  headroom: 30_000,
  thresholds: {} as Record<string, Threshold>,
  signals: 3,
  handoffCost: 5,
  remainingSteps: 10,
  maxHandoffs: 5,
  fable: 'ask',
  fableModel: 'claude-fable-5-1',
}
let setup: Setup = { provider: 'anthropic', betasOff: false, version: '0' }

/** Reads the userConfig options over the defaults above. */
function configure(options: PluginOptions) {
  const num = (k: string, d: number) => (typeof options[k] === 'number' ? (options[k] as number) : d)
  const str = (k: string, d: string) => (typeof options[k] === 'string' ? (options[k] as string) : d)
  const bool = (k: string, d: boolean) => (typeof options[k] === 'boolean' ? (options[k] as boolean) : d)
  prices = { ...PRICES, ...parsePrices(str('pricesJson', '')) }
  tiers = str('tiers', DEFAULT_TIERS).split(',').map(s => s.trim()).filter(Boolean).slice(0, 6)
  if (tiers.length === 0) tiers = DEFAULT_TIERS.split(',')
  const c = str('effortCap', 'xhigh')
  cap = isEffort(c) ? c : 'xhigh'
  rungs = ladder(tiers, cap)
  maxLevel = Math.min(2, tiers.length - 1)
  cfg = {
    budget: num('budgetUsd', cfg.budget),
    budgetSpent: str('budgetSpent', cfg.budgetSpent),
    softPct: num('softBudgetPct', cfg.softPct),
    pin: str('pinModel', cfg.pin).trim(),
    mainModel: str('mainModel', cfg.mainModel),
    planner: bool('planner', cfg.planner),
    plannerMin: num('plannerMinChars', cfg.plannerMin),
    overheadTokens: num('agentOverheadTokens', cfg.overheadTokens),
    maxConcurrent: num('maxConcurrentAgents', cfg.maxConcurrent),
    maxDepth: num('maxDepth', cfg.maxDepth),
    escalateAfter: num('escalateAfterErrors', cfg.escalateAfter),
    marginPct: num('switchMarginPct', cfg.marginPct),
    minUsd: num('minSwitchUsd', cfg.minUsd),
    cooldownTurns: num('switchCooldownTurns', cfg.cooldownTurns),
    retryPct: num('retryRiskPct', cfg.retryPct),
    handoff: bool('handoff', cfg.handoff),
    handoffPct: num('handoffContextPct', cfg.handoffPct),
    handoffTokens: num('handoffContextTokens', cfg.handoffTokens),
    headroom: num('headroomTokens', cfg.headroom),
    thresholds: parseThresholds(str('thresholdsJson', '')),
    signals: num('signalsForHandoff', cfg.signals),
    handoffCost: num('handoffCostUsd', cfg.handoffCost),
    remainingSteps: num('expectedRemainingSteps', cfg.remainingSteps),
    maxHandoffs: num('maxHandoffs', cfg.maxHandoffs),
    fable: str('fable', cfg.fable),
    fableModel: str('fableModel', cfg.fableModel).trim(),
  }
}

/** The provider and features that decide whether an effort change keeps the prompt cache. */
async function detectSetup($: EngineInterface): Promise<Setup> {
  const yes = (v: string | undefined) => v !== undefined && /^(1|true|yes)$/i.test(v.trim())
  const base = (await $.env.get('ANTHROPIC_BASE_URL'))?.trim()
  const provider: Provider = yes(await $.env.get('CLAUDE_CODE_USE_BEDROCK'))
    ? 'bedrock'
    : yes(await $.env.get('CLAUDE_CODE_USE_VERTEX'))
      ? 'vertex'
      : yes(await $.env.get('CLAUDE_CODE_USE_FOUNDRY'))
        ? 'foundry'
        : base && !/^https:\/\/api\.anthropic\.com\/?$/.test(base)
          ? 'gateway'
          : 'anthropic'
  const v = await $.session.version()
  return { provider, betasOff: yes(await $.env.get('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS')), version: v.base ?? v.version }
}

let L: Ledger = freshLedger(newId(), Date.now())
const loops = new Map<string, Loop>()
const active = new Set<string>()
let pending: Route | undefined
let mainTurnId: string | undefined
let mainTurns = 0
let sessionEffort: Effort | undefined
/** The main loop's model as the engine resolved it (`$.session.model()` is its display form). */
let engineModel: string | undefined
let chatBase = 0
let turnsSince = 99
let cooldown = 2
let busy = false
let expectClear = false
let queued: string[] = []
const failedCmds = new Map<string, number>()
const reads = new Map<string, number>()

const rungOf = (loop: Loop): Rung => loop.ladder[Math.max(0, Math.min(loop.rung, loop.ladder.length - 1))] ?? { tier: 0, model: tiers[0] ?? '' }
const tierOf = (model: string) => {
  const i = tiers.findIndex(t => sameModel(t, model, prices))
  return i < 0 ? undefined : i
}
const keeps = (model: string) => effortCache(model, setup, L.effortCache).mode === 'keeps'
/** Spend against the current budget: a budget-driven handoff renews it for the fresh chat. */
const spentOfBudget = () => L.spent - (L.budgetFrom ?? 0)
const overBudget = () => cfg.budget > 0 && spentOfBudget() >= cfg.budget
const overSoft = () => cfg.budget > 0 && spentOfBudget() >= (cfg.budget * cfg.softPct) / 100
const BUDGET_WHY: HandoffWhy = { kind: 'cost', why: 'task budget spent' }
/** A budget-driven handoff may start: the setting allows it and the guards that stop a loop are clear. */
const budgetHandoff = () => cfg.budgetSpent === 'handoff' && !busy && !L.pending && turnsSince >= cooldown && L.handoffs.length < cfg.maxHandoffs
/** Budget-driven handoffs may start once no agent is running; until then messages wait in `queued`. */
const budgetHandoffNow = () => budgetHandoff() && active.size === 0
const pinned = () => L.pin || cfg.pin
const note = (text: string) => {
  L.decisions = [...L.decisions, { at: Date.now(), text: `${hhmm(Date.now())} ${text}` }].slice(-80)
}
const signal = (text: string) => {
  L.signals = [...L.signals, { at: Date.now(), text }].slice(-20)
  L.chatSignals += 1
  note(`warning signal: ${text}`)
}
const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase()

function newTask() {
  const pin = L.pin
  const observed = L.effortCache
  L = freshLedger(newId(), Date.now())
  L.pin = pin
  L.effortCache = observed // a fact about the connection, not the task
  loops.clear()
  pending = undefined
  chatBase = 0
  turnsSince = 99
  cooldown = 2
  failedCmds.clear()
  reads.clear()
}

function describeRoute(r: RouteLike) {
  const c = effortCache(r.model, setup, L.effortCache)
  return `${pinned() ? `${pinned()} (pinned)` : label(r)} · main model ${cfg.mainModel === 'keep' ? 'kept' : 'routed'} · an effort change ${c.mode === 'keeps' ? 'keeps' : 'rebuilds'} the cache (${c.source}; ${setup.provider})`
}

async function commit($: EngineInterface) {
  const main = loops.get('main')
  const route = pinned() || (main ? label(rungOf(main)) : 'auto')
  const ctx = L.ctx ? ` · ctx ${kt(L.ctx.tokens)}` : ''
  $.ui.status(`⇄ ${route}${ctx} · ≈$${spentOfBudget().toFixed(2)}${cfg.budget > 0 ? `/$${cfg.budget}` : ''} · saved ≈$${savings(L).net.toFixed(2)}`)
  const copy = JSON.parse(JSON.stringify(L)) as Ledger
  await update($, ledgerAtom, () => copy)
}

function addTokens(u: Usage) {
  L.tokens.in += u.input_tokens
  L.tokens.out += u.output_tokens
  L.tokens.read += u.cache_read_input_tokens
  L.tokens.write += u.cache_creation_input_tokens
}

/** The mod's own calls (planner, handoff summary, receiver checks): spend, and overhead against the savings. */
function charge(usage: Usage | undefined, model: string, kind: 'planning' | 'handoff' | 'verification') {
  if (!usage) return
  const c = usd(usage, model, prices)
  addTokens(usage)
  L.spent += c
  L.overhead += c
  L.chatSpent += c
  L.overheadBy[kind] += c
}

function account($: EngineInterface, key: string, r: TurnStepResult, retrying: boolean) {
  const u = r.usage
  if (!u) return
  const loop = loops.get(key)
  const cost = usd(u, u.model, prices)
  addTokens(u)
  // Priced on the model that would have run without the router. The cache a switch rewrote
  // counts as read there, so the estimate never flatters the router.
  const base = loop?.switched
    ? { ...u, cache_read_input_tokens: u.cache_read_input_tokens + u.cache_creation_input_tokens, cache_creation_input_tokens: 0 }
    : u
  L.baseline += usd(base, loop?.baseline ?? u.model, prices)
  const thinking = reasoningOf(u.output_tokens, r.answer + JSON.stringify(r.toolUses))
  L.reasoningTokens += thinking
  L.reasoningUsd += (thinking * priceOf(u.model, prices).out) / 1e6
  L.spent += cost
  L.chatSpent += cost
  const route = label({ model: u.model, effort: loop && !(key === 'main' && pinned()) ? rungOf(loop).effort : undefined })
  L.byRoute[route] = (L.byRoute[route] ?? 0) + cost
  if (retrying) L.overheadBy.retry += cost
  if (key === 'main' && chatBase === 0) chatBase = promptOf(u)
  if (key === 'main' && L.savedTokens > 0) L.handoffSaved += (L.savedTokens * priceOf(u.model, prices).read) / 1e6
  if (loop) {
    loop.switched = false
    loop.tokens = promptOf(u)
    if (loop.first) {
      loop.first = false
      L.overheadBy.agentStartup += usd({ ...u, output_tokens: 0, cache_read_input_tokens: 0 }, u.model, prices)
    }
    if (key !== 'main' && !loop.warned) {
      // Subagents get no handoff (the platform offers none for them): their context is watched and reported.
      const th = thresholdOf(u.model, loop.kind)
      const window = L.ctx && loops.get('main') && sameModel(rungOf(loops.get('main')!).model, u.model, prices) ? L.ctx.window : 0
      const why = contextTrigger({ tokens: loop.tokens, window, limit: 0, th, headroom: 0 })
      if (why) {
        loop.warned = true
        signal(`${loop.name}: ${why}; subagents cannot be handed off, it relies on Claude Code's own compaction`)
      }
    }
  }
  if (!L.warnedSoft && overSoft()) {
    L.warnedSoft = true
    $.ui.toast(`cost-router: ${cfg.softPct}% of the $${cfg.budget} budget is spent (estimate); routes no longer move up a model.`)
  }
}

/** Moves a loop to rung `at` of its ladder for a quality reason. */
function move(loop: Loop, at: number, why: string) {
  const cur = rungOf(loop)
  const to = loop.ladder[at]
  if (!to) return
  const modelUp = !sameModel(to.model, cur.model, prices)
  const cache = modelUp ? 'a new model rebuilds the cache' : keeps(to.model) ? 'the effort change keeps the cache' : 'the effort change rebuilds the cache'
  note(`${loop.name} escalated ${label(cur)} → ${label(to)}: ${why} (quality-driven; ${cache})`)
  loop.rung = at
  loop.fails = 0
  loop.bumps = modelUp ? 0 : loop.bumps + 1
  loop.switched = modelUp || !keeps(to.model)
  loop.changedTurn = mainTurns
  if (loop.name === 'main') L.route = describeRoute(to)
}

/** One quality-driven step up, model and effort together (see `escalation`). Past the soft budget, effort only. False at the top. */
function escalate(loop: Loop, why: string): boolean {
  const at = escalation(loop.ladder, loop.rung, loop.bumps)
  const to = at === undefined ? undefined : loop.ladder[at]
  if (at === undefined || !to) return false
  if (overSoft() && !sameModel(to.model, rungOf(loop).model, prices)) return false
  move(loop, at, why)
  return true
}

/** The ladder with the Fable tier on top, once this task approved it (or the setting is auto and it was needed). */
function withFable(lad: Rung[]): Rung[] {
  const fable = cfg.fableModel
  if (L.fable !== 'yes' || cfg.fable === 'off' || !fable || lad.some(r => sameModel(r.model, fable, prices))) return lad
  const top = (lad.at(-1)?.tier ?? -1) + 1
  return [...lad, ...ladder([fable], cap).map(r => ({ ...r, tier: top }))]
}

/** Where on the Fable tier to land: the docs' default (high) unless the work ran lower. */
const fableRung = (lad: Rung[], from: Rung) =>
  rungFor(lad, lad.at(-1)?.tier ?? 0, from.effort === 'low' || from.effort === 'medium' || from.effort === undefined ? 'medium' : 'high')

/**
 * The strongest configured route is not enough: ask once per task whether to use Fable, or take it when the
 * setting is auto. Never past the soft budget. True when Fable may be used now.
 */
async function offerFable($: EngineInterface, why: string, from: Rung): Promise<boolean> {
  const fable = cfg.fableModel
  if (cfg.fable === 'off' || !fable || sameModel(from.model, fable, prices) || L.fable === 'no') return false
  if (overSoft()) {
    note(`${fable} not offered (${why}): past the soft budget`)
    return false
  }
  if (L.fable === 'yes') return true
  if (cfg.fable === 'auto') {
    L.fable = 'yes'
    note(`${fable} enabled automatically (setting): ${why} on ${label(from)}`)
    return true
  }
  const ratio = priceOf(fable, prices).out / priceOf(from.model, prices).out
  const pick = await $.ui
    .ask(
      `${why} on ${label(from)}, the strongest route configured. Switch this task to ${fable}? It costs about ${ratio.toFixed(1)}x per token and rebuilds the prompt cache once ("Fable" in /config can make this automatic).`,
      ['Use Fable', 'Not now'],
    )
    .catch(() => 'no answer')
  L.fable = pick === 'Use Fable' ? 'yes' : 'no'
  note(`asked about ${fable} (${why}): ${L.fable === 'yes' ? 'approved for this task' : `${pick === 'no answer' ? 'no answer' : 'declined'}; not asked again this task (/router fable on to allow)`}`)
  return L.fable === 'yes'
}

const fromTriage = (text: string, agentType?: string): Route => {
  const t = triage(text, agentType)
  const level = Math.min(t.tier, maxLevel)
  return { rung: rungFor(rungs, level, t.effort), level, reason: t.reason, effort: t.effort, quality: false }
}

async function planTask($: EngineInterface, text: string): Promise<{ plan?: Plan; usd: number }> {
  const model = tiers[0] ?? 'haiku'
  const res = await $.model.complete({
    model,
    effort: 'low',
    maxTokens: 1500,
    timeoutMs: 30_000,
    system: PLANNER_SYSTEM,
    prompt: text.slice(0, 30_000),
  })
  charge(res.usage, model, 'planning')
  return { plan: res.isAnswered ? parsePlan(res.text) : undefined, usd: res.usage ? usd(res.usage, model, prices) : 0 }
}

/** Complexity from the free triage, or the planner for long and multi-step work; uncertainty raises effort. */
async function assess($: EngineInterface, text: string, agentType?: string, canPlan = true) {
  const t = fromTriage(text, agentType)
  const plannable = canPlan && !READ_ONLY_AGENTS.test(agentType ?? '') && (text.length >= cfg.plannerMin || triage(text).multi)
  if (!(cfg.planner && plannable)) return { ...t, plan: undefined, planUsd: 0 }
  const { plan, usd: planUsd } = await planTask($, text)
  if (!plan) {
    const effort = uncertain(t.effort)
    return { ...t, rung: rungFor(rungs, t.level, effort), effort, reason: `${t.reason}; unplanned, effort raised`, plan, planUsd }
  }
  const level = Math.min(plan.tier, maxLevel)
  return { rung: rungFor(rungs, level, plan.effort), level, reason: `planned: ${plan.reason}`, effort: plan.effort, quality: false, plan, planUsd }
}

const adviceFor = (plan: Plan, parent: Rung, planUsd: number) =>
  planAdvice(plan, rungs, parent, {
    overheadTokens: cfg.overheadTokens,
    maxConcurrent: cfg.maxConcurrent,
    maxLevel,
    marginPct: cfg.marginPct,
    minUsd: cfg.minUsd,
    retryPct: cfg.retryPct,
    planUsd,
    prices,
  })

/** The main chat's route for a turn: the session's model kept by default, effort chosen with the cache in mind. */
async function routeMain($: EngineInterface, route: Route) {
  const baseline = engineModel ?? (await $.session.model())
  const prev = loops.get('main')
  const keep = cfg.mainModel !== 'route'
  let lad = withFable(keep ? keptLadder(baseline, tiers, cap, prices) : rungs)
  const current: RouteLike = prev ? rungOf(prev) : { model: baseline, effort: sessionEffort }
  const tokens = prev && prev.tokens === 0 ? 0 : ((await $.session.usage()).context.tokens ?? 0)
  // A kept model meets harder work with more effort: one step per level it sits below what the task needs.
  const t = tierOf(baseline)
  const effort = keep && t !== undefined && route.level > t ? (EFFORT_ORDER[Math.min(3, EFFORT_ORDER.indexOf(route.effort) + route.level - t)] ?? route.effort) : route.effort
  let start = keep ? rungFor(lad, 0, effort) : route.rung
  if (route.floorTier !== undefined) start = Math.max(start, rungFor(lad, route.floorTier, effort))
  let quality = route.quality
  if (route.escalate && prev && JSON.stringify(prev.ladder) === JSON.stringify(lad)) {
    let up = escalation(lad, prev.rung, prev.bumps)
    if (up === undefined && (await offerFable($, 'The person said the last answer failed', rungOf(prev)))) {
      lad = withFable(lad)
      up = fableRung(lad, rungOf(prev))
    }
    if (up !== undefined && up > start) start = up
    quality = true
  }
  const cooling = !quality && prev !== undefined && mainTurns - prev.changedTurn < cfg.cooldownTurns
  const pick = chooseRung(lad, start, current, tokens, route.level, {
    prices,
    keeps,
    marginPct: cfg.marginPct,
    minUsd: cfg.minUsd,
    retryPct: cfg.retryPct,
    cooling,
  })
  const rung = lad[pick.index] ?? lad[0] ?? { tier: 0, model: baseline }
  const changed = !sameRoute(rung, current, prices)
  const effortOnly = changed && sameModel(rung.model, current.model, prices)
  loops.set('main', {
    ladder: lad,
    rung: pick.index,
    depth: 0,
    fails: 0,
    bumps: prev?.bumps ?? 0,
    name: 'main',
    baseline,
    kind: KINDS[route.level] ?? 'standard',
    switched: changed && !(effortOnly && keeps(rung.model)),
    sent: prev?.sent,
    changedTurn: changed ? mainTurns : (prev?.changedTurn ?? -99),
    tokens,
    first: false,
  })
  L.route = describeRoute(rung)
  note(`main → ${pinned() ? `${pinned()} (pinned)` : label(rung)}: ${route.reason}; ${pick.why} (est $${pick.est.toFixed(3)})`)
}

async function reconcile($: EngineInterface) {
  const live = new Set(
    (await $.agent.list()).filter(a => a.status === 'pending' || a.status === 'running' || a.status === 'waiting').map(a => a.id),
  )
  for (const id of active) if (!live.has(id)) active.delete(id)
}

const thresholdOf = (model: string, kind: string) =>
  thresholdFor(cfg.thresholds, model, kind, {
    ...(cfg.handoffPct > 0 ? { pct: cfg.handoffPct } : {}),
    ...(cfg.handoffTokens > 0 ? { tokens: cfg.handoffTokens } : {}),
    source: FALLBACK_SOURCE,
  })

/** The live context against its threshold: tokens as the API reported them, the window, and the auto-compaction point. */
async function measureContext($: EngineInterface): Promise<ContextGate> {
  const u = await $.session.usage({ breakdown: 'summary' }).catch(() => $.session.usage())
  const c = u.context
  const tokens = c.tokens ?? 0
  const b = c.breakdown
  const limit = Math.min(c.window, b?.autoCompactThreshold ?? c.window)
  const main = loops.get('main')
  const model = main ? rungOf(main).model : await $.session.model()
  const th = thresholdOf(model, main?.kind ?? 'standard')
  const describe = [th.pct ? `${th.pct}%` : '', th.tokens ? `${kt(th.tokens)} tokens` : ''].filter(Boolean).join(' or ') || 'off'
  const cats = b?.categories
    .filter(x => x.kind === 'used' && x.tokens > 0)
    .sort((x, y) => y.tokens - x.tokens)
    .slice(0, 5)
    .map(x => `${x.name} ${kt(x.tokens)}`)
    .join(', ')
  L.ctx = {
    tokens,
    window: c.window,
    threshold: `${describe} (${th.key}: ${th.source ?? 'configured'}), reserve ${kt(cfg.headroom)}${limit < c.window ? `, auto-compact at ${kt(limit)}` : ''}`,
    ...(cats ? { categories: `estimated: ${cats}` } : {}),
  }
  L.plan = u.rateLimits.map(r => `${r.kind.replace('_', ' ')} ${r.percentUsed}%`).join(', ') || undefined
  return { tokens, window: c.window, limit, th, headroom: cfg.headroom }
}

async function home($: EngineInterface) {
  const h = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return h?.replace(/\\/g, '/')
}

let calRow: Omit<CalibrationRow, 'outcome'> | undefined

async function calibrate($: EngineInterface, outcome: CalibrationRow['outcome']) {
  const row = calRow
  calRow = undefined
  const h = await home($)
  if (!row || !h) return
  const path = `${h}/.claude/cost-router/calibration.jsonl`
  const old = await $.fs.read(path).catch(() => '')
  const lines = [...old.split('\n').filter(Boolean), JSON.stringify({ ...row, outcome })].slice(-500)
  await $.fs.write(path, `${lines.join('\n')}\n`).catch(() => undefined)
}

async function skip($: EngineInterface, why: string) {
  cooldown = 5
  turnsSince = 0
  note(`handoff skipped: ${why}`)
  $.ui.toast(`cost-router: handoff skipped, ${why}`)
  await calibrate($, 'skipped')
  await commit($)
}

/** What a fresh chat on `model` says is missing from the handoff; undefined when it could not say. */
async function receiverCheck($: EngineInterface, model: string, doc: string): Promise<string[] | undefined> {
  const res = await $.model.complete({
    model,
    effort: 'low',
    maxTokens: 800,
    timeoutMs: 90_000,
    system: RECEIVER_SYSTEM,
    prompt: `${doc}\n\n${RECEIVER_ASK}`,
  })
  charge(res.usage, model, 'verification')
  if (!res.isAnswered) return undefined
  const j = extractJson(res.text) as { nextAction?: unknown; missing?: unknown } | undefined
  if (!j || typeof j.nextAction !== 'string' || j.nextAction.trim() === '') return undefined
  return strings(j.missing, 5)
}

/** Writes the handoff and reads it back: the durable checkpoint everything after it relies on. */
async function save($: EngineInterface, path: string, doc: string): Promise<boolean> {
  try {
    await $.fs.write(path, doc)
    return (await $.fs.read(path)) === doc
  } catch {
    return false
  }
}

async function transcriptOf($: EngineInterface, h: string, id: string) {
  for (const dir of new Set([await $.session.cwd(), await $.session.root()])) {
    const path = `${h}/.claude/projects/${dir.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
    if (await $.fs.exists(path).catch(() => false)) return path
  }
  return undefined
}

async function handoff($: EngineInterface, why: HandoffWhy, forced: boolean) {
  if (busy || L.pending) return
  busy = true
  let cleared = false
  try {
    // A safe checkpoint: between turns, no subagent running (their results report to this chat).
    await reconcile($)
    if (active.size > 0) return await skip($, `${active.size} agents are still running`)
    const usage = await $.session.usage()
    const pct = usage.context.percent ?? 0
    const tokens = usage.context.tokens ?? 0
    const main = loops.get('main')
    const model = main ? rungOf(main).model : await $.session.model()
    const est = handoffEconomics({ tokens, baseTokens: chatBase, docTokens: 3_000, files: L.files.length, steps: cfg.remainingSteps, model, prices })
    if (!forced && why.kind === 'cost' && !pays(est.saved, est.overhead, cfg.marginPct, cfg.minUsd)) {
      return await skip($, `a cost-driven handoff would save ≈$${est.saved.toFixed(3)} against ≈$${est.overhead.toFixed(3)} overhead + ${cfg.marginPct}% margin`)
    }
    if (why !== BUDGET_WHY && cfg.budget > 0 && spentOfBudget() + est.overhead > cfg.budget) return await skip($, `the budget cannot cover its ≈$${est.overhead.toFixed(3)} overhead`)
    $.ui.toast(`cost-router: ${why.kind}-driven handoff to a fresh context (${why.why})`)
    calRow = {
      at: Date.now(),
      model,
      kind: main?.kind ?? 'standard',
      tokens,
      pct,
      threshold: thresholdOf(model, main?.kind ?? 'standard').key,
      reason: why.kind,
      signals: L.chatSignals,
      missing: 0,
      clarified: false,
    }

    // A fork reads this chat through its own prompt cache: the cheapest way to summarize it.
    const fork = await $.model.fork({ prompt: HANDOFF_PROMPT })
    charge('usage' in fork ? fork.usage : undefined, model, 'handoff')
    if (!fork.isAnswered) return await skip($, `the summary failed (${fork.reason})`)
    const h = parseHandoff(fork.text)
    if (!h) return await skip($, 'the summary was not valid JSON')
    const problems = handoffProblems(h)
    if (problems.length) return await skip($, problems.join('; '))

    const id = newId()
    const n = L.handoffs.length + 1
    const from = await $.session.id()
    const dir = await home($)
    const path = dir ? `${dir}/.claude/cost-router/handoffs/${L.taskId}-${n}.md` : undefined
    const ctx = {
      id,
      n,
      from,
      reason: `${why.kind}-driven: ${why.why}`,
      pct,
      tokens,
      date: new Date().toISOString().slice(0, 16).replace('T', ' '),
      instructions: L.instructions,
      actions: L.actions,
      edited: L.files,
      validations: L.validations,
      clarifications: [] as string[],
      ...(path ? { path } : {}),
      ...(dir ? { transcript: await transcriptOf($, dir, from) } : {}),
    }
    let doc = handoffDoc(h, ctx)

    // Before retiring this chat: a fresh context on the model that will continue must name the next action.
    let missing = await receiverCheck($, model, doc)
    if (missing === undefined) return await skip($, 'the receiver check did not answer')
    calRow.missing = missing.length
    if (missing.length > 0) {
      const fix = await $.model.fork({ prompt: clarifyPrompt(missing) })
      charge('usage' in fix ? fix.usage : undefined, model, 'handoff')
      const answers = fix.isAnswered ? strings((extractJson(fix.text) as { answers?: unknown } | undefined)?.answers) : []
      if (answers.length === 0) return await skip($, `the receiver lacks: ${missing.join('; ')}`)
      ctx.clarifications = missing.map((m, i) => `${m}: ${answers[i] ?? '(no answer)'}`)
      calRow.clarified = true
      doc = handoffDoc(h, ctx)
      missing = await receiverCheck($, model, doc)
      if (missing === undefined || missing.length > 0) return await skip($, `the receiver still lacks: ${(missing ?? ['an answer']).join('; ')}`)
    }
    const docTokens = tokensOf(doc)
    // A fresh context that starts nearly as full would only trigger the next handoff: a loop, not a gain.
    if (!forced && (docTokens > tokens * (why.kind === 'cost' ? 0.3 : 0.5) || chatBase + docTokens > tokens * 0.8)) {
      return await skip($, `a fresh context would start at ≈${kt(chatBase + docTokens)} of ${kt(tokens)} tokens: not enough of a reduction`)
    }
    if (!path || !(await save($, path, doc))) return await skip($, 'the handoff could not be saved and read back')

    // Recorded before the chat is retired, so a reload or a second trigger can never run it twice.
    L.pending = { id, from, path, text: continuation(doc, { id, path, queued: [] }), attempts: 1, readOk: false }
    L.handoffs = [...L.handoffs, { at: Date.now(), id, from, kind: why.kind, why: why.why, pct, tokens, docTokens, method: 'clear', path }]
    await commit($)

    // Retire this chat's context: same process, new session id; the old transcript stays resumable.
    expectClear = true
    try {
      await $.command.run({ command: 'clear' })
    } catch (err) {
      expectClear = false
      L.pending = undefined
      L.handoffs = L.handoffs.slice(0, -1)
      return await skip($, `/clear was refused (${errText(err)}); this chat and the checkpoint ${path} are kept`)
    }
    cleared = true
    if (why === BUDGET_WHY) {
      L.budgetFrom = L.spent
      L.warnedSoft = false
      note(`budget renewed: a fresh $${cfg.budget} for the new chat`)
    }
    L.savedTokens = Math.max(0, tokens - docTokens)
    L.chatSpent = 0
    L.chatSignals = 0
    chatBase = 0
    turnsSince = 0
    cooldown = 2
    failedCmds.clear()
    reads.clear()
    // The fresh context has nothing cached; it keeps the model (no downgrade just for being fresh), effort reassessed.
    const left = fromTriage([h.objective, ...h.unresolved, ...h.nextSteps].join('\n'))
    if (main) {
      main.sent = undefined
      main.tokens = 0
    }
    pending = {
      ...left,
      quality: true,
      reason: h.status === 'done' ? 'reassessed at handoff: the work is done' : `reassessed at handoff: ${left.reason}`,
      ...(main ? { floorTier: rungOf(main).tier } : {}),
    }
    note(`handoff ${n} (${why.kind}-driven: ${why.why}): ${pct}% context → fresh context with a ${docTokens}-token handoff saved at ${path}`)
    if (queued.length) L.pending.text = continuation(doc, { id, path, queued })
    queued = []
    await commit($)
    await $.prompt.submit({ text: L.pending.text })
  } catch (err) {
    if (!cleared) await skip($, `it failed: ${errText(err)}`)
    else {
      note(`handoff continuation not submitted: ${errText(err)}`)
      $.ui.toast(`cost-router: the fresh context did not start. Checkpoint: ${L.pending?.path ?? 'none'}; previous chat: claude --resume ${L.pending?.from ?? ''}`)
      await commit($)
    }
  } finally {
    busy = false
    // Messages typed during a handoff that did not happen go through as typed.
    for (const text of queued.splice(0)) void $.prompt.submit({ text })
  }
}

/** The fresh chat's first turn: it must have read the handoff file and named the next action, else one retry, then the person is told. */
async function confirmHandoff($: EngineInterface, reason: string, answer: string) {
  const p = L.pending
  if (!p) return
  const h = L.handoffs.find(x => x.id === p.id)
  const ok = reason === 'answer' && acked(answer, p.id) && p.readOk
  if (ok) {
    if (h) h.confirmed = true
    L.pending = undefined
    note(`handoff ${p.id} confirmed: the fresh context read ${p.path} and named its next action`)
    await calibrate($, 'confirmed')
    return
  }
  const ack = acked(answer, p.id)
  const lacking = [
    reason !== 'answer' ? `the turn ended (${reason})` : '',
    ack ? '' : `no ${ACK} line`,
    p.readOk ? '' : `the handoff file was not read${ack ? '; it has the text inline, but to let it read the file allow Read of ~/.claude/cost-router/**' : ''}`,
  ]
    .filter(Boolean)
    .join(', ')
  // One retry when the handoff may not have landed, never after the person stopped the turn themselves.
  // An ack with an unreadable file is a permission matter: the same call would be refused again.
  if (p.attempts < 2 && reason !== 'aborted' && !ack) {
    p.attempts += 1
    note(`handoff ${p.id} not confirmed (${lacking}); resubmitting once`)
    const text = p.text
    $.clock.after(100, () => void $.prompt.submit({ text }))
    return
  }
  if (h) h.confirmed = false
  L.pending = undefined
  note(`handoff ${p.id} unconfirmed (${lacking}); checkpoint ${p.path}, previous chat claude --resume ${p.from}`)
  $.ui.toast(`cost-router: the fresh context did not confirm the handoff (${lacking}). Checkpoint: ${p.path}; previous chat: claude --resume ${p.from}`)
  await calibrate($, 'unconfirmed')
}

const startHandoff = ($: EngineInterface, why: HandoffWhy, forced: boolean) => {
  $.clock.after(100, () => void handoff($, why, forced))
}

export const register: Register = (on, options) => {
  configure(options)

  on('session.start', async ($, e, next) => {
    // A reload keeps the ledger; a new session starts a new task.
    const stored = await read($, ledgerAtom)
    if (stored.taskId) L = JSON.parse(JSON.stringify(stored)) as Ledger
    setup = await detectSetup($)
    await $.command.register({
      name: 'router',
      description: 'Cost router: spend, savings and routing decisions; or handoff, calibration, fable <on|off|ask>, reset, pin <model|auto>',
      argumentHint: '[handoff | calibration | fable <on|off|ask> | reset | pin <model|auto>]',
    })
    void $.ui.open({ id: PANE, title: 'Cost router' })
    await commit($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      // The person's own /clear starts a new task; the router's handoff carries the task on.
      if (expectClear) expectClear = false
      else newTask()
      await commit($)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    const ours = e.origin?.kind === 'plugin' && e.origin.name === $.plugin.name
    const id = ours ? /^\[cost-router handoff (\w+)\]/.exec(e.text)?.[1] : undefined
    if (id) {
      // A continuation, delivered once: never after its fresh chat confirmed it.
      if (L.handoffs.some(h => h.id === id && h.confirmed)) return { drop: `cost-router: handoff ${id} was already delivered.` }
      return next(e)
    }
    if (busy) {
      // One agent at a time: the person's message waits for the fresh context instead of starting a turn in this one.
      queued.push(e.text)
      return { drop: 'cost-router: a handoff to a fresh context is in progress; this message will be delivered there.' }
    }
    if (overBudget()) {
      if (budgetHandoff()) {
        queued.push(e.text)
        if (active.size === 0) void handoff($, BUDGET_WHY, true)
        return { drop: `cost-router: the $${cfg.budget} budget is spent; handing off to a fresh chat with a new budget${active.size > 0 ? ` once ${active.size} agents have stopped` : ''}. This message will be delivered there.` }
      }
      return {
        drop: `cost-router: this task's budget ($${cfg.budget}, estimated at list prices) is spent ($${L.spent.toFixed(2)}). Raise "Task budget" in /config, or run /router reset to start a new task.`,
      }
    }
    L.instructions = [...L.instructions, e.text.length > 2000 ? `${e.text.slice(0, 2000)} …(cut)` : e.text].slice(-30)
    if (FORGOT.test(e.text)) signal('the user repeated an instruction')
    if (e.turnId !== undefined) {
      // Folded into a running turn: that turn keeps its route.
      await commit($)
      return next(e)
    }
    const a = await assess($, e.text)
    pending = { ...a, escalate: NEGATIVE.test(e.text) }
    const main = loops.get('main')
    const parentModel = main ? rungOf(main).model : await $.session.model()
    const parent: Rung = { tier: tierOf(parentModel) ?? maxLevel, model: parentModel, ...(main && rungOf(main).effort ? { effort: rungOf(main).effort } : {}) }
    const advice = a.plan && adviceFor(a.plan, parent, a.planUsd)
    if (a.plan) note(`plan: ${a.plan.subtasks.length} subtasks, ${advice ? 'delegation advised' : 'kept whole (splitting would not pay for itself)'}`)
    await commit($)
    return next(advice ? { ...e, context: [...(e.context ?? []), advice] } : e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      active.add(e.agentId)
      return next(e)
    }
    mainTurnId = e.turnId
    mainTurns += 1
    const route = pending ?? (e.text ? fromTriage(e.text) : undefined)
    pending = undefined
    if (route) await routeMain($, route)
    else {
      const main = loops.get('main')
      if (main) main.fails = 0
    }
    await commit($)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const key = e.agentId ?? 'main'
    const loop = loops.get(key)
    if (key === 'main') {
      engineModel = e.model
      sessionEffort = isEffort(e.effort) ? e.effort : undefined
    }
    if (loop && loop.fails >= cfg.escalateAfter) {
      const why = `${loop.fails} failure points (failed checks or tool calls)`
      if (!escalate(loop, why) && (await offerFable($, `Checks keep failing (${why})`, rungOf(loop)))) {
        loop.ladder = withFable(loop.ladder)
        move(loop, fableRung(loop.ladder, rungOf(loop)), why)
      }
    }
    if (overBudget() && (key === 'main' ? e.turnId === mainTurnId : cfg.budgetSpent === 'handoff')) {
      if (key === 'main') $.ui.toast(`cost-router: the $${cfg.budget} budget is spent (estimate); stopping this turn${active.size > 0 ? ` and ${active.size} agents` : ''}.`)
      const turnId = e.turnId
      $.clock.after(0, () => void $.turn.abort({ turnId }).catch(() => undefined))
    }
    const pin = key === 'main' ? pinned() : ''
    const rung = loop ? (overBudget() ? loop.ladder[0] : rungOf(loop)) : undefined
    // The kept main model goes out as the engine named it; only an escalated tier names another model.
    const model = rung && !(key === 'main' && cfg.mainModel !== 'route' && rung.tier === 0) ? rung.model : e.model
    const routed = pin ? { ...e, model: pin } : rung ? { ...e, model, ...(rung.effort ? { effort: rung.effort } : {}) } : e
    const sentEffort = isEffort(routed.effort) ? routed.effort : undefined
    const now = await $.clock.now()
    // An effort change on a warm cache: the response's cache counts tell whether this connection kept the cache.
    const effortChanged =
      loop?.sent !== undefined && sameModel(loop.sent.model, routed.model, prices) && loop.sent.effort !== sentEffort && now - loop.sent.at < 5 * 60_000
    const retrying = (loop?.fails ?? 0) > 0
    const result = yield* next(routed)
    if (loop) loop.sent = { model: routed.model, ...(sentEffort ? { effort: sentEffort } : {}), at: now }
    const seen = effortChanged && result.usage ? judgeEffortCache(result.usage) : undefined
    if (seen && result.usage && L.effortCache[modelKey(result.usage.model)] !== seen) {
      L.effortCache = { ...L.effortCache, [modelKey(result.usage.model)]: seen }
      note(`observed: an effort change on ${result.usage.model} ${seen === 'keeps' ? 'kept' : 'rebuilt'} the prompt cache (read ${kt(result.usage.cache_read_input_tokens)}, wrote ${kt(result.usage.cache_creation_input_tokens)})`)
    }
    account($, key, result, retrying)
    await commit($)
    return result
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    const cmd = tool === 'Bash' && typeof input.command === 'string' ? input.command.trim() : undefined
    if (cmd && L.handoffs.length > 0 && L.actions.includes(cmd)) {
      const answer = await $.ui
        .ask(`This exact command already ran before a chat handoff: ${cmd}. Run it again?`, ['Skip it', 'Run again'])
        .catch(() => 'Skip it')
      if (answer !== 'Run again') {
        return { deny: 'cost-router: this exact command already ran before the chat handoff (see "Actions already performed"); skipped so it is not done twice.' }
      }
    }
    const r = await next(e)
    if (r.deny !== undefined) return r
    const loop = loops.get(e.agentId ?? 'main')
    const check = cmd !== undefined && VALIDATION.test(cmd)
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
    if (check) L.validations = [...L.validations.filter(v => !v.endsWith(`\`${cmd}\``)), `${r.isError ? 'FAILED' : 'passed'}: \`${cmd}\``].slice(-10)
    if (r.isError) {
      if (loop) loop.fails += check ? 2 : 1
      if (cmd && e.agentId === undefined) {
        const n = (failedCmds.get(cmd) ?? 0) + 1
        failedCmds.set(cmd, n)
        if (n === 2) signal(`the same command failed twice: ${cmd.slice(0, 80)}`)
      }
    } else {
      if (check && loop) {
        loop.fails = 0
        loop.bumps = 0
      }
      if (cmd && SIDE_EFFECT.test(cmd)) L.actions = [...L.actions.filter(a => a !== cmd), cmd].slice(-50)
      if (path && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
        reads.delete(normPath(path))
        if (!L.files.includes(path)) L.files = [...L.files, path].slice(-60)
      }
      if (path && tool === 'Read') {
        if (L.pending?.path && normPath(path) === normPath(L.pending.path)) L.pending.readOk = true
        if (e.agentId === undefined) {
          const n = (reads.get(normPath(path)) ?? 0) + 1
          reads.set(normPath(path), n)
          if (n === 3) signal(`the same unchanged file was read 3 times: ${path}`)
        }
      }
    }
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    const parent = loops.get(e.parentAgentId ?? 'main')
    const depth = (parent?.depth ?? 0) + 1
    const name = e.description || e.subagentType
    const refuse = async (why: string) => {
      note(`agent "${name}" refused: ${why}`)
      await commit($)
      return { deny: `cost-router: ${why}` }
    }
    if (depth > cfg.maxDepth) return refuse(`the nesting depth limit (${cfg.maxDepth}) is reached; do "${name}" inline instead.`)
    if (active.size >= cfg.maxConcurrent) await reconcile($)
    if (active.size >= cfg.maxConcurrent) return refuse(`${active.size} agents are running (limit ${cfg.maxConcurrent}); wait for one to finish or do this inline.`)
    if (overBudget()) return refuse(`the task budget ($${cfg.budget}) is spent${cfg.budgetSpent === 'handoff' ? '; a handoff to a fresh chat with a new budget follows, start nothing more' : ''}.`)
    if (busy) return refuse('a handoff to a fresh context is in progress; start agents after it.')

    const baseline = e.model ?? e.parentModel
    const base = { depth, fails: 0, bumps: 0, baseline, switched: false, changedTurn: mainTurns, tokens: 0, first: true }
    if (e.fork) {
      // A fork keeps its parent's model, effort and cache.
      const r = await next(e)
      if (r.agentId) {
        loops.set(r.agentId, { ...base, ladder: parent?.ladder ?? rungs, rung: parent?.rung ?? 0, kind: parent?.kind ?? 'standard', name: `fork "${name}"` })
        active.add(r.agentId)
      }
      return r
    }

    const a = await assess($, e.prompt, e.subagentType, depth < cfg.maxDepth)
    let rung = a.rung
    let reason = a.reason
    const asked = e.model ? tierOf(e.model) : undefined
    if (asked !== undefined && asked > (rungs[rung]?.tier ?? 0) && !overSoft()) {
      // Trust the parent's ask for a stronger model, one tier at most.
      rung = rungFor(rungs, Math.min(asked, (rungs[rung]?.tier ?? 0) + 1), a.effort)
      reason += `; parent asked for ${e.model}`
    }
    const chosen = rungs[rung] ?? rungs[0] ?? { tier: 0, model: baseline }
    const advice = a.plan && adviceFor(a.plan, chosen, a.planUsd)
    const budgetLeft = cfg.budget > 0 ? ` About $${Math.max(0, cfg.budget - spentOfBudget()).toFixed(2)} of the shared task budget is left (estimate).` : ''
    const suffix = [
      `\n\n[cost-router] You are a subagent at depth ${depth} of ${cfg.maxDepth}.${budgetLeft} Model and effort routing is automatic.`,
      depth >= cfg.maxDepth ? ' Do not spawn subagents (depth limit).' : ' Spawn a subagent only for a large, independent part, with only the context it needs.',
      advice ? `\n${advice}` : '',
    ].join('')
    // A workflow agent's prompt is its script's own: change only its model there.
    const isWorkflow = (e as { workflow?: unknown }).workflow !== undefined
    const r = await next(isWorkflow ? { ...e, model: chosen.model } : { ...e, model: chosen.model, prompt: e.prompt + suffix })
    if (r.agentId) {
      loops.set(r.agentId, { ...base, ladder: rungs, rung, kind: KINDS[a.level] ?? 'standard', name: `agent "${name}"` })
      active.add(r.agentId)
    }
    note(`agent "${name}" (depth ${depth}) → ${label(chosen)}: ${reason}`)
    await commit($)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) {
      active.delete(e.agentId)
      // The last agent (at any depth) has stopped: a waiting budget handoff may run now.
      if (overBudget() && budgetHandoffNow()) startHandoff($, BUDGET_WHY, true)
      return r
    }
    turnsSince += 1
    if (L.pending && !busy) await confirmHandoff($, e.reason, 'answer' in e ? e.answer : '')
    const gate = await measureContext($)
    await commit($)
    if (overBudget() && budgetHandoff()) {
      if (active.size === 0) startHandoff($, BUDGET_WHY, true)
    } else if (e.reason === 'answer' && cfg.handoff && !busy && !L.pending) {
      const why = handoffReason({
        turnsSince,
        cooldown,
        handoffs: L.handoffs.length,
        maxHandoffs: cfg.maxHandoffs,
        activeAgents: active.size,
        context: contextTrigger(gate),
        signals: L.chatSignals,
        signalsNeeded: cfg.signals,
        share: contextShare(gate),
        chatSpent: L.chatSpent,
        costUsd: cfg.handoffCost,
      })
      if (why) startHandoff($, why, false)
    }
    return r
  })

  // Claude Code's own compaction (auto or /compact) keeps the person's words and the actions taken.
  on('session.compact', ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const main = loops.get('main')
    if (main) main.sent = undefined // the next request has a new prefix: not evidence about effort and the cache
    if (L.instructions.length + L.actions.length === 0) return next(e)
    const keep = [
      'Keep these verbatim in the summary.',
      'User instructions:',
      ...L.instructions.map((x, i) => `${i + 1}. ${x}`),
      ...(L.actions.length ? ['Actions already performed (do not repeat):', ...L.actions.map(a => `- ${a}`)] : []),
    ].join('\n')
    return next({ ...e, instructions: [e.instructions, keep].filter(Boolean).join('\n\n') })
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const [sub = '', arg = ''] = e.args.trim().split(/\s+/)
    if (sub === 'handoff') {
      if (busy || L.pending) return { text: 'A handoff is already running or awaiting confirmation.' }
      if (active.size > 0) return { text: `${active.size} agents are still running; hand off once they finish.` }
      startHandoff($, { kind: 'quality', why: 'requested' }, true)
      return { text: 'Preparing a handoff to a fresh context…' }
    }
    if (sub === 'calibration') {
      const h = await home($)
      const text = h ? await $.fs.read(`${h}/.claude/cost-router/calibration.jsonl`).catch(() => '') : ''
      const rows = text
        .split('\n')
        .filter(Boolean)
        .flatMap(l => {
          try {
            return [JSON.parse(l) as CalibrationRow]
          } catch {
            return []
          }
        })
      return { text: `Handoff calibration (${h}/.claude/cost-router/calibration.jsonl):\n${calibrationSummary(rows)}` }
    }
    if (sub === 'fable') {
      L.fable = arg === 'on' ? 'yes' : arg === 'off' ? 'no' : undefined
      await commit($)
      return {
        text: L.fable === 'yes' ? `${cfg.fableModel} may be used when this task outgrows the configured tiers.` : L.fable === 'no' ? `${cfg.fableModel} is off for this task.` : `This task will ${cfg.fable === 'auto' ? 'use' : cfg.fable === 'ask' ? 'ask about' : 'not use'} ${cfg.fableModel} when it outgrows the tiers (setting: ${cfg.fable}).`,
      }
    }
    if (sub === 'reset') {
      newTask()
      await commit($)
      return { text: `Started task ${L.taskId}: the ledger and budget are reset.` }
    }
    if (sub === 'pin') {
      L.pin = arg && arg !== 'auto' ? arg : undefined
      await commit($)
      return { text: L.pin ? `The main chat is pinned to ${L.pin}; subagents are still routed.` : 'Automatic routing restored.' }
    }
    await $.ui.open({ id: PANE, title: 'Cost router' })
    return { text: report(L, cfg.budget) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const l = await read($, ledgerAtom)
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 16)
    const s = summaryLines(l, cfg.budget)
    return (
      <Box flexDirection="column">
        <Text bold>{s.spend}</Text>
        <Text>{s.route}</Text>
        <Text>{s.context}</Text>
        <Text dimColor>{s.tokens}</Text>
        <Text>{s.saved}</Text>
        <Text dimColor>{s.overhead}</Text>
        <Text dimColor>{s.routes}</Text>
        <Text dimColor>{s.signals}</Text>
        <Box flexDirection="row">
          <Button
            key="handoff"
            label="Hand off now"
            onPress={() => {
              if (!busy && !L.pending && active.size === 0) startHandoff($, { kind: 'quality', why: 'requested' }, true)
            }}
          />
          <Button
            key="reset"
            label="New task"
            onPress={async () => {
              newTask()
              await commit($)
            }}
          />
        </Box>
        <Text bold>Decisions</Text>
        {l.decisions.length === 0 && <Text dimColor>No routing decisions yet.</Text>}
        {l.decisions
          .slice(-room)
          .reverse()
          .map(d => (
            <Text dimColor>{d.text}</Text>
          ))}
      </Box>
    )
  })
}
