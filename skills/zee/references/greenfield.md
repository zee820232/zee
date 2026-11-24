# Project 0→1 Mode (`greenfield.md`)

Auto-triggers on `/zee init`, an empty repository / missing Git `HEAD`, or an explicit request to build a new product/project from scratch. **All product interviews, spec summaries, sign-off prompts, and delivery notes presented to the user MUST be in Simplified Chinese (简体中文).**

## Pre-Check · Non-Empty Repo Guard
Before starting Stage 1, inspect the current working directory. If it already contains source code or existing Git commits (and the user did not explicitly ask to build inside this existing repo), pause in Chinese and ask whether to create a new subdirectory or switch to an empty folder before writing anything.

## Stage 1 · Product Shaping & Scope Lock (0 -> 0.3)
Orchestrator works directly with the user in Chinese (never delegate user interviews):
1. Run structured decision-tree **Grilling** (multi-round as needed; every question includes a `-> 推荐` default) until 4 product anchors are locked:
   - **Target User & Core Journeys**: the exact 2–3 end-to-end user flows that define v1 success.
   - **MVP vs Out-of-Scope**: explicitly list tempting features cut from v1 so autonomous slices do not bloat.
   - **Stack, Data & Runtime Shape**: CLI / Web / API / Bot, language/framework, persistence, auth/config model.
   - **Visual Tone** (if UI): product personality, density, dark/light support, reference direction.
2. Write `<busDir>/SPEC.md` (and copy to `<repo>/SPEC.md` once initialized).
3. **Default Product Sign-Off Gate**: pause once and present a concise Chinese summary of `SPEC.md` (核心流程 + 明确砍掉的 Out-of-Scope + 技术栈) for user approval before building. Skip this pause only if the user supplied a complete spec or explicitly granted full autonomy ("全权交给你").

## Stage 2 · Technical & Design Foundation
1. **Scout (0→1 Research Mode)**: inspect local runtimes/package managers and verify current stable initialization/API patterns for the chosen stack.
2. **Architect (+ `UI` in parallel if visual)**:
   - `Architect` (single primary or L3 Arena if architecture is novel) produces `ARCHITECTURE.md`, `GLOSSARY.md` (domain terms), and a **Vertical Milestone Roadmap** (`M0 -> M1 -> M2..Mk -> M_final`).
   - `UI` produces `DESIGN.md` (Design Read 3 dials, color/type/spacing tokens, component rules) and `ui-spec.md`. For open-ended consumer UI, optionally render 2–3 visual direction prototypes (`?variant=A|B|C`) for user sign-off in Chinese.

## Stage 3 · M0 Foundation Commit + M1 Walking Skeleton
1. **M0 · Bootstrap Foundation** (single `Coder`, before any worktree fan-out):
   - Initialize `git init` (if needed), create `.gitignore`, minimal runnable project scaffold, formatter/linter/typecheck, 1 runnable smoke test, and `<repo>/.agents/zee.project.json` (populating real `testCmds`, `buildCmd`, `lintCmd`, `riskPaths`, `uiGlobs`, `denyCommands`).
   - Copy locked `SPEC.md`, `ARCHITECTURE.md`, `GLOSSARY.md`, and `DESIGN.md` into repo docs.
   - Verify build + smoke test exit 0, then make **`chore: bootstrap foundation`** (Initial Commit). Worktrees, Pinned SHA, and deterministic gates are now unlocked.
2. **M1 · Walking Skeleton** (single owner, serial end-to-end):
   - Implement the single thinnest vertical slice piercing every layer (entry/UI -> logic/API -> storage -> real E2E test) to prove the architecture runs live before parallelizing.

## Stage 4 · M2..Mk Autonomous Vertical Slices
Execute remaining MVP slices in DAG order using standard `zee` L2/L3 closed loops (`Coder`/`UI` in isolated worktrees -> `Verifier` Gate 1 -> Cross-Family `Reviewer` Gate 2 -> Sequential Merge + commit per green slice). If the user steps away or requests unattended completion, transition seamlessly into `references/overnight.md`.

## Stage 5 · 0→1 Delivery & Cold-Start Readiness (0.9 -> 1.0)
Before declaring the 0→1 project complete:
1. **Polish Pass**: verify empty states, error states, loading feedback, and mobile layout (if UI).
2. **Cold-Start Check (`Verifier`)**: test installation, build, and startup from a clean state following the documented commands; run full core user-journey E2E (with final screenshots if UI).
3. **Handover Docs**: write a concise, accurate `README.md` (project overview, prerequisites, setup/env vars, run/test commands, directory layout) and `.env.example` (no real secrets).
4. **Cross-Family Final Audit**: run 1 independent cross-family Reviewer/Judge pass checking `SPEC.md` coverage vs delivered code and cold-start receipts, then deliver the final Chinese summary.
