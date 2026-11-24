# Google Antigravity (`agy`) Native Adapter (`zee`)

When `zee` is installed as a native Google Antigravity plugin (`agy plugin install https://github.com/zee820232/zee`), it integrates directly with the official `agy` CLI, Antigravity 2.0 App, and Antigravity IDE.

## 1. Entry Points & Auto-Routing
- **Dedicated Primary Agent (Equivalent to Pi `/zee-mode auto`)**: launch `agy --agent zee` from the terminal, or pick **`zee`** via `/agents` in the CLI / agent selector in the Antigravity App.
- **Explicit Slash Commands**: `/zee`, `/zee-plan`, `/zee-init`, `/zee-review`, `/zee-night`, `/zee-setup` work natively in chat without prefixes.
- **Plan Mode Synergy**: pair `/zee-plan` with `agy --mode plan` (or `/plan`). Even outside `--mode plan`, the bundled `hooks.json` (`scripts/agy-guard.mjs`) enforces the path-scoped write lock on `/zee-plan` and `/zee-review` and enforces `.agents/zee.project.json` `denyCommands`.

## 2. Native Role Subagent Dispatch (`invoke_subagent`)
Always dispatch the plugin's dedicated isolated subagents (all have `inheritCustomizations: false` so they never inherit competing global orchestrators or recursively re-enter `zee`):

| `zee` Role | `TypeName` | Default `Model` Tier | `Workspace` | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Scout** | `zee-scout` | `flash` (or `flash_lite`) | `inherit` | Read-only repo reconnaissance |
| **Architect** | `zee-architect` | `pro` | `inherit` | Contracts, seams, L3 Arena sketches |
| **UI** | `zee-ui` | `pro` | `share` (build) / `inherit` (spec) | Design system, frontend code & visual QA |
| **Coder** | `zee-coder` | `inherit` (`pro` on heavy) | `share` (or `branch`) | Isolated implementation; commits & reports `HEAD_SHA` |
| **Verifier** | `zee-verifier` | `flash` (or `inherit`) | `share` (or `inherit`) | Cold-start Pinned SHA gate (`PASS/FAIL/INCONCLUSIVE`) |
| **Reviewer** | `zee-reviewer` | `pro` | `inherit` | Adversarial 3-axis evidence-only review |

*(If `zee` was installed skills-only without the plugin, fall back to `TypeName: "self"` with the `[zee-worker]` header.)*

## 3. Native Workspace Isolation, Coordination & Model Policy
- **Isolation**: Prefer `Workspace: "share"` (lightweight shared-git worktree) for parallel `zee-coder` / `zee-ui` slices; use `Workspace: "branch"` only when a fully separate clone is required. Never shell out to manual `git worktree add` when native `Workspace: "share"` is available.
- **Reactive Wakeup (Zero Polling)**: After launching parallel `invoke_subagent` calls, end the turn and wait for system completion messages. Use `send_message` to iterate with an idle worker and `manage_subagents` to cancel extras.
- **Wide Sweeps & Overnight**: Use `run_workflow` for wide read-only `sweep` fan-outs across many files/modules, and native `schedule` for watchdog timers if needed.
- **Single-Vendor Disclosure**: In standalone `agy` (without T3 Code cross-provider `delegate_task`), announce single-vendor model tier mapping (`pro` / `flash` / `flash_lite` / `inherit`) once in Chinese while maintaining strict fresh-context role isolation.
