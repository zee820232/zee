---
name: zee-night
description: Zee 过夜无人值守循环：校验前置条件、多单元自动推进、两败停损与晨报汇总
disable-model-invocation: true
---

# `/zee-night` — 过夜无人值守循环

遵循 `skills/zee/playbooks/overnight.md` 执行安全无人值守推进：

1. 执行 `node <scripts>/zee-tool.mjs doctor --repo <repoRoot>` 检查配置与总线健康度。
2. 定位当前 `<busDir>`（若尚无则提示先用 `/zee-plan` 或现场快速建总线拆好可机测的 `units`），调用 `update-state <busDir> --mode night --status running` 开启夜跑模式。
3. 逐 unit 推进：**施工 → 实时单测 → `verifier` 实跑 → 写 `decisions.tsv` 与 `update-state --unit-upsert`**。单个 unit 连续失败 **2 次即自动熔断标 `blocked`**，更新 `--resume-next` 并切换下一独立单元或收尾止损。
4. 全部可控单元收口后，跑 `gate-tamper-diff` 与跨家族 `reviewer`，写入 `<busDir>/morning-report.md`，更新 `state.json` 为 `completed` 或 `handoff`。
