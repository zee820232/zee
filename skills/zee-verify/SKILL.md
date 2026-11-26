---
name: zee-verify
description: Zee 无谎言验证全生命周期：支持 init 读仓生成并自跑验真、maintain 防腐保鲜与 run 实机验收 + 防篡改审查
disable-model-invocation: true
---

# `/zee-verify` — 实机验证全生命周期与门禁校验

遵循 `skills/zee/playbooks/verify.md` 与 `skills/zee/roles/verifier.md`，按子命令分支执行：

- **`/zee-verify init`**（建验证入口）：
  1. 读仓分析运行形态（CLI / Web / 服务 / 库），生成 `.agents/verify-ctl.mjs`，统一封装 `launch` / `doctor`（纯只读健康检查）/ `run`（3–5 条用户视角核心路径）/ `cleanup`（按 PID 精确回收进程，**严禁删除 `<busDir>` 证明产物**），失败必返非 0 退出码。
  2. **交付前双向验真**：至少真实跑通 1 次绿色主链路，并对新增关键断言在临时沙盒或单点故意破损下做一次“能失败（Able to fail）”核验，杜绝永真假测试。

- **`/zee-verify maintain`**（防腐维护，严禁改业务源码掩盖回归）：
  1. 对照最近改动核查 `.agents/verify-ctl.mjs` 与项目入口/路由/命令是否漂移。
  2. 只更新过时的验证驱动或选择句柄，串行真实复跑 1 次并留存退出码；若暴露真实产品回归，立刻标 `FAIL` 上报，严禁为了跑绿去改业务源码或弱化断言。

- **`/zee-verify run`**（默认行为）：
  1. 运行 `.agents/verify-ctl.mjs` 与项目原有测试命令，保存完整真实退出码与摘要日志。
  2. 必跑 `node <scripts>/zee-tool.mjs gate-tamper-diff --repo <repoRoot> --working-tree`，核对 `gateFilesTouched`、`suppressionsAdded`、`secretsAdded` 与 `\uFFFD` `encodingIssues`。
  3. 汇总 `PASS / FAIL / UNVERIFIED` 清单并附上原始命令证据（未实跑一律标 `UNVERIFIED`）。
