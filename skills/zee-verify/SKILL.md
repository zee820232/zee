---
name: zee-verify
description: Zee 无谎言验证闭环：支持 init 生成实测入口脚本与 run 执行验证 + 防篡改审查
disable-model-invocation: true
---

# `/zee-verify` — 实跑闭环与门禁校验

遵循 `skills/zee/playbooks/verify.md` 与 `skills/zee/roles/verifier.md`，按子命令分支执行：

- **`/zee-verify init`**：
  1. 分析项目结构与运行形态（CLI / Web / Node 服务 / 库），在项目根目录生成 `.agents/verify-ctl.mjs`（幂等、带超时保护、真实运行与断言、失败返回非 0 退出码）。
  2. 跑通一次 `.agents/verify-ctl.mjs` 确认基础设施本身无语法或路径错误。

- **`/zee-verify run`**（默认行为）：
  1. 运行 `.agents/verify-ctl.mjs` 与项目原有测试命令，保存完整真实退出码与摘要日志。
  2. 必跑 `node <scripts>/zee-tool.mjs gate-tamper-diff --repo <repoRoot> --working-tree`，检查 `gateFilesTouched`、`suppressionsAdded`、`secretsAdded` 与 UTF-8 `\uFFFD` `encodingIssues`。
  3. 汇总 `PASS / FAIL / UNVERIFIED` 清单并附上原始命令证据。
