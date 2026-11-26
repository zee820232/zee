# 剧本：无谎言闭环验证 (`verify`)

适用场景：`/zee-verify init`、`/zee-verify maintain`、`/zee-verify run [--fuzz]`、任意功能/设计改版/过夜合并前门禁。

## `/zee-verify init`（读仓自建项目确定性验证入口）
1. 运行 `<ZEE_TOOL> doctor --repo <repoRoot>` 读取 `projectProfile`，设计 `.agents/verify-ctl.mjs` 统一封装 4 个确定性子命令：
   - `doctor`：纯只读环境、依赖与配置检查；
   - `launch` / `run`：自动分配**动态空闲端口**与**隔离临时数据目录**，依次执行类型/语法检查、单元测试及 3–5 条用户视角核心路径实跑，支持 `--json` 输出 `{ ok, checks[], cleanupPid }`；
   - `cleanup`：按 PID 文件精确回收自启子进程，**清理动作严禁删除 `<busDir>` 内的截图与日志证明产物**。
2. 脚本必须严格遵守失败返非 0 退出码，并在交付前完成**双向验真**：跑通至少 1 条真实绿灯链路 + 故意破损验证关键断言“能失败（Able to fail）”。

## `/zee-verify maintain`（防腐保鲜）
1. 对照最近改动核查 `.agents/verify-ctl.mjs` 与项目入口、路由或命令是否漂移，仅修复过时的验证驱动或选择句柄。
2. 串行真实复跑 1 次并保存退出码；**严禁修改业务源码或弱化断言来掩盖真实回归**。

## `/zee-verify run [--fuzz]`（分级实跑 + 探索压测 + 防篡改）
1. **按应用形态分级实跑（消灭 UI 肉身代理）**：
   - **纯库 / CLI / 后端**：实跑 `.agents/verify-ctl.mjs`（若无则跑项目原生测试与真实 CLI/HTTP 断言）；
   - **触及 UI / 前端视图 / 设计改版**：主测/构建通过后**必须**启动真实渲染或无头浏览器检查核心页面、桌面+移动双视口无溢出且 0 个未捕获 JS Console Error（不再等待用户开口要求）。
2. **探索式 `--fuzz` 压测层**（0→1 建项、UI 改版、`overnight` 终局或显式传 `--fuzz` 时默认启用）：
   - 跑完固定清单后，执行有限步/限时（如 30–60s / 8–10 步）的边界与异常交互探索（空输入、超长输入、特殊字符、快速连点、窄屏切换、重复调用），专抓既定测试清单没覆盖的真实回归。
3. **确定性防篡改与会签核验**：
   ```bash
   <ZEE_TOOL> gate-tamper-diff --repo <repoRoot> --working-tree
   ```
   核对 `gateFilesTouched`（纯新增测试归 `testFilesAdded` 不误报）、`suppressionsAdded`、`secretsAdded`、`encodingIssues`（`\uFFFD`）。若 `requiresCountersign: true`，必须核查是否存在合法 `GATE_CHANGE_RATIONALE:` 并在报告中显著标出交由跨家族审查确认。
4. 未实跑的步骤一律标 `UNVERIFIED`，严禁将静态阅读推断写成“已验证通过”。
