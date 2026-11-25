---
name: zee-arch
description: >-
  代码库深模块抗熵增巡检：结合 git log 热点、花园队列（list-findings systemic 模式）与删除测试定位浅模块、散弹修改与缺失 Test Seam，输出交互式 Before/After 架构体检报告并无缝转入 /zee-plan（只读不改业务代码）。仅在用户显式调用 /zee-arch 或要求做架构巡检时启用。
disable-model-invocation: true
---

# zee-arch — 代码库深模块抗熵增巡检

Read sibling `../zee/SKILL.md`, `../zee/disciplines/deep-modules.md`, and `../zee/disciplines/domain-modeling.md`. **All questions, summaries, and recommendations shown to the user MUST be in Simplified Chinese (简体中文). Never modify production code during `/zee-arch`.**

> **Zero-Config Standalone（单兵开箱即用）**：若未配置 `~/.agents/zee-config.json`，调用 `zee-tool.mjs resolve-model --allow-standalone --role architect` 退化为当前会话模型执行（附一句简短中文提示即可，绝不阻塞）。

## Pipeline
1. **Preflight & Bus**: initialize an out-of-tree bus (`zee-tool.mjs init-run "<repoRoot>" "arch-audit"`). Confirm the `plan` write lock is active.
2. **Churn-First Hotspot & Gardening Scan (`Scout`, Read-Only)**:
   - Run `node "<zeeDir>/scripts/zee-tool.mjs" list-findings --repo "<repoRoot>"` to inspect `.agents/gardening-queue.jsonl` and **surface any `systemic: true` (`count >= 3`) patterns at top priority**.
   - Inspect `git log` churn hotspots (last 60–90 days / 50–100 commits), largest frequently-touched files, existing `GLOSSARY.md` / `docs/adr/`, and test layout. Prioritize hot paths (YAGNI — ignore untouched cold modules).
3. **Deep-Module Diagnosis (`Architect`, Read-Only)**: apply the **Deletion Test** and 4-Dependency classification (`disciplines/deep-modules.md`) on the top hotspots and `systemic: true` clusters to find 2–4 concrete candidates:
   - Shallow pass-through wrappers adding indirection without hiding complexity.
   - Shotgun-surgery clusters where one business rule ripples across many files.
   - Missing Test Seams forcing brittle internal mocks.
   - Overloaded domain terms needing `GLOSSARY.md` / ADR clarification.
4. **Visual Before/After Audit Report**:
   - Emit a clean self-contained HTML report (`<busDir>/artifacts/arch-audit.html`, or render inline via `html_preview` -> `html_render` on T3 Code) showing each candidate's **Before vs After module boundary**, **Leverage / Effort badge**, exact repo-relative affected file paths (never prepend `src/` onto `tests/` or root paths!), and proposed **Test Seam**.
   - Present a crisp Chinese summary table (top 2–4 candidates with `➡️ 推荐` priority, highlighting any `systemic: true` clusters).
5. **Clean Bus Closeout & Seamless Plan Handoff**:
   - Touch zero production source files.
   - Mark the audit bus complete via `zee-tool.mjs update-state "<busDir>" --status completed` and log a concise summary row to `decisions.tsv`.
   - Ask which candidate (if any) the user wants to deepen; on selection, hand off directly into `/zee-plan` (including **Design-It-Twice** orthogonal interface exploration + `domain-modeling`).
