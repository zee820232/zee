# 剧本：过夜无人值守循环 (`overnight`)

适用场景：`/zee-night`，用户在睡眠或离线前将清晰 `units` 队列交给 Zee 自动推进。

## 启动前置与续跑接棒
1. 运行 `<ZEE_TOOL> doctor --repo <repoRoot>` 确认 `projectProfile`（Git 基线 `hasHeadCommit: true`、测试命令与 `verifiability`）与总线健康度；若无 Git 基线先 `init-run <repoRoot> <slug> --mode night --ensure-git`，若 `verifyCtl: false` 且为 Web/CLI/服务项目优先把自举 `.agents/verify-ctl.mjs` 列为 `U0`。
2. 确认 `<busDir>/plan.md` 与 `state.json` 存在可机测 `units`（Windows PowerShell 复杂 JSON 一律走 `--units-file <path|->`）；开启夜跑模式并写入当前宿主 `conversationId`（若可得，供 AGY `Stop` Hook 严格会话隔离）与 `phase=start` 轮次分界：
   ```bash
   <ZEE_TOOL> update-state <busDir> --mode night --status running [--conversation-id <cid>] --budget '{"maxDelegates":12,"maxFailuresPerUnit":2}'
   <ZEE_TOOL> log-decision <busDir> --unit RUN --phase start --decision "night-start" --why "进入过夜推进" --result running
   ```
3. **冷启动接棒（`session-pickup`）与安全挂起（`pause-safely`）**：接手已有运行总线时，信任既有 `done` 轨迹不重复施工，仅对终态产物做实证复验；若因预算/外部阻塞必须中断，先打 `wip:` commit 保护现场、更新 `--status handoff --resume-next <unitId>` 并在 `<busDir>/morning-report.md` 写明续跑入口。

## 主循环协议（并发/分单推进）
1. **领取待办单元**：≥2 个互不重叠且依赖就绪的 `pending` unit 时，Pi 下用 `zee_subagent` + 声明式 `worktree`（省略 `timeoutMs`），T3 下用 `delegate_task(isolation:"worktree")`，AGY 下用 `invoke_subagent(TypeName:"self", Workspace:"share", Model:"inherit")`（严禁自定义 Agent），勿手调 `worktree-create` 制造冲突。
2. **施工 + 即时校验 + Verifier 实跑**：每次改码立刻跑语法检查与窄单测；单元收尾跑对应测试与 `.agents/verify-ctl.mjs`（UI/设计单元含真实渲染核验）。
3. **先落袋再加餐**：单单元跑绿后立即 `update-state`（如 `--unit-upsert '{"id":"U1","status":"done"}'` 或 `--units-file`）、`log-decision` 与 `git commit` 锁定成果；连续失败 **2 次即熔断标 `blocked`** 并记录前提假设复盘；非阻断 P2 坏味道随手 `finding add` 入园艺队列。
4. **预算熔断、日志核验与晨前对抗终审**：遇 `budget_warning`（70% 截断）或达时间边界停止开新单；跑 `/zee-verify run --fuzz`、`gate-tamper-diff` 与跨家族 `reviewer`（传 `--author-family <fam>`，必要时加 `judge` 终审把关）；**收口前对照实跑记录核验 `decisions.tsv` 证据指针（严禁修改/删除旧行，有误仅追加 `phase=audit` 的 `supersede` 行纠正）**，提交通过代码并将 `state.json` 置为 `completed` 或 `handoff`。

## 中文晨报协议（`<busDir>/morning-report.md`，吸收 `ketchup` + `show-me-your-work`）
1. **顶部状态简报（严格 <100 字人话，图文优先）**：交付进度与核心结果；触及 UI 的可见变更必须内联截图/产物链接（未截图显式标注 `未捕获截图`）。
2. **中部待拍板决策项（按风险降序，绝不折叠成计数/链接）**：逐条完整展开每个需人类拍板的事项，每条自带**背景 + 实测证据 + 推荐动作 + 风险**，做到只看晨报即可直接回复决策。
3. **底部 `Attention` 风险点名区**：由跨家族审查模型首行署名 `reviewed by <model>` 列出 ≤3 条最值得人工抽查的风险点（附 `file:line` 或 `decisions.tsv` 行号与命令证据），并附 `decisions.tsv` 路径。
