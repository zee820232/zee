# 剧本：0→1 规划与单元拆解 (`plan`)

适用场景：`/zee-plan`、全新项目建项、跨模块需求立项、准备 `/zee-night` 过夜任务队列。

## 执行步骤
1. **建总线**：运行 `node <scripts>/zee-tool.mjs init-run <repoRoot> <slug>` 拿到 `busDir`（所有产物写入 `busDir`，不污染项目根目录）。
2. **极速摸底**：若仓库非空，快速摸清技术栈、测试入口与结构；空目录则跳过侦察直接定方案。**规划阶段禁止刷外部 `todo` 工具或冗长记忆检索，控制上下文简洁，争取 1–3 轮内落盘**。
3. **聚焦关键决策**：用简体中文向用户一次问清最多 3–5 个会实质影响架构/交互的核心选择（附推荐项；若用户指定按推荐推进则立即敲定）。
4. **拆解原子 Unit**：每个 unit 明确 `id`、互不重叠的 `files` 边界、可机测验收标准与推荐 `role`。
5. **批量落盘**：
   - 将完整实施蓝图写入 `<busDir>/plan.md`；
   - 用 `zee-tool.mjs update-state <busDir> --status planned --units '[...]'` **一条命令批量登记全部 units**（支持多 `--unit-upsert`，勿并发调多条命令）。
6. **停在规划门口**：呈报 `<busDir>/plan.md` 路径与单元清单，确认后切入 `/zee` 或 `/zee-night`。
