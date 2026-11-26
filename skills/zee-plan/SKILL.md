---
name: zee-plan
description: Zee 0→1 / 复杂需求规划入口：探索摸底、关键决策澄清与原子 unit 批量落盘
disable-model-invocation: true
---

# `/zee-plan` — 规划与单元拆解

1. 遵循 `skills/zee/SKILL.md`、`skills/zee/principles.md` 与 `skills/zee/playbooks/plan.md`。
2. 先运行 `<Zee Tool CLI> init-run <repoRoot> <slug>` 创建任务总线 `busDir`。
3. 摸清当前仓库状况（非空可快速检索；空目录跳过侦察，**禁止刷外部 `todo` 工具或无关历史记忆检索空耗时间**，争取 1–3 轮完成落盘）。
4. 向用户（或当前会话指令）确认最多 3–5 个关键架构/交互决策点（附推荐项；若对方已要求“按推荐直接推进”则立即敲定）。
5. 将设计契约与互不踩文件的 `units` 写入 `<busDir>/plan.md`，并使用 `<Zee Tool CLI> update-state <busDir> --status planned --units '[...]'` **一次性批量落盘**后汇报。
