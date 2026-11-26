# Project 0→1 Mode (`greenfield.md` v4.2)

Auto-triggers on `/zee init`, an empty repository / missing Git `HEAD`, or an explicit request to build a new product/project from scratch. **All product interviews, spec summaries, sign-off prompts, and delivery notes presented to the user MUST be in Simplified Chinese (简体中文).** *(Runtime guards `guard-core.mjs` / `agy-guard.mjs` hold the `init-design` write lock across Stage 1–2 until Stage 3 M0 writes `<repo>/.agents/zee.project.json`.)*

## Pre-Check · Non-Empty Repo Guard
Before starting Stage 1, inspect the current working directory. If it already contains source code or existing Git commits (and the user did not explicitly ask to build inside this existing repo), pause in Chinese and ask whether to create a new subdirectory or switch to an empty folder before writing anything.

## Stage 1 · Product Shaping & Scope Lock (0 -> 0.3)
Orchestrator works directly with the user in Chinese (never delegate user interviews):
1. Run structured decision-tree **Grilling** (multi-round as needed; every question includes a `-> 推荐` default) until 4 product anchors are locked: **Target User & Core Journeys**, **MVP vs Out-of-Scope**, **Stack, Data & Runtime Shape**, and **Visual Tone** (if UI).
2. Write `<busDir>/SPEC.md` (mirror `<artifactDir>/implementation_plan.md` with `RequestFeedback: true` on AGY when awaiting sign-off), then record Stage 1 completion via `zee-tool.mjs update-state "<busDir>" --mode init --status stage1-spec` and `zee-tool.mjs log-decision`.
3. **Default Product Sign-Off Gate**: pause once and present a concise Chinese summary of `SPEC.md` (核心流程 + 明确砍掉的 Out-of-Scope + 技术栈) for user approval before building. Skip only if the user supplied a complete spec or explicitly granted full autonomy ("全权交给你").

## Stage 2 · Technical & Design Foundation (Mandatory Two-Beat Serialization)
**Never run `Scout ∥ UI ∥ Architect` blindly in a single beat!** Architect MUST consume Scout's live-verified toolchain and acceptance APIs before freezing contracts:
1. **Beat 1 (`Scout ∥ UI` in parallel)**:
   - **`Scout` (0→1 Research & Live Probe Mode)**: inspect local runtimes, compilers, SDKs, package managers, and **live-verify every critical build/test/headless-screenshot/automation API** inside an isolated `/tmp/zee-probe-*` sandbox so downstream slices never build against broken flags or stale library APIs.
   - **`UI`** (if visual): produces `<busDir>/DESIGN.md` (Design Read 3 dials, palette/type/spacing tokens, component rules) and `<busDir>/ui-spec.md` (including visual rubric & exact screenshot states).
   - Record checkpoint with `zee-tool.mjs update-state "<busDir>" --status stage2-beat1` (on Pi, `zee_subagent` auto-accounts `delegatesDispatched` — NEVER manually pass `--inc-delegates` or `--delegate-id` on Pi; only non-Pi harnesses without `zee_subagent` pass `--inc-delegates --delegate-id <id>`) and `zee-tool.mjs log-decision`.
2. **Beat 2 (`Architect` — consumes Beat 1 outputs)**:
   - Consumes `<busDir>/context.md` and `<busDir>/DESIGN.md` / `ui-spec.md` to emit ONE clean, single-source `<busDir>/ARCHITECTURE.md`, `<busDir>/GLOSSARY.md`, and a **Vertical Milestone Roadmap** (`M0 -> M1 -> M2..Mk -> M_final`), keeping every slice **≤5 files and ≤400 LOC**.
   - **No Dual-Truth Patching**: update the single canonical contract cleanly (no trailing amendments), validate with `zee-tool.mjs check-plan`, and update `<busDir>/state.json` + `decisions.tsv`.

## Stage 3 · M0 Foundation Commit + M1 Walking Skeleton
1. **M0 · Bootstrap Foundation** (single `Coder`, before any worktree fan-out):
   - Initialize `git init` (if needed), `.gitignore`, minimal runnable scaffold, formatter/linter/typecheck, 1 runnable smoke test, and `<repo>/.agents/zee.project.json` (populating real `testCmds`, `buildCmd`, `lintCmd`, `riskPaths`, `uiGlobs`, `denyCommands`, optional `trustLevel` / `pathSkills`).
   - Copy locked `SPEC.md`, `ARCHITECTURE.md`, `GLOSSARY.md`, `DESIGN.md`, and any 3-condition `docs/adr/` entries into repo docs.
   - **Project-Local Verification Skill (`verify-<app>`)**: follow `<zeeDir>/disciplines/verification-skill.md` once M0/M1 runs to generate `<projectSkillsDir>/verify-<app>/SKILL.md` + `scripts/verify-ctl.(mjs|py|sh)` + `features/` (isolating all temp outputs in `/tmp/zee-verify-*` or `<busDir>`) AND **prove it live end-to-end on 1 mapped feature** (confirming evidence survives cleanup).
   - Verify build + smoke test exit 0, then make **`chore: bootstrap foundation`** (Initial Commit) and update `state.json`. Worktrees, Pinned SHA, and deterministic gates are now unlocked.
2. **M1 · Walking Skeleton** (single owner, serial end-to-end):
   - Implement the single thinnest vertical slice piercing every layer (entry/UI -> logic/API -> storage -> real E2E test) to prove the architecture runs live before parallelizing. Run Gate 1 `Verifier` `PASS` before starting M2.

## Stage 4 · M2..Mk Autonomous Vertical Slices
Execute remaining MVP slices in DAG order using standard `zee` L2/L3 closed loops (`Coder`/`UI` in isolated atomic worktrees -> **Gate 1 `Verifier` `PASS`** -> **Gate 2 Cross-Family `Reviewer`** -> Sequential Merge per green slice; keep `CHANGELOG.md`/`README.md` single-writer). Honor the **70% wall-clock cutoff** and transition seamlessly into `references/overnight.md` if unattended completion is requested.

## Stage 5 · 0→1 Delivery & Cold-Start Readiness (0.9 -> 1.0)
Before declaring the 0→1 project complete:
1. **Polish Pass**: verify empty states, error states, loading/controls feedback, and responsive layout (if UI).
2. **Cold-Start Check + Exploratory `--fuzz` (Gate 1 · `Verifier`)**: test installation, build, and startup from a clean state following documented commands; run full core user-journey E2E **plus default `--fuzz` exploratory edge-input/interaction fuzzing** (saving final screenshots to `<busDir>/screenshots/` and temp logs to `/tmp/zee-verify-*`).
3. **Handover Docs** (Orchestrator or integration single-writer): write a concise, accurate `README.md` and `.env.example` (no real secrets).
4. **Cross-Family Final Audit (Gate 2 · ONLY after Gate 1 `PASS`)**: run 1 independent cross-family Reviewer/Judge pass checking `SPEC.md` coverage vs delivered code, screenshots, and cold-start receipts. On AGY mirror `<artifactDir>/walkthrough.md` (with screenshot `carousel`); deliver the final Chinese summary.
