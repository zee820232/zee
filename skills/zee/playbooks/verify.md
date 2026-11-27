# 剧本：无谎言闭环验证 (`verify`)

适用场景：`/zee-verify init`、`/zee-verify maintain`、`/zee-verify run [--fuzz]`、任意功能/设计改版/过夜合并前门禁。

## `/zee-verify init`（读仓自建确定性验证入口 + Feature Map 物化记忆）
1. 运行 `<ZEE_TOOL> doctor --repo <repoRoot>` 读取 `projectProfile`，生成两件套：
   - **驱动脚本 `.agents/verify-ctl.mjs`**：统一封装 `doctor`（纯只读检查）/ `launch` / `run`（动态空闲端口、隔离临时数据目录、3–5 条用户视角核心路径、`--json` 输出 `{ ok, checks[], cleanupPid }`）/ `cleanup`（按 PID 精确回收，**严禁删除 `<busDir>` 证明产物**），失败必返非 0；
   - **Feature Map `.agents/verify-features/`**：含索引 `README.md` 与 3–5 份核心功能 `.md`，每份固定 4 节 H2（`## Sub-features` / `## 用户入口（全路径）` / `## 驱动与可观测验收` / `## Gotchas`）。多入口须全覆盖，**缺种子数据须判 FAIL 并记入 `Gotchas`，绝不放宽检查**。
2. **交付前三重验真**：① 真实跑通至少 1 条绿色主链路；② 故意破损验证关键断言“能失败（Able to fail）”；③ 执行 `cleanup` 后实查 `<busDir>` 证据文件依然存活。

## `/zee-verify maintain`（防腐保鲜 · 严格三结局）
1. **Wave 1 源核对**：核对 `.agents/verify-features/README.md` 索引与每份功能文件是否漂移（跨多文件时可并行派只读 `scout`），排查近期改动新增的用户入口。
2. **Wave 2 串行全量实跑**：即使源码看似无漂移也必实跑全部映射功能至少 1 次；任一失败后先跑 `doctor` 判断是驱动漂移还是产品回归，**严禁修改业务源码或弱化断言来掩盖回归**。
3. **严格三结局收口**：仅返回 `CLEAN`（全覆盖零漂移）/ `CHANGED`（仅修 `.agents/verify-ctl.mjs` 与 `.agents/verify-features/` 并重跑绿灯）/ `BLOCKED`（列明环境前置缺口；若抓到真回归直报 `PRODUCT_REGRESSION`）。

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
