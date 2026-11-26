# Changelog

## [5.0.6] - 2026-11-26

### Fixed
- **移除 AGY `hooks.json` 的 `PreToolUse` 钩子以彻底解决独立 AGY CLI 误拒所有命令的问题**：
  - Antigravity `PreToolUse` 契约要求返回 `decision`（`"allow" | "deny" | "ask" | "force_ask"`），不支持空对象 `{}` 作为透传，导致独立 `agy` CLI 在收到 `{}` 时以空 reason 拒绝执行 `run_command`；现仅在 `hooks.json` 保留明确支持 `{}` 透传的 `Stop` 过夜断尾守护。
- **统一全模型与全槽位最低思考档位为 `medium`（禁用 `low`）**：
  - 更新 `skills/zee/models.json`（`effortLadder` 为 `["medium", "high", "xhigh"]`，`large`: `xhigh`/`high`、`medium`: `high`/`medium`、`small`: `medium`/`medium`）；
  - `zee-tool.mjs` 在 `recommend-models`、`resolve-model`（自动抬升遗留 `"low"`）与 `doctor` 中统一强制 `medium` 下限，并同步更新 `skills/zee-setup/SKILL.md` 及本机 `~/.agents/zee-config.json`。

## [5.0.5] - 2026-11-26

### Added & Fixed
- **对齐 `pstack` 能力梯队与预算阶梯，重构模型自动分配机制**：
  - 新增 `skills/zee/models.json` 声明式能力梯队（`flagship` / `fastQuality`）与预算思考阶梯（`large` = `xhigh`/`medium`、`medium` = `high`/`low` 推荐、`small` = `medium`/`low`），并将 `deepseek` / `gemini-3.8` / `mini` / `lite` 等降智/轻量通道隔离进 `optInOnly`，禁止自动入选；
  - `zee-tool.mjs` 新增异步支持管道的 `recommend-models` 子命令（同时兼容 `pi --list-models` 文本表、T3 `orchestrator_capabilities` JSON 与模型列表 JSON），自动去重同类路由别名并输出异构 3 槽位推荐；
  - `resolve-model` 与 `doctor` 新增 `inherit-parent` / `auto` / `inherit` 父模型别名支持；
  - 重写 `/zee-setup` 引导流程：取消 `"reply ok"` 严苛匹配与测速竞速误配，直接按能力梯队推荐，默认即得 `gpt-6.2-astra` / `claude-sonnet-5-5` / `gemini-4-hydrogen` / `gpt-6.1-sol` 等一线主力。

## [5.0.4] - 2026-11-26

### Fixed & Improved
- **彻底修复 `/zee-setup` 与 `zee-tool.mjs` 跨宿主串台，实现严格单宿主隔离**：
  - `detectActiveHarness()` 优先识别 `T3CODE_THREAD_ID` / `T3_ACP_MCP_*` 返回 `"t3"`（不再与独立 AGY CLI 混淆），并新增 `runtimeProvider` 标识当前宿主内的运行提供方；
  - `skills/zee-setup/SKILL.md` 先查 `doctor.activeHarness` 再按宿主单线分支：`t3` 仅调一次 `orchestrator_capabilities`（0 条 shell 探活、0 次跑去 `pi --list-models`），`antigravity` 直接按 Gemini 4 代际锁设 `inherit` + `swarmModel`，`pi` 仅探活自身头部候选并只写入 `harnesses.<activeHarness>.slots`（完整保留其他宿主分区）；
  - `zee-tool.mjs` 新增 `harnesses.<h>.slots` 多宿主共存Schema，并修复 legacy 仅含 `bindings.pi` 的 `slots` 串读到 `t3`/`agy` 的漏洞；为 `t3` 输出 `delegateTarget`（含 `providerInstanceId` / `model` / `options`），同时修复 `normalizeModelForAgy` 将 `gemini-4-hydrogen` 等误映射为 `flash`/`pro` 的代际锁隐患；
  - `provider-health.mjs` 与 `pi-extension/index.ts` 优先支持 `harnesses.pi.slots` 且不串读 `harnesses.t3` / `harnesses.agy`。

## [5.0.3] - 2026-11-26

### Added
- **恢复极简独立命令 `/zee-setup`**：专职枚举当前宿主模型、30s 轻量实机探活、确认 `fast` / `workhorse` / `adversary` 三槽位跨家族分配并写入 `~/.agents/zee-config.json`（Schema v3），同步注册进 Pi 扩展（8 个扩展命令）与多宿主安装器，且不带重型初始化历史包袱。

## [5.0.2] - 2026-11-26

### Added
- **新增 `skills/zee/playbooks/understand.md`**：吸收 `pstack` 的 `how`/`why` 动态只读摸底与 `matt-pocock-skills` 懒沉淀理念，面向接手陌生老项目提供现状运行流追踪、`git log` 历史溯源与极薄 `AGENTS.md` / `GLOSSARY.md` 按需沉淀规范（不生成易过时静态目录地图，也不增加额外斜杠命令）。

## [5.0.1] - 2026-11-26

> 基于 `D:\proj\poke-zee` 真实 Pi RPC 全链路实战与 `gemini-4-neon` 独立监督审查（`6.4 / 10`）暴露的 P0/P1 缺陷实施专项修复。

### Fixed
- **[P0] 修复展开 `<skill>` 消息后 `writeGate` 只读保护锁 0ms 自毁漏洞（`pi-extension/index.ts`）**：
  - `before_agent_start` 优先解析 `<skill name="...">...</skill>` 及其尾随参数再推算 `nextGate`，彻底修复 `/zee-verify run` 与 `/zee plan|review|init` 刚上锁即被重置为 `none` 的漏洞。
- **[P0] 修复 `update-state` 多参数覆盖、无锁并发丢 unit 与 Windows `renameSync` EPERM 留孤儿临时文件（`skills/zee/scripts/lib/fs-atomic.mjs`, `zee-tool.mjs`, `provider-health.mjs`, `pi-extension/index.ts`）**：
  - 新增 `withFileLock` + `atomicWriteJson` 共享原语；支持多次 `--unit-upsert` / `--fallback` 累加及 `--units` 批量 upsert，杜绝并发覆盖与 `.tmp.*` 孤儿残留；恢复轻量 `log-decision` 原语写入 `decisions.tsv`。
- **[P0] 修复 `gate-tamper-diff` 门禁目录与剧本文件漏监（`zee-tool.mjs`）**：
  - `isGateFilePath` 新增对 `.agents/verify-ctl*`、`.agents/zee.project.json`、`verify-*/` 及单数 `test/` 目录的监测。
- **[P1] 对齐预算字段、`verifier` 槽位、worktree 基线检查与 Pi 过夜防断尾提醒**：
  - `recordSubagentBudgetAndCutoff` 同时兼容 `budget.maxDelegates ?? budget.maxSubagents`；`mapRoleToSlotName("verifier")` 对齐为 `"workhorse"`；`resolve-model --harness pi` 直接输出 `subagentArgs`；`doctor --repo` 检测 `hasHeadCommit` 与脏区；`agent_settled` 增加未收尾 `night` 状态提醒；更新 `plan`/`feature`/`bug-fix`/`overnight` 剧本及 `zee-plan`/`zee-retro` 技能防止刷 `todo` 超时与复盘脱离实盘。
- **[P1] 收口优化：死进程 `.tmp.*` 清理、子代理短超时下限与“先落袋再加餐”规则**：
  - `fs-atomic.mjs` 新增 `cleanStaleTempFiles`，在 `init-run` 与 `update-state` 时自动清理陈旧/死进程孤儿 `.tmp.*`；`pi-extension/index.ts` 新增 `resolveEffectiveSubagentTimeout`，为研发/审查类子代理施加 `120s` 最小安全超时下限；剧本补充“先落袋再加餐”、默认轻量验证不强拉 Playwright、`zee-review` 聚焦 diff 且省略 `timeoutMs`，本地 `zee-config.json` 将 `adversary` 思考强度调为 `medium`。

## [5.0.0] - 2026-11-26

> 架构大瘦身：**个人主厨 + 可过夜（Personal Head Chef + Overnight Ready）**，从重度仪式与 TUI 状态机全面回归“核心门禁 + 按需剧本 + 3 槽位多模型 + 真实无人值守”。

### Removed
- 彻底删除重量级控制台与状态机：`pi-extension/fsm.ts`、`pi-extension/hub-ui.ts`、`pi-extension/bus-sync.ts`、`/zee-hub`、`Ctrl+Alt+H` / `F2` 及 `@earendil-works/pi-tui` 依赖。
- 移除冗余技能与模板碎片：`skills/zee-arch`、`skills/zee-init`、`skills/zee-setup`、`skills/zee/references/*`、`skills/zee/disciplines/*` 以及重复的 `agents/zee-*.md` 子角色文件。
- 移除 `guard-core.mjs` / `worker-guard.ts` 中高误报的 `checkBashUnderGate` Bash 写入正则猜猜看；移除 `zee-tool.mjs` 11 个边缘分析/补丁子命令（保留最硬核的 11 个执行原语）。
- `gate-tamper-diff` 默认不再扫描普通 IP 字面量，仅保留门禁篡改、抑制注解、高危密钥前缀与 UTF-8 `\uFFFD` 乱码审计。

### Changed & Added
- **Skill 与角色极致瘦身**：`skills/zee/SKILL.md`（≤4 KB）配合 `principles.md`、6 份按需 `playbooks/*.md`（`plan` / `feature` / `bug-fix` / `perf` / `verify` / `overnight`）与 6 份极简 `roles/*.md`。
- **3 槽位模型配置（Schema v3）**：`zee-config.json` 简化为 `fast` / `workhorse` / `adversary` 三槽位，配合 `--allow-standalone` 单兵降级，零配置也能开箱即用。
- **Pi 扩展聚焦执行稳定性**：保留 `/zee`、`/zee-plan`、`/zee-verify`、`/zee-review`、`/zee-night`、`/zee-retro`、`/zee-mode` 与增强版 `zee_subagent`（429/5xx 跨通道冷却与 0ms 切备、`authorFamily` 跨家族拦截、worktree 隔离与 `node_modules` junction、>2KB 输出抢救、只读越权回滚与 70% 预算提示）。

## [4.2.2] - 2026-11-26

> 专项修复 `v4.2.1` 真实程序员 7 场景复测（`8.8 / 10`）中通过真机 Pi CLI + PTY 冒烟抓出的 4 项 P0/P1 现网缺陷与 P2 体验细节。

### Fixed
- **[P0] 修复真实 Pi CLI 中 `429/5xx` 熔断器与预算免扣 0% 生效的现网缺陷（`pi-extension/index.ts`, `skills/zee/scripts/lib/provider-health.mjs`）**：
  - Pi CLI 遇 HTTP 429 自动内部退避重试 4 次、每次发出 `message_end(stopReason="error")` 空消息；此前 `index.ts` 无条件 `details.usage.turns += 1` 将 `turns` 推成 `4`，导致 `provider-health.mjs` 的 `turnCount > 1` 误判为非瞬态失败。
  - 修复后，零产出/零工具调用/零输出 token 的 `stopReason="error"` 重试不再递增 `turns`，且 `classifyTransientProviderFailure` 同步校验 `hasToolCalls` 与 `outputTokens`，真正兑现 429 跨会话 30m 冷却、0ms 切备与预算免扣。
- **[P1] 修复正常任务推进 >5s 永久误报 `⚠ /tree rollback drift` 与 `!` 徽章（`pi-extension/index.ts`）**：
  - `busAheadOfBranch` 漂移检测收敛为仅在 `restoreState()`（`session_start` / `session_tree`）分支恢复时校验；当前会话自身执行 `init-run`、`update-state`、`log-decision`、`/zee-review --strict` 与 `zee_subagent` 写盘时不再触发假漂移告警，并同步刷新 `branchEntryTs`。
- **[P1] 修复 Markdown 加粗 `VERDICT: **PASS**` 触发 `G-02` 假告警（`pi-extension/index.ts`）**：
  - 放宽 `VERDICT` 正则为 `/\bVERDICT\*{0,2}\s*:\s*[*`_\s]*(PASS|FAIL|REVISE|INCONCLUSIVE)\b/i`，兼容加粗与反引号格式，杜绝 Verifier 已 PASS 却误报 `gate1=missing`。
- **[P1] 修复 `sandbox-clean` 在 `cwd === sandboxDir` 自拒与 `review🔒` 沙盒 `cp ... 2>&1` / `patch` 误拦（`skills/zee/scripts/zee-tool.mjs`, `skills/zee/scripts/lib/guard-core.mjs`）**：
  - `cmdSandboxClean` 校验不再将 `process.cwd()` 误当受保护仓库（仍严禁删 `.git` 或 `.agents/zee.project.json` 目录，且删除前若身处沙盒则先切出至 `os.tmpdir()`）；
  - `guard-core.mjs` 新增 `stripShellRedirectionTokens` 剥离 `2>&1`、`2>/dev/null` 等重定向 token，彻底修复 `cp -R node_modules $S/node_modules 2>&1` 被误判目标为 `2>&1` 的问题；仅在严格位于 `/tmp/zee-*` / `os.tmpdir()/zee-*` 沙盒内且无逃逸参数时放行 `patch`（仓库内 `patch` 仍硬拦截）。

### Improved
- **[P2] TUI Hub 80 列与换行加固（`pi-extension/hub-ui.ts`）**：`fitToWidth` 与 Tab 4 `inv.error` 清洗嵌入 `\r\n` 彻底防裂框；宽度 `<94` 列时 Hub Tab 栏自动切换短标签（`1总览 2车道 3门禁 4树/费 5控制`），80 列下全部 5 个标签完整可见。
- **[P2] FSM 生命周期收敛（`pi-extension/fsm.ts`, `pi-extension/index.ts`）**：`init-design` 在 M0 落盘自动解锁且存在活跃总线时平滑进入 `EXECUTING`（不再跌回 `IDLE`）；无总线的单轮辅助命令（`/zee-setup`、`/zee recall`、`/zee-retro`）在 `agent_settled` 后自动回归 `IDLE` 保持 HUD 零噪音。
- **[P2] 花园队列关闭闭环与 `mine-transcripts` 降噪（`skills/zee/scripts/zee-tool.mjs`, `skills/zee-retro/SKILL.md`）**：新增 **`zee-tool.mjs resolve-finding --repo <repo> --pattern <slug> [--note <text>]`**（追加审计关闭已固化 `systemic` 簇，`list-findings` 默认仅显示未关闭项并支持 `--include-resolved`，若日后复发自动重新计数）；`mine-transcripts --mode retro` 过滤 ADR/文档与 `<skill ...>` 展开块，大幅降低 `human_correction` 误报。
- **[P2] 文档防误导修正（`greenfield.md`, `zee-review/SKILL.md`, `overnight.md`）**：明确 Pi 端禁止手传 `--inc-delegates`/`--delegate-id`，并明确 `reviewers[0]` 429 或备胎同家族时继续顺位尝试 `reviewers[1..N]`。

## [4.2.1] - 2026-11-26

> 专项响应 Mac mini 端 7 场景真实程序员实战体验评测反馈（`8.1 / 10` 报告中的 8 大体感痛点与 5 条高杠杆建议）。

### Added
- **跨会话 `429/5xx` 熔断冷却与 `0ms` 健康切备（`skills/zee/scripts/lib/provider-health.mjs`, `zee-tool.mjs provider-health`, `pi-extension/index.ts`, `pi-extension/hub-ui.ts`）**：
  - `zee_subagent` v2.4 将 HTTP `429`（默认 `30m` TTL）与 `5xx`（默认 `5m` TTL）建连即败记录至 `~/.local/state/zee/provider-health.json`，**彻底免扣 `delegatesDispatched` 预算名额**；后续 `zee_subagent` 与 `zee-tool.mjs resolve-model`（无 `--ignore-cooldown` 时）直接 `0ms` 自动切换健康备胎（遵守跨家族审查隔离）。
  - 新增 `zee-tool.mjs provider-health [--clear [modelKey]]` 并集成进 `doctor`；Hub Tab 4 新增冷却通道清单、Tab 5 新增 `[h]` 一键清理冷却操作。
- **Pi 11 干净命令去重（`package.json`, `pi-extension/index.ts` `expandBundledZeeSkill`）**：移除 `package.json` 中的 `pi.skills` 暴露，改为 `pi-extension/index.ts` 直接读取并展开仓库内置 `skills/<name>/SKILL.md`，消灭 Pi 命令列表 19 项 `/skill:zee*` 重影。
- **`/zee-review --strict / --quick` 双档位与 **`L1.5` 轻量快轨**（`skills/zee-review/SKILL.md`, `skills/zee/SKILL.md`, `pi-extension/index.ts`）**：
  - `/zee-review` 默认 `--strict` 在 Pi 扩展层机械自动创建独立 `review-*` 总线并追踪跨家族 `Reviewer` 派发（跳过则记录 `G-02` 告警），`--quick`（目标 `<45s`）用于小 diff 轻量只读快审；`/zee` 路由新增 `L1.5` 轻量快轨降低 `≤3` 文件小修耗时。
- **HUD/流式实时心跳深化**：`HEARTBEAT_INTERVAL_MS` 缩短至 `10s`，实时输出 `turns`、`cost` 与纯思考 `thinking=Xs`；Layer 1 `formatWorkerLine` 同步显示 `t<turns>` 与 `$<cost>`。

### Changed & Fixed
- **解除只读锁 3 类“自伤”摩擦（`skills/zee/scripts/lib/guard-core.mjs`）**：
  - 严格在 `/tmp/zee-*` / `os.tmpdir()/zee-*` 沙盒内放行本地 `git -C ... init/apply/add/commit/...`（**绝不含 `push`**）；
  - `cp` 识别 `-t <dir>` / `--target-directory=<dir>` 并支持 `${TMPDIR:-/tmp}` 沙盒变量绑定；
  - `<busDir>`（`RUNS_ROOT`）及白名单目标文件放行受控 `sed -i` / `perl -i` 与解释器写操作（业务源码与逃逸 `..` 仍硬拦截）；
  - `review`/`plan` 锁下精准放行清理 `.gitignore` 忽略且零 tracked 文件的标准构建/测试产物目录（`test-results/`、`dist/`、`playwright-report/`、`coverage/` 等，严禁删 `.git`/`node_modules`/`.env*`）。
- **修复功能分支下 worktree 清理基准（`zee-tool.mjs cleanup-worktrees`）**：未显式传入 `--base` 时默认同时校验当前 `HEAD` 与默认主干，使功能分支内已合并 worktree 立即可被 `--prune-safe` 回收。
- **强化父编排器全局规则隔离（`pi-extension/index.ts`, `zee-tool.mjs audit-rules`）**：即使 `/zee-mode off` 时显式运行 `/zee-retro` 等命令，也在父会话注入 `AMBIENT_RULE_ISOLATION_LINE` 覆盖 `~/CLAUDE.md` / `~/.claude/CLAUDE.md` / `~/.pi/agent/AGENTS.md` 的冲突硬限制。
- **包清单与脚本同步**：`package.json` 与 `.antigravity-plugin/plugin.json` 同步升至 `4.2.1`。

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
