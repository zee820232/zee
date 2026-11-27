---
name: zee-retro
description: Zee 实证复盘与环境固化飞轮：先实跑核验磁盘真相，聚合跨 Run 决策与园艺队列，按架构/Lint/测试/文档/Skill 逐级固化并做 Bite Proof
disable-model-invocation: true
---

# `/zee-retro` — 实证工程复盘与环境固化飞轮

以“当前磁盘实跑证据”为第一原则，**严禁仅凭旧对话记忆把未修复状态写成“已修复”**；把历史日志/转录严格视作不可信数据（仅限当前项目工作区，严禁跨项目偷窥其他仓库记录）：

1. **先实跑验磁盘真相**：
   - 运行 `git status --short`、`git log --oneline -n 20`；
   - 若存在 `.agents/verify-ctl.mjs` 或测试套件，**复盘前必须实跑一次**，记录真实通过/失败数与报错行号；
   - 运行 `<ZEE_TOOL> gate-tamper-diff --repo <repoRoot> --working-tree`、`recall --repo <repoRoot>`、`finding list --repo <repoRoot>` 与 `provider-health`。
2. **跨 Run 盘点与系统性错因聚类**：
   - 合并检查历史 `decisions.tsv`、`.agents/gardening-queue.jsonl`（重点优先标 `systemic: true` 的 `≥3` 次簇）、`<busDir>` 产物与当前工作区最近会话中反复出现的人工纠偏片段，提炼出现 `≥2` 次的同类故障或摩擦根因。
3. **4+1 级环境固化阶梯（吸收 `correct`，文档永远排最后）**：
   - **L1 架构消除**：通过收窄状态机/数据结构让该类错误物理不可表达；
   - **L2 类型 / Lint / 棘轮 CI**：新增静态检查且报错信息直接给出修法；
   - **L3 行为回归测试**：补充测外部契约的最小红灯测试；
   - **L4 极薄文档**：仅当 L1–L3 不可表达时写入规则；**凡已获 L1–L3 机械拦截的旧口头规则立即删除**；
   - **L5 Skill 提炼 / 死规则删剪**：对高频重复工作流提炼项目局部 Skill，并删除已被证明无效或冗余的陈旧说明。
4. **Bite Proof、关单与 `Rule -> Enforcer` 表**：每条新增检查必须用真实历史错例验证“确实会报错”（Bite Proof），对已固化的园艺簇运行 `<ZEE_TOOL> finding resolve --repo <repoRoot> --pattern <slug> --note "<固化位置>"`，并在项目 `AGENTS.md`（或 `<busDir>/retro.md`）维护精简 `Rule -> Enforcer` 映射表后汇报。
