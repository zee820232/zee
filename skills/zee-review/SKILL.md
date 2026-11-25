---
name: zee-review
description: >-
  对当前分支 diff 或指定提交执行 zee 跨家族三轴实证对抗审查（Spec 贴合度 + 规范/坏味道 + 真实命令证伪 Bug + UI 截图检查），纯只读不改代码。
disable-model-invocation: true
---

# zee-review — 跨家族对抗审查（只审不改）

This is the shortcut entry for `zee` **`review` mode**.

1. Read sibling `../zee/SKILL.md`, `../zee/references/protocols.md`, and `../zee/roles/reviewer.md` in full.
2. **Always initialize a dedicated independent run bus** via `node "<zeeDir>/scripts/zee-tool.mjs" init-run "<repoRoot>" "review-<short-slug>"` (NEVER reuse or mix artifacts into an old feature/init bus).
3. Execute `zee` strictly in **standalone read-only `review` mode** on the requested scope/SHA (default: current branch diff against base branch).
4. Spawn cross-family `Reviewer` delegate(s) (passing `authorFamily` on Pi when known), run Lead Verifier Rerun on any dynamic Axis 3 `P0/P1` repro command, keep only evidence-backed findings across the 3 isolated axes (5-level blast-radius certainty + lint suppression audit + Gate Tampering + UI screenshot audit if applicable), touch **zero** repo files, and present the verdict in Simplified Chinese.
