# Project 0→1 Mode (`greenfield.md` v4)

Auto-triggers on `/zee init`, an empty repository / missing Git `HEAD`, or an explicit request to build a new product/project from scratch. **All product interviews, spec summaries, sign-off prompts, and delivery notes presented to the user MUST be in Simplified Chinese (简体中文).**

> **Stage 1–2 Write Lock (`init-design`)**: both Pi Extension and AGY `agy-guard.mjs` automatically hold the `init-design` write lock across Stage 1–2 (allowing only `<busDir>`, `.scratch/`, `.agents/`, and root `SPEC.md`/`ARCHITECTURE.md`/`GLOSSARY.md`/`DESIGN.md`) until Stage 3 M0 writes `<repo>/.agents/zee.project.json`.

## Pre-Check · Non-Empty Repo Guard
Before starting Stage 1, inspect the current working directory. If it already contains source code or existing Git commits (and the user did not explicitly ask to build inside this existing repo), pause in Chinese and ask whether to create a new subdirectory or switch to an empty folder before writing anything.

## Stage 1 · Product Shaping & Scope Lock (0 -> 0.3)
Orchestrator works directly with the user in Chinese (never delegate user interviews):
1. Run structured decision-tree **Grilling** (multi-round as needed; every question includes a `-> 推荐` default) until 4 product anchors are locked:
   - **Target User & Core Journeys**: the exact 2–3 end-to-end user flows that define v1 success.
   - **MVP vs Out-of-Scope**: explicitly list tempting features cut from v1 so autonomous slices do not bloat.
   - **Stack, Data & Runtime Shape**: CLI / Web / API / Game / Bot, language/framework, persistence, auth/config model.
   - **Visual Tone** (if UI): product personality, density, dark/light support, reference direction.
2. Write `<busDir>/SPEC.md` (and on AGY mirror `<artifactDir>/implementation_plan.md` with `RequestFeedback: true` when awaiting sign-off), then record Stage 1 completion via `zee-tool.mjs update-state "<busDir>" --mode init --status stage1-spec` and `zee-tool.mjs log-decision`.
3. **Default Product Sign-Off Gate**: pause once and present a concise Chinese summary of `SPEC.md` (核心流程 + 明确砍掉的 Out-of-Scope + 技术栈) for user approval before building. Skip this pause only if the user supplied a complete spec or explicitly granted full autonomy ("全权交给你").

## Stage 2 · Technical & Design Foundation (Mandatory Two-Beat Serialization)
**Never run `Scout ∥ UI ∥ Architect` blindly in a single beat!** Architect MUST consume Scout's live-verified toolchain and acceptance APIs before freezing contracts:
1. **Beat 1 (`Scout ∥ UI` in parallel)**:
   - **`Scout` (0→1 Research & Live Probe Mode)**: inspect local runtimes, compilers, SDKs, package managers, and **live-verify every critical build/test/headless-screenshot/automation API** (running a self-cleaning `/tmp` probe with `trap 'rm -rf "$TMP"' EXIT` if needed) so downstream slices never build against broken flags or stale library APIs.
   - **`UI`** (if visual): produces `<busDir>/DESIGN.md` (Design Read 3 dials, palette/type/spacing tokens, component rules) and `<busDir>/ui-spec.md` (including visual rubric & exact screenshot states).
   - After Beat 1 completes, record the checkpoint with `zee-tool.mjs update-state "<busDir>" --status stage2-beat1 --inc-delegates 2` and `zee-tool.mjs log-decision`.
2. **Beat 2 (`Architect` — consumes Beat 1 outputs)**:
   - Consumes `<busDir>/context.md` (Scout's verified toolchain + APIs) and `<busDir>/DESIGN.md` / `ui-spec.md` to emit ONE clean, single-source `<busDir>/ARCHITECTURE.md`, `<busDir>/GLOSSARY.md`, and a **Vertical Milestone Roadmap** (`M0 -> M1 -> M2..Mk -> M_final`).
   - **Slice Hard Budget**: every slice MUST stay **≤5 files and ≤400 LOC** so `Coder` completes cleanly without hitting wall-clock timeouts.
   - **No Dual-Truth Patching**: never append trailing `cat >>` amendments onto `ARCHITECTURE.md`; update the single canonical contract cleanly, validate with `zee-tool.mjs check-plan`, and immediately update the bus via `zee-tool.mjs update-state "<busDir>" --status stage2-planned --inc-delegates` + `log-decision`.

## Stage 3 · M0 Foundation Commit + M1 Walking Skeleton
1. **M0 · Bootstrap Foundation** (single `Coder`, before any worktree fan-out):
   - Initialize `git init` (if needed), create `.gitignore`, minimal runnable project scaffold, formatter/linter/typecheck, 1 runnable smoke test, and `<repo>/.agents/zee.project.json` (populating real `testCmds`, `buildCmd`, `lintCmd`, `riskPaths`, `uiGlobs`, `denyCommands`).
   - Copy locked `SPEC.md`, `ARCHITECTURE.md`, `GLOSSARY.md`, and `DESIGN.md` into repo docs.
   - **Optional Persistent Verification Feature Map**: for multi-screen UI or multi-command CLI apps, also create a lightweight `<repo>/.agents/verify-map.md` (or `.agents/skills/verify-<app>/SKILL.md`) mapping the app's boot command, routes/controls, and deterministic screenshot/assertion targets so every subsequent Verifier run reuses one consistent harness.
   - Verify build + smoke test exit 0, then make **`chore: bootstrap foundation`** (Initial Commit). Update `state.json` via `zee-tool.mjs update-state`. Worktrees, Pinned SHA, and deterministic gates are now unlocked.
2. **M1 · Walking Skeleton** (single owner, serial end-to-end):
   - Implement the single thinnest vertical slice piercing every layer (entry/UI -> logic/API -> storage/audio -> real E2E test) to prove the architecture runs live before parallelizing. Run Gate 1 `Verifier` `PASS` before starting M2.

## Stage 4 · M2..Mk Autonomous Vertical Slices
Execute remaining MVP slices in DAG order using standard `zee` L2/L3 closed loops (`Coder`/`UI` in isolated atomic worktrees -> **Gate 1 `Verifier` `PASS`** -> **Gate 2 Cross-Family `Reviewer`** -> Sequential Merge + commit per green slice; never modify `CHANGELOG.md`/`README.md` on parallel branches). Honor the **70% wall-clock cutoff** so verified slices are integrated cleanly before timeout. If the user steps away or requests unattended completion, transition seamlessly into `references/overnight.md`.

## Stage 5 · 0→1 Delivery & Cold-Start Readiness (0.9 -> 1.0)
Before declaring the 0→1 project complete:
1. **Polish Pass**: verify empty states, error states, loading/controls feedback, and responsive layout (if UI).
2. **Cold-Start Check (Gate 1 · `Verifier`)**: test installation, build, and startup from a clean state following the documented commands; run full core user-journey E2E (with final screenshots saved to `<busDir>/screenshots/` if UI).
3. **Handover Docs** (Orchestrator or integration single-writer): write a concise, accurate `README.md` (project overview, prerequisites, setup/env vars, run/test commands, directory layout) and `.env.example` (no real secrets).
4. **Cross-Family Final Audit (Gate 2 · ONLY after Gate 1 `PASS`)**: run 1 independent cross-family Reviewer/Judge pass checking `SPEC.md` coverage vs delivered code, screenshots, and cold-start receipts. On AGY mirror `<artifactDir>/walkthrough.md` (with screenshot `carousel`); deliver the final Chinese summary.
