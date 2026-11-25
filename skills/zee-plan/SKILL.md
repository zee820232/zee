---
name: zee-plan
description: >-
  先通过多轮决策树访谈（grill）把需求与取舍彻底聊透，再由架构师（可选多模型 Arena）沉淀成可执行的 plan.md 计划文档并干净停机，绝不直接改生产代码。
disable-model-invocation: true
---

# zee-plan — 深度访谈并沉淀计划文档

This is the shortcut entry for `zee` **`plan` mode**.

> **Zero-Config Standalone（单兵开箱即用）**：若未配置 `~/.agents/zee-config.json`，调用 `zee-tool.mjs resolve-model --allow-standalone --role architect` 退化为当前会话模型完成侦察、访谈与规划出稿（向用户输出一句简短中文提示即可，绝不阻塞）。

1. Read sibling `../zee/SKILL.md` (Preflight + User-Facing Language Policy) and `../zee/references/plan-mode.md` in full.
2. Execute `zee` strictly in **`plan` mode** (append `L3` if the user asks for multi-model Arena debate on the plan).
3. Communicate with the user in Simplified Chinese, write the finalized plan document, and **stop cleanly without modifying production source code**.
