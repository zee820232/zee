# zee — 通用多模型全自动工程工作流（v4.1.1）

`zee` 是一套按标准 [Agent Skills](https://agentskills.io) 编写的**通用多模型全自动研发工作流**，采用 **Pi Package + Google Antigravity Native Plugin + 标准 Agent Skills 三形态单仓封装**。

**核心理念：**
- **一次装配，长期自动**：只需通过 `/zee-setup` 配置一次各角色的模型、思考强度与预授权备胎，后续自动按任务风险调度执行。
- **装在哪就管哪个 Harness**：不绑死特定总控，也不越界改动其他框架。安装在 Pi、Google Antigravity、T3 Code、Claude Code、Codex、Cursor 或 OpenCode 中的哪一个，就只管理当前这一个宿主环境。
- **内部契约严谨、对外交互全中文**：底层跨模型 worker 契约保持英文以保证执行稳定；所有面向用户的访谈提问、进度播报、方案确认、风险提醒、架构报告和过夜晨报一律使用简体中文。

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

### 方式二：Pi 用户（完整 Pi Package 形态）

```bash
pi install git:github.com/zee820232/zee
```

安装即得（v4.1.1）：
- **9 个完整工作流技能 + `/zee-mode` 常驻路由开关**：`/zee`、`/zee-init`、`/zee-plan`、`/zee-review`、`/zee-verify`、`/zee-arch`、`/zee-retro`、`/zee-night`、`/zee-setup` + `/zee-mode` + **6 份按需工程纪律**（`skills/zee/disciplines/`）
- **跨回合持久化保护锁 + 双端词法安全核 + 子进程 `worker-guard.ts`**：`/zee-plan`/`/zee-arch` 与 `/zee-init`（Stage 1–2）跨多轮保持防写锁，封堵 `(...)`/`{}`/`$(...)`/`perl -0pi` 词法绕过，token 边界精准匹配项目 `denyCommands`（不误杀 `/tmp/zee-*`），放行 `/tmp/zee-*` 沙盒探针与装包，子进程 `-ne -e worker-guard.ts` 消灭安全真空
- **内置并行子代理引擎 `zee_subagent` v2.2**：`provider/model` 按 `zee-config.json` 自动归一、流式正文优先抢救并自动落盘（`>2KB` 存 `artifacts/partial-*.md`）、并发 Map 双态看门狗、15s 节流心跳、原子 worktree 预挂 `node_modules`（写 `.git/info/exclude` 零误报）+ 嵌套分支 ref 冲突自动扁平化、70% 预算自动注入 `[ZEE_BUDGET_CUTOFF]` 与 `delegatesDispatched` 自动落账、归一化 `authorFamily` 同家族硬拦截

### 方式三：Google Antigravity（`agy` CLI / App / IDE 原生插件形态）

```bash
agy plugin install https://github.com/zee820232/zee
```

安装即得（v4.1.1）：
- **专属主控代理 `zee`（零劫持闲聊）**：终端运行 **`agy --agent zee`**（或在 CLI `/agents` / Antigravity App 切换 `zee`），绝不内置劫持普通对话的 `rules/AGENTS.md`
- **6 个硬权限隔离角色子代理**（`zee-scout` / `zee-architect` / `zee-ui` / `zee-coder` / `zee-verifier` / `zee-reviewer`）：全部内置 `inheritCustomizations: false` 与精确 OneHarness `tools:` 白名单
- **9 个原生斜杠命令 + 三事件生命周期 Hook（`PreInvocation` + `PreToolUse` + `Stop`）**：`$PLUGIN_DATA` 跨回合保持锁状态、共用 `guard-core.mjs` 词法安全核、支持 Brain Artifacts（「Proceed」按钮 / `walkthrough.md` / `carousel` / `decisions.tsv`）、`run_workflow` 宽扇出与 `Stop` 过夜防断尾

> ⚠️ **防冲突提示**：使用 `pi install` 或 `agy plugin install` 安装后，请勿在对应宿主的 `skills/` 目录保留旧的手动 `zee*` 副本，以免触发重名警告（`install.mjs` 会自动清理，也可运行 `zee-tool.mjs doctor` 排查）。

### 方式四：其他通用 Harness（T3 Code / Claude Code / Codex / Cursor / OpenCode）

```bash
npx skills add zee820232/zee
```

安装完成后运行一次 **`/zee-setup`** 完成模型装配即可使用。

---

## 全指令一览（9 技能 + 自动路由入口）

| 命令 / 入口 | 定位 | 写锁保护 | 一句话场景 |
| :--- | :--- | :--- | :--- |
| **`/zee-setup`** | 模型装配 + 宿主体检 + 项目契约 | 无 | 首次安装、切换模型/预算、排查配置漂移或接手仓库立规矩 |
| **`/zee-mode`** / **`agy --agent zee`** | 常驻自动路由开关 | 随状态联动 | 开启日常智能自动路由（简单问答直答，复杂工程自动走 zee） |
| **`/zee-init`** | 项目 **0→1** 全自动建项 | Stage 1–2 `init🔒` | 空目录或全新想法从零做到实机验收通过的 v1 |
| **`/zee-plan`** | 深度 Grill 访谈 + 领域建模 + 计划沉淀 | 跨回合 `plan🔒` | 动手前先聊透需求、补 `GLOSSARY.md`/ADR、产出 `plan.md` 后停机 |
| **`/zee`** | **1→100** 全自动开发主入口（含 10+ 专项子模式） | `plan`/`review`/`arch` 自动上锁 | 日常开发、修 Bug、重构、执行已拍板 `plan.md`、调研、性能调优、续跑 |
| **`/zee-review`** | 只读跨家族三轴对抗审查 | 单轮 `review🔒` | 审未提交工作区改动（`git diff HEAD`）、分支 diff 或指定 PR/SHA |
| **`/zee-verify`** | **项目级实机验证技能全生命周期**（对标 pstack） | `run` 启 `review🔒` | 给新/老项目生成并真机跑通 `verify-<app>`、定期防腐维护或一键实机验收 |
| **`/zee-arch`** | 代码库深模块抗熵增巡检 | 跨回合 `plan🔒` | 扫描 git 热点、浅模块与散弹修改，生成可交互 Before/After HTML 报告 |
| **`/zee-retro`** | 会话复盘与 4 级机械化纠错飞轮 | 审批后执行 | 聚类历史返工错因，固化成类型/Lint/Hook/测试并做咬合力实证（Bite Proof） |
| **`/zee-night`** | 无人值守过夜模式 | 隔离分支不碰 `main` | 睡前锁定 5 项不变量后无人值守逐片开发、异构终审并出中文晨报 |

---

## 全指令用法详解（逐命令手册）

### 1. `/zee-setup` — 模型装配、健康体检与项目初始化

**何时使用**：首次装完 `zee`、换模型/调预算、排查配置漂移（`CONFIG_DRIFT`），或刚进一个现成仓库想建 `.agents/zee.project.json`。

```text
/zee-setup
/zee-setup 只跑一次 doctor 体检当前宿主，不要改动任何文件
/zee-setup 帮我把预算切到 balanced，并给当前项目生成 .agents/zee.project.json
```

**它会做什么**：
1. 执行 `zee-tool.mjs doctor` 一站式检查 `~/.agents/zee-config.json`、Pi `enabledModels` 漂移（含 `prefer` 与 `backup` 槽位）、规则冲突与总线可写性。
2. 用中文引导选择 `eco / balanced（推荐）/ max` 预算与 6 大角色槽位（`scout` / `architect` / `ui` / `coder` / `verifier` / `reviewers`）。
3. 可选为当前 Git 仓库生成 `.agents/zee.project.json`（测试/构建/Lint 命令、`riskPaths`、`uiGlobs`、`denyCommands`），并提示用 `/zee-verify init` 建立实机验收安全网。

---

### 2. `/zee-mode`（Pi）与 `agy --agent zee`（Antigravity）— 常驻自动路由

**何时使用**：希望平时直接用自然语言提需求，不需要每句都敲 `/zee`。

```text
# Pi 中切换常驻自动路由（按会话分支持久化，重启不丢）：
/zee-mode status     # 查看当前模式与保护锁状态
/zee-mode auto       # 推荐：闲聊/简单解释/≤1 文件非风险微调直答，复杂工程自动走 zee
/zee-mode strict     # 严格：所有非问答工程改动强制先走 zee Preflight 与门禁验收
/zee-mode off        # 关闭常驻路由（仍可随时用 /zee* 斜杠命令手动触发）
```

```bash
# Google Antigravity 终端启动专属总控代理（等价于 Pi /zee-mode auto，零劫持普通对话）：
agy --agent zee
```

---

### 3. `/zee-init` — 项目 0→1 全自动建项

**何时使用**：空目录或新想法，想从零构建可运行、有测试、有实机验证技能且验收通过的 v1。

```text
/zee-init 做一个本地 Markdown 书签管理 CLI（TypeScript + SQLite）
/zee-init 做一个手绘复古风格的俯视角荒野求生小游戏（Vite + Canvas + Web Audio）
```

**5 阶段自动流水线**：
1. **Stage 1 · 产品成型（`init🔒` 写锁生效）**：多轮带 `➡️ 推荐` 的中文访谈 → 产出 `SPEC.md`、`GLOSSARY.md`、核心 `docs/adr/0001-*.md` → **默认停一次由你拍板方向**。
2. **Stage 2 · 骨架与视觉设计**：`Scout` 在 `/tmp/zee-probe-*` 实测工具链与框架最新版 ∥ `UI` 产出 `DESIGN.md` → `Architect` 定垂直切片路线图并通过 `check-plan`。
3. **Stage 3 · M0 地基 + M1 最小活链路**：写 `.agents/zee.project.json`（自动解除 `init🔒`）、搭脚手架打首个基线 commit，再单人跑通 M1 端到端主链路并生成真机跑通的 `verify-<app>`。
4. **Stage 4 · M2..Mk 自动切片**：按依赖图在隔离 worktree 逐片开发，严格串行 `Gate 1 Verifier -> Gate 2 Cross-Family Reviewer -> 顺序合入`。
5. **Stage 5 · 交付验收**：冷启动实机验证 + 全套截图多模态审查 + 生成 `README.md` / `CHANGELOG.md` / `.env.example`。

---

### 4. `/zee-plan` — 深度访谈、领域建模与计划沉淀（只规划不写码）

**何时使用**：需求还不清晰、涉及跨模块/高风险改动，想先把接口、边界、术语和取舍想透再决定什么时候写代码。

```text
/zee-plan 给现有游戏加入动态天气系统和套索陷阱
/zee-plan L3 重构支付结算状态机，启动多模型 Arena 架构辩论对比两套方案
```

**特点与护栏**：
- 启用**跨回合持久化 `plan🔒` 写锁**：即便连续聊 3–5 轮访谈或重开会话，任何修改生产源码的写/改操作都会被硬拦截；仅放行运行总线、`/tmp/zee-*`、`.scratch/`、`docs/plans/`、`docs/adr/`、`GLOSSARY.md`。
- 支持**主动领域建模**：在规划阶段顺手补齐 `GLOSSARY.md` 与 3 条件 ADR，并用 `zee-tool.mjs check-plan` 校验切片预算（≤5 文件 / ≤400 LOC）、依赖环与悬空依赖。
- 完成后产出 `.scratch/<slug>/plan.md` 并干净停机，绝不擅自改代码；确认后直接用 `/zee 执行 .scratch/<slug>/plan.md` 或 `/zee-night 执行 ...` 接棒。

---

### 5. `/zee` — 1→100 全自动开发主入口（含全部子模式）

**何时使用**：绝大多数已有项目上的开发、修 Bug、重构、性能调优、调研或接续未完成任务。

#### 常规开发与自动定级（`L0 / L1 / L2 / L3`）
```text
/zee 修复重试超时导致的重复扣款问题                     # Bug 意图自动走「先红后绿复现专线」
/zee 给设置页增加暗色主题切换按钮                         # 自动定级（L1/L2）+ UI 视觉验收
/zee 执行 .scratch/weather-traps/plan.md               # Approved Plan Fast-Path：跳过重访谈直接 Build -> Check -> Merge
/zee L3 重新设计分布式任务调度器                          # 强制 L3：正交 Arena 辩论 + 重装编码 + 多席跨家族会审
```

#### 全部内置专项子模式（可随时附加在 `/zee` 后）
```text
/zee investigate 订单状态机和重试补偿是怎么流转的         # 纯只读深度调研：逐条给 file:line 与实测证据，不改代码
/zee debate 对比 Event Sourcing 与快照表两种存档架构      # 仅跑 L3 多模型 Arena 辩论 + 跨厂商裁判 ADR 报告后停机
/zee perf 优化大列表虚拟滚动帧率（目标 p95 < 16ms）       # 7 问基准冻结 + ABAB 交替测量 + 单变量科学爬坡
/zee loop --verify "pnpm typecheck && pnpm test"        # 面向明确 pass/fail 命令的确定性收敛修复循环（上限 8 轮）
/zee prototype 对比两种背包网格拖拽交互手感               # 一次性可抛原型（纯 HTML 逻辑沙盒或 ?variant=a|b 实时对比）
/zee sweep 检查全仓 20 个 API 路由的鉴权与入参校验遗漏    # 大规模只读并发清扫，输出汇总证据表
/zee resume                                             # 调用 list-runs 定位未完结/暂停的总线，从断点无缝续跑
```

> 快捷等效：`/zee plan ...`、`/zee review ...`、`/zee init ...`、`/zee arch ...` 会自动挂上与对应短命令完全相同的运行时写保护锁。

---

### 6. `/zee-review` — 只读跨家族三轴对抗审查

**何时使用**：合 PR 前、提交前自查，或自己手改了一堆代码还没 `git commit` 想请异构模型找茬。

```text
/zee-review                                             # 默认审当前未提交改动（git diff HEAD）或当前分支 diff
/zee-review 审查最近 3 个提交的并发安全与边界条件
/zee-review 审查 PR #42（附关注点：状态机幂等性）
```

**三轴隔离 + 零污染保证**：
- 启用 `review🔒` 只读锁，审查员硬剥离 `edit` 工具，绝不改动你工作区里的任何文件。
- 动态排除作者模型家族（Pi 上用 `authorFamily` 静态硬拦截同源审查）。
- 严格分三轴报告：**Axis 1 规格贴合度** / **Axis 2 规范卫生与 Fowler 12 坏味道**（含 `as any`/`@ts-ignore` 抑制审计）/ **Axis 3 `/tmp/zee-rev-*` 独立沙盒实测证伪**（标注 L1–L5 爆破半径确定性等级 + `GATE_AUDIT` 反签），有动态 P0/P1 时必带可复现命令。

---

### 7. `/zee-verify` — 项目级实机验证技能全生命周期（对标 pstack verify）

**何时使用**：接手任何已有项目建立防回归安全网、新项目补齐实机验证手册、迭代几版后检查测试地图是否漂移，或随时跑一次冷启动真机验收。

```text
/zee-verify                      # 智能缺省：仓库尚无 verify-<app> 时自动 init；已有时自动 run
/zee-verify init                 # 读源码生成 <projectSkillsDir>/verify-<app>/SKILL.md + features/ 并强制真机跑通 1 条功能证真
/zee-verify maintain             # 防腐维护：索引体检 + 并行 Scout 查漂移 + 逐条真机重跑 + 三分流（文档漂移/驱动缺口/真产品回归）
/zee-verify run                  # 只读（review🔒）派冷启动 Verifier 按 verify-<app> 实机跑完全部映射功能并查图汇报 PASS/FAIL/INCONCLUSIVE
/zee-verify run checkout         # 仅实机验收指定的某个功能切片
```

**为什么必须有它**：
- 单元测试只证明函数逻辑；`verify-<app>` 教“从未见过这个项目的冷启动 Verifier”如何从空数据目录 `Launch -> Doctor -> Drive -> Evidence -> Cleanup`（且保证清理后证据存活）。
- 一旦提交进仓库，后续每次 `/zee`、`/zee-night` 的 Gate 1 `Verifier` 都会**自动优先按 `verify-<app>/SKILL.md` 执行真机验收**。

---

### 8. `/zee-arch` — 代码库深模块抗熵增巡检

**何时使用**：接手陌生老仓库摸家底、几个迭代后觉得改一个小需求总要同时改五六个文件（散弹修改），想定位最值得重构的高杠杆模块。

```text
/zee-arch
/zee-arch 重点巡检 src/core 和 src/app 的模块边界与缺失 Test Seam
```

**工作流与产出**：
- 自动挂 `plan🔒` 锁，**绝不改业务源码**。
- 只读 `Scout` 基于近 60–90 天 `git log` 变更热点（churn hotspots）与共改耦合过滤冷代码 → 只读 `Architect` 应用 **删除测试（Deletion Test）与四类依赖分类** 锁定 2–4 个最高杠杆候选。
- 输出零外链自包含的交互式 Before/After 架构体检报告（`<busDir>/artifacts/arch-audit.html`）+ 中文优先级表（标出 `➡️ 推荐`），选中候选即可直接无缝转入 `/zee-plan`。

---

### 9. `/zee-retro` — 会话复盘与 4 级结构化纠错飞轮

**何时使用**：完成一个里程碑、刚修完一连串返工 Bug，或过夜任务结束后，想把“踩过的坑”变成**机器自动拦住的规则**，而不是再往提示词里堆一句没人看的注意事项。

```text
/zee-retro
/zee-retro 复盘最近两周的提交和运行总线，提炼最高杠杆的防再犯护栏
```

**两回合机制（审批 + 咬合力证明）**：
1. **第 1 回合（只读分析 + 停等审批）**：调用 `zee-tool.mjs list-runs` 读全部历史运行总线 `decisions.tsv` 与 `git log` 返工提交，聚类错因，严格按 **4 级纠错阶梯（1. 架构/类型边界 > 2. Lint/Hook/CI > 3. 公共 Seam 回归测试 > 4. 精简规范文档）** 给出 1–5 张 ≤30 字中文 Ketchup 决策卡，**停下来等你批准**。
2. **第 2 回合（实施 + Mandatory Bite Proof）**：只落地你批准的条目，且对每条新增的自动检查/Lint/回归测试，必须在 `/tmp/zee-retro-*` 复现真实历史错例**证明新规则确实报错咬住（FAIL）**、在干净 `HEAD` 上**全部通过（PASS）**，最终输出 `Rule <-> Enforcer` 映射表。

---

### 10. `/zee-night` — 无人值守过夜模式

**何时使用**：需求边界已清晰（或刚用 `/zee-plan` 产出了 `plan.md`），准备离开电脑让多模型整晚自动逐切片推进。

```text
/zee-night 执行 .scratch/auth-v2/plan.md，在隔离分支 zee/night-auth-v2 上推进
/zee-night 在独立分支完成篝火烹饪与成就徽章两个切片
```

**全链路安全与交付闭环**：
1. **Pre-Launch Trust Gate（必停确认）**：锁定 5 项启动前不变量（可证伪 Done Predicate、清零未决分叉、隔离集成分支 `zee/<slug>` 绝不直接提交 `main`、核验 `denyCommands` 红线、向 `state.json` 写入硬预算与 70% 截断线）——确认前绝不写码。
2. **Unit 0 基线 + Unit 1 Canary**：先核验 `verify-<app>` 并录基线，再单独跑通首切片验证 worktree 与串行双门禁畅通。
3. **逐片串行门禁 + UI 截图强核验 + 70% 自动收口**：凡改动命中 `uiGlobs`，Gate 1 必落盘新 PNG 截图、Gate 2/Judge 必逐图肉眼核验新增元素可见性；预算或墙钟触及 70%（`[ZEE_BUDGET_CUTOFF]`）自动停止开新切片并安全合流收口。
4. **零写码异构 Audit Judge + 中文晨报**：由整晚**未写过一行代码**的异构家族裁判核验 `decisions.tsv`、`git log` 与截图证据指针，最后输出 Ketchup 风格中文晨报（目标状态、已落盘 SHA、搁置项、异构终审提示、≤30 字拍板决策卡、4 级复盘建议）。

---

## 典型场景组合配方

### 场景 A：接手一个现成老项目（推荐标准 4 步 SOP）

```text
# 1. 进仓立规矩（只做一次）：体检模型 + 生成 .agents/zee.project.json 红线契约
/zee-setup

# 2. 摸清家底 + 建实机安全网（全程不改老业务代码）：
/zee-arch                                    # 看 git 热点与浅模块，拿交互式架构报告
/zee investigate 核心支付链路是怎么流转的       # 定向深挖关键模块（只读 file:line 证据）
/zee-verify init                             # 自动读源码生成并真机跑通 verify-<app>

# 3. 规划再动手（日常主循环）：
/zee-plan 给老系统加上多租户隔离                # 访谈 + 术语/ADR + plan.md（写锁护航）
/zee 执行 .scratch/multi-tenant/plan.md      # 白天执行（或换成 /zee-night 过夜执行）
/zee-review                                  # 随时只读审查未提交改动或分支 diff

# 4. 迭代几版后防腐与固化经验：
/zee-verify maintain                         # 检查实机测试地图漂移并抓隐蔽回归
/zee-retro                                   # 把重复踩坑固化成 Lint/测试 + Bite Proof
```

### 场景 B：从 0→1 做全新项目

```text
/zee-init 做一个带昼夜循环与天气系统的荒野求生小游戏
# 后续演进新特性：
/zee-plan 加入篝火烹饪和生存徽章
/zee-night 执行 .scratch/cooking-badges/plan.md
```

---

## 核心架构与 `zee-tool.mjs` 确定性原语速查

### 六大正交角色

| 角色 | 职责定位 | 最小权限边界 |
| :--- | :--- | :--- |
| **`scout`** | 只读侦察与热点扫描 | 禁 `edit`/`write`；仅允许在 `/tmp/zee-*` 沙盒跑环境探针 |
| **`architect`** | 架构契约、切片与 Deletion Test | 纯只读（禁 `edit`/`write`/`bash`）；输出交由总控落盘 |
| **`ui`** | Design Engineer（审美 + 前端） | `DESIGN.md` / `ui-spec.md` / `?variant=` 原型 / 隔离 worktree 写前端 |
| **`coder`** | Worktree 隔离实现与 Seam TDD | 隔离 worktree 写代码与单测，汇报精确 `PINNED_SHA` |
| **`verifier`** | 独立冷启动机器门禁（Gate 1） | 禁 `edit`；优先按 `verify-<app>` 实机跑通 + 变异杀死 + 截图留证 |
| **`reviewer`** | 跨家族三轴对抗审查（Gate 2） | 禁 `edit` + 同家族静态硬拦；分 Spec / Smells / `/tmp` 沙盒证伪 + 看图审 UI |

### `zee-tool.mjs` 常用命令（`skills/zee/scripts/zee-tool.mjs`）

| 子命令 | 用途 |
| :--- | :--- |
| `doctor [--harness <名>] [--all]` | 一站式健康体检（配置 + Pi `enabledModels` 漂移含 backup + 规则冲突 + 总线可写 + AGY Hook 探活） |
| `validate [cfg] [--check-live]` | 校验 `zee-config.json` schema v2、跨家族多样性与 Pi live 漂移 |
| `audit-rules [--all \| --harness <名>]` | 审计当前宿主规则/双安装冲突 |
| `init-run <repo> <slug> [--conversation-id <cid>]` | 创建仓库外运行总线 `~/.local/state/zee/runs/<repo-key>/<slug>/` |
| `update-state <busDir> [--status ...] [--budget '<json>'] [--inc-delegates [N]] [--inc-aborted [N]] [--unit-upsert '<json>']` | `tmp+rename` 原子更新 `state.json` |
| `list-runs [repo \| --all]` | 列出活跃/暂停总线供 `/zee resume` 一键续跑 |
| `log-decision --bus ... --unit ... --phase ... --decision ... --why ... --evidence ... --result ...` | 安全追加一行审计记录到 `decisions.tsv` |
| `worktree-create <repo> <slug> <lane> <baseRef> [--branch <name>]` | 在总线目录原子创建隔离 worktree（自动扁平化嵌套分支 ref 冲突） |
| `cleanup-worktrees [repo] [--base <ref>] [--prune-safe]` | 分级体检 worktree（识别 squash-merge 与 `.zee-lock.json` 活锁），加 `--prune-safe` 安全回收 |
| `check-plan <plan.md> [--strict-budget]` | 校验必备章节、切片循环依赖、悬空依赖与单切片硬预算（≤5 文件 / ≤400 LOC） |
| `resolve-model --harness agy\|pi\|t3 --role <角色>` | 按宿主与执行面确定性翻译角色模型标识 |
| `symlinks [--apply]` | 仅在用户显式要求同步多端时检查或创建跨宿主软链 |

---

## 目录结构

```text
.antigravity-plugin/plugin.json   # Google Antigravity 原生插件清单
assets/logo.svg                   # Antigravity 插件卡片图标
agents/                           # Antigravity 原生代理（主控 zee + 6 隔离角色子代理）
hooks.json                        # Antigravity 原生三事件 Hook（PreInvocation / PreToolUse / Stop）
scripts/
├── install.mjs                   # 交互式 / 命令行多宿主选择安装器（pi | agy | skills | both）
└── agy-guard.mjs                 # Antigravity 生命周期守卫与跨回合写锁
package.json                      # Pi Package 清单（导出 pi-extension 与 skills）
pi-extension/
├── index.ts                      # Pi 原生扩展：/zee-mode、9 短命令、跨回合路径锁、并行 zee_subagent v2.2
└── worker-guard.ts               # Pi 子进程极简安全守卫（-ne -e 挂载，消灭子代理安全真空）
skills/
├── zee/                          # 核心工作流（唯一真源）
│   ├── SKILL.md                  # 宿主无关总控内核（L0–L3 + 专项轨道 + 70% 收口）
│   ├── worker.md                 # 子代理通用前置契约（含 [zee-worker] 防递归哨兵）
│   ├── roles/                    # scout / architect / ui / coder / verifier / reviewer
│   ├── disciplines/              # domain-modeling / deep-modules / diagnosing-bugs / code-smells / phase-boundaries / verification-skill
│   ├── references/               # harness / antigravity / interop / protocols / plan-mode / greenfield / overnight / specialized
│   └── scripts/                  # zee-tool.mjs（12 确定性原语）+ lib/guard-core.mjs（双端共享词法安全核）
├── zee-plan/                     # 快捷入口：Grill 访谈 + 领域建模 → 沉淀计划文档（只规划不写码）
├── zee-init/                     # 快捷入口：项目 0→1 全自动建项（含实机跑通的 verify-<app>）
├── zee-review/                   # 快捷入口：只读跨家族三轴对抗审查（支持未提交工作区）
├── zee-verify/                   # 快捷入口：项目级实机验证技能全生命周期（init / maintain / run）
├── zee-arch/                     # 快捷入口：代码库深模块抗熵增巡检（热点 + 删除测试 + HTML 报告）
├── zee-retro/                    # 快捷入口：会话复盘与 4 级结构化纠错飞轮（含 Bite Proof）
├── zee-night/                    # 快捷入口：无人值守过夜模式（Trust Gate + 隔离分支 + 中文晨报）
└── zee-setup/                    # 快捷入口：模型装配、当前宿主体检与项目契约生成
```

## 开源协议

MIT
