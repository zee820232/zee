# Plan Mode: Grill-First Discovery -> Crystallized Plan (`plan-mode.md`)

Triggered by `/zee-plan <idea/request>` or `/zee plan <idea/request>` (append `L3` or `debate` to force orthogonal multi-model Arena during Step 3). **All user-facing questions, decision summaries, and final handoff notes MUST be in Simplified Chinese (简体中文). Never write or edit production code in this mode.**

## Step 1 · Ground Facts First (`Scout`)
- **Existing Repo**: spawn read-only `Scout` (`roles/scout.md`) to collect `file:line` pointers, real gate commands, touched `riskPaths` / `uiGlobs`, domain glossary terms, and non-grep readers.
- **Empty / 0→1 Idea**: run `Scout` in External & Toolchain Research mode (local runtimes + current stable framework APIs).
- **Iron Rule**: never ask the user any fact that `Scout` can observe from the codebase or environment.

## Step 2 · Decision-Tree Grilling (Multi-Round in Chinese)
Orchestrator works directly with the user (never delegate user interviews):
1. Build an internal decision tree of every unresolved **product, scope, UX, contract, or architecture trade-off** surfaced by Step 1.
2. Ask along the current decision frontier in crisp Chinese batches (≤5 questions per round); **every question MUST carry `➡️ 推荐：<option>（理由）`**.
3. Continue round by round until every high-impact fork is resolved (if the user says "其余按推荐定" / "approve defaults", lock all remaining defaults and proceed immediately).

## Step 3 · Crystallize Executable Plan Package (`Architect` [+ `UI`])
1. Invoke `Architect` (`roles/architect.md`) with `<busDir>/context.md` + locked Grill decisions:
   - Use L3 orthogonal **Arena** + anonymous cross-vendor `Judge` + Orchestrator **Graft** when the user passed `L3`/`debate` OR the scope has high architectural risk; otherwise use `architect.primary`.
   - If `uiGlobs` are touched or the idea includes UI, spawn `UI` (`roles/ui.md`) in parallel to emit `ui-spec.md` (and `DESIGN.md` for 0→1).
2. Write the finalized plan into a user-visible repository path (default: `<repo>/.scratch/<slug>/plan.md`, or `<repo>/docs/plans/<slug>.md` if the repo uses `docs/plans/`, plus sibling `ui-spec.md` when applicable) AND mirror a copy into `<busDir>/plan.md` with `state.json` set to `status: "planned"`.
3. Every plan document MUST contain:
   - **目标与明确不做（Out-of-Scope）**
   - **关键决策记录**（Grill 阶段拍板的每一项取舍与理由）
   - **数据形状、共享契约与文件归属**
   - **Test Seam、Throughput Checkpoint 与可机检的 `Done Predicate`**
   - **带 `blockedBy` 依赖的垂直切片清单**（每片独立可验收）

## Step 4 · Clean Stop & Seamless Execution Handoff
1. Stop cleanly — touch **zero** production source files.
2. Present a concise Chinese summary: plan file link, key locked decisions, slice count, risk level, and exact next command to execute it:
   - Interactive execution: `/skill:zee 执行 <plan路径>`
   - Overnight autonomous execution: `/skill:zee-night 执行 <plan路径>`

## Seamless Resume Rule (When User Later Runs `/zee` or `/zee-night` on a Plan)
When the user supplies an approved `plan.md` / `SPEC.md` produced by `zee-plan`:
1. Skip Intake Grilling and Architect re-design (honor the approved plan as authoritative unless `Scout` reveals repo drift since the plan was written).
2. Run Preflight -> verify `Done Predicate` & `denyCommands` -> jump straight into **Build (`Coder`/`UI`) -> Check (`Verifier` + `Reviewer`) -> Sequential Merge**.
