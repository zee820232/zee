# 剧本：新功能与迭代开发 (`feature`)

适用场景：明确的新特性开发、UI + 逻辑联调、中型模块扩展、多问题专项修复。

## 执行步骤
1. **查总线 / 建基线**：若从 `/zee-plan` 延续，读取 `busDir` 的 `plan.md` 与 `state.json`；若仓库尚无首次 `git commit`（`doctor --repo` 告警 `hasHeadCommit: false`），先做基础提交再启并行工作树。
2. **契约先行**：跨前后端改动先在 `plan.md` 敲定数据结构与公开函数名，避免互踩。
3. **默认按域拆分，禁止重复建 worktree**：
   - 单模块小改：主厨直接施工 + 立刻 `node --check`/窄单测。
   - **多互不重叠单元（≥2 个 unit）**：Pi 下直接调用 `zee_subagent` 传入声明式 `worktree` 参数并行派发 `coder` / `ui`（用 `resolve-model --harness pi --role <role>` 取回 `resolved.subagentArgs` 直接透传），**不要提前手调 `worktree-create` 以免路径冲突**；仅 Codex/CC 无内置 worktree 时才先手调 `worktree-create`。
4. **合并与集成验证**：
   - 将分支合入主工作区并补齐回归单测；
   - 运行完整语法校验、单元测试与 `.agents/verify-ctl.mjs`。
5. **先落袋再加餐与清理**：
   - 全量测试与 `.agents/verify-ctl.mjs` 跑绿后，**先执行 `update-state`、`log-decision` 与 `git commit` 把成果落袋**，严禁未提交前继续附加浏览器探活等重型加餐任务导致回合超时；
   - 运行 `gate-tamper-diff` 核查门禁（含 `.agents/verify-ctl.mjs`、`.agents/zee.project.json`、`test/`）、抑制注解、密钥与 `\uFFFD`；
   - 用 `cleanup-worktrees <repoRoot> --prune-safe` 清理已合入工作树。
