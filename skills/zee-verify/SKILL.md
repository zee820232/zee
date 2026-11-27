---
name: zee-verify
description: Zee 无谎言验证全生命周期：支持 init 读仓生成并双向验真 .agents/verify-ctl.mjs、maintain 防腐保鲜与 run [--fuzz] 实机验收 + 防篡改审查
disable-model-invocation: true
---

# `/zee-verify` — 实机验证全生命周期与门禁校验

遵循 `skills/zee/playbooks/verify.md` 与 `skills/zee/roles/verifier.md`，按子命令分支执行：

- **`/zee-verify init`**（建确定性验证入口 + Feature Map）：
  1. 运行 `<ZEE_TOOL> doctor --repo <repoRoot>` 摸清形态，生成 `.agents/verify-ctl.mjs`（封装 `doctor`/`launch`/`run --json`/`cleanup`，动态空闲端口、隔离临时目录、按 PID 精确回收且**严禁删 `<busDir>` 证明产物**，失败返非 0）与 `.agents/verify-features/`（`README.md` 索引 + 3–5 份固定 4-H2 功能文档：`Sub-features` / `用户入口（全路径）` / `驱动与可观测验收` / `Gotchas`，缺种子数据判 FAIL 绝不放宽）。
  2. **交付前三重验真**：① 跑通至少 1 条绿色主链路；② 故意破损验证关键断言“能失败（Able to fail）”；③ 执行 `cleanup` 后实查 `<busDir>` 证据文件完整存活。

- **`/zee-verify maintain`**（防腐维护 · 严格三结局，严禁改业务源码掩盖回归）：
  1. Wave 1 核查 `.agents/verify-features/` 与 `.agents/verify-ctl.mjs` 是否漂移；Wave 2 串行实跑全部映射功能至少 1 次并留存退出码。
  2. 仅输出 `CLEAN`（无漂移）/ `CHANGED`（仅修验证目录并复跑转绿）/ `BLOCKED`（列明前置缺口；若暴露真实产品回归直报 `PRODUCT_REGRESSION` 绝不改文档凑绿）。

- **`/zee-verify run [--fuzz]`**（默认行为）：
  1. 运行 `.agents/verify-ctl.mjs` 与项目原有测试命令；若触及 UI/前端视图或设计改版，必跑真实渲染/无头浏览器核验桌面+移动双视口与 0 Console Error；传入 `--fuzz`（或 0→1 / UI 改版 / 过夜终局）时追加 30–60s 限时边界探索压测。
  2. 必跑 `<ZEE_TOOL> gate-tamper-diff --repo <repoRoot> --working-tree`，核对 `gateFilesTouched`（纯新增测试归 `testFilesAdded` 不误报）、`suppressionsAdded`、`secretsAdded` 与 `\uFFFD` `encodingIssues`；若 `requiresCountersign: true`，必须核查 `GATE_CHANGE_RATIONALE:`。
  3. 汇总 `PASS / FAIL / UNVERIFIED` 清单并附原始命令证据（未实跑一律标 `UNVERIFIED`）。
