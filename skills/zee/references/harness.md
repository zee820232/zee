# Harness Adapter Layer (`zee`)

`zee` core files stay 100% harness-agnostic. The active session detects its host once at startup and translates abstract ops through this adapter.

## 1. Host Detection & 4-Tier Subagent Ladder

Select the highest available tier in the active harness (never switch hosts or shell out to another CLI behind the user's back):

| Tier | Active Harness | Detection Signal | `PROBE` | `SPAWN` | `ISOLATE` | `ASK` | `SCHEDULE` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **T1** | **T3 Code** (any active provider) | `delegate_task` + `orchestrator_capabilities` available | `orchestrator_capabilities` (1x/thread) | `delegate_task(mode:"async", target, role, isolation)` | `isolation:"worktree"` | `ask_question` or numbered text | `schedule_task` |
| **T2** | **Pi** (`zee` Package or subagent ext) | `zee_subagent` (built-in) or `subagent_spawn` available (no `delegate_task`) | `pi --list-models` or session models | `zee_subagent({ task, role, provider, model, thinkingLevel, tools, cwd })` (supports parallel calls) or `subagent_spawn` | `git worktree add` (pass `cwd` to worker) | `ask_user_question` or numbered text | manual |
| **T3** | **Cursor / OpenCode / Claude / Codex / Antigravity** (standalone) | `Task` / `task` / `Agent` / `spawn_agent` / `invoke_subagent` (no `delegate_task`) | Host model catalog / tiers | Native subagent tool (`Task` / `task` / `Agent` / `spawn_agent` / `invoke_subagent`) | Native worktree/branch or `git worktree` | Host ask tool or numbered text | `/loop` / `schedule` / manual |
| **T4** | **Single-Thread Fallback** (bare Pi / no subagent tool) | No subagent tool available | Active model only | Sequential role switching in current thread | Dedicated branch `zee/<slug>` | numbered text | manual |

### Visual Check (`VISUAL_CHECK`)
- Default (background/silent): headless Playwright CLI or `agent_browser` on an isolated free port, saving PNGs to `<busDir>/screenshots/`.
- Interactive browser preview (`preview_*` in T3 Code): **strictly only when the user's request asks for browser/preview work**; pass `reuseExistingTab: false` and close your tab before replying.

## 2. Universal Model Resolution & Capability Clamping

Read `~/.agents/zee-config.json` (plus optional `.agents/zee.local.json` override) and resolve each slot in order:

1. **Extract True Model Family** (never use proxy `providerInstanceId` like `pi` as family):
   - Use explicit `family` in config; otherwise parse model tail: `claude`/`fable` -> `claude`, `gpt`/`o1`/`o3`/`o4`/`codex` -> `openai`, `gemini` -> `gemini`, `swe-` -> `devin`, `deepseek` -> `deepseek`, `grok` -> `grok`.
2. **Resolve Target for Active Harness**:
   - **T3 Code**:
     - Filter `PROBE` providers to `canRunChildTask === true`.
     - Prefer `bindings.t3` if its provider & model are live; else match `prefer.modelHint` (or `prefer.family` + `prefer.tier`) across live providers; else try user-authorized `backup` (**always announce backup usage explicitly**).
     - **Option Key & Capability Clamping**: read the matched model's live `options[]` (`thought_level` on Antigravity, `thinking` on Pi, `effort` on Claude). Adjust `prefer.effort` by global `budget` (`eco`: -1 step, `balanced`: 0, `max`: +1 step; **cap routine effort at `xhigh`**), then clamp to the highest legal value in `options[].values` at or below target (e.g. `swe-2` clamps `low` -> `medium`; `deepseek-v4.1-flash` clamps `medium` -> `low`).
     - **Always pass explicit `providerInstanceId`, `model`, AND `options`** on every `delegate_task` to prevent inheriting parent `thinking: max`.
     - **Fail-Closed Rule**: if neither `prefer` nor authorized `backup` is live, STOP and tell the user. Never switch silently to unapproved models or fall back to native subagents/CLIs.
   - **Pi (`zee_subagent` / `subagent_spawn`)**:
     - Match `prefer.modelHint` / `backup.modelHint` against Pi's configured models (`~/.pi/agent/models.json` or `pi --list-models`) to pass exact `provider`, `model`, and explicit `thinkingLevel` (always pass `thinkingLevel` explicitly so children do not inherit parent `max`).
     - Enforce least-privilege `tools`: read-only roles (`Scout`, `Architect`, `Judge`) use `["read","grep","find","ls"]`; writing/execution roles (`Coder`, `UI`, `Verifier`, `Reviewer` Break axis) add `"edit","write","bash"`.
     - **Read-Only Output Contract**: when a read-only worker runs without `write` tool, instruct it to emit its full structured report in final output and have the Orchestrator write `<busDir>/context.md` / `<busDir>/plan.md`.
     - `zee_subagent` supports parallel tool calls in a single assistant turn and enforces `-ne` (`--no-extensions`) + `ZEE_WORKER=1` anti-recursion automatically. When using `subagent_spawn`, cancel unneeded jobs with `subagent_cancel({ jobId })`.
   - **Cursor**: emit `<modelHint>-<effort>` (omit unsupported `-xhigh` on models that cap at `high`).
   - **Claude Code (standalone)**: pass Claude `modelHint` + `effort` directly; if slot prefers an external family, announce single-vendor degradation once and map by `tier` (`pro`->opus, `standard`->sonnet, `fast`->haiku) while preserving fresh-context separation.
   - **Antigravity (standalone)**: map `tier` -> `pro | flash | flash_lite | inherit`; announce single-vendor degradation once.
   - **Single-Thread Fallback**: announce sequential mode once; enforce strict bus artifact handoffs between phases so context stays clean.

## 3. Concurrency & Wakeup Discipline
- On **T3 Code**: dispatch parallel delegates with `mode: "async"`, yield the turn with zero tool calls, wait for system completion wakeups, and cancel unneeded runs with `task_cancel`. Never poll `task_status` before wakeup and never use `t3_thread_send` for re-reviews.
- On **Antigravity (standalone)**: yield turn after `invoke_subagent`; arm one watchdog timer only if needed; cancel timer upon quorum.
- On **other harnesses**: follow host async background/wait semantics without busy-wait `sleep` loops.
