---
name: zee
description: >-
  Universal harness-agnostic multi-model autonomous engineering workflow.
  Supports 0-to-1 greenfield projects, 1-to-100 risk-routed iteration, multi-model
  Arena architecture debate, cross-family adversarial review, and overnight autonomous
  runs from a single role-model config. Use when explicitly invoked with /zee or when
  the user asks to run a task with the zee workflow.
disable-model-invocation: true
---

# zee — Universal Multi-Model Autonomous Workflow

Command syntax: `/zee <request> [init | L0 | L1 | L2 | L3 | debate | review | night]`
Current session acts as **Orchestrator** on any harness. Never delegate orchestration itself.

## 0. Preflight (Every Run)

1. Load `references/harness.md` to bind abstract ops (`PROBE`, `SPAWN`, `ISOLATE`, `ASK`, `VISUAL_CHECK`, `SCHEDULE`) to the active harness.
2. Read `~/.agents/zee-config.json` (plus optional `<repo>/.agents/zee.project.json` and `<repo>/.agents/zee.local.json`). If missing, run `zee-setup` first.
3. Run `PROBE` once per thread. Resolve each needed role slot (`bindings.<harness>` -> `prefer` -> authorized `backup`) with **Capability Clamping** onto live supported option values (cap routine effort at `xhigh`). Fail closed if no authorized model is available; always announce any `backup` switch.
4. Detect workspace state (`git rev-parse --verify HEAD`, dirty tree, `CONTEXT.md`/`GLOSSARY.md`, `docs/adr/`).
5. Create Out-of-Tree Run Bus via:
   `node ~/.agents/skills/zee/scripts/zee-tool.mjs init-run "<repoRoot>" "<slug>"`
   Store all handoff artifacts under `~/.local/state/zee/runs/<repo-key>/<slug>/`. Never use repo-local `.scratch/` as the worker bus (uncommitted files do not enter worktrees and collide with issue trackers).

## 1. Intake & Two-Track Routing

Classify unknowns before asking: **code facts -> Scout**; **observable tech forks -> prototype**; **product/preference forks -> `ASK`** (one batch with recommended defaults).

- **Track A · Project 0→1 (`init` or empty repo / no `HEAD` / new product request)**
  Load `references/greenfield.md` and run Stages 1–5 (`SPEC.md` sign-off -> Architecture + `DESIGN.md` + Roadmap -> M0 Foundation Commit + M1 Walking Skeleton -> M2..Mk auto slices -> Cold-Start & E2E Delivery).
- **Track B · 1→100 Risk-Routed Execution (`Risk × Intent × Mode`)**
  Assign provisional level (re-evaluate after Scout; **upgrade only, never downgrade**):
  - **L0 Direct**: non-risk path, ≤1 file trivial edit/Q&A -> Orchestrator executes and runs a quick check.
  - **L1 Quick**: low-risk local change, no contract/schema/UI-system impact -> `[optional Scout]` -> `Coder(standard)` or `UI(standard)` -> `Verifier`.
  - **L2 Standard**: multi-file feature, bug fix, refactor, or **any edit touching `riskPaths`** (auth, crypto, billing, migrations, live trading/signing, public APIs) -> full pipeline + 1 cross-family `Reviewer`.
  - **L3 High-Stakes / Debate**: cross-module architecture, concurrency/state-machine change, major redesign, or explicit `debate`/`L3` -> `Scout(Deep)` -> orthogonal **Arena** + cross-vendor `Judge` + Orchestrator **Graft** -> `Coder(heavy)` / `UI(heavy)` -> `Verifier` (Gate 1) -> 2–3 cross-family `Reviewers` (Gate 2).
  - **Standalone Modes**: `debate` stops after Arena + ADR/decision report; `review` runs `Reviewers` read-only on target diff/SHA without editing.
  - **`night` Mode (orthogonal modifier)**: load `references/overnight.md`. Applies autonomous branch isolation, Unit 0 verification harness + baseline, Canary first unit, `decisions.tsv` audit trail, budget fuse, and morning report.

## 2. Core Pipeline (Load Role Card Per Step)

Load `references/protocols.md` for bus schemas, Pinned SHA rules, and worktree merging. Every `SPAWN` prompt MUST start with the `worker.md` header, explicit target model + explicit options (preventing silent `max` inheritance), role card path, bus path, and pinned SHA.

1. **Scout (`roles/scout.md`)** [L2+]: read-only pointer map (`file:line`, test commands, `riskPaths`, non-grep readers). Re-check level (upgrade only).
2. **Design (`roles/architect.md` + `roles/ui.md`)**:
   - **Bug Intent**: skip Architect; open Bug Fast-Track in `roles/coder.md` (Phase 1 must commit or prove a fast **red reproduction** before touching production code).
   - **Feature / Refactor**: Architect produces `plan.md` (data shape, Test Seam, Throughput Checkpoint, Out-of-Scope, falsifiable `Done Predicate`, vertical slices; L3 runs orthogonal Arena + anonymous cross-vendor Judge + Orchestrator Graft).
   - **UI Scope** (matches `uiGlobs` or visual task): `ui` runs alongside Architect to emit `ui-spec.md` (state matrix, design tokens, visual rubric, optional `?variant=` prototype). Default L3 proceeds after design unless user asks to review plan first.
3. **Build (`roles/coder.md`, `roles/ui.md`)**:
   - Execute in isolated worktree (`ISOLATE`). Small full-stack slices stay single-owner; large full-stack freezes executable shared types first (or completes Slice 1 end-to-end) before parallel `Coder ∥ UI` on disjoint file lanes.
   - Writer commits on worktree branch and returns `BRANCH`, `HEAD SHA`, and local check results.
4. **Check (`roles/verifier.md` + `roles/reviewer.md`) on Pinned SHA**:
   - **L2**: run `Verifier` and 1 cross-family `Reviewer` in parallel on the exact `HEAD SHA` (merge findings).
   - **L3 / `night`**: run `Verifier` first (**Gate 1**); only on `PASS` launch 2–3 cross-family `Reviewers` (**Gate 2**).
   - `Reviewer` MUST exclude the `family` used by `Coder`/`UI` on this unit; include ≥1 multimodal reviewer when UI screenshots exist.
   - **Gate Tampering Rule**: any diff modifying existing tests, snapshots, baselines, lint/CI config, or pinned hashes requires explicit rationale + cross-family Reviewer countersign.
5. **Merge (`Sequential Grafting`)**: merge verified SHAs one by one into the integration branch (`zee/<slug>` in `night`), verifying after each merge. Never bulk-merge parallel branches.

## 3. Four-Level Failure Ladder & Circuit Breaker

- **Level 0 · Micro-Fix (≤15 lines, localized, unambiguous)**: Orchestrator fixes directly, commits new SHA, and re-runs `Verifier` (no heavy Coder delegate).
- **Level 1 · 1st Substantive Failure**: spawn a fresh same-tier `Coder`/`UI` with consolidated scope (original brief, all directives, findings, previous SHA); require a 5-line root-cause reflection before editing; allow evidence-backed objection.
- **Level 2 · 2nd Failure on Same Root Cause**: state the shared premise of both failed attempts.
  - Premise is in `plan.md` / boundaries -> trigger **`Scrap`** back to `Architect` (max 1 Scrap per task) using Subtract-Before-Add.
  - Premise is implementation difficulty -> escalate to `heavy` tier (prefer switching model `family`).
- **Level 3 · 3rd Failure (Hard Fuse)**: halt. Interactive -> present root cause & options to user. `night` -> mark unit `parked`, block dependents, continue unrelated units; 2 consecutive `parked` units trigger global stop + morning report.

## 4. Guardrails & Operator Controls

- **One-Way Doors (Always Pause)**: merge to protected `main`/trunk, `git push --force`, destructive data deletion, production deploy, external messages, and any command matching project `denyCommands` (e.g. live signing/trading/reading private keys).
- **Zero Polling**: after async `SPAWN`, yield the turn and wait for completion wakeups. Never run `sleep` loops or repeated status polling.
- **Operator Overrides**: `stop` cancels active delegates immediately; `fewer` cancels extra delegates with no replacement; `pause` runs safe-pause checkpoint (`references/overnight.md`).
- **Final Report**: open with user goal -> what changed & why -> before/after verification evidence & Pinned SHA -> one-way doors / blast radius -> any `backup` models used -> open decisions.
