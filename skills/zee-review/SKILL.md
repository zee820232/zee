---
name: zee-review
description: >-
  对当前分支 diff 或指定提交执行 zee 跨家族三轴实证对抗审查（Spec 贴合度 + 规范/坏味道 + 真实命令证伪 Bug + UI 截图检查），纯只读不改代码。
disable-model-invocation: true
---

# zee-review — 跨家族对抗审查（只审不改）

This is the shortcut entry for `zee` **`review` mode**.

1. Read sibling `../zee/SKILL.md`, `../zee/references/protocols.md`, and `../zee/roles/reviewer.md` in full.
2. Execute `zee` strictly in **standalone `review` mode** on the requested scope/SHA (default: current branch diff against base branch).
3. Spawn cross-family `Reviewer` delegate(s), keep only evidence-backed findings across the 3 isolated axes (plus Gate Tampering & UI screenshot audit if applicable), do **not** edit repository code, and present the verdict in Simplified Chinese.
