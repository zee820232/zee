# 剧本：无谎言闭环验证 (`verify`)

适用场景：`/zee-verify init`、`/zee-verify maintain`、`/zee-verify run`、任意版本合并前门禁。

## `/zee-verify init`（读仓自建项目自检入口）
1. 读仓分析运行形态，设计 `.agents/verify-ctl.mjs` 统一封装 4 个子能力：
   - `doctor`：纯只读环境/依赖/端口冲突检查；
   - `launch` / `run`：类型或语法检查、单元测试，以及 Web/服务端/CLI 的 3–5 条用户视角核心路径实跑（HTTP 200 / 无致命报错 / 核心断言）；
   - `cleanup`：按 PID 精确回收启动的子进程，**清理动作严禁删除 `<busDir>` 内的截图与日志证明产物**。
2. 明确脚本仅输出结构化真实日志与准确退出码（失败必返非 0），并在交付前完成**双向验真**：跑通至少 1 条真实绿灯链路 + 故意破损验证关键断言“能失败（Able to fail）”。

## `/zee-verify maintain`（防腐保鲜）
1. 对照最近改动核查 `.agents/verify-ctl.mjs` 与项目入口、路由或命令是否漂移，仅修复过时的验证驱动/句柄。
2. 串行真实复跑 1 次并保存退出码；**严禁修改业务源码或弱化断言来掩盖真实回归**。

## `/zee-verify run`（执行并交叉防伪）
1. **验证分级**：默认运行轻量确定性验证——`.agents/verify-ctl.mjs`、语法检查与单元测试（含本地 HTTP 端口/API 断言）；**仅在用户明确要求浏览器实机交互或截图时，才启用 Playwright 等重型工具**。
2. 真实运行 `.agents/verify-ctl.mjs` 与项目测试命令，保存原始通过/失败摘录。
3. 立即执行篡改检查：
   ```bash
   node <scripts>/zee-tool.mjs gate-tamper-diff --repo <repoRoot> --working-tree
   ```
   核对 `gateFilesTouched`、`suppressionsAdded`、`secretsAdded`、`encodingIssues`（`\uFFFD` 乱码）。若 `requiresCountersign: true`，必须在报告中标出并交由人工或独立审查确认。
4. 未实跑的步骤必须标 `UNVERIFIED`，严禁将静态阅读推断写成“已验证通过”。
