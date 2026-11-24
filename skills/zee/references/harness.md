# Harness Adapter Layer (`zee`)

`zee` core files stay 100% harness-agnostic. The active session detects its host once at startup and translates abstract ops through this adapter.

## 1. Host Detection & Primitive Translation

| Active Harness | Detection Signal | `PROBE` | `SPAWN` | `ISOLATE` | `ASK` | `SCHEDULE` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **T3 Code** (any active provider) | `delegate_task` + `orchestrator_capabilities` tools available | `orchestrator_capabilities` (1x/thread) | `delegate_task(mode:"async", target, role, isolation)` | `isolation:"worktree"` | `ask_question` or numbered text | `schedule_task` |
| **Cursor** | `Task` tool available | Inspect Cursor model slugs | `Task(subagent_type, model, run_in_background:true)` | Local/cloud worktree | `AskQuestion` | `/loop` |
| **OpenCode** | `task` tool available | `opencode models` | `task(subagent_type:"general", model)` | `git worktree` | `question` | cron/manual |
| **Claude Code (standalone)** | `Agent` tool (no `delegate_task`) | Session Claude model list | `Agent(model, effort)` | `isolation:"worktree"` or `git worktree` | `AskUserQuestion` | `/loop` |
| **Codex (standalone)** | `spawn_agent` tool (no `delegate_task`) | Session Codex models | `spawn_agent` | `git worktree` | numbered text | manual |
| **Antigravity (standalone)** | `invoke_subagent` (no `delegate_task`) | Native tiers (`pro/flash/flash_lite/inherit`) | `invoke_subagent(TypeName:"self", Model, Workspace)` | `Workspace:"branch"` | `ask_question` | `schedule` |
| **Single-Thread Fallback** (e.g. bare Pi) | No subagent tool | Active model only | Sequential role switching in current thread | Dedicated branch `zee/<slug>` | numbered text | manual |

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
   - **Cursor**: emit `<modelHint>-<effort>` (omit unsupported `-xhigh` on models that cap at `high`).
   - **Claude Code (standalone)**: pass Claude `modelHint` + `effort` directly; if slot prefers an external family, announce single-vendor degradation once and map by `tier` (`pro`->opus, `standard`->sonnet, `fast`->haiku) while preserving fresh-context separation.
   - **Antigravity (standalone)**: map `tier` -> `pro | flash | flash_lite | inherit`; announce single-vendor degradation once.
   - **Single-Thread Fallback**: announce sequential mode once; enforce strict bus artifact handoffs between phases so context stays clean.

## 3. Concurrency & Wakeup Discipline
- On **T3 Code**: dispatch parallel delegates with `mode: "async"`, yield the turn with zero tool calls, wait for system completion wakeups, and cancel unneeded runs with `task_cancel`. Never poll `task_status` before wakeup and never use `t3_thread_send` for re-reviews.
- On **Antigravity (standalone)**: yield turn after `invoke_subagent`; arm one watchdog timer only if needed; cancel timer upon quorum.
- On **other harnesses**: follow host async background/wait semantics without busy-wait `sleep` loops.
