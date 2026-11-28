# 剧本：新功能与迭代开发 (`feature`)

适用场景：明确的新特性开发、全栈联调、中型模块扩展、从 `plan.md` 自动直通进入施工。

## 执行步骤
1. **查体检与总线**：运行 `<ZEE_TOOL> doctor --repo <repoRoot>` 读取 `projectProfile`（免猜包管理器、测试/Lint/构建命令）；若从规划延续则读 `<busDir>/plan.md` 与 `state.json`；若目录无 `.git` 或 `hasHeadCommit: false`，先跑 `<ZEE_TOOL> init-run <repoRoot> <slug> --ensure-git` 建立基线。
2. **契约先行**：跨前后端或跨模块改动先在 `plan.md` 锁定数据结构、公开接口与验收口径，避免并发互踩。
3. **按需并发，禁止重复建 worktree**：
   - **单模块/小改**：主厨直接施工 + 立刻跑语法检查与窄单测（0 子代理）。
   - **≥2 个互不重叠单元**：用 `<ZEE_TOOL> resolve-model --role <role> --allow-standalone` 解析模型（`standalone: true` 直接用默认模型）。Pi 下用 `zee_subagent` 声明式 `worktree` 并行派发 `coder`/`ui`，T3 用 `delegate_task(isolation:"worktree")`，AGY 用 `invoke_subagent(TypeName:"self", Workspace:"share", Model:"inherit")`（纯只读侦察用 `TypeName:"research"`，严禁自定义 Agent），**勿提前手调 `worktree-create`**；仅无内置隔离的宿主才先手调 `worktree-create`。
4. **集成验收与验证自举**：
   - 合入变更并补齐外部行为回归单测（拒绝锁死内部实现的同义反复废测）；
   - 若项目已有 `.agents/verify-ctl.mjs` 直接实跑；若缺失，纯库类跑原生 `projectProfile.detectedCmds.test`，Web/CLI/服务类的 0→1 或核心新功能按 `verify.md` (`init`) 自动自举轻量 `.agents/verify-ctl.mjs` 并跑通；
   - 跨模块或中高风险改动须经 `verifier` 实跑并由跨家族 `reviewer` 抽检（解析审查模型必传 `--author-family <fam>`）。
5. **落袋收口与园艺记账**：
   - 跑 `<ZEE_TOOL> gate-tamper-diff --repo <repoRoot> --working-tree`（纯新增测试归 `testFilesAdded` 不误报，若 `requiresCountersign: true` 须核查 `GATE_CHANGE_RATIONALE:`）；
   - 审查或施工发现的非阻断 P2 坏味道/缺失 Seam，用 `<ZEE_TOOL> finding add --repo <repoRoot> --pattern <slug> --summary "<摘要>"` 入园艺队列，**不扩 scope 顺手大改**；
   - 允许提交上下文下主测跑绿先 `update-state`、`log-decision` 与小步 `git commit` 落袋，最后 `cleanup-worktrees <repoRoot> --prune-safe` 清理已合入工作树。
