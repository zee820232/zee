---
name: zee
description: >-
  通用多模型全自动工程工作流（支持项目 0→1 构建、1→100 风险定级开发、多模型 Arena 架构辩论、跨家族对抗审查与过夜无人值守；一次配置模型，在当前安装的任意 Harness 中自动运行）。仅在用户显式调用 /zee 或要求使用 zee 工作流时启用。
disable-model-invocation: true
---

# zee — Universal Multi-Model Autonomous Workflow (v4)

Command syntax: `/zee <request> [init | plan | L0 | L1 | L2 | L3 | debate | review | investigate | perf | loop | prototype | sweep | resume | night]`
Shortcuts: `zee-plan`, `zee-init`, `zee-review`, `zee-night`, `zee-setup` (plus Pi `/zee-mode` auto-routing switch and Antigravity `agy --agent zee` primary agent).
Current session acts as **Orchestrator** on whichever harness `zee` is installed in. Never delegate orchestration itself, and only manage the active harness where this skill lives (`<zeeDir>` = parent directory of this `SKILL.md`).

## User-Facing Language Policy (Mandatory)
- **All user-facing prompts, questions, status updates, routing reasons, fallback notices, confirmation cards, final reports, and morning briefs MUST be written in clear Simplified Chinese (简体中文)** (unless the user explicitly asks for another language).
- Internal subagent briefs (`worker.md` header) and technical identifiers/commands may remain in English for cross-model reliability.

## 0. Preflight (Every Run)

1. Resolve `<zeeDir>` (the directory containing this `SKILL.md`). Load `<zeeDir>/references/harness.md` to bind abstract ops (`PROBE`, `SPAWN`, `ISOLATE`, `ASK`, `VISUAL_CHECK`, `SCHEDULE`) to the active harness only (load `<zeeDir>/references/antigravity.md` when running natively in Google Antigravity), and follow `<zeeDir>/references/interop.md` when reusing host-discovered domain skills.
2. Read `~/.agents/zee-config.json` (plus optional `<repo>/.agents/zee.project.json` and `<repo>/.agents/zee.local.json`). If missing, run `zee-setup` first.
3. Run `PROBE` once per thread. Resolve each needed role slot (`bindings.<harness>` -> `prefer` -> authorized `backup`) with **Capability Clamping** onto live supported option values (cap routine effort at `xhigh`). Fail closed if no authorized model is available; always announce any `backup` switch to the user in Chinese.
4. Detect workspace state (`git rev-parse --verify HEAD`, dirty tree, `CONTEXT.md`/`GLOSSARY.md`, `docs/adr/`). Ignore repo-irrelevant global `~/CLAUDE.md` rules.
5. Create Out-of-Tree Run Bus via:
   `node "<zeeDir>/scripts/zee-tool.mjs" init-run "<repoRoot>" "<slug>"`
   Always update `state.json` atomically via `zee-tool.mjs update-state` and append decisions via `zee-tool.mjs log-decision`. Never use repo-local `.scratch/` as the worker bus.

## 1. Intake & Two-Track Routing

Classify unknowns before asking: **code facts -> Scout**; **observable tech forks -> prototype**; **product/preference forks -> `ASK` in Chinese** (one batch with `推荐` defaults).

- **Track A · Project 0→1 (`init` or empty repo / no `HEAD` / new product request)**
  Load `<zeeDir>/references/greenfield.md` and run Stages 1–5 (`SPEC.md` Chinese sign-off -> 2-beat Architecture + `DESIGN.md` + Roadmap -> M0 Foundation Commit + M1 Walking Skeleton -> M2..Mk auto slices -> Cold-Start & E2E Delivery).
- **Track B · 1→100 Risk-Routed Execution (`Risk × Intent × Mode`)**
  Assign provisional level and tell the user the level + reason in 1 Chinese line (re-evaluate after Scout; **upgrade only, never downgrade**):
  - **L0 Direct**: non-risk path, ≤1 file trivial edit/Q&A -> Orchestrator executes and runs a quick check.
  - **L1 Quick**: low-risk local change, no contract/schema/UI-system impact -> `[optional Scout]` -> `Coder(standard)` or `UI(standard)` -> `Verifier`.
  - **L2 Standard**: multi-file feature, bug fix, refactor, or **any edit touching `riskPaths`** (auth, crypto, billing, migrations, live trading/signing, public APIs) -> full pipeline + Gate 1 `Verifier` -> Gate 2 cross-family `Reviewer`.
  - **L3 High-Stakes / Debate**: cross-module architecture, concurrency/state-machine change, major redesign, or explicit `debate`/`L3` -> `Scout(Deep)` -> orthogonal **Arena** + cross-vendor `Judge` + Orchestrator **Graft** -> `Coder(heavy)` / `UI(heavy)` -> `Verifier` (Gate 1) -> 2–3 cross-family `Reviewers` (Gate 2).
  - **Standalone & Specialized Modes**:
    - `plan` (or `/zee-plan`): load `<zeeDir>/references/plan-mode.md`. Runs `Scout` -> multi-round Chinese **Grilling** (cross-turn write lock stays active) -> `Architect` (+ `UI`, optional L3 Arena) -> `zee-tool.mjs check-plan` -> writes finalized `plan.md` and **stops without editing production code**.
    - `debate`: stops after L3 Arena + cross-vendor Judge ADR/decision report.
    - `review` (or `/zee-review`): initializes an independent run bus and runs cross-family `Reviewers` read-only on target diff/SHA without editing.
    - `investigate` / `perf` (`hillclimb`) / `loop` / `prototype` / `sweep`: load `<zeeDir>/references/specialized.md` and follow the matched specialized track.
    - `resume`: run `node "<zeeDir>/scripts/zee-tool.mjs" list-runs "<repoRoot>"` to locate active/paused buses and follow Session-Pickup in `<zeeDir>/references/overnight.md`.
  - **Approved Plan Fast-Path**: if the user passes an existing approved `plan.md` / `SPEC.md` (e.g. from `zee-plan`), verify no repo drift and skip Intake/Architect straight into **Build -> Check -> Merge**.
  - **`night` Mode (or `/zee-night`, orthogonal modifier)**: load `<zeeDir>/references/overnight.md`. Applies autonomous branch isolation, Unit 0 verification harness + baseline, Canary first unit, `decisions.tsv` audit trail, 70% cutoff & budget fuse, and Chinese morning report.

## 2. Core Pipeline (Load Role Card Per Step)

Load `<zeeDir>/references/protocols.md` for bus schemas, Pinned SHA rules, and worktree merging. Every `SPAWN` prompt MUST start with the `<zeeDir>/worker.md` header, explicit target model + explicit options, role card path, bus path, and pinned SHA.

1. **Scout (`roles/scout.md`)** [L2+]: read-only pointer map (`file:line`, test commands, `riskPaths`, non-grep readers, optional MCP evidence sources). Re-check level (upgrade only).
2. **Design (`roles/architect.md` + `roles/ui.md`)**:
   - **Bug Intent**: skip Architect; write a 10-line `<busDir>/bug-brief.md` (symptom, repro command, expected behavior) as Reviewer Axis 1 anchor, then open Bug Fast-Track in `roles/coder.md` (Phase 1 must prove a fast **red reproduction** before touching production code).
   - **Feature / Refactor**: Architect produces `plan.md` (data shape, Test Seam, Throughput Checkpoint, Out-of-Scope, falsifiable `Done Predicate`, vertical slices each **≤5 files / ≤400 LOC**; L3 runs orthogonal Arena + anonymous cross-vendor Judge + Orchestrator Graft). Validate with `zee-tool.mjs check-plan`.
   - **UI Scope** (matches `uiGlobs` or visual task): `ui` runs alongside Architect to emit `ui-spec.md` (state matrix, design tokens, visual rubric, optional `?variant=` prototype). Default L3 proceeds after design unless user asks to review plan first.
3. **Build (`roles/coder.md`, `roles/ui.md`)**:
   - Execute in isolated worktree (`ISOLATE` — on Pi use `zee_subagent({ worktree: {...} })`; on AGY use `Workspace: "share"`). Never modify shared integration files (`CHANGELOG.md`, `README.md`, global test registries) on parallel branches.
   - Writer runs pre-commit `deslop` hygiene, commits on worktree branch, and returns `BRANCH`, `HEAD_SHA`, and local check results.
4. **Check (`roles/verifier.md` + `roles/reviewer.md`) on Pinned SHA**:
   - **Strict Serial Gate 1 -> Gate 2 (L2 / L3 / Stage 5 / `night`)**: ALWAYS run `Verifier` (**Gate 1**) first. Launch cross-family `Reviewer`(s) (**Gate 2**) ONLY after Gate 1 returns `VERDICT: PASS`. Never waste review tokens on code that fails build/tests.
   - `Reviewer` MUST exclude the `family` used by `Coder`/`UI` on this unit (on Pi pass `authorFamily` to `zee_subagent` for static enforcement); include ≥1 multimodal reviewer when UI screenshots exist.
   - **Lead Verifier Rerun**: before accepting any dynamic Axis 3 `P0/P1` blocker from a Reviewer, the Orchestrator re-runs the cited reproduction command once to filter false positives and build an explicit Agreement Map when multiple reviewers run.
   - **Gate Tampering Rule**: any diff modifying existing tests, snapshots, baselines, lint/CI config, or pinned hashes requires explicit rationale + cross-family Reviewer countersign.
5. **Merge (`Sequential Grafting`)**: merge verified SHAs one by one into the integration branch (`zee/<slug>` in `night`), verifying after each merge. Never bulk-merge parallel branches.

## 3. Four-Level Failure Ladder, Partial Salvage & 70% Cutoff

- **Partial Salvage Rule**: if a delegate returns `[STATUS: TIMEOUT_PARTIAL | IDLE_TIMEOUT_PARTIAL | STAGNANCY_LOOP_PARTIAL | ABORTED_PARTIAL]`, inspect its rescued `partialText` and `git status/HEAD` before re-dispatching — reuse valid findings or split oversized slices instead of blindly repeating the same prompt.
- **70% Wall-Clock / Budget Cutoff**: when approaching 70% of the session wall-clock or delegate budget, STOP opening new feature units; immediately finish integrating verified SHAs, update `state.json`, and deliver the complete Chinese summary so work never times out mid-closeout.
- **Level 0 · Micro-Fix (≤15 lines, localized, unambiguous)**: Orchestrator fixes directly, commits new SHA, and re-runs `Verifier`.
- **Level 1 · 1st Substantive Failure**: spawn a fresh same-tier `Coder`/`UI` with consolidated scope; require a 5-line root-cause reflection before editing; allow evidence-backed objection.
- **Level 2 · 2nd Failure on Same Root Cause**: state the shared premise of both failed attempts.
  - Premise is in `plan.md` / boundaries -> trigger **`Scrap`** back to `Architect` (max 1 Scrap per task).
  - Premise is implementation difficulty -> escalate to `heavy` tier (prefer switching model `family`).
- **Level 3 · 3rd Failure (Hard Fuse)**: halt. Interactive -> present root cause & options in Chinese. `night` -> mark unit `parked`, block dependents, continue unrelated units; 2 consecutive `parked` units trigger global stop + Chinese morning report.

## 4. Guardrails & Operator Controls

- **One-Way Doors (Always Pause in Chinese)**: merge to protected `main`/trunk, `git push --force`, destructive data deletion, production deploy, external messages, and any command matching project `denyCommands`.
- **Zero Polling**: after async `SPAWN`, yield the turn with zero tool calls and wait for completion wakeups. Never run `sleep` loops or repeated status polling.
- **Operator Overrides**: `stop` cancels active delegates immediately; `fewer` cancels extra delegates with no replacement; `pause` runs safe-pause checkpoint (`references/overnight.md`).
- **Final Report (in Chinese)**: open with user goal -> what changed & why -> before/after verification evidence & Pinned SHA -> one-way doors / blast radius -> any `backup` models used -> open decisions.
