# Changelog

## [4.2.0] - 2026-11-26

### Added
- **Pi v1.6.1 双轴 FSM 与零冲突 Layer 0/1/2 HUD/Hub（`pi-extension/fsm.ts`, `bus-sync.ts`, `hub-ui.ts`）**：
  - 实现 **14 个工作流阶段 × 9 个子代理车道状态** 双轴状态机与 **G-01..G-06** 守卫不变量，支持 `zee-fsm` 分支条目持久化与 `zee-mode`/`zee-gate` 向下兼容恢复，并在 `/tree` 切回时提供 `busAheadOfBranch` 保护（绝不覆写磁盘较新的 `state.json`）。
  - 实现三层零冲突界面：**Layer 0** `setStatus("zee-mode")` 紧凑徽章（绝不调用 `setFooter()`，与 `pi-cometix-footer` 和平共存）；**Layer 1** `setWidget("zee-hud", ..., { placement: "aboveEditor" })` 响应式自适应卡片（`IDLE` 隐身 0 行、`full`/`compact`/`hidden`、RPC 降级、Print/JSON/`ZEE_WORKER=1` 全静默）；**Layer 2** `/zee-hub`（`Ctrl+Alt+H` / `F2`，避开保留 `Ctrl+G`）5-Tab 交互控制台（Overview & FSM / Workers + `partial-*.md` 预览 / Gates & Trail / Worktrees & Cost / Controls）。
- **`zee-tool.mjs` 8 项确定性 CLI 原语（共 20 原语）**：
  - `sandbox-export` / `sandbox-clean`：一键导出 `PINNED_SHA` 或 `--working-tree` 到隔离 `os.tmpdir()/zee-*` 沙盒并安全清理，取代 `verifier.md` / `reviewer.md` 长串手工 POSIX 模板。
  - `gate-tamper-diff`：确定性扫描测试/CI/Lint 门禁文件变更与新增 `@ts-ignore`/`as any`/`eslint-disable` 等抑制注释。
  - `mine-transcripts`（`retro` / `recall`）+ **新子模式 `/zee recall <topic>` 与 `/zee triage`**：跨 AGY/Pi/Claude/Codex 会话、总线、ADR 与花园队列挖掘并自动 `<REDACTED>` 脱敏；`/zee recall` 输出 `≤40` 行历史决策简报，`/zee triage` 执行 3 步外环聚类分诊。
  - `queue-finding` / `list-findings` + **花园队列（`.agents/gardening-queue.jsonl`）**：沉淀非阻塞 `P2` 坏味道与缺失 Test Seam（累计 `≥3` 次标记 `systemic: true` 并在 `/zee-arch`、`/zee-retro` 置顶）；`/zee-retro` 新增第 5 演化选项 **Skill Creation / Dead-Rule Pruning**。
  - `readiness` + **Autopilot 信任梯度（`T1 / T2 / T3`）**：机械校验 `.agents/zee.project.json` 与 `verify-*`/`verify-ctl.*`，自动向下钳位 `trustLevel`；`overnight.md` 新增低风险**定期外环只读巡检配方**。
  - `match-skills` + **`pathSkills` 按需注入**：仅当改动文件命中 glob 时向子代理注入项目技能（零常驻上下文税）。
- **零配置单兵开箱即用（"Own Set of Knives"）**：`resolve-model --allow-standalone` 支持缺省 `~/.agents/zee-config.json` 时返回 exit 0；`/zee-verify`、`/zee-retro`、`/zee-arch`、`/zee-review`、`/zee-plan` 与 `/zee` 只读/单兵子模式自动优雅退化为当前会话模型执行（附简短中文提示，不再阻塞）。
- **`verify-<app>` 升级与 `--fuzz`**：要求提供 `verify-<app>/scripts/verify-ctl.(mjs|py|sh)`（`launch / doctor / snapshot / evidence / cleanup`），并新增探索式 `--fuzz` 实机压测（`L3`、`0→1 Stage 5` 与 `T3` 默认开启）。

### Changed & Fixed
- **清理 `verify-map.md` 文档漂移**：从 `roles/coder.md` 与 `roles/scout.md` 移除过时的 `.agents/verify-map.md` 主路径指令并统一收敛到 `<projectSkillsDir>/verify-<app>/`（`coder.md` 回执新增 `VERIFY_MAP_DELTA`）；强制要求全部测试产物/Playwright 报告/Scratch 隔离到 `/tmp/zee-verify-*` 或 `<busDir>`（严禁在 `review🔒` 锁下向仓库写入或清理 `test-results`/`dist`）。
- **修复 Mac 实测 Bug A（`delegatesDispatched` 2x 重复记账）**：`zee_subagent` 与 `zee-tool.mjs update-state --delegate-id <id>` 引入 `countedDelegateIds` 幂等去重（保留最近 200 条），并在文档中明确 Pi 自动落账语义。
- **全面修复 Windows 跨平台兼容性**：`guard-core.mjs` 修复反斜杠路径转义吞字符与盘符大小写无关的 `isAllowedZeeTmpPath` / `isWithinDir` 判定（且放行 `.agents/gardening-queue.jsonl` 与全部新原语）；`zee-tool.mjs cleanup-worktrees` 使用 `path.resolve` 对齐路径分隔符；`scripts/install.mjs` 在 Windows 下改用 `where`；`pi-extension/index.ts` 修复 `ZEE_PI_BIN` `.mjs`/`.js`/`.ts` 子进程 `spawn EFTYPE` 与 `"junction"` `node_modules` 挂载。
- **文档瘦身**：精简 `SKILL.md`、`worker.md`、`protocols.md`、`overnight.md`、`greenfield.md` 中由运行时安全核物理兜底的重复散文。
- **包清单同步**：`package.json` 与 `.antigravity-plugin/plugin.json` 同步升至 `4.2.0`，`package.json` 新增可选 `peerDependencies`: `"@earendil-works/pi-tui": "*"`。

## [4.1.1] - 2026-11-25

### Added
- **独立短命令 `/zee-verify`（9+1 全命令体系）**：将项目级实机验证技能 `verify-<app>` 的全生命周期收口为独立显式入口，支持 `init`（读源码生成并真机证真）、`maintain`（索引体检 + 并行 Scout 漂移扫描 + 串行真机复跑三分流）与 `run`（带 `review🔒` 只读锁的冷启动实机验收），接手现成老项目开箱即用。
- **`zee_subagent` v2.2 预算截断与抢救落盘**：自动回写 `<busDir>/state.json` 的 `delegatesDispatched`/`abortedDelegates`，跨过 70% 阈值自动注入 `[ZEE_BUDGET_CUTOFF]` 并在 Pi 状态栏提示；`>2KB` 的流式抢救正文自动落盘至 `<busDir>/artifacts/partial-<role>-*.md` 供续跑复用。
- **`zee-tool.mjs` 升级**：`update-state` 新增 `--budget '<json>'`、`--inc-aborted [N]` 与可累加重复的 `--inc-delegates [N]`；`check-plan` 新增悬空 `blockedBy` 依赖检测与 `--strict-budget` 标志；`validate --check-live` / `doctor` 新增 `backup` 槽位 `CONFIG_DRIFT` 联检。
- **`README.md` 全面重构**：新增「全指令用法详解（逐命令手册）」、「接手现成老项目标准 4 步 SOP」与 `zee-tool.mjs` 12 原语速查表。

### Fixed
- **[P0-1] `guard-core.mjs` 词法绕过封堵**：`splitShellSegments` 剥离独立未加引号子 shell 括号 `(...)` 与命令分组 `{ ...; }`，`getAllNestedCommands` 递归提取 `$(...)` 命令替换，且 `sed`/`perl` 原地写正则升级为 `/^-[a-zA-Z0-9]*i/`，彻底拦截 `(rm -rf /)`、`{ rm -rf /; }`、`echo $(rm -rf /)`、`(pnpm add ...)` 与 `perl -0pi`。
- **[P0-2] 解除 0→1 Scout `/tmp/zee-probe-*` 沙盒三重死锁**：`recordLeadingStaticVars` 支持受控 `VAR=$(mktemp -d /tmp/zee-...)` 路径绑定；当虚拟工作目录严格位于 `/tmp/zee-*` 沙盒内且无逃逸参数时，放行沙盒内包安装与探针脚本，仓库本身保持 100% 物理只读。
- **[P0-3] 统一 `/tmp/zee-*` 白名单与 `denyCommands` 边界匹配**：放行所有合法 `/tmp/zee-<name>` 目录（修复 `/tmp/zee-sim-*` 误拦）；`checkProjectDenyCommands` 改为词法 token 边界匹配，彻底修复 `denyCommands: "rm -rf /"` 误杀 `rm -rf /tmp/zee-retro-*`；允许 `plan`/`init-design` 锁内针对已确认白名单目标（如 `docs/adr/`）的静态字面量内联脚本。
- **[P1-2] `provider/model` 自动归一**：`zee_subagent` 在建 worktree 之前按 `~/.agents/zee-config.json` 自动归一 `provider="remote-magpie"` + `model="vm/..."` 或缺 `provider` 的单模型名，消灭 0.2s 前缀快败。
- **[P1-3 & P2-1] Worktree 依赖预挂与嵌套 ref 防撞**：`prepareAtomicWorktree` 对已有未跟踪 `node_modules` 的仓库自动预挂只读软链并写入 worktree 专属 `.git/info/exclude`（不带尾斜杠，彻底消除 `?? node_modules` 触发的 `ROLE_VIOLATION` 误报），同时在 Pi 扩展与 `zee-tool.mjs` 统一实现 Git 嵌套分支 ref 冲突自动扁平化。
- **[P1-4 & P2-4] 过夜 `uiGlobs` 强制截图视觉门禁与角色账本卫生**：`references/overnight.md` 与 `roles/reviewer.md` 强制要求命中 `uiGlobs` 时落盘最新截图并逐图肉眼核验新增 UI 像素可见性；明确 `FAMILY:` 必须填写审查员自身家族而非 `authorFamily`；`/zee-review` 与 `/zee-arch` 补齐总线 `completed` 结项。
- **[P2-5] 默认路由建议调优**：`/zee-setup` `balanced` 预设将常规 `architect.primary` 旗舰模型建议调为 `low`（实测提速 2–4× 且 100% 完结），并提示避免将超慢模型设为长切片 `coder.heavy.backup`。

## [4.1.0] - 2026-11-25
- 新增 `pi-extension/worker-guard.ts` 消灭 `-ne` 子进程安全真空；升级 `zee_subagent` v2.1 流式优先抢救与精准增量脏区回滚；新增 `/zee-arch`、`/zee-retro`、6 份工程纪律与 `verify-<app>` 实机验证体系；加固 AGY `Stop` Hook 会话隔离与子代理路径锁。

## [4.0.1] - 2026-11-24
- 词法化 `guard-core.mjs`（Heredoc 剥离、静态变量、同命令 `cd`、`git merge-base`）、流式 `PARTIAL_RECEIPT` 抢救与并发工具双态看门狗。

## [4.0.0] - 2026-11-23
- 统一 Pi Package + Google Antigravity Native Plugin + Agent Skills 三形态单仓架构，落地共享 `guard-core.mjs`、跨回合写锁与 `zee_subagent` v2。
