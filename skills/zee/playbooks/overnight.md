# 剧本：过夜无人值守循环 (`overnight`)

适用场景：`/zee-night`，用户在睡眠或离线前将清晰 `units` 队列交给 Zee 自动推进。

## 启动前置检查
1. 跑 `node <scripts>/zee-tool.mjs doctor --repo <repoRoot>` 确认 3 槽位、总线及 **Git 基线（`hasHeadCommit: true`，必要时先提交未跟踪基础代码）**。
2. 确认 `<busDir>/plan.md` 与 `state.json` 存在可机测 `units`（用 `--units '[...]'` 一次写入）；开启夜跑模式（预算键为 `maxDelegates`）：
   ```bash
   node <scripts>/zee-tool.mjs update-state <busDir> --mode night --status running --budget '{"maxDelegates":12,"maxFailuresPerUnit":2}'
   ```

## 主循环协议（并发/分单推进）
1. **领取待办单元**：≥2 个互不重叠且依赖就绪的 `pending` unit 时，Pi 下用 `zee_subagent` + 声明式 `worktree`（透传 `resolve-model` 的 `subagentArgs`，**省略 `timeoutMs` 沿用角色默认值**）派发 `coder`/`ui`，勿手调 `worktree-create` 制造冲突。
2. **施工 + 即时校验**：每次改动后立即跑 `node --check` 与最窄单测，绝不留语法破损给下一轮。
3. **Verifier 实跑验收**：跑通对应测试与 `.agents/verify-ctl.mjs`。
4. **先落袋再加餐（状态与提交优先）**：单单元一经实测通过，**立即执行 `update-state`、`log-decision` 与 `git commit` 锁定阶段成果**；禁止在未提交落盘前顺手拉起重型浏览器工具加餐。
   - 成功：`update-state <busDir> --unit-upsert '{"id":"...","status":"done"}' --resume-next <nextId>`，并用 `zee-tool.mjs log-decision <busDir> --unit <id> --phase execute --decision "<做法>" --why "<依据>" --evidence "<命令与结果>" --result pass` 记入 `decisions.tsv`。
   - 失败：连续失败 **2 次即熔断标 `blocked`**，用 `log-decision ... --result blocked` 记录原因与断点并跳下一独立 unit。
5. **预算熔断**：遇 `budget_warning`（70% 截断）或接近时间边界时停止开新单，立即跑校验、写清 `<busDir>/morning-report.md` 并将 `state.json` 置为 `completed` 或 `handoff`。
6. **晨前对抗审**：跑 `gate-tamper-diff` 与跨家族 `reviewer`（`sandbox-export --working-tree`），提交通过代码后输出中文晨报。
