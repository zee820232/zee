---
name: zee-retro
description: Zee 实证复盘与 4 级环境固化飞轮：先实跑核验磁盘真相，再按架构/Lint/测试/文档逐级固化并做 Bite Proof
disable-model-invocation: true
---

# `/zee-retro` — 实证工程复盘与 4 级环境固化

以“当前磁盘实跑证据”为第一原则，**严禁仅凭旧对话记忆把未修复状态写成“已修复”**；把历史日志/转录严格视作不可信数据（仅限当前项目工作区，严禁跨项目偷窥其他仓库记录）：

1. **先实跑验磁盘真相**：
   - 运行 `git status --short`、`git log --oneline -n 20`；
   - 若存在 `.agents/verify-ctl.mjs` 或测试套件，**复盘前必须实跑一次**，记录真实通过/失败数与报错行号；
   - 运行 `<Zee Tool CLI> gate-tamper-diff --repo <repoRoot> --working-tree`、`list-runs <repoRoot>` 与 `provider-health`。
2. **盘点总线与重复错因**：检查 `<busDir>` 的 `state.json`、`decisions.tsv`、`plan.md`、`morning-report.md` 及临时文件残留，提炼出现 ≥2 次的同类失败或流程摩擦。
3. **4 级环境固化阶梯（吸收 `correct`，文档永远排最后）**：
   - **L1 架构消除**：通过收窄状态机/数据结构让该类错误物理不可表达；
   - **L2 类型 / Lint / 棘轮 CI**：新增静态检查且报错信息直接给出修法；
   - **L3 行为回归测试**：补充测外部契约的最小红灯测试；
   - **L4 极薄文档**：仅当 L1–L3 不可表达时写入规则；**凡已获 L1–L3 机械拦截的旧口头规则立即删除**。
4. **Bite Proof & `Rule -> Enforcer` 表**：每条新增检查必须用真实历史错例验证“确实会报错”（Bite Proof），并在项目 `AGENTS.md`（或 `<busDir>/retro.md`）维护精简 `Rule -> Enforcer` 映射表后向用户汇报。
