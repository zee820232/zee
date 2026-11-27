# CLI 状态总线、召回与信任闸门

覆盖 `zee-tool.mjs` 的 15 个确定性原语：总线初始化与并发更新、跨 Run 决策与文档召回、园艺队列、门禁防篡改及 `doctor` 信任档位硬校验。

## Sub-features

- `bus-lifecycle`：`init-run --ensure-git`、`update-state`、`log-decision`、`list-runs`
- `workspace-recall`：`recall --repo --topic` 聚合单仓决策、园艺簇、ADR 与词汇表
- `trust-gate`：`doctor --repo` 按可验证性硬校验并钳制 `trustLevel`（`T1/T2/T3`）
- `tamper-guard`：`gate-tamper-diff` 区分纯新增测试与篡改门禁、抑制注解、密钥与 `\uFFFD`

## 用户入口（全路径）

- 直接调用 `node skills/zee/scripts/zee-tool.mjs <subcommand>`
- 通过 `npm run verify`（即 `node .agents/verify-ctl.mjs run --json`）执行全链路冒烟
- 通过 `npm test`（`tests/zee-tool.test.mjs` 与 `tests/guard-core.test.mjs`）执行契约测试

## 驱动与可观测验收

- **环境体检**：运行 `node skills/zee/scripts/zee-tool.mjs doctor --repo .`；期望 `ok: true`、`projectProfile.verifiability === "ready"`、`projectProfile.effectiveTrust === "T3"`。
- **全链路冒烟**：运行 `node .agents/verify-ctl.mjs run --json`；期望退出码 `0` 且 `e2e-bus-smoke` 与 `unit-tests` 均为 `ok: true`。

## Gotchas

- `zee-tool.mjs doctor` 依赖 `~/.local/state/zee/runs` 可写；若沙盒禁写家目录会返回 `busWritable: false`。
- Windows 下执行带嵌套 JSON 的 `update-state` 需通过 `--units-file` 规避 PowerShell 引号剥离。
