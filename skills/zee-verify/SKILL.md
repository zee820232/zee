---
name: zee-verify
description: Zee 无谎言验证全生命周期：支持 init 读仓生成并双向验真 .agents/verify-ctl.mjs、maintain 防腐保鲜与 run [--fuzz] 实机验收 + 防篡改审查
disable-model-invocation: true
---

# `/zee-verify` — 实机验证全生命周期与门禁校验

遵循 `skills/zee/playbooks/verify.md` 与 `skills/zee/roles/verifier.md`，按子命令分支执行：

- **`/zee-verify init`**（建确定性验证入口）：
  1. 运行 `<ZEE_TOOL> doctor --repo <repoRoot>` 摸清形态，生成 `.agents/verify-ctl.mjs`，统一封装 `doctor`（纯只读检查）/ `launch` / `run`（动态空闲端口、隔离临时状态目录、3–5 条用户视角核心路径、`--json` 输出 `{ ok, checks[], cleanupPid }`）/ `cleanup`（按 PID 精确回收，**严禁删除 `<busDir>` 证明产物**），失败必返非 0。
  2. **交付前双向验真**：至少真实跑通 1 次绿色主链路，并对关键断言在临时沙盒或单点故意破损下验证“能失败（Able to fail）”，杜绝永真假测试。

- **`/zee-verify maintain`**（防腐维护，严禁改业务源码掩盖回归）：
  1. 对照最近改动核查 `.agents/verify-ctl.mjs` 与项目入口/路由/命令是否漂移。
  2. 只更新过时的验证驱动或选择句柄，串行真实复跑 1 次并留存退出码；若暴露真实产品回归，立刻标 `FAIL` 上报，严禁改业务源码或弱化断言凑绿。

- **`/zee-verify run [--fuzz]`**（默认行为）：
  1. 运行 `.agents/verify-ctl.mjs` 与项目原有测试命令；若触及 UI/前端视图或设计改版，必跑真实渲染/无头浏览器核验桌面+移动双视口与 0 Console Error；传入 `--fuzz`（或 0→1 / UI 改版 / 过夜终局）时追加 30–60s 限时边界探索压测。
  2. 必跑 `<ZEE_TOOL> gate-tamper-diff --repo <repoRoot> --working-tree`，核对 `gateFilesTouched`（纯新增测试归 `testFilesAdded` 不误报）、`suppressionsAdded`、`secretsAdded` 与 `\uFFFD` `encodingIssues`；若 `requiresCountersign: true`，必须核查 `GATE_CHANGE_RATIONALE:`。
  3. 汇总 `PASS / FAIL / UNVERIFIED` 清单并附原始命令证据（未实跑一律标 `UNVERIFIED`）。
