# Evidence behind cost-router's defaults

Checked 2026-10-28 against Claude Code 2.1.309 (Windows, Claude subscription). What each source says, what it covers, and what it does not.

## Effort and the prompt cache

| Source | Date read | Says | Covers |
| --- | --- | --- | --- |
| [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) (API docs) | 2026-10-28 | A per-message effort change (beta `mid-conversation-output-config-2026-07-01`) keeps the cache on Fable 5.1, Mythos 5.1, Opus 5.5, Opus 5, Sonnet 5.5, Haiku 5.5 (Claude API, Google-managed); on Bedrock only Fable 5.1, Mythos 5.1, Opus 5.5. A top-level change restarts the cache. A per-message change placed after a tool-result turn waits for the next user turn with new input. Sonnet 5.5 with `between_tools` and Haiku 5.5 with thinking disabled cannot change effort mid-conversation. Defaults: medium on Opus 5.5 and Haiku 5.5, high elsewhere. | The raw API |
| [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching) | 2026-10-28 | In Claude Code, changing effort keeps the cache on Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1 with an API key or a Claude subscription (Fable 5.1 from v2.1.260); not on Bedrock, Google Cloud's Agent Platform, a Claude apps gateway, with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, or for HIPAA organizations. Every model has its own cache; a model switch re-reads everything. Subagents start their own cache; forks read the parent's. | Claude Code itself |
| [Model configuration](https://code.claude.com/docs/en/model-config) | 2026-10-28 | Claude Code's default effort is medium on Opus 5.5, Sonnet 5.5 and Haiku 5.5. Auto-compaction runs at the model's limit unless a window is set (`/autocompact`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`). | Claude Code itself |

**Differences resolved.** The API page lists Opus 5 and the Google-managed endpoint as cache-preserving; the Claude Code page does not. The mod follows the Claude Code page (it is the client that builds the request), and the observation below corrects it either way. The installed version (2.1.309) is past the 2.1.260 Fable 5.1 change, so the docs apply as written.

**What the mod does with it.** It treats an effort change as free where the Claude Code docs say the cache is kept and as a full cache write elsewhere, and then measures: the first response after an effort change on a warm cache (prompt ≥ 8k tokens, within 5 minutes) is judged by its cache counts (≥ 50% read = kept, ≥ 50% written = rebuilt), and that observation overrides the docs for the rest of the task. A HIPAA configuration cannot be detected from a mod; the observation is how it shows up. How Claude Code transmits a plugin's per-request effort rewrite (per-message or top-level) is not documented; the observation answers that too, for turn-boundary changes. Mid-turn changes may only take effect from the next user turn, per the API page.

## Context degradation

| Source | Date | Models | Workload | Finding | Limits |
| --- | --- | --- | --- | --- | --- |
| [Effective context engineering for AI agents](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents) (Anthropic) | 2025-09-29 | All models, none measured there | Agent design guidance | Recall declines as context grows ("context rot"), as a gradient, not a cliff; context is an attention budget. Recommends compaction, structured notes, sub-agents with clean contexts, tool-result clearing. | No threshold, no numbers for any model |
| [Context Rot](https://www.trychroma.com/research/context-rot) (Chroma: Hong, Troynikov, Huber) | 2025-07-14 | 18 models; Claude Opus 4, Sonnet 4, Sonnet 3.7, Sonnet 3.5, Haiku 3.5 | Extended needle-in-a-haystack, LongMemEval (300 vs ~113k tokens), repeated words | Performance falls with input length even on simple tasks, unevenly by model and task; distractors and low question-needle similarity make it worse. No universal threshold. | Simple synthetic tasks; models two generations older than the ones routed here |
| [Claude Opus 5.5 System Card](https://www-cdn.anthropic.com/fc1b44717c85dc068bc6ba5024219938094694bd/Claude%20Opus%205.5%20System%20Card.pdf) (Anthropic) | 2026-09-22 | Opus 5.5 | §8.10 "Long context" | **Not read**: the PDF exceeded the fetch limit. Secondary sources say it reports long-context recall qualitatively. | Unverified here |
| [Explore the context window](https://code.claude.com/docs/en/context-window) | read 2026-10-28 | Claude Code | — | What survives compaction (5 most recent files, skills, CLAUDE.md); 1M windows on Fable, Sonnet 5+, Haiku 5.5, Opus 4.6+. | Mechanics, not quality |

**Conclusion used by the mod.** No primary source found gives a percentage, or a token count, at which Opus 5.5, Sonnet 5.5, Haiku 5.5 or Fable 5.1 degrade on agentic coding. The 60% default is kept as an explicitly **unvalidated fallback**, labelled so in the pane, the report and the settings. Per-model and per-task thresholds (`thresholdsJson`) accept a `source` so a measured value says where it came from.

**Warning signals** (the same command failing twice, an unchanged file read three times, the user repeating an instruction) are logged as signals, never as proof; three of them at 75% of the threshold bring a handoff forward.

## Calibrating

Every handoff appends a row to `~/.claude/cost-router/calibration.jsonl`: model, task type, tokens and percent at handoff, threshold key, reason (quality or cost), warning signals, items the receiver check said were missing, whether a clarification round was needed, and whether the fresh context confirmed (read the file, named the next action). `/router calibration` summarizes it by model and task type. To calibrate a threshold: run representative tasks of one type on one model, compare outcomes (rework, repeated failures, the missing-items count) across handoffs at different context sizes, and set `thresholdsJson` with the evidence named in `source`. This is data collection; the mod does not tune thresholds by itself.

## Usage and billing

[Models, usage, and limits in Claude Code](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code) (read 2026-10-28) treats plan usage and API billing as separate meters and gives no conversion. The mod therefore labels every dollar figure as an estimate at API list prices and shows the API-reported rate-limit windows (five-hour, seven-day) as the plan meter when present. Prices are a fixed table; the 1-hour cache writes a subscription's main conversation uses (2x input, vs 1.25x for 5-minute writes) are priced at the 5-minute rate, which understates cache-write cost there.
