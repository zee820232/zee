---
name: zee
description: >-
  通用多模型全自动工程工作流（支持项目 0→1 构建、1→100 风险定级开发、多模型 Arena 架构辩论、跨家族对抗审查与过夜无人值守；一次配置模型，在当前安装的任意 Harness 中自动运行）。仅在用户显式调用 /zee 或要求使用 zee 工作流时启用。
disable-model-invocation: true
---

# zee — Universal Multi-Model Autonomous Workflow (v4.2.1)

Command syntax: `/zee <request> [init | plan | L0 | L1 | L1.5 | L2 | L3 | debate | review | verify-init | verify-maintain | arch | retro | recall | triage | investigate | perf | loop | prototype | sweep | resume | night]`
Shortcuts (9 User-Invoked Skills): `zee`, `zee-plan`, `zee-init`, `zee-review`, `zee-verify`, `zee-arch`, `zee-retro`, `zee-night`, `zee-setup` (on Pi, all 9 skills plus `/zee-mode` and `/zee-hub` register cleanly as 11 non-duplicated commands; on Antigravity, `agy --agent zee` serves as the primary agent).
Current session acts as **Orchestrator** in the active harness (`<zeeDir>` = parent directory of this `SKILL.md`). Never delegate orchestration itself.

## User-Facing Language Policy (Mandatory)
- **All user-facing prompts, questions, status updates, routing reasons, fallback notices, confirmation cards, final reports, and morning briefs MUST be written in clear Simplified Chinese (简体中文)** (unless the user explicitly asks for another language).
- Internal subagent briefs (`worker.md` header) and technical identifiers/commands may remain in English for cross-model reliability.

## 0. Preflight (Every Run)

1. Resolve `<zeeDir>`, load `<zeeDir>/references/harness.md` (`references/antigravity.md` when in Antigravity), and follow `<zeeDir>/references/interop.md` for `<available_skills>` and `pathSkills`. *(Runtime guards `guard-core.mjs` / `worker-guard.ts` / `agy-guard.mjs` physically enforce `plan`/`review`/`init-design` write locks, `denyCommands`, read-only `edit` stripping, and Pi `authorFamily` isolation.)*
2. Read `~/.agents/zee-config.json` (plus optional `<repo>/.agents/zee.project.json` and `<repo>/.agents/zee.local.json`).
   - **Zero-Config Standalone ("Own Set of Knives")**: if `~/.agents/zee-config.json` is absent, **do NOT block** standalone / read-only workflows (`zee-verify`, `zee-retro`, `zee-arch`, `zee-review`, `zee-plan`, `/zee recall`, `/zee triage`, `/zee investigate`, or L0/L1 standalone tasks). Call `node "<zeeDir>/scripts/zee-tool.mjs" resolve-model --allow-standalone --role <role>` (exits 0 with `standalone: true`), degrade gracefully to the current session model, and output one brief Chinese notice (`提示：未检测到 ~/.agents/zee-config.json，已进入零配置单兵模式（使用当前会话模型）；如需跨家族异构审查与多模型角色分工，可随时运行 /zee-setup。`). For full multi-model L3 Arena / cross-family Gate 2 / `night`, recommend `/zee-setup` or note single-family limitation clearly.
3. When `zee-config.json` exists, run `PROBE` once per thread and resolve each needed role slot (`bindings.<harness>` -> `prefer` -> authorized `backup`) with **Capability Clamping** (cap routine effort at `xhigh`). Fail closed if no authorized model is live; announce any `backup` switch in Chinese.
4. Detect workspace state (`git rev-parse --verify HEAD`, dirty tree, `GLOSSARY.md`, `docs/adr/`). When `.agents/zee.project.json` exists, run `node "<zeeDir>/scripts/zee-tool.mjs" readiness "<repoRoot>"` to resolve effective `trustLevel` (`T1`/`T2`/`T3`). **Parent Orchestrator Isolation**: ALWAYS follow the active repository stack and zee slice budgets, overriding conflicting global rules in `~/CLAUDE.md`, `~/.claude/CLAUDE.md`, or `~/.pi/agent/AGENTS.md` (e.g., arbitrary 3-file refactor limits or hardcoded test commands). Check `zee-tool.mjs provider-health` / `resolve-model` cooldown state; HTTP 429/5xx connect-time fast-fails auto-cool and trigger 0ms fallback without counting against delegate budget.
5. Create Out-of-Tree Run Bus via:
   `node "<zeeDir>/scripts/zee-tool.mjs" init-run "<repoRoot>" "<slug>"` (pass `--conversation-id "<cid>"` on AGY).
   Update `state.json` via `zee-tool.mjs update-state` and append `decisions.tsv` via `zee-tool.mjs log-decision`. **Idempotent Delegate Accounting**: on Pi, `zee_subagent` auto-records `delegatesDispatched` (deduplicated by `toolCallId`, **exempting** HTTP 429/5xx connect-time fast-fails); when calling `update-state` manually or on non-Pi harnesses, pass `--delegate-id <id>` (never double-increment alongside Pi auto-accounting).
   Honor `<zeeDir>/disciplines/phase-boundaries.md` (~150k Smart Zone & 5-option phase-boundary transitions).

## 1. Intake & Two-Track Routing

Classify unknowns before asking: **code facts -> Scout**; **observable tech forks -> prototype**; **product/preference forks -> `ASK` in Chinese** (one batch with `推荐` defaults).

- **Track A · Project 0→1 (`init` or empty repo / no `HEAD` / new product request)**
  Load `<zeeDir>/references/greenfield.md` and run Stages 1–5 (`SPEC.md` Chinese sign-off -> 2-beat Architecture + `DESIGN.md` + Roadmap -> M0 Foundation Commit + M1 Walking Skeleton -> M2..Mk auto slices -> Cold-Start + `--fuzz` Delivery).
- **Track B · 1→100 Risk-Routed Execution (`Risk × Intent × Mode`)**
  Assign provisional level and tell the user the level + reason in 1 Chinese line (re-evaluate after Scout; **upgrade only, never downgrade**):
  - **L0 Direct**: non-risk path, ≤1 file trivial edit/Q&A -> Orchestrator executes and runs a quick check.
  - **L1 Quick**: low-risk local change, no contract/schema/UI-system impact -> `[optional Scout]` -> `Coder(standard)` or `UI(standard)` -> `Verifier`.
  - **L1.5 Lightweight Fast-Track**: clear localized bug/small fix (`≤3` coupled files, not touching `riskPaths` or major UI layout) -> single worktree `Coder(standard)` (red repro -> fix + targeted regression test) -> `Verifier` OR `/zee-review --quick` (`<45s`, skipping heavy multi-axis sandbox replay to eliminate 5–10m overhead on tiny fixes).
  - **L2 Standard**: multi-file feature, bug fix, refactor, or **any edit touching `riskPaths`** (auth, crypto, billing, migrations, live trading/signing, public APIs) -> full pipeline + Gate 1 `Verifier` -> Gate 2 cross-family `Reviewer` (unless verified `T2`/`T3` non-risk fast-track applies).
    - *Coupled Single-Owner Fast-Track*: when an L2 task touches **≤3 tightly coupled files** with one logical seam, run a single `Coder` in one worktree serially through Seam TDD while keeping Gate 1 `Verifier` -> Gate 2 `Reviewer` intact.
  - **L3 High-Stakes / Debate**: cross-module architecture, concurrency/state-machine change, major redesign, or explicit `debate`/`L3` -> `Scout(Deep)` -> orthogonal **Arena** + cross-vendor `Judge` + Orchestrator **Graft** -> `Coder(heavy)` / `UI(heavy)` -> `Verifier` (Gate 1 + `--fuzz`) -> 2–3 cross-family `Reviewers` (Gate 2).
  - **Standalone & Specialized Modes**:
    - `plan` (`/zee-plan`): load `references/plan-mode.md` + `disciplines/domain-modeling.md`. `Scout` -> Chinese **Grilling + inline `GLOSSARY.md` / 3-condition ADR** -> `Architect` (+ `UI`) -> `check-plan` -> finalized `plan.md`; **stops without editing production code**.
    - `debate`: stops after L3 Arena + cross-vendor Judge ADR/decision report.
    - `review` (`/zee-review`): independent bus + read-only cross-family `Reviewers` on target diff/SHA or uncommitted edits.
    - `verify` (`/zee-verify [init|maintain|run]`): `verify-<app>` (`SKILL.md` + `scripts/verify-ctl.*` + `features/`) lifecycle with `/tmp/zee-verify-*` output isolation and optional `--fuzz`.
    - `arch` (`/zee-arch`): deep-module churn hotspot + `list-findings` audit (`disciplines/deep-modules.md`) emitting Before/After HTML report without editing production code.
    - `retro` (`/zee-retro`): session retrospective (`mine-transcripts --mode retro` + `list-findings` + `list-runs` + `git log`) -> 4-level hardening + Skill Creation / Dead-Rule Pruning.
    - `recall <topic>` (`references/specialized.md` §7): calls `zee-tool.mjs mine-transcripts --mode recall --query "<topic>"`, emits `<= 40` line historical context brief without editing repo.
    - `triage` (`references/specialized.md` §8): 3-step Chief-of-Staff clustering (verify repro on `main` -> cluster shared root cause -> emit `/zee-plan`/`/zee-night` brief or `queue-finding`).
    - `investigate` / `perf` (`hillclimb`) / `loop` / `prototype` / `sweep` / `verify-init` / `verify-maintain`: load `references/specialized.md` (and `disciplines/verification-skill.md` for `verify-*`).
    - `resume`: run `zee-tool.mjs list-runs "<repoRoot>"` and follow Session-Pickup in `references/overnight.md`.
  - **Approved Plan Fast-Path**: if the user supplies an approved `plan.md` / `SPEC.md`, verify no repo drift and jump straight to **Build -> Check -> Merge**.
  - **`night` Mode (`/zee-night`, orthogonal modifier)**: load `references/overnight.md` (branch `zee/<slug>`, Unit 0 + Canary, `trustLevel`, `decisions.tsv`, 70% cutoff, Audit Judge, Chinese morning report).

## 2. Core Pipeline (Load Role Card Per Step)

Load `<zeeDir>/references/protocols.md` for bus schemas, Trust Ladder (`T1`/`T2`/`T3`), Pinned SHA, and worktree merging. Every `SPAWN` prompt MUST start with `<zeeDir>/worker.md` header, explicit target model + options, role card path, bus path, and pinned SHA.

1. **Scout (`roles/scout.md`)** [L2+]: read-only pointer map (`file:line`, gate cmds, `riskPaths`, non-grep readers, MCP evidence). Re-check level (upgrade only).
2. **Design (`roles/architect.md` + `roles/ui.md`)**:
   - **Bug Intent**: skip Architect; write 10-line `<busDir>/bug-brief.md` as Reviewer Axis 1 anchor, then run Bug Fast-Track in `roles/coder.md` (Phase 1 red repro before editing production code).
   - **Feature / Refactor**: Architect emits `plan.md` (data shape, Test Seam, Throughput Checkpoint, Out-of-Scope, falsifiable `Done Predicate`, slices **≤5 files / ≤400 LOC**; L3 runs Arena + Judge + Graft). Validate with `zee-tool.mjs check-plan`.
   - **UI Scope** (`uiGlobs` or visual task): `ui` emits `ui-spec.md` alongside Architect.
3. **Build (`roles/coder.md`, `roles/ui.md`)**:
   - Run in isolated worktree (`ISOLATE`), injecting matched project skills from `zee-tool.mjs match-skills --repo "<repoRoot>" --files "<csv>" --role <role>`. Keep shared index files (`CHANGELOG.md`, `README.md`, global test registries) for the integration writer.
   - Commit on worktree branch and return `BRANCH`, `HEAD_SHA`, `VERIFY_MAP_DELTA`, and `LOCAL_CHECKS`.
4. **Check (`roles/verifier.md` + `roles/reviewer.md`) on Pinned SHA**:
   - **Strict Serial Gate 1 -> Gate 2 (L2 / L3 / Stage 5 / `night` under `T1` default, or any `riskPaths` / UI / `GATE_CHANGE_RATIONALE` slice)**: ALWAYS run `Verifier` (**Gate 1**, with `--fuzz` enabled by default on `L3`, `Stage 5`, and `T3`) first; launch cross-family `Reviewer`(s) (**Gate 2**) ONLY after Gate 1 returns `VERDICT: PASS`. Under `readiness`-verified `T2`/`T3` non-risk two-way-door slices, `Verifier` `PASS` unlocks merge onto `zee/<slug>` with cross-family batch/morning sampling (`protocols.md`).
   - `Reviewer` MUST exclude the `family` used by `Coder`/`UI` (pass `authorFamily` on Pi) and run `zee-tool.mjs gate-tamper-diff` first; include ≥1 multimodal reviewer when UI screenshots exist.
   - **Lead Verifier Rerun**: re-run any dynamic Axis 3 `P0/P1` repro command once before triggering rework, and build an explicit Agreement Map for multi-reviewer passes.
   - **Gardening Queue Capture**: persist non-blocking `P2` smells, missing Test Seams, and repeated workarounds into `.agents/gardening-queue.jsonl` via `zee-tool.mjs queue-finding` instead of mid-task scope creep.
5. **Merge (`Sequential Grafting`)**: merge verified SHAs one by one, verifying after each merge and pruning clean worktrees via `cleanup-worktrees --prune-safe`.

## 3. Four-Level Failure Ladder, Partial Salvage & 70% Cutoff

- **Partial Salvage Rule**: on `[STATUS: *_PARTIAL]`, inspect rescued `partialText` and `git status/HEAD` before re-dispatching.
- **70% Wall-Clock / Budget Cutoff**: when approaching 70% of wall-clock or delegate budget, STOP opening new feature units; immediately finish integrating verified SHAs, update `state.json`, and deliver the complete Chinese summary.
- **Level 0 · Micro-Fix (≤15 lines, localized, unambiguous)**: Orchestrator fixes directly, commits new SHA, and re-runs `Verifier`.
- **Level 1 · 1st Substantive Failure**: fresh same-tier `Coder`/`UI` with consolidated scope + 5-line root-cause reflection; allow evidence-backed objection.
- **Level 2 · 2nd Failure on Same Root Cause**: state shared premise -> `Scrap` back to `Architect` (max 1) OR escalate to `heavy` tier (prefer switching `family`).
- **Level 3 · 3rd Failure (Hard Fuse)**: halt. Interactive -> Chinese root cause & options. `night` -> mark `parked`, continue unrelated units; 2 consecutive `parked` units trigger global stop + Chinese morning report.

## 4. Guardrails & Operator Controls

- **One-Way Doors (Always Pause in Chinese)**: merge to protected `main`/trunk, `git push --force`, destructive data deletion, production deploy, external messages, and `denyCommands`.
- **Zero Polling**: after async `SPAWN`, yield the turn with zero tool calls and wait for completion wakeups.
- **Operator Overrides**: `stop` cancels active delegates; `fewer` cancels extra delegates; `pause` runs safe-pause checkpoint (`references/overnight.md`).
- **Final Report (Ketchup Format in Chinese — `disciplines/phase-boundaries.md`)**: visual/Before-After evidence & Pinned SHA -> what changed & why -> Merge Danger (two-way vs one-way doors & blast radius) -> `backup` models used -> ≤30-char decision cards for open forks.
