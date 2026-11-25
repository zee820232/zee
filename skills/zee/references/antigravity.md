# Google Antigravity (`agy`) Native Adapter (`zee` v4)

When `zee` is installed as a native Google Antigravity plugin (`agy plugin install https://github.com/zee820232/zee`), it eats full native AGY primitives across `agy` CLI, Antigravity 2.0 App, and Antigravity IDE **without** shipping a global hijacking `rules/AGENTS.md`.

## 1. Zero-Hijack Entry Points & Lifecycle Hooks (`hooks.json`)
- **Dedicated Primary Agent (Equivalent to Pi `/zee-mode auto`)**: launch `agy --agent zee` from the terminal, or pick **`zee`** via `/agents` in CLI / agent selector in Antigravity App.
- **Explicit Slash Commands**: `/zee`, `/zee-plan`, `/zee-init`, `/zee-review`, `/zee-arch`, `/zee-retro`, `/zee-night`, `/zee-setup` work natively in chat with zero hijacking of ordinary non-zee chats.
- **Optional User-Level Auto-Route**: `/zee-setup` offers an **opt-in (default OFF)** toggle to write a ≤15-line rule at `~/.gemini/config/rules/zee-auto.md` if the user wants automatic routing in default chats.
- **Bundled 3-Event Lifecycle Hooks (`hooks.json` -> `scripts/agy-guard.mjs`)**:
  1. **`PreInvocation`**: persists cross-turn lock/mode state (`plan`, `review`, `init-design`, `night`) by `conversationId` in `$PLUGIN_DATA/sessions/<cid>.json` (auto-prunes >7d files and automatically clears `night` mode once a completed/paused run moves into a new interactive turn). Ordinary chats create 0 files and receive `{}` (0 token injection).
  2. **`PreToolUse`**: shares `skills/zee/scripts/lib/guard-core.mjs` with Pi — recursively unwraps `sh/bash/zsh` (including `-e`/`--norc`/`-o`) `-c` & `eval`, blocks project `denyCommands` (`deny`), flags destructive commands (`rm -rf /`, trunk `git push --force`, DB `DROP DATABASE`) with `force_ask` (interactive) or `deny` (headless/`night`), enforces independent-`conversationId` path allowlists on read-only/gate `[zee-worker]` subagents, and enforces main-thread path locks (allowing `GLOSSARY.md`, `docs/adr/`, `/tmp/zee-*`, and allowlisted `mkdir`/`cp`/`rm`/`mv`). **All safe pass-through paths return `{}`**.
  3. **`Stop`**: active ONLY in `night` mode when `fullyIdle === true && continuationActive !== true && terminationReason === "NO_TOOL_CALL"` AND the matching `conversationId` `state.json` is strictly `status === "running"` (never interrupting Trust Gate human approval during `initialized`!).

## 2. Native Role Subagent Dispatch (`invoke_subagent` + Hard `tools:` Allowlists)
All 6 bundled role subagents set `inheritCustomizations: false` AND explicit OneHarness `tools:` allowlists (preventing recursive spawning, user questions, and unauthorized edits):

| `zee` Role | `TypeName` | Default `Model` Tier | `Workspace` | Hard `tools:` Boundary |
| :--- | :--- | :--- | :--- | :--- |
| **Scout** | `zee-scout` | `flash` / `flash_lite` | `inherit` | `[read_file, run_command, search_web, send_message]` + `inheritMcp: true` (no write/edit) |
| **Architect** | `zee-architect` | `pro` | `inherit` | `[read_file, search_web, send_message]` (**strictly read-only**, matches Pi; Orchestrator writes `plan.md`) |
| **UI** | `zee-ui` | `pro` | `share` (build) / `inherit` (spec) | `[read_file, edit_file, write_file, run_command, manage_task, send_message, generate_image]` + `inheritMcp: true` |
| **Coder** | `zee-coder` | `inherit` (`pro` heavy) | `share` (or `branch`) | `[read_file, edit_file, write_file, run_command, manage_task, send_message]` |
| **Verifier** | `zee-verifier` | `flash` / `inherit` | `share` (or `inherit`) | `[read_file, write_file, run_command, manage_task, send_message]` + `inheritMcp: true` (**no `edit_file`**) |
| **Reviewer** | `zee-reviewer` | `pro` | `inherit` | `[read_file, write_file, run_command, send_message]` (**no `edit_file`**) |

*(If `zee` was installed skills-only without the plugin, fall back to `TypeName: "self"` with the `[zee-worker]` header.)*

## 3. Reactive Wakeup & Global Watchdog Protocol (Mandatory for Fan-Outs)
Antigravity subagents run asynchronously and wake the parent ONLY via `send_message`:
1. **Mandatory Reporting Contract**: pass `Parent Conversation ID: <conversation-id>` in every subagent prompt and require the worker to call `send_message(Recipient: "<conversation-id>", Message: "<≤30-line receipt>")` upon completion.
2. **Single Unconditional Global Watchdog**: in the SAME turn as parallel `invoke_subagent` calls, arm ONE timer:
   `schedule(DurationSeconds: 300..600, Prompt: "zee 看门狗：检查未返回子代理状态", TimerCondition: "never")`
   *(Never use `TimerCondition: "any"` for multi-worker fan-outs — the first completion would prematurely cancel timeout protection for slower siblings!)*
3. **Mechanical Turn Yield**: immediately emit a brief Chinese progress message with **ZERO tool calls**. On each incremental `send_message` arrival, record the receipt and yield again with ZERO tool calls while siblings remain pending.
4. **Quorum Teardown**: once all expected workers report, cancel the watchdog immediately via `manage_task(Action: "kill", TaskId: "<timerTaskId>")`. *(Note: `manage_task` controls timers and background `run_command` tasks; `manage_subagents` controls AI subagents.)*
5. **Timeout Diagnosis & `N-1` Rule**: call `manage_subagents(Action: "list")` ONLY if the watchdog fires or an error occurs. Inspect `state` and `stateDetail` before killing — **do NOT kill a worker actively compiling or running tests**. If stuck in `error` or silent `idle`, `kill` it and continue with `N-1` (recording the dropout explicitly). Use `send_message` for tight iterations on an active worker; spawn fresh workers on phase boundaries.

## 4. Dual-Storage Synergy: Out-of-Tree Bus + Native Brain Artifacts
Keep machine-to-machine cross-worktree bus files under `~/.local/state/zee/runs/<repo-key>/<slug>/` (so isolated workspaces always resolve the exact same path). At user-facing milestones, mirror deliverables into `<appDataDir>/brain/<conversation-id>/` via `write_file` with `ArtifactMetadata`:

| Workflow Milestone | Brain Artifact File | `ArtifactMetadata` | Visual / Chat Discipline |
| :--- | :--- | :--- | :--- |
| `/zee-plan` & `0→1` Stage 1 (`SPEC.md`) | `implementation_plan.md` | `UserFacing: true, RequestFeedback: true` (lights up native **Proceed** button!) | Chat shows crisp Chinese summary + `[implementation_plan.md](file:///...)` link; never paste full doc |
| L2 / L3 / `0→1` Completion | `walkthrough.md` | `UserFacing: true, RequestFeedback: false` | Copy final PNGs into `<artifactDir>/` first, then embed before/after `carousel` (`<!-- slide -->`) |
| `/zee-review` / `investigate` | `review_verdict.md` / `investigation_report.md` | `UserFacing: true, RequestFeedback: false` | Evidence tables + exact `[file](file:///path#L10-L20)` links |
| `/zee-night` Autonomous Run | `morning_report.md` + mirror `decisions.tsv` | `UserFacing: true, RequestFeedback: false` (never block unattended!) | `decisions.tsv` enables AGY 2.13+ virtualized sortable table view |
| Temporary probe scripts / raw logs | `scratch/<name>` | Omit `ArtifactMetadata` | Automatically folded into AGY Scratch sidebar |

## 5. Surface Model Translation, 429 Fallback & Wide `run_workflow` Sweeps
- **Deterministic Model Translation**: resolve `zee-config.json` slots to exact AGY surface names via:
  `node "<zeeDir>/scripts/zee-tool.mjs" resolve-model --harness agy --surface invoke_subagent --role <role>`
  - `invoke_subagent` accepts ONLY `inherit | pro | flash | flash_lite` (`gemini-4-neon` -> `pro`, `gemini-4-hydrogen` / `3.8-flash` -> `flash`, `gemini-4-argon` -> `inherit`).
  - Native `swarm` accepts exact effort-suffixed IDs (e.g. `gemini-4-neon-high`, `gemini-4-hydrogen-medium`).
- **HTTP 429 / Single-Tier Fallback**: if `invoke_subagent` hits `429 RESOURCE_EXHAUSTED` or a single-tier account restriction, immediately retry with `Model: "inherit"` (preserving full coverage without dropping slots) and announce once in Chinese.
- **Wide `sweep` Fan-Out (`≥5` Disjoint Read-Only Slices)**: prefer AGY native **`run_workflow`** (`parallel(slices, lambda s: agent(..., type_name="zee-scout", model="flash", workspace="inherit", schema={...}))`) to obtain schema-validated JSON results in one background run with zero cloud infrastructure.
- **Workspace Preference**: always prefer `Workspace: "share"` over `"branch"` for coding slices (faster, shares `.git` objects so `zee-verifier` can check out `PINNED_SHA` directly).

## 6. Surface Precedence & `permissioned-github` Sandbox Recovery
1. **Surface Precedence**: `Filesystem Tools (read_file)` > `CLI / Runtime (run_command)` > `Browser Tools (browser_subagent / preview_*)`. Never use a browser to view or search repository source code.
2. **Sandbox Denial Recovery (exit 126/127, `EACCES`, `PermissionDenied`)**:
   - **Never apologize or retry the identical blocked command in a loop.**
   - If the task is investigatory/read-only, immediately fall back to native filesystem read tools.
   - If external mutation is required, name the exact missing `permissioned-github` grant (`git.update`, `git.create`, `gh.create`, `gh.update`, `gh.delete`) and present the exact command for the human operator to execute on the host.
