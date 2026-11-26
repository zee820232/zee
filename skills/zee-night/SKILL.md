---
name: zee-night
description: Zee 过夜无人值守循环：校验项目可验证性与基线、多单元自动推进、两败停损与中文晨报汇总
disable-model-invocation: true
---

# `/zee-night` — 过夜无人值守循环

遵循 `skills/zee/playbooks/overnight.md` 执行安全无人值守推进：

1. 执行 `<ZEE_TOOL> doctor --repo <repoRoot>` 检查配置、`projectProfile`（Git 基线与 `verifiability`）与总线健康度；无 Git 基线先 `init-run <repoRoot> <slug> --mode night --ensure-git`。
2. 定位当前 `<busDir>`（若尚无则快速拆好可机测 `units` 并用 `--units-file <path|->` 写入），调用 `<ZEE_TOOL> update-state <busDir> --mode night --status running [--conversation-id <cid>]` 开启夜跑模式（AGY 下务必写入当前 `conversationId` 供 `Stop` Hook 会话隔离）。
3. 逐 unit 推进：**施工 → 实时单测 → `verifier` 实跑 → 写 `decisions.tsv` 与 `update-state --unit-upsert '{"id":"U1","status":"done"}'`（PowerShell 推荐 `--units-file`）**。单 unit 连续失败 **2 次即自动熔断标 `blocked`**，更新 `--resume-next` 并切下一独立单元或止损。
4. 全部可控单元收口后，跑 `/zee-verify run --fuzz`、`gate-tamper-diff` 与跨家族 `reviewer`（传 `--author-family <fam>`），写入 `<busDir>/morning-report.md`，更新 `state.json` 为 `completed` 或 `handoff`。
