# cost-router

A Claude Code mod that keeps the total usage of a task down without letting quality drop, and hands long tasks to a fresh context before an overfull one hurts.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install cost-router --marketplace MoaBelhadj/claude-cost-router-mod
```

Answer `y` to add the marketplace, then pick a scope (user scope is first; Enter takes it).

From a shell:

```
claude plugin install cost-router --marketplace MoaBelhadj/claude-cost-router-mod
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `MoaBelhadj/claude-cost-router-mod`, then Add plugin.

## What it does

- **Cache-aware routing.** The main chat keeps the session's model by default (`mainModel: keep`); effort is chosen per turn, at turn boundaries. An effort change counts as free where Claude Code keeps the cache across effort changes (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1 on an API key or subscription) and as a full cache rewrite everywhere else (Bedrock, Vertex, gateways, other models, experimental betas off). It then *observes*: the first response after an effort change shows whether the cache was kept, and that overrides the docs for the rest of the task.
- **Cost-driven changes must pay.** A cheaper route, a delegation to a subagent, or a cost-driven handoff goes ahead only when its estimated saving beats its overhead (cache rebuild, planning, agent startup, the parent's verification, likely retries, the handoff itself) by `switchMarginPct` and `minSwitchUsd`, and never inside `switchCooldownTurns` of the last change. Moving up because the task needs it is never held back.
- **Escalation, model and effort together.** Failure points (a failed check counts 2, another failed tool call 1; a passing check resets) raise effort once; if that does not fix it, the next model at the same effort, not back at its lowest rung. "That's wrong / try again" starts the next turn one step up.
- **Fable for tasks too hard for the tiers.** When the strongest configured route still fails, `fable: ask` (default) asks once per task whether to switch to `fableModel` (shows the price ratio); `auto` switches without asking; `off` never. Never past the soft budget. `/router fable on|off|ask` changes it for the current task.
- **Nested agents.** Every spawn at any depth is triaged, routed across `tiers`, given only a self-contained prompt plus its depth and the budget left, and held to `maxDepth`, `maxConcurrentAgents` and the one shared task budget. A fork keeps its parent's route and cache.
- **Context management.** Context tokens are the API-reported input of the last response (system prompt, tools, messages and tool results together), with a local per-category estimate and Claude Code's auto-compaction point. Thresholds per model and task type, in tokens and/or percent (`thresholdsJson`), fall back to `handoffContextTokens` / `handoffContextPct`. **60% is an unvalidated fallback, not a measured degradation point** (see [RESEARCH.md](RESEARCH.md)). A reserve (`headroomTokens`) is kept below the limit for the next operation and a whole handoff. Repeated failing commands, rereads of unchanged files and repeated instructions are warning signals, not proof.
- **Automatic handoff.** Between turns, with no subagent running, past a threshold:
  1. a fork summarizes the chat from its prompt cache (objective, acceptance criteria, constraints and permission boundaries, decisions and reasons, completed work, files, validation results, failed approaches, unresolved issues, pending operations, next steps); the mod adds the person's instructions verbatim, the side-effecting commands already run, edited files, validation results and links to the saved handoff and the previous transcript;
  2. a fresh-context check on the model that will continue must name the next action with nothing missing (one clarification round);
  3. the handoff is saved under `~/.claude/cost-router/handoffs/` and read back;
  4. `/clear`, then the continuation is submitted automatically, with any message typed meanwhile;
  5. the fresh context must read the saved file and start with `HANDOFF-ACK <id>: <next action>`; one automatic retry, then you are told where the checkpoint and the old transcript are.
- **Quality vs cost handoffs.** Context thresholds, the reserve and warning signals are quality-driven: allowed even if they cost more, within the budget. A chat-spend threshold (`handoffCostUsd`) is cost-driven and runs only when its estimated saving beats its overhead by the margin. A fresh context keeps the model (no downgrade for being fresh); effort is reassessed for what is left.
- **Transparency.** The **Cost router** pane, the status line and `/router` show the route and why, context tokens against the threshold and its source, reported token counts (input, output, cache read, cache write), estimated spend, the plan meter when the API reports one, overhead by kind (planning, handoff, verification; agent startup and retries inside spend), estimated net saving, the decision log and the assumptions.

## Use

- `/router`: report and pane
- `/router handoff`: hand off now
- `/router calibration`: handoffs so far, by model and task type
- `/router fable on|off|ask`: Fable for this task
- `/router pin <model|auto>`: pin the main chat's model (subagents are still routed)
- `/router reset`: start a new task (your own `/clear` does the same)
- Settings: `/config` → cost-router. The ones you will most likely adjust: `budgetUsd`, `budgetSpent` (handoff to a fresh chat with a new budget, or stop), `mainModel`, `fable`, `switchMarginPct`, `minSwitchUsd`, `switchCooldownTurns`, `retryRiskPct`, `handoffContextPct`, `handoffContextTokens`, `thresholdsJson`, `headroomTokens`, `signalsForHandoff`, `handoffCostUsd`, `maxHandoffs`.
- To let the fresh context read the saved handoff without a permission prompt, allow `Read` of `~/.claude/cost-router/**` (or add that folder with `/add-dir`).

## Limits of the platform

- **A handoff is a fresh context in the same chat, not a new chat.** The mod API cannot open a new chat or session. It uses `/clear` in the same process: a new session id and an empty context in the same window. The previous transcript stays on disk (`claude --resume <id>`, named in the handoff). The permission mode and saved allow rules carry over; one-time approvals do not.
- **Pre-retirement verification is a simulation.** Before `/clear`, the receiver check runs the handoff in a fresh context on the continuing model, with no tools; the real fresh context's read and ack are checked after, with one retry. If `/clear` is refused or anything fails before it, the chat is left as it was and the checkpoint is kept; there is no compaction fallback.
- **Subagents get no handoff.** The platform offers no way for a mod to clear or replace a subagent's context. Their context is tracked and a warning is logged past their threshold; Claude Code's own compaction applies.
- **Effort changes mid-turn.** Escalation inside a turn sets the new effort on the next request; with per-message effort the API applies it from the next user turn with new input, so a mid-turn effort escalation may only take hold next turn. The mod keeps effort stable within a turn otherwise.
- **Dollars are estimates.** List prices from a fixed table (2026-10), applied to the token counts the API reports for the requests this mod sees. Not a measure of Claude subscription allowance; a subscription's 1-hour cache writes are priced at the 5-minute rate. Requests outside the mod's view (titles, Claude Code's own compaction, other plugins) are not counted, so `/cost` can differ.
- **Savings are estimates** against the model that would have run without the router, with heuristic traffic shapes and a heuristic retry risk.
- **Context thresholds are not validated** for these models; see [RESEARCH.md](RESEARCH.md) and calibrate with `/router calibration`.
- **`CLAUDE_CODE_SUBAGENT_MODEL`** outranks the router's subagent choice. **Bedrock, Vertex and gateways** use other model ids: set `tiers` and `fableModel`.
- **What stays manual:** turning mods on (the engine asks once), permission prompts in the fresh context, raising the budget, approving Fable in `ask` mode.
