# Plan Mode: Grill-First Discovery -> Crystallized Plan (`plan-mode.md` v4)

Triggered by `/zee-plan <idea/request>` or `/zee plan <idea/request>` (append `L3` or `debate` to force orthogonal multi-model Arena during Step 3). **All user-facing questions, decision summaries, and final handoff notes MUST be in Simplified Chinese (简体中文). Never write or edit production code in this mode.**

> **Persistent Multi-Turn Write Lock**: both Pi Extension (`zee-gate` branch entry) and AGY `agy-guard.mjs` (`$PLUGIN_DATA/sessions/<cid>.json`) keep the `plan` write lock active across ALL Grill Q&A turns until you explicitly invoke `/zee`, `/zee-night`, or unlock. Allowed writes include `<busDir>`, `/tmp/zee-*`, `.scratch/`, `docs/plans/`, `docs/adr/`, and `GLOSSARY.md` (for inline domain modeling).

## Step 1 · Ground Facts First (`Scout`)
- **Existing Repo**: spawn read-only `Scout` (`roles/scout.md`) to collect `file:line` pointers, real gate commands, touched `riskPaths` / `uiGlobs`, domain glossary terms, and non-grep readers.
- **Empty / 0→1 Idea**: run `Scout` in External & Toolchain Research mode (local runtimes + current stable framework APIs).
- **Iron Rule**: never ask the user any fact that `Scout` can observe from the codebase or environment; background fact lookups should not block unrelated frontier questions.

## Step 2 · Decision-Tree Grilling + Active Domain Modeling (Multi-Round in Chinese)
Load `<zeeDir>/disciplines/domain-modeling.md`. Orchestrator works directly with the user (never delegate user interviews):
1. Build an internal decision tree of every unresolved **product, scope, UX, contract, or architecture trade-off** surfaced by Step 1.
2. Ask along the current decision frontier in crisp Chinese batches (≤5 questions per round, separated by `---`); **every question MUST carry `➡️ 推荐：<option>（理由）` phrased so replying `是` / `yes` / `按推荐` cleanly adopts defaults**.
3. **Inline Domain Modeling**: challenge vague or overloaded domain terms immediately, update `GLOSSARY.md` (including `_Avoid_` synonyms) inline, and write a concise 1-paragraph `docs/adr/NNNN-slug.md` **only** when all 3 ADR conditions hold (hard to reverse + confusing without context + real trade-off).
4. **Optional Dual-Mode Prototype**: when a state-machine rule or visual direction fork is better seen than debated, run `references/specialized.md#4` (single-file pure HTML logic sandbox OR host-page `?variant=` UI switcher) before locking the plan.
5. Continue round by round until every high-impact fork is resolved.

## Step 3 · Crystallize Executable Plan Package (`Architect` [+ `UI`])
1. Invoke `Architect` (`roles/architect.md`, plus `disciplines/deep-modules.md` for Design-It-Twice when interfaces are non-trivial) with `<busDir>/context.md` + locked Grill decisions:
   - Use L3 orthogonal **Arena** + anonymous cross-vendor `Judge` + Orchestrator **Graft** when the user passed `L3`/`debate` OR the scope has high architectural risk; otherwise use `architect.primary`.
   - If `uiGlobs` are touched or the idea includes UI, spawn `UI` (`roles/ui.md`) in parallel to emit `ui-spec.md` (and `DESIGN.md` for 0→1).
2. Write the finalized plan into a user-visible repository path (default: `<repo>/.scratch/<slug>/plan.md`, or `<repo>/docs/plans/<slug>.md` if the repo uses `docs/plans/`, plus sibling `ui-spec.md` and optional behavior-contract slice tickets under `.scratch/<slug>/issues/NN-*.md` when requested) AND mirror a copy into `<busDir>/plan.md`. Update bus state via:
   `node "<zeeDir>/scripts/zee-tool.mjs" update-state "<busDir>" --status planned`
3. Every plan document MUST pass:
   `node "<zeeDir>/scripts/zee-tool.mjs" check-plan "<planPath>"`
   verifying all 5 required sections and single-slice budgets (**≤5 files / ≤400 LOC**):
   - **目标与明确不做（Out-of-Scope）**
   - **关键决策记录**（Grill 阶段拍板的每一项取舍与理由）
   - **数据形状、共享契约与文件归属**（若计划前后端 `Coder ∥ UI` 或多 `Coder` 并行，必须显式把“共享可编译契约/Mock 数据提交”列为前置 Slice 0，或规定由单人串行打通第 1 条垂直切片后再并行）
   - **Test Seam、Throughput Checkpoint 与可机检的 `Done Predicate`**
   - **带 `blockedBy` 依赖的垂直切片清单**（每片独立可验收，≤5 文件 / ≤400 LOC）
4. **Google Antigravity Native Artifact Mirror**: when running in AGY, also write `<artifactDir>/implementation_plan.md` with `ArtifactMetadata: { Summary: "...", UserFacing: true, RequestFeedback: true }` so the user gets the native **Proceed** review card.

## Step 4 · Clean Stop & Seamless Execution Handoff
1. Stop cleanly — touch **zero** production source files.
2. Present a concise Chinese summary: plan file link, key locked decisions, slice count, risk level, and exact next command to execute it:
   - 交互式执行：`/zee 执行 <plan路径>`
   - 过夜无人值守执行：`/zee-night 执行 <plan路径>`

## Seamless Resume Rule (When User Later Runs `/zee` or `/zee-night` on a Plan)
When the user supplies an approved `plan.md` / `SPEC.md` produced by `zee-plan`:
1. Skip Intake Grilling and Architect re-design (honor the approved plan as authoritative unless `Scout` reveals repo drift since the plan was written).
2. Run Preflight -> verify `Done Predicate` & `denyCommands` -> jump straight into **Build (`Coder`/`UI`) -> Check (Gate 1 `Verifier` -> Gate 2 `Reviewer`) -> Sequential Merge**.
