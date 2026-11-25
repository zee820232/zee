# Changelog

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
