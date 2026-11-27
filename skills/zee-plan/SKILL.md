---
name: zee-plan
description: Zee 显式只规划入口：探索摸底、原型探针、2-Shape 对比、极简决策澄清与原子 unit 批量落盘（带 plan 锁不写业务码）
disable-model-invocation: true
---

# `/zee-plan` — 显式规划与单元拆解

1. 遵循 `skills/zee/SKILL.md`、`skills/zee/principles.md` 与 `skills/zee/playbooks/plan.md`（纯规划模式，不修改业务源码）。
2. 先运行 `<ZEE_TOOL> doctor --repo <repoRoot>` 读取 `projectProfile`，再运行 `<ZEE_TOOL> init-run <repoRoot> <slug>`（空目录无 Git/HEAD 时加 `--ensure-git`）创建任务总线 `busDir`。
3. 摸清仓库现状（非空快速检索，空目录跳过侦察，**禁止刷外部 `todo` 空耗**，能用 30 秒探针沙盒实测裁决的技术分叉绝不反问）。
4. 仅把实验无法裁决的 **3–5 个产品/不可逆权衡**一次性问清用户（附推荐项；若对方声明“按推荐直接推进”则立即敲定）。
5. 将设计契约与互不踩文件的 `units` 写入 `<busDir>/plan.md`，并使用 `<ZEE_TOOL> update-state <busDir> --status planned --units-file <path|->` 一次性批量落盘后汇报停门等待确认。
