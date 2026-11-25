# Harness Adapter Layer (`zee` v4)

`zee` core files stay 100% harness-agnostic. The active session detects its host once at startup and translates abstract ops through this adapter.

## 1. Host Detection & 4-Tier Subagent Ladder

Select the highest available tier in the active harness (never switch hosts or shell out to another CLI behind the user's back):

| Tier | Active Harness | Detection Signal | `PROBE` | `SPAWN` | `ISOLATE` | `ASK` | `SCHEDULE` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **T1** | **T3 Code** (any active provider) | `delegate_task` + `orchestrator_capabilities` available | `orchestrator_capabilities` (1x/thread) | `delegate_task(mode:"async", target, role, isolation)` | `isolation:"worktree"` | `ask_question` or numbered text | `schedule_task` |
| **T2** | **Pi** (`zee` Package v4) | `zee_subagent` (built-in v2) or `subagent_spawn` available (no `delegate_task`) | `pi --list-models` + `zee-tool.mjs validate --check-live` | `zee_subagent({ task, role, provider, model, thinkingLevel, worktree, authorFamily, tools })` (parallel calls) | Declarative `worktree` param on `zee_subagent` (atomic `~/.local/state/zee/runs/.../worktrees/<lane>`, zero race) | `ask_user_question` or numbered text | manual |
| **T2-AGY** | **Google Antigravity** (`zee` Plugin v4 / `agy`) | `invoke_subagent` available (no `delegate_task`); see `references/antigravity.md` | `zee-tool.mjs resolve-model --harness agy` + native tiers (`pro`/`flash`/`flash_lite`/`inherit`) | `invoke_subagent(TypeName:"zee-scout"\|"zee-architect"\|"zee-ui"\|"zee-coder"\|"zee-verifier"\|"zee-reviewer", Model, Workspace)` (or `run_workflow` for wide `sweep`) | `Workspace:"share"` (worktree) or `"branch"` | `ask_question` | `schedule(TimerCondition:"never")` |
| **T3** | **Cursor / OpenCode / Claude / Codex** (standalone) | `Task` / `task` / `Agent` / `spawn_agent` (no `delegate_task`) | Host model catalog / tiers | Native subagent tool (`Task` / `task` / `Agent` / `spawn_agent`) | Native worktree/branch or `zee-tool.mjs worktree-create` | Host ask tool or numbered text | `/loop` / manual |
| **T4** | **Single-Thread Fallback** (bare Pi / no subagent tool) | No subagent tool available | Active model only | Sequential role switching in current thread | Dedicated branch `zee/<slug>` | numbered text | manual |

### Visual Check (`VISUAL_CHECK`)
- Default (background/silent): headless Playwright CLI or `agent_browser` on an isolated free port, saving PNGs to `<busDir>/screenshots/`.
- Interactive browser preview (`preview_*` in T3 Code): **strictly only when the user's request asks for browser/preview work**; pass `reuseExistingTab: false` and close your tab before replying.

## 2. Universal Model Resolution & Capability Clamping

Read `~/.agents/zee-config.json` (plus optional `.agents/zee.local.json` override) and resolve each slot in order:

1. **Extract True Model Family** (never use proxy `providerInstanceId` like `pi` / `vm` / `devin` as family):
   - Use explicit `family` in config; otherwise parse model tail: `claude`/`fable`/`sonnet`/`opus`/`haiku` -> `claude`, `gpt`/`o1`/`o3`/`o4`/`codex` -> `openai`, `gemini` -> `gemini`, `swe-` -> `devin`, `deepseek` -> `deepseek`, `grok` -> `grok`.
2. **Resolve Target for Active Harness**:
   - **T3 Code**:
     - Filter `PROBE` providers to `canRunChildTask === true`.
     - Prefer `bindings.t3` if its provider & model are live; else match `prefer.modelHint` (or `prefer.family` + `prefer.tier`) across live providers; else try user-authorized `backup` (**always announce backup usage explicitly**).
     - **Option Key & Capability Clamping**: read the matched model's live `options[]` (`thought_level` on Antigravity, `thinking` on Pi, `effort` on Claude). Adjust `prefer.effort` by global `budget` (`eco`: -1 step, `balanced`: 0, `max`: +1 step; **cap routine effort at `xhigh`**), then clamp to the highest legal value in `options[].values` at or below target.
     - **Always pass explicit `providerInstanceId`, `model`, AND `options`** on every `delegate_task` to prevent inheriting parent `thinking: max`.
     - **Fail-Closed Rule**: if neither `prefer` nor authorized `backup` is live, STOP and tell the user. Never switch silently to unapproved models or fall back to native subagents/CLIs.
   - **Pi (`zee_subagent` v2.2)**:
     - Match `prefer.modelHint` / `backup.modelHint` against Pi's configured models (`~/.pi/agent/models.json` and check `~/.pi/agent/settings.json` `enabledModels` via `zee-tool.mjs validate --check-live` to catch `CONFIG_DRIFT` on both `prefer` and `backup`). Pass explicit `provider` (the first column of `pi --list-models` / `bindings.pi.*.providerInstanceId`, e.g. `magpie` — never a path prefix like `remote-magpie` or `vm`), `model`, and `thinkingLevel` (`zee_subagent` also auto-normalizes mismatched prefixes via `zee-config.json` before spawning).
     - **Hard Least-Privilege Role Tools** (enforced automatically inside `zee_subagent` even if omitted or over-requested):
       - `Judge`: `["read","grep","find","ls"]`
       - `Scout`: `["read","grep","find","ls","bash"]` (hard-strips `edit` and `write`; `/tmp/zee-*` sandbox probes & package installs allowed while repo stays 100% read-only)
       - `Architect`: `["read","grep","find","ls"]` (hard-strips `edit` and `bash`; emits `plan.md` in output for Orchestrator to write)
       - `Verifier` & `Reviewer`: `["read","grep","find","ls","bash","write"]` (**hard-strips `edit`!** Write logs/reports ONLY to `<busDir>` or `/tmp/zee-*`; run any mutation/break tests ONLY inside a self-cleaning `/tmp/zee-*` `git archive` directory. Post-run precision dirty-tree audit reverts unauthorized repo edits and flags `[ROLE_VIOLATION]`).
       - `Coder` & `UI`: full coding tools (`["read","grep","find","ls","edit","write","bash"]`) inside their isolated `worktree`.
     - **Atomic Worktree & Cross-Family Guard**: pass `worktree: { repoRoot, slug, lane, baseRef, branch?, autoCleanup? }` so `zee_subagent` creates the worktree BEFORE spawning (zero 0ms race, never pollutes Desktop, auto-flattens nested Git branch ref collisions, pre-mounts read-only `node_modules` via `.git/info/exclude`, and auto-cleans clean detached verify/review worktrees). Pass `authorFamily` whenever `role: "reviewer"` to hard-block same-family self-review.
     - **Resilience & 70% Cutoff Built-In**: `zee_subagent` v2.2 provides role-tiered default timeouts (`scout 240s`, `verifier 300s`, `reviewer 480s`, `architect/coder/ui 600s`), dual-mode idle watchdog, 4-strike `StagnancyTracker`, auto-persists `>2KB` `[STATUS: *_PARTIAL]` streaming salvage to `<busDir>/artifacts/partial-<role>-*.md`, and auto-updates `state.json` `delegatesDispatched` + emits `[ZEE_BUDGET_CUTOFF]` at 70%.
   - **Cursor**: emit `<modelHint>-<effort>` (omit unsupported `-xhigh` on models that cap at `high`).
   - **Claude Code (standalone)**: pass Claude `modelHint` + `effort` directly; if slot prefers an external family, announce single-vendor degradation once and map by `tier` (`pro`->opus, `standard`->sonnet, `fast`->haiku) while preserving fresh-context separation.
   - **Google Antigravity (`agy` standalone)**: load `references/antigravity.md`; use `zee-tool.mjs resolve-model --harness agy`, prefer bundled `TypeName: "zee-*"` subagents (with OneHarness `tools:` allowlists and `inheritCustomizations: false`) with `Workspace: "share"`, and fall back to `Model: "inherit"` immediately on HTTP 429 `RESOURCE_EXHAUSTED`.
   - **Single-Thread Fallback**: announce sequential mode once; enforce strict bus artifact handoffs between phases so context stays clean.

## 3. Concurrency & Wakeup Discipline
- On **T3 Code**: dispatch parallel delegates with `mode: "async"`, yield the turn with zero tool calls, wait for system completion wakeups, and cancel unneeded runs with `task_cancel`. Never poll `task_status` before wakeup and never use `t3_thread_send` for re-reviews.
- On **Antigravity (standalone)**: follow the full Reactive Watchdog protocol in `references/antigravity.md` (`{PARENT_CONVERSATION_ID}` + `send_message` + `schedule(TimerCondition:"never")` + ZERO tool calls yield + `manage_task(kill)` on quorum).
- On **other harnesses**: follow host async background/wait semantics without busy-wait `sleep` loops.
