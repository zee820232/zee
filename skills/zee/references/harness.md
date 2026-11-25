# Harness Adapter Layer (`zee` v4.2)

`zee` core files stay 100% harness-agnostic. The active session detects its host once at startup and translates abstract ops through this adapter.

## 1. Host Detection & 4-Tier Subagent Ladder

Select the highest available tier in the active harness (never switch hosts or shell out to another CLI behind the user's back):

| Tier | Active Harness | Detection Signal | `PROBE` | `SPAWN` | `ISOLATE` | `ASK` | `SCHEDULE` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **T1** | **T3 Code** (any active provider) | `delegate_task` + `orchestrator_capabilities` available | `orchestrator_capabilities` (1x/thread) | `delegate_task(mode:"async", target, role, isolation)` | `isolation:"worktree"` | `ask_question` or numbered text | `schedule_task` |
| **T2** | **Pi** (`zee` Package v4.2 / Pi v1.6.1) | `zee_subagent` (built-in v2.3) available (no `delegate_task`) | `pi --list-models` + `zee-tool.mjs validate --check-live` | `zee_subagent({ task, role, provider, model, thinkingLevel, worktree, authorFamily, tools })` (parallel calls) | Declarative `worktree` param on `zee_subagent` (atomic `~/.local/state/zee/runs/.../worktrees/<lane>`, zero race) | `ask_user_question` or numbered text | manual |
| **T2-AGY** | **Google Antigravity** (`zee` Plugin v4.2 / `agy`) | `invoke_subagent` available (no `delegate_task`); see `references/antigravity.md` | `zee-tool.mjs resolve-model --harness agy [--allow-standalone]` + native tiers | `invoke_subagent(TypeName:"zee-scout"\|"zee-architect"\|"zee-ui"\|"zee-coder"\|"zee-verifier"\|"zee-reviewer", Model, Workspace)` (or `run_workflow` for wide `sweep`) | `Workspace:"share"` (worktree) or `"branch"` | `ask_question` | `schedule(TimerCondition:"never")` / `CronExpression` |
| **T3** | **Cursor / OpenCode / Claude / Codex** (standalone) | `Task` / `task` / `Agent` / `spawn_agent` (no `delegate_task`) | Host model catalog / tiers | Native subagent tool (`Task` / `task` / `Agent` / `spawn_agent`) | Native worktree/branch or `zee-tool.mjs worktree-create` | Host ask tool or numbered text | `/loop` / manual |
| **T4** | **Single-Thread Fallback** (bare Pi / no subagent tool) | No subagent tool available | Active model only | Sequential role switching in current thread | Dedicated branch `zee/<slug>` | numbered text | manual |

### Visual Check (`VISUAL_CHECK`)
- Default (background/silent): headless Playwright CLI or `verify-ctl` on an isolated free port, saving PNGs to `<busDir>/screenshots/` and temp reports/traces to `/tmp/zee-verify-*` (never repo scratch).
- Interactive browser preview (`preview_*` in T3 Code): **strictly only when the user's request asks for browser/preview work**; pass `reuseExistingTab: false` and close your tab before finishing.

## 2. Universal Model Resolution & Zero-Config Standalone

Read `~/.agents/zee-config.json` (plus optional `.agents/zee.local.json` override). If absent on standalone / read-only flows, invoke `zee-tool.mjs resolve-model --allow-standalone` (returns `standalone: true` cleanly with exit 0 and degrades to the current session model with one brief Chinese notice instead of blocking). When configured, resolve each slot in order:

1. **Extract True Model Family** (never use proxy `providerInstanceId` like `pi` / `vm` / `devin` as family):
   - Use explicit `family` in config; otherwise parse model tail (`claude`/`sonnet`/`opus`/`haiku` -> `claude`, `gpt`/`o1`/`o3`/`o4`/`codex` -> `openai`, `gemini` -> `gemini`, `swe-` -> `devin`, `deepseek` -> `deepseek`, `grok` -> `grok`, `qwen` -> `qwen`).
2. **Resolve Target for Active Harness**:
   - **T3 Code**:
     - Filter `PROBE` providers to `canRunChildTask === true`, match `bindings.t3` / `prefer` / authorized `backup`, clamp `effort` against live `options[].values` (`xhigh` routine cap), and always pass explicit `providerInstanceId`, `model`, and `options`. Fail closed if neither `prefer` nor authorized `backup` is live.
   - **Pi (`zee_subagent` v2.3 & Pi v1.6.1 Dual-Axis FSM + Zero-Conflict HUD/Hub)**:
     - Match `prefer.modelHint` / `backup.modelHint` against Pi's `~/.pi/agent/models.json` + `~/.pi/agent/settings.json` (`enabledModels` drift checked via `validate --check-live`). Pass explicit `provider`, `model`, and `thinkingLevel` (`zee_subagent` auto-normalizes mismatched prefixes via `zee-config.json`).
     - **Hard Least-Privilege Role Tools** (enforced automatically inside `zee_subagent` via `guard-core.mjs`):
       - `Judge`: `["read","grep","find","ls"]`
       - `Scout`: `["read","grep","find","ls","bash"]` (hard-strips `edit` and `write`; `/tmp/zee-*` probes allowed while repo stays read-only)
       - `Architect`: `["read","grep","find","ls"]` (hard-strips `edit` and `bash`; emits `plan.md` in output for Orchestrator to write)
       - `Verifier` & `Reviewer`: `["read","grep","find","ls","bash","write"]` (**hard-strips `edit`!** Write logs/reports ONLY to `<busDir>` or `/tmp/zee-*`; run mutation/break tests ONLY inside `zee-tool.mjs sandbox-export` under `/tmp/zee-*`. Post-run precision dirty-tree audit reverts unauthorized repo edits and flags `[ROLE_VIOLATION]`).
       - `Coder` & `UI`: full coding tools (`["read","grep","find","ls","edit","write","bash"]`) inside their isolated `worktree`.
     - **Dual-Axis FSM (`pi-extension/fsm.ts`)**:
       - Tracks **14 Workflow Phases** (`IDLE`, `PREFLIGHT`, `SCOUTING`, `PLANNING`, `INIT_DESIGN`, `AWAITING_APPROVAL`, `EXECUTING`, `VERIFYING`, `REVIEWING`, `MERGING`, `CUTOFF_CLOSING`, `COMPLETED`, `PAUSED`, `BLOCKED`) × **9 Worker Lane Phases** (`QUEUED`, `PREPARING_WT`, `RUNNING`, `STALLED_WARN`, `COMPLETED`, `PARTIAL_SALVAGED`, `ROLE_VIOLATION`, `FAILED`, `ABORTED`).
       - Enforces **G-01..G-06** invariants: write/bash block violation tracking (`G-01`), Gate 1 `Verifier` `PASS` before Gate 2 `Reviewer` on matching `pinnedSha` (`G-02`, respecting `T2`/`T3` non-risk sampling when allowed), same-family reviewer violation logging (`G-03`), `CUTOFF_CLOSING` new feature-slice blocking (`G-04`), monotonic `riskLevel` upgrade-only rule (`G-05`), and 30-item ring buffers persisted in `"zee-fsm"` branch entries with backward-compatible fallback to legacy `"zee-mode"` / `"zee-gate"`.
       - `bus-sync.ts` hydrates `<busDir>/state.json` + `decisions.tsv` on `tool_result` without polling, detects `/tree` rollback drift via `busAheadOfBranch`, and never overwrites newer disk `state.json`.
     - **Zero-Conflict Layer 0 / 1 / 2 HUD & Interactive Hub (`pi-extension/hub-ui.ts`)**:
       - **Layer 0 (`ctx.ui.setStatus("zee-mode", ...)`)**: `<= 18`-col compact badge (`zee:auto·EXEC`, `plan🔒`, `cut:3/4`). **NEVER calls `ctx.ui.setFooter()`** so `pi-cometix-footer` owns the footer cleanly with zero conflict.
       - **Layer 1 HUD (`ctx.ui.setWidget("zee-hud", ..., { placement: "aboveEditor" })`)**: auto-hides (`[]`) when `IDLE` and unlocked, renders full 2–4 line bordered card (`width >= 90 && rows >= 24`) or borderless 1–2 line summary (`compact` / narrow terminal), degrades to `<= 3` RPC strings when non-TUI, and stays 100% silent in `Print` / `JSON` / `ZEE_WORKER=1`.
       - **Layer 2 Hub (`openZeeHubOverlay`)**: invoked via `/zee-hub`, `Ctrl+Alt+H`, or `F2` (strictly avoiding Pi's reserved `Ctrl+G` external editor binding; gated on `ctx.mode === "tui"`). Provides 5 interactive Tabs: `1 Overview & FSM`, `2 Workers` (live `partial-*.md` preview), `3 Gates & Trail` (Gate 1->2 + `G-01..G-06` + `decisions.tsv`), `4 Worktrees & Cost` (6-bucket cleanup + cost bars), and `5 Controls` (`m`/`l`/`w`/`c`/`d`/`p`).
     - **Resilience, Windows Fixes & Deduplicated Accounting**: role-tiered timeouts, dual-mode idle watchdog, 4-strike `StagnancyTracker`, `>2KB` `partial-*.md` salvage, `toolCallId`-deduplicated `countedDelegateIds` preventing 2x `delegatesDispatched` double-counting, Windows `ZEE_PI_BIN` script `process.execPath` spawn fix (`spawn EFTYPE`), and Windows `"junction"` `node_modules` symlink mounting.
   - **Cursor**: emit `<modelHint>-<effort>` (omit unsupported `-xhigh` on models that cap at `high`).
   - **Claude Code (standalone)**: pass Claude `modelHint` + `effort` directly; if slot prefers an external family, announce single-vendor degradation once and map by `tier` (`pro`->opus, `standard`->sonnet, `fast`->haiku).
   - **Google Antigravity (`agy` standalone)**: load `references/antigravity.md`; use `zee-tool.mjs resolve-model --harness agy [--allow-standalone]`, prefer bundled `TypeName: "zee-*"` subagents (`Workspace: "share"`), and fall back to `Model: "inherit"` on HTTP 429 `RESOURCE_EXHAUSTED`.
   - **Single-Thread Fallback**: announce sequential mode once; enforce strict bus artifact handoffs between phases.

## 3. Concurrency & Wakeup Discipline
- On **T3 Code**: dispatch parallel delegates with `mode: "async"`, yield with zero tool calls, wait for wakeups, and cancel unneeded runs with `task_cancel` (never poll `task_status`).
- On **Antigravity (standalone)**: follow the Reactive Watchdog protocol in `references/antigravity.md` (`{PARENT_CONVERSATION_ID}` + `send_message` + `schedule(TimerCondition:"never")` + ZERO tool calls yield + `manage_task(kill)` on quorum).
- On **other harnesses**: follow host async background/wait semantics without busy-wait `sleep` loops.
