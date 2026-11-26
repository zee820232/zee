# 剧本：无谎言闭环验证 (`verify`)

适用场景：`/zee-verify init`、`/zee-verify run`、任意版本合并前门禁。

## `/zee-verify init`（建立项目自检入口）
1. 在目标项目下设计 `.agents/verify-ctl.mjs`（或适配项目的校验脚本），必须包含：
   - 依赖检查 / 类型或语法检查 / 单元测试执行
   - 若为 Web / App / 服务端项目：实际拉起进程/本地服务 + 探活（如 HTTP 200 / 无 console 致命报错 / 核心 DOM 或 API 响应断言）+ 优雅关闭进程
2. 明确脚本只输出结构化真实日志与准确退出码（失败必返回非 0 退出码）。

## `/zee-verify run`（执行并交叉防伪）
1. **验证分级**：默认只运行轻量确定性验证——`.agents/verify-ctl.mjs`、语法检查与单元测试（含本地 HTTP 端口/API 断言）；**仅在用户明确要求浏览器实机交互或截图时，才启用 Playwright 等重型浏览器工具**。
2. 真实运行 `.agents/verify-ctl.mjs` 与项目自带测试命令，保存原始通过/失败摘录。
3. 立即执行篡改检查：
   ```bash
   node <scripts>/zee-tool.mjs gate-tamper-diff --repo <repoRoot> --working-tree
   ```
   核对以下 4 项：`gateFilesTouched`、`suppressionsAdded`、`secretsAdded`、`encodingIssues`（`\uFFFD` 乱码）。若 `requiresCountersign: true`，必须在报告中标出并由人工或独立审查确认原因。
3. 未实跑的步骤必须标 `UNVERIFIED`，严禁将仅靠静态阅读的推断写成“已验证通过”。
