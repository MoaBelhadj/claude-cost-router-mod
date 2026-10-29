export type Decision = { at: number; text: string }

export type HandoffRecord = {
  at: number
  id: string
  /** The retired chat's session id: `claude --resume <from>` reopens it. */
  from: string
  kind: 'quality' | 'cost'
  why: string
  pct: number
  tokens: number
  docTokens: number
  method: 'clear'
  path?: string
  /** The fresh chat read the handoff file and named the next action. */
  confirmed?: boolean
}

/** A handoff whose fresh chat has not confirmed yet: kept so a reload, a retry or a duplicate never runs it twice. */
export type PendingHandoff = {
  id: string
  from: string
  path?: string
  text: string
  attempts: number
  readOk: boolean
}

export type Ledger = {
  taskId: string
  startedAt: number
  /** Everything priced so far at list prices, USD: model turns, subagents, planner, handoff and check calls. */
  spent: number
  /** What the same model turns would have cost on the models that ran without the router. */
  baseline: number
  /** The mod's own extra calls: planner, handoff summary, receiver checks. */
  overhead: number
  /** Estimated re-reads avoided by handoffs. */
  handoffSaved: number
  chatSpent: number
  /** Context tokens the last handoff removed from every later main-chat request. */
  savedTokens: number
  /** Output tokens spent thinking (output minus what was visibly written) and their cost. */
  reasoningTokens: number
  reasoningUsd: number
  /** Token counts as the API reported them, every request the mod saw. */
  tokens: { in: number; out: number; read: number; write: number }
  /** USD by kind: extra calls (planning, handoff, verification) and attributions inside spend (agentStartup, retry). */
  overheadBy: { planning: number; handoff: number; verification: number; agentStartup: number; retry: number }
  /** USD by `model · effort`. */
  byRoute: Record<string, number>
  decisions: Decision[]
  /** Warning signals of context trouble: never proof on their own. */
  signals: Decision[]
  chatSignals: number
  /** The person's prompts this task, verbatim (capped): carried through every handoff. */
  instructions: string[]
  /** Side-effecting commands that ran: never repeated silently after a handoff. */
  actions: string[]
  /** Files edited this task. */
  files: string[]
  /** Validation commands and their latest result. */
  validations: string[]
  handoffs: HandoffRecord[]
  pending?: PendingHandoff
  /** Whether an effort change kept the prompt cache, as observed, by model. */
  effortCache: Record<string, 'keeps' | 'invalidates'>
  /** For display: the main route and why, the live context, the plan meter. */
  route?: string
  ctx?: { tokens: number; window: number; threshold: string; categories?: string }
  plan?: string
  pin?: string
  /** Whether this task may use the Fable tier once it outgrows the configured ones: approved, declined, or not yet asked. */
  fable?: 'yes' | 'no'
  warnedSoft?: boolean
  /** Spend at the last budget-driven handoff: the budget counts from here. */
  budgetFrom?: number
}

declare module 'claude-code' {
  interface PluginState {
    'cost-router': { ledger: Shaped<Ledger> }
  }
}
