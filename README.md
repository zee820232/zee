# zee — 通用多模型全自动工程工作流（v4.2.2）

`zee` 是一套按标准 [Agent Skills](https://agentskills.io) 编写的**通用多模型全自动研发工作流**，采用 **Pi Package + Google Antigravity Native Plugin + 标准 Agent Skills 三形态单仓封装**。

**核心理念：**
- **零配置即战力（Own Set of Knives）+ 一次装配长期自动**：只读/单兵技能（`/zee-verify`、`/zee-retro`、`/zee-arch`、`/zee-review`、`/zee-plan`、`/zee recall`、`/zee triage`）在无 `~/.agents/zee-config.json` 时通过 `resolve-model --allow-standalone` 优雅退化为当前会话模型直接运行；运行 `/zee-setup` 一次装配多家族模型与预授权备胎后，自动按 `T1/T2/T3` 信任梯度与风险定级推进全流程。
- **装在哪就管哪个 Harness**：不绑死特定总控，也不越界改动其他框架。安装在 Pi、Google Antigravity、T3 Code、Claude Code、Codex、Cursor 或 OpenCode 中的哪一个，就只管理当前这一个宿主环境。
- **确定性 CLI 卸载 + 内部契约严谨 + 对外交互全中文**：沙盒导出、门禁篡改扫描、跨宿主对话挖掘、花园队列与信任度钳位全部下沉为 `zee-tool.mjs` 确定性原语；所有面向用户的访谈提问、进度播报、方案确认、风险提醒、架构报告和过夜晨报一律使用简体中文。

---

## 安装方式

### 方式一：一行 `npx` 交互式选择安装（推荐 · 无需克隆）

```bash
# 弹出菜单自由选择：Pi / Google Antigravity (agy) / 通用 Agent Skills / 同时安装
npx github:zee820232/zee

# 或直接非交互指定目标宿主（可附加 --doctor 安装后体检）：
npx github:zee820232/zee --target pi --doctor
npx github:zee820232/zee --target agy --doctor
npx github:zee820232/zee --target skills
npx github:zee820232/zee --target both --doctor
```

### 方式二：Pi 用户（完整 Pi Package 形态 · 适配 Pi v1.6.1）

```bash
pi install git:github.com/zee820232/zee
```

安装即得（v4.2.2）：
- **11 个干净命令（零 `/skill:zee*` 重影）**：`/zee`、`/zee-init`、`/zee-plan`、`/zee-review`（`--strict` / `--quick`）、`/zee-verify`、`/zee-arch`、`/zee-retro`、`/zee-night`、`/zee-setup` + `/zee-mode` + `/zee-hub`（`Ctrl+Alt+H` / `F2`）+ **6 份按需工程纪律**（`package.json` 移除了 `pi.skills`，由扩展直接内置展开，彻底消除 Pi 菜单 19 项重影）
- **Pi v1.6.1 双轴 FSM 与零冲突 Layer 0/1/2 HUD/Hub（`fsm.ts` + `bus-sync.ts` + `hub-ui.ts`）**：
  - **14 个工作流阶段 × 9 个子代理车道状态** + **G-01..G-06 运行期守卫**（跨回合 `zee-fsm` 分支持久化与 `zee-mode`/`zee-gate` 向下兼容，`/tree` 切回时自动标出 `busAheadOfBranch` 绝不覆写磁盘较新 `state.json`）。
  - **Layer 0 状态栏徽章**（`setStatus("zee-mode")` `≤18` 列紧凑指示，**绝不调用 `setFooter()`**，与 `pi-cometix-footer` 完美共存）。
  - **Layer 1 `aboveEditor` 响应式 HUD**（`setWidget("zee-hud", ..., { placement: "aboveEditor" })`：`IDLE` 时自动隐身 0 行；`full` 边框卡片含实时 `turns`/`cost` 跳表 / `compact` 1–2 行 / `hidden`；RPC 降级 `string[]`、`Print`/`JSON`/`ZEE_WORKER=1` 100% 静默）。
  - **Layer 2 5-Tab 交互控制台（`/zee-hub` / `Ctrl+Alt+H` / `F2`，严格避开 Pi 保留快捷键 `Ctrl+G`）**：`1 Overview & FSM`、`2 Workers`（实时预览 `partial-*.md`）、`3 Gates & Trail`（Gate 1→2 + `G-01..G-06` + `decisions.tsv`）、`4 Worktrees & Cost`（6 桶回收 + 成本条 + `429/5xx` 熔断冷却状态）、`5 Controls`（`m`/`l`/`w`/`c`/`d`/`p`/`h` 单键控制）。
- **跨回合保护锁 + 零自伤只读放行 + 子进程 `worker-guard.ts`**：`/zee-plan`/`/zee-arch`/`/zee-init`/`/zee-review` 保护锁与 `guard-core.mjs` 共享（支持 Windows 反斜杠与大小写无关 `/tmp/zee-*`/`os.tmpdir()/zee-*`），精准放行 `/tmp/zee-*` 内 `git apply`、`cp -t /tmp/zee-*`、`<busDir>` 内 `sed -i`/`python3` 与 `.gitignore` 忽略且零 tracked 产物清理（`test-results/`/`dist/`），并注入父编排器全局规则隔离。
- **内置并行子代理引擎 `zee_subagent` v2.4**：**跨会话 `429/5xx` 熔断冷却（`provider-health.json`）与 `0ms` 健康切备（建连即败免扣预算）**、`10s` 实时进度心跳（含 `turns`/`cost`/`thinking`）、`toolCallId` 幂等去重、G-02 Gate 1→Gate 2 硬门槛校验、Windows `ZEE_PI_BIN` `.mjs`/`.js`/`.ts` `spawn EFTYPE` 修复与 `"junction"` `node_modules` 挂载、流式抢救（`>2KB` 落盘 `partial-*.md`）、4 击 `StagnancyTracker`、`authorFamily` 同家族硬拦截与 70% 截断提示。

### 方式三：Google Antigravity（`agy` CLI / App / IDE 原生插件形态）

```bash
agy plugin install https://github.com/zee820232/zee
```

安装即得（v4.2.2）：
- **专属主控代理 `zee`（零劫持闲聊）**：终端运行 **`agy --agent zee`**（或在 CLI `/agents` / Antigravity App 切换 `zee`），绝不内置劫持普通对话的 `rules/AGENTS.md`
- **6 个硬权限隔离角色子代理**（`zee-scout` / `zee-architect` / `zee-ui` / `zee-coder` / `zee-verifier` / `zee-reviewer`）：全部内置 `inheritCustomizations: false` 与精确 OneHarness `tools:` 白名单
- **9 个原生斜杠命令 + 三事件生命周期 Hook（`PreInvocation` + `PreToolUse` + `Stop`）**：`$PLUGIN_DATA` 跨回合保持锁状态、共用 `guard-core.mjs` 词法安全核、支持 Brain Artifacts（「Proceed」按钮 / `walkthrough.md` / `carousel` / `decisions.tsv`）、`run_workflow` 宽扇出与 `Stop` 过夜防断尾

> ⚠️ **防冲突提示**：使用 `pi install` 或 `agy plugin install` 安装后，请勿在对应宿主的 `skills/` 目录保留旧的手动 `zee*` 副本，以免触发重名警告（`install.mjs` 会自动清理，也可运行 `zee-tool.mjs doctor` 排查）。

### 方式四：其他通用 Harness（T3 Code / Claude Code / Codex / Cursor / OpenCode）

```bash
npx skills add zee820232/zee
```

单兵/只读命令（`/zee-verify`、`/zee-retro`、`/zee-arch`、`/zee-review`、`/zee-plan`、`/zee recall`、`/zee triage`）安装即用；运行一次 **`/zee-setup`** 即可启用完整跨家族多模型协同。

---

## 全指令一览（9 技能 + 自动路由 + 控制台 + 专项子模式）

| 命令 / 入口 | 定位 | 写锁保护 / 零配置兜底 | 一句话场景 |
| :--- | :--- | :--- | :--- |
| **`/zee-setup`** | 模型装配 + 宿主体检 + `readiness` | 无锁 | 配置模型/预算、检查漂移、生成 `.agents/zee.project.json`（含 `trustLevel` 与 `pathSkills`） |
| **`/zee-mode`** / **`agy --agent zee`** | 常驻自动路由开关 | 随状态联动 | 开启日常智能自动路由（简单问答直答，复杂工程自动走 zee） |
| **`/zee-hub`**（`Ctrl+Alt+H` / `F2`） | Pi 交互式 5-Tab 控制台 | 只读观测+安全控制 | 查看 FSM 阶段、Worker 实时进度与抢救稿、Gate 1→2 门禁、Worktree 与成本控制 |
| **`/zee-init`** | 项目 **0→1** 全自动建项 | Stage 1–2 `init🔒` | 空目录或全新想法从零做到实机验收（含 `--fuzz`）通过的 v1 |
| **`/zee-plan`** | 深度 Grill 访谈 + 领域建模 + 计划 | 跨回合 `plan🔒` · 支持零配置 | 动手前先聊透需求、补 `GLOSSARY.md`/ADR、产出 `plan.md` 后停机 |
| **`/zee`** | **1→100** 全自动开发主入口 | 按子模式自动上锁 | 支持 L0/L1/**L1.5 快轨**/L2/L3、接棒 `plan.md`、`recall`、`triage`、`investigate`、`perf`、`loop`、`sweep`、`resume` |
| **`/zee-review`** | 只读跨家族三轴对抗审查 | 单轮 `review🔒` · 支持零配置 | 默认 `--strict` 机械建独立总线 + 跨家族审未提交/分支改动；支持 `--quick` (<45s) 快审 |
| **`/zee-verify`** | **项目级实机验证技能全生命周期** | `run` 启 `review🔒` · 支持零配置 | 生成并真机跑通 `verify-<app>` + `verify-ctl.*`、防腐维护、冷启动验收与 `--fuzz` |
| **`/zee-arch`** | 代码库深模块抗熵增巡检 | 跨回合 `plan🔒` · 支持零配置 | 结合 `git log` 热点与 `list-findings`（`systemic` 模式），输出交互式 HTML 报告 |
| **`/zee-retro`** | 会话复盘与 4+1 纠错飞轮 | 审批后执行 · 支持零配置 | 挖掘跨宿主对话与花园队列，按 4 级阶梯 +「新建技能/裁剪死规则」固化并做 Bite Proof |
| **`/zee-night`** | 无人值守过夜模式 | 隔离分支不碰 `main` | 睡前锁定 5 项不变量与 `T1/T2/T3` 信任梯度后过夜推进并出中文晨报 |

---

## v4.2.1 / v4.2.0 核心增强亮点（8 大原则 + 程序员体验实测优化）

- **Mac 7 场景实战体验专项优化（v4.2.1）**：
  - **Pi 菜单去重（19 → 11 项）**：`package.json` 移除了 `pi.skills` 字段，Pi 扩展通过 `expandBundledZeeSkill` 内置展开 9 个工作流技能，彻底消除 `/skill:zee*` 重影。
  - **跨会话 `429/5xx` 熔断切备与免扣预算**：新增 `lib/provider-health.mjs` + `zee-tool.mjs provider-health`，429/5xx 建连即败自动写入冷却（30m / 5m）且**绝不扣减 `delegatesDispatched` 预算**，下次直接 `0ms` 自动切换健康备选，HUD 与 Hub 同步展示 `turns`/`cost`/冷却倒计时。
  - **解除只读锁 3 类“自伤”**：安全放行 `/tmp/zee-*` 内 `git -C ... apply` 与 `cp -t /tmp/zee-*`、`<busDir>` 内 `sed -i`/`python3`、以及 `.gitignore` 忽略且零 tracked 产物（`test-results/`/`dist/`）清理；业务源码与 `.git`/`node_modules`/`.env*` 依旧 100% 物理拦截。
  - **`/zee-review --strict / --quick` + `L1.5` 快轨 + 功能分支 worktree 回收**：`--strict` 机械自建独立总线并检查 Reviewer 派发；`--quick` & `L1.5` 压缩小改等待时间；`cleanup-worktrees` 默认同时比对当前 `HEAD` 与主干，功能分支已合入 worktree 即刻可回收；全局 `~/CLAUDE.md`/`~/.pi/agent/AGENTS.md` 冲突限制不再渗透 `/zee-retro` 等编排。

### 1. 信任梯度（`trustLevel: T1 / T2 / T3`）与机械化准入（`readiness`）
在 `<repo>/.agents/zee.project.json` 中配置可选 `"trustLevel"`，并由 `zee-tool.mjs readiness "<repoRoot>"` 按仓库实际完备度**自动向下钳位**为 `effectiveTrustLevel`：
- **`T1`（默认）**：每片严格串行 **Gate 1 (`Verifier`) → Gate 2 跨家族 (`Reviewer`)**。
- **`T2`（双向门提速）**：需具备 `projectJson && testCmds && lintCmd && denyCommands && verifySkill`。非 `riskPaths`、非 UI 的双向门切片通过 Gate 1（`verify-<app>` `PASS`）后即可合入 `zee/<slug>`，并在里程碑收口由跨家族 `Reviewer` 批量抽检（命中 `riskPaths`、UI 截图或 `GATE_CHANGE_RATIONALE` 仍保持严格逐片双门禁）。
- **`T3`（高信任过夜自治）**：需在 `T2` 基础上具备 `verify-ctl.*` 与 `riskPaths`。在隔离分支 `zee/<slug>` 上执行 Gate 1 + `--fuzz` + 晨间抽检 + 零写码 `Audit Judge`。

### 2. 花园队列（`.agents/gardening-queue.jsonl`）、`/zee recall` 与 `/zee triage`
- **不丢失的非阻塞债**：Bug 排查（`diagnosing-bugs.md`）与代码审查（`roles/reviewer.md`）发现的非阻塞 `P2` 坏味道、缺失 Test Seam 或重复绕过，不再中途扩 scope 或埋没在总线回执里，而是通过 `zee-tool.mjs queue-finding` 追加到 `.agents/gardening-queue.jsonl`；同一 `pattern` 累计 `>= 3` 次自动标为 `systemic: true`，在 `/zee-arch` 与 `/zee-retro` 中置顶处理。
- **`/zee recall <topic>`**：调用 `zee-tool.mjs mine-transcripts --mode recall` 跨 AGY/Pi/Claude/Codex 会话日志、总线 `decisions.tsv`/`partial-*.md`/`plan.md`、`docs/adr/` 与花园队列检索历史决策（自动对密钥做 `<REDACTED>` 脱敏），输出 `≤40` 行高密度中文上下文简报。
- **`/zee triage`**：Chief-of-Staff 三步外环分诊——在 `main` 上只读复现过滤陈旧噪音 → 按共享根因聚类 → 输出可执行 `/zee-plan`/`/zee-night` 简报或入库 `queue-finding`。

### 3. `verify-<app>` 升级与 `verify-map.md` 漂移清理
- 统一以 `<projectSkillsDir>/verify-<app>/`（`SKILL.md` + `scripts/verify-ctl.(mjs|py|sh)` + `features/`）为唯一真源，彻底清理 `roles/coder.md` 与 `roles/scout.md` 中的过时 `.agents/verify-map.md` 指引，并在 `coder.md` 回执中新增 `VERIFY_MAP_DELTA`。
- **零仓库污染铁律**：所有测试报告、Playwright 产物、临时构建与 Scratch 强制放入 `/tmp/zee-verify-*` 或 `<busDir>`（严禁在 `review🔒` 锁定的 `/zee-verify run` 中向仓库写入或 `rm -rf` `test-results`/`dist`）。
- **`--fuzz` 探索式实机压测**：`L3`、`0→1 Stage 5` 与 `T3` 默认在脚本化功能验收后执行时间盒限制的真实用户交互与边界输入 fuzzing。

### 4. `pathSkills` 按路径按需注入 & 定期只读巡检配方
- 在 `.agents/zee.project.json` 配置 `pathSkills`（`[{ "glob": "...", "skill": "...", "roles": [...] }]`），通过 `zee-tool.mjs match-skills` 仅在修改文件命中 glob 时向子代理注入对应技能（零常驻上下文税）。
- `references/overnight.md` 新增低风险**定期外环只读巡检配方**（借助宿主 `schedule_task` / `schedule` 定时执行 `/zee-verify maintain` 与 `list-findings` 扫描，不自动改写业务源码）。

---

## 全指令用法详解（逐命令手册）

### 1. `/zee-setup` — 模型装配、健康体检与项目初始化
```text
/zee-setup
/zee-setup 只跑一次 doctor 体检当前宿主，不要改动任何文件
/zee-setup 帮我把预算切到 balanced，并给当前项目生成 .agents/zee.project.json
```
1. 执行 `zee-tool.mjs doctor [--repo <repoRoot>]` 体检配置、`enabledModels` 漂移、规则冲突、总线可写性与项目 `readiness`。
2. 引导选择 `eco / balanced（推荐）/ max` 预算与 6 大角色槽位。
3. 可选生成 `.agents/zee.project.json`（含 `trustLevel`、`pathSkills`、`riskPaths`、`uiGlobs`、`denyCommands`）并建议用 `/zee-verify init` 建立实机验收安全网。

### 2. `/zee-mode` & `/zee-hub`（Pi）与 `agy --agent zee`（Antigravity）
```text
/zee-mode status | auto | strict | off
/zee-hub                 # 或快捷键 Ctrl+Alt+H / F2 打开 5-Tab 交互控制台
agy --agent zee          # Antigravity 专属总控代理（零劫持普通对话）
```

### 3. `/zee-init` — 项目 0→1 全自动建项
`Stage 1（SPEC + 术语/ADR）→ Stage 2（Scout 沙盒探针 ∥ UI DESIGN → Architect）→ Stage 3（M0 + M1 + verify-<app>）→ Stage 4（M2..Mk）→ Stage 5（冷启动 + --fuzz + 文档交付）`。

### 4. `/zee-plan` — 深度访谈、领域建模与计划沉淀（只规划不写码）
跨回合持久化 `plan🔒` 写锁护航，多轮中文决策树 Grill + `GLOSSARY.md`/3 条件 ADR + `check-plan` 校验，产出 `.scratch/<slug>/plan.md` 后干净停机。

### 5. `/zee` — 1→100 全自动开发主入口（含全部专项子模式）
```text
/zee 修复重试超时导致的重复扣款问题                     # Bug 意图自动走「先红后绿复现专线」
/zee 执行 .scratch/weather-traps/plan.md               # Approved Plan Fast-Path
/zee L3 重新设计分布式任务调度器                          # 强制 L3：正交 Arena + --fuzz + 多席跨家族会审
/zee recall 为什么当初把 guard-core 拆成双端共享          # 跨宿主对话与总线回忆，输出 ≤40 行中文简报
/zee triage                                             # 复现验证 + 根因聚类 + 输出 /zee-plan 或 queue-finding
/zee investigate 订单状态机和重试补偿是怎么流转的         # 纯只读深度调研
/zee debate / perf / loop --verify "..." / prototype / sweep / resume
```

### 6. `/zee-review`、`/zee-verify`、`/zee-arch`、`/zee-retro`、`/zee-night`
- **`/zee-review [--strict | --quick]`**：启用 `review🔒` 只读锁，默认 `--strict` 机械建独立总线 + `gate-tamper-diff` + `sandbox-export` 隔离爆破复现与三轴审查；`--quick`（`<45s`）用于清晰小改动快速只读核验，`P2` 自动入库 `.agents/gardening-queue.jsonl`。
- **`/zee-verify [init|maintain|run] [--fuzz]`**：围绕 `verify-<app>/SKILL.md` + `scripts/verify-ctl.(mjs|py|sh)` + `features/` 执行，所有产物隔离在 `/tmp/zee-verify-*` 或 `<busDir>`。
- **`/zee-arch`**：结合 `git log` 热点与 `zee-tool.mjs list-findings`（`systemic: true` 置顶）做删除测试，输出交互式 Before/After HTML 报告。
- **`/zee-retro`**：联查 `mine-transcripts --mode retro`、`list-findings`、`list-runs` 与 `git log`，按「架构 > Lint/Hook/CI > Seam 测试 > 精简文档 > 新建技能/裁剪死规则」提案并做 Mandatory Bite Proof。
- **`/zee-night`**：Pre-Launch Trust Gate + `readiness` 校核 + `zee/<slug>` 隔离分支 + `T1/T2/T3` 门禁 + 70% 截断收口 + 异构 Audit Judge + 中文晨报。

---

## 核心架构与 `zee-tool.mjs` 确定性原语速查（21 项）

| 子命令 | 用途 |
| :--- | :--- |
| `provider-health [--clear [模型键]]` | 查看当前跨会话 `429/5xx` 熔断冷却通道，或清除指定/全部冷却缓存 |
| `doctor [--harness <名>] [--repo <path>] [--all]` | 一站式健康体检（配置 + Pi 漂移 + 规则冲突 + 总线 + AGY Hook + 项目 `readiness` + `providerHealth`） |
| `validate [cfg] [--check-live]` | 校验 `zee-config.json` schema v2、跨家族多样性与 Pi live 漂移 |
| `audit-rules [--all \| --harness <名>]` | 审计宿主规则与双安装重名冲突 |
| `readiness [repoRoot]` | 检查 `.agents/zee.project.json` 与 `verify-*`/`verify-ctl`，将 `trustLevel` 钳位为有效档位 |
| `match-skills --repo <repo> --files <csv> [--role <r>]` | 匹配 `pathSkills` glob 与角色，按需注入项目技能（零常驻税） |
| `init-run <repo> <slug> [--conversation-id <cid>]` | 创建仓库外运行总线 `~/.local/state/zee/runs/<repo-key>/<slug>/` |
| `update-state <busDir> [--delegate-id <id>] [...]` | `tmp+rename` 原子更新 `state.json`（`--delegate-id` 幂等去重防 2x 记账） |
| `list-runs [repo \| --all]` | 列出活跃/暂停总线供 `/zee resume` 一键续跑 |
| `log-decision --bus ... --unit ... --phase ...` | 安全追加一行审计记录到 `decisions.tsv` |
| `worktree-create <repo> <slug> <lane> <baseRef>` | 原子创建隔离 worktree（自动扁平化嵌套分支 ref 冲突） |
| `cleanup-worktrees [repo] [--base <ref>] [--prune-safe]` | 未传 `--base` 时同时比对当前 `HEAD` 与默认主干，跨平台 6 桶体检 worktree 与安全回收 |
| `check-plan <plan.md> [--strict-budget]` | 校验必备章节、切片循环/悬空依赖与单切片预算（≤5 文件 / ≤400 LOC） |
| `resolve-model --harness ... --role <角色> [--allow-standalone] [--ignore-cooldown]` | 翻译角色模型标识；命中冷却自动切健康 `backup`，缺省配置加 `--allow-standalone` 单兵兜底 |
| `sandbox-export --repo <repo> [--sha <sha> \| --working-tree] [--prefix rev\|mut]` | 一行导出快照或工作区 diff 到安全 `os.tmpdir()/zee-*` 沙盒 |
| `sandbox-clean <sandboxDir>` | 校验路径安全后彻底清理 `zee-*` 沙盒目录（不碰 `<busDir>`） |
| `gate-tamper-diff --repo <repo> [--base <ref>] [--head <ref> \| --working-tree]` | 自动检测测试/CI/Lint 门禁文件改动与新增抑制注释（`as any`、`@ts-ignore` 等） |
| `mine-transcripts [--mode retro\|recall] [--repo <repo>] [--query <text>]` | 只读挖掘跨宿主会话日志、总线决策、ADR 与花园队列（自动 `<REDACTED>` 脱敏） |
| `queue-finding --repo <repo> --category <c> --pattern <p> --summary <s>` | 追加非阻塞 P2 债/缺失 Seam 到 `.agents/gardening-queue.jsonl`（≥3 标 `systemic`） |
| `list-findings --repo <repo> [--min-count 1]` | 按 `pattern` 聚合排序输出 `.agents/gardening-queue.jsonl` 集群 |
| `symlinks [--apply]` | 仅在用户显式要求同步多端时检查或创建跨宿主软链 |

---

## 目录结构

```text
.antigravity-plugin/plugin.json   # Google Antigravity 原生插件清单（v4.2.1）
assets/logo.svg                   # Antigravity 插件卡片图标
agents/                           # Antigravity 原生代理（主控 zee + 6 隔离角色子代理）
hooks.json                        # Antigravity 原生三事件 Hook（PreInvocation / PreToolUse / Stop）
scripts/
├── install.mjs                   # 交互式 / 命令行多宿主选择安装器（pi | agy | skills | both）
└── agy-guard.mjs                 # Antigravity 生命周期守卫与跨回合写锁
package.json                      # Pi Package 清单（v4.2.1，移除 pi.skills 消除重影）
pi-extension/
├── index.ts                      # Pi v1.6.1 扩展：11 干净命令、/zee-review 双档、zee_subagent v2.4
├── fsm.ts                        # 纯 TS 双轴状态机（14 工作流阶段 × 9 车道状态 + G-01..G-06）
├── bus-sync.ts                   # 零轮询总线水合 + /tree busAheadOfBranch 保护
├── hub-ui.ts                     # 零冲突 Layer 0/1/2 HUD & 5-Tab 交互 Hub（含冷却显示与 [h] 清除）
└── worker-guard.ts               # Pi 子进程极简安全守卫（-ne -e 挂载，消灭子代理安全真空）
skills/
├── zee/                          # 核心工作流（唯一真源）
│   ├── SKILL.md                  # 宿主无关总控内核（v4.2.1）
│   ├── worker.md                 # 子代理通用前置契约（含 [zee-worker] 防递归哨兵）
│   ├── roles/                    # scout / architect / ui / coder / verifier / reviewer
│   ├── disciplines/              # domain-modeling / deep-modules / diagnosing-bugs / code-smells / phase-boundaries / verification-skill
│   ├── references/               # harness / antigravity / interop / protocols / plan-mode / greenfield / overnight / specialized
│   └── scripts/                  # zee-tool.mjs（21 原语）+ lib/guard-core.mjs + lib/provider-health.mjs
├── zee-plan/                     # Grill 访谈 + 领域建模 → 计划文档
├── zee-init/                     # 项目 0→1 全自动建项
├── zee-review/                   # 只读跨家族三轴对抗审查
├── zee-verify/                   # 项目级实机验证技能全生命周期（init / maintain / run / --fuzz）
├── zee-arch/                     # 代码库深模块抗熵增巡检
├── zee-retro/                    # 会话复盘与 4+1 结构化纠错飞轮
├── zee-night/                    # 无人值守过夜模式
└── zee-setup/                    # 模型装配、宿主体检（readiness）与项目契约生成
```

## 开源协议

MIT
