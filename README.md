# zee — 通用多模型全自动工程工作流

`zee` 是一套按标准 [Agent Skills](https://agentskills.io) 编写的**通用多模型全自动研发工作流**。

**核心理念：**
- **一次装配，长期自动**：只需通过 `/zee-setup` 配置一次各角色的模型、思考强度与预授权备胎，后续自动按任务难度调度执行。
- **装在哪就管哪个 Harness**：不绑死特定总控，也不越界改动其他框架。你安装在 Pi、T3 Code、Claude Code、Codex、Cursor、OpenCode 或 Antigravity 中的哪一个，就只管理当前这一个宿主环境。
- **内部指令严谨、对外提示全中文**：底层工程契约与跨模型 worker 协议保持英文以确保各家模型执行稳定；所有面向用户的提问、进度播报、方案确认、风险提醒、最终报告和过夜晨报一律使用简体中文。

---

## 安装方式（安装时自由选择宿主）

`zee` 采用 **Pi Package + Google Antigravity Native Plugin + 标准 Agent Skills 三形态单仓封装**，装在哪就只管哪一个宿主：

### 方式一：一行 `npx` 交互式选择安装（推荐 · 无需克隆）

```bash
# 弹出菜单自由选择：Pi / Google Antigravity (agy) / 通用 Agent Skills / 同时安装
npx github:zee820232/zee

# 或直接非交互指定目标宿主：
npx github:zee820232/zee --target pi
npx github:zee820232/zee --target agy
npx github:zee820232/zee --target skills
npx github:zee820232/zee --target both
```

### 方式二：Pi 用户（完整 Pi Package 形态）

```bash
pi install git:github.com/zee820232/zee
```

一次安装自动获得（v4.1.0）：
- **8 个完整工作流技能**（`zee` / `zee-plan` / `zee-init` / `zee-review` / `zee-arch` / `zee-retro` / `zee-night` / `zee-setup`）+ **6 份按需工程纪律**（`skills/zee/disciplines/`）
- **常驻自动路由开关 `/zee-mode`（`auto | strict | off`）**：按分支持久化状态，直注 `<zeeDir>` 绝对路径，内置 4 层防子代理递归与全局模板隔离
- **免前缀短命令**：直接输入 `/zee`（含 `/zee plan|review|init|arch` 自动上锁）、`/zee-plan`、`/zee-init`、`/zee-review`、`/zee-arch`、`/zee-retro`、`/zee-night`、`/zee-setup`
- **跨回合持久化保护锁 + 双端词法安全核 + 子进程 `worker-guard.ts`**：`/zee-plan`/`/zee-arch` 与 `/zee-init`（Stage 1–2）跨多轮保持防写锁（自动放行 `GLOSSARY.md`/`docs/adr/`/`/tmp/zee-*` 与白名单文件操作），子进程通过 `-ne -e worker-guard.ts` 消灭安全真空，日常编码常驻拦截 `denyCommands` 与嵌套子 shell 破坏性命令
- **内置并行子代理引擎 `zee_subagent` v2.1**：流式正文优先抢救（`PARTIAL_RECEIPT`）、并发 Map 工具双态看门狗、15s 节流心跳、精准增量脏区回滚（零误杀用户未提交改动）、Worktree 活锁（`.zee-lock.json` 防误删）与归一化 `authorFamily` 同家族硬拦截

### 方式三：Google Antigravity（`agy` CLI / App / IDE 原生插件形态）

```bash
agy plugin install https://github.com/zee820232/zee
```

一次安装自动获得（v4.1.0）：
- **专属主控代理 `zee`（零劫持闲聊）**：终端运行 **`agy --agent zee`**（或在 CLI `/agents` / Antigravity App 中切换 `zee`），插件绝不内置劫持普通对话的 `rules/AGENTS.md`
- **6 个硬权限隔离角色子代理**（`zee-scout` / `zee-architect` / `zee-ui` / `zee-coder` / `zee-verifier` / `zee-reviewer`）：全部内置 `inheritCustomizations: false` 与精确 OneHarness `tools:` 白名单（`zee-scout`/`zee-architect` 纯只读，`zee-verifier`/`zee-reviewer` 硬剥离 `edit_file`）
- **8 个原生斜杠命令** + **AGY 原生体验满血**：支持 Brain Artifacts（`implementation_plan.md` 原生「Proceed」审批按钮、`walkthrough.md` + 截图 `carousel`、虚拟化 `decisions.tsv`）、`TimerCondition: "never"` 响应式全局看门狗、`run_workflow` 宽扇出与 429 自动降级
- **三事件生命周期 Hook**（`hooks.json` -> `PreInvocation` + `PreToolUse` + `Stop`）：`$PLUGIN_DATA` 跨回合保持规划/初始化锁、与 Pi 共用 `guard-core.mjs` 词法防危、保护独立 `conversationId` 子代理写边界、`{}` 零副作用透传，以及按 `conversationId` 精准绑定 `status==="running"` 的 `Stop` 过夜防断尾兜底

> ⚠️ **防冲突提示**：使用 `pi install` 或 `agy plugin install` 安装后，请勿同时在对应宿主的 `skills/` 目录保留旧的 `zee*` 手动拷贝，以免触发重名警告（`install.mjs` 会自动检测清理，也可运行 `zee-tool.mjs audit-rules` 排查）。

### 方式四：其他通用 Harness（T3 Code / Claude Code / Codex / Cursor / OpenCode）

```bash
npx skills add zee820232/zee
```

安装完成后，在当前宿主运行一次 **`/zee-setup`** 完成模型装配即可开用。

---

## 斜杠命令一览（简洁无冗余）

> 在 Pi 中安装 Pi Package 后可直接使用下方全部短命令；通用 Harness 若仅安装 Skills 则使用对应宿主的技能触发方式。

| 命令 / 入口 | 定位 | 典型用法 |
| :--- | :--- | :--- |
| **`/zee-mode`** / **`agy --agent zee`** | **常驻自动路由入口**（Pi 用 `/zee-mode auto\|strict\|off`；Antigravity 用 `agy --agent zee`） | `/zee-mode auto` 或 `agy --agent zee` |
| **`/zee`** | 全自动主入口（按风险自动定级，也可直接接棒已确认的 `plan.md`） | `/zee 修复重试超时导致的重复提交` |
| **`/zee-plan`** | **Grill 访谈 + 主动领域建模（`GLOSSARY.md`/3 条件 ADR）→ 沉淀计划停机**（跨回合写锁） | `/zee-plan 给面板加多账户支持` |
| **`/zee-init`** | **项目 0→1 模式**：从想法访谈到生成实机跑通的 `verify-<app>` 与验收通过 v1 | `/zee-init 做一个本地书签管理 CLI` |
| **`/zee-review`** | **只读跨家族三轴对抗审查**（支持未提交工作区 + Fowler 12 坏味道参考基线） | `/zee-review` |
| **`/zee-arch`** | **代码库深模块抗熵增巡检**（热点扫描 + 删除测试 + HTML 报告，不改业务代码） | `/zee-arch 巡检核心状态机` |
| **`/zee-retro`** | **会话复盘与 4 级纠错飞轮**（将重复错因机械化固化进架构/Lint/Hook/测试） | `/zee-retro` |
| **`/zee-night`** | **无人值守过夜模式**（独立分支、断点日志、70% 收口、Ketchup 中文晨报） | `/zee-night 执行 .scratch/auth/plan.md` |
| **`/zee-setup`** | 配置模型槽位、执行当前宿主全面体检并按需生成项目级 `verify-<app>` 技能 | `/zee-setup` |

---

## 核心能力

### 1. 双入口引擎：项目 0→1 落地 & 1→100 风险定级

- **项目 0→1 模式（`/zee init` 或空目录自动触发）** — 见 [`skills/zee/references/greenfield.md`](skills/zee/references/greenfield.md)
  1. **产品成型**：多轮带默认推荐的结构化访谈 → 产出 `SPEC.md`（锁定 MVP 核心主线与明确砍掉的 Out-of-Scope），默认停一次由你拍板方向。
  2. **骨架与设计**：`Scout` 查本机工具链与框架最新版 → `Architect` 定架构与垂直切片里程碑 → 涉 UI 时 `UI` 同步定 `DESIGN.md`（可选 `?variant=` 风格原型）。
  3. **M0 地基 + M1 最小活链路**：搭建脚手架 + 冒烟测试 + `.agents/zee.project.json` 并打下首次基础提交（解锁 Worktree 与门禁），再单人打通 1 条最薄端到端主线。
  4. **M2..Mk 自动切片**：按依赖图逐切片全自动闭环开发，每绿一个本地 commit（可无缝切入 `night` 过夜模式）。
  5. **0→1 交付验收**：冷启动实测安装/构建/启动、跑通核心用户旅程 E2E 与 UI 截图、生成 `README.md`、异构终审交付。

- **1→100 自动风险定级（`风险路径 × 意图 × 模式`）**
  - `L0 直出`：非敏感路径的极简改动或问答，总控直接处理并自验。
  - `L1 轻量`：低风险局部改动（`Coder` 或 `UI` → `Verifier`）。
  - `L2 标准`：常规功能、重构、触及 `riskPaths` 的改动，或 Bug 修复（**先红后绿复现专线**）→ 全流程 + 1 个跨家族 `Reviewer`。
  - `L3 攻坚 / 辩论`：高风险架构变更或显式 `debate` → 正交约束 **Arena**（2–3 个模型各自按不同维度出方案 + 匿名跨厂商裁判评分 + 总控手工嫁接）+ `Verifier` 前置门禁 + 2–3 个跨家族 `Reviewer` 实证会审。
  - **专项模式（[`specialized.md`](skills/zee/references/specialized.md)）**：`investigate`（纯只读深度调研）、`perf` / `hillclimb`（冻结基准测试 + 单变量指标爬坡）、`prototype`（隔离一次性技术实验）、`sweep`（大规模只读并发清扫）、`resume`（通过 `list-runs` 一键跨会话续跑）。
  - `+ night`：独立无人值守模式（隔离分支 `zee/<slug>`、Unit 0 验证夹具与基线、Canary 首单元、仓库外 `state.json` 与 `decisions.tsv`、预算熔断、异构抽检中文晨报）。

### 2. 六大正交角色

| 角色 | 职责定位 | 核心纪律 |
| :--- | :--- | :--- |
| **`scout`** | 只读侦察与环境调研 | 输出精确 `file:line` 指针、真实测试命令、`riskPaths`、grep 查不到的隐式调用方；0→1 查本机环境与框架最新版 |
| **`architect`** | 架构契约与垂直切片设计 | 数据形状优先、锁定 Test Seam、四维并行检查点、正交约束 Arena、架构受阻触发 `Scrap` 重画 |
| **`ui`** | Design Engineer（审美 + 前端） | 输出 `DESIGN.md` / `ui-spec.md`、执行 Anti-Slop 硬禁令、`?variant=` 原型、写前端代码并做 4 象限无头截图自检 |
| **`coder`** | Worktree 隔离实现与测试 | 功能走 Seam TDD、Bug 必先跑红复现再修、宽重构走 Expand–Contract；提交后汇报 **Pinned SHA**，拥有带证据反驳权 |
| **`verifier`** | 独立冷启动机器门禁（Gate 1） | 检出精确 Pinned SHA 复跑构建、单测、E2E 与 UI 截图；严格三态判定（`PASS / FAIL / INCONCLUSIVE`） |
| **`reviewer`** | 跨家族三轴对抗审查（Gate 2） | 动态排除作者模型家族；分 `Spec`、`Standards/Smells`、`Break/Blast-Radius` 实证三轴审查 + 看图审 UI + Gate 篡改反签 |

### 3. 核心工程护栏
- **仓库外共享总线**：`~/.local/state/zee/runs/<repo-key>/<slug>/`，跨 Worktree 无损共享，绝不污染 Git，也不与仓库内 `.scratch/` 冲突。
- **Pinned SHA 与顺序合流**：所有验证和审查结论严格绑定具体提交 SHA，多分支按验证顺序逐个合入并复测。
- **四级失败阶梯**：≤15 行明确小错由总控原地自修 → 第 1 次实质失败同档重试（先写 5 行根因反思）→ 第 2 次同根因检查共享前提（计划错触发 `Scrap` 重画，实现难升档 `heavy`）→ 第 3 次硬熔断。
- **项目级安全红线**：通过 `<repo>/.agents/zee.project.json` 声明 `testCmds`、`riskPaths`、`uiGlobs` 与 `denyCommands`（硬禁止 `--live`、实盘签名、读私钥、直接发生产等操作）。

---

## 目录结构

```text
.antigravity-plugin/plugin.json   # Google Antigravity 原生插件清单
assets/logo.svg                   # Antigravity 插件卡片图标
agents/                           # Antigravity 原生代理（主控 zee + 6 隔离角色子代理）
hooks.json                        # Antigravity 原生 PreToolUse 安全与规划保护 Hook
scripts/
├── install.mjs                   # 交互式 / 命令行多宿主选择安装器（pi | agy | skills | both）
└── agy-guard.mjs                 # Antigravity PreToolUse 路径级防写锁与 denyCommands 守卫
package.json                      # Pi Package 清单（导出 pi-extension 与 skills）
pi-extension/
├── index.ts                      # Pi 原生扩展：/zee-mode、8 短命令、跨回合路径锁、并行 zee_subagent v2.1
└── worker-guard.ts               # Pi 子进程极简安全守卫（-ne -e 挂载，消灭子代理安全真空）
skills/
├── zee/                          # 核心工作流（唯一真源）
│   ├── SKILL.md                  # 宿主无关总控内核（L0–L3 + L2 单 Owner 快轨 + 专项轨道）
│   ├── worker.md                 # 子代理通用前置契约（含 [zee-worker] 防递归哨兵）
│   ├── agents/openai.yaml        # Codex 触发策略
│   ├── roles/                    # scout / architect / ui / coder / verifier / reviewer
│   ├── disciplines/              # domain-modeling / deep-modules / diagnosing-bugs / code-smells / phase-boundaries / verification-skill
│   ├── references/               # harness / antigravity / interop / protocols / plan-mode / greenfield / overnight / specialized
│   └── scripts/                  # zee-tool.mjs（12 确定性原语）+ lib/guard-core.mjs（双端共享词法安全核）
├── zee-plan/                     # 快捷入口：Grill 访谈 + 领域建模 → 沉淀计划文档（只规划不写码）
├── zee-init/                     # 快捷入口：项目 0→1 全自动建项（含实机跑通的 verify-<app>）
├── zee-review/                   # 快捷入口：只读跨家族三轴对抗审查（支持未提交工作区）
├── zee-arch/                     # 快捷入口：代码库深模块抗熵增巡检（热点 + 删除测试 + HTML 报告）
├── zee-retro/                    # 快捷入口：会话复盘与 4 级结构化纠错飞轮
├── zee-night/                    # 快捷入口：无人值守过夜模式
└── zee-setup/                    # 一次模型装配、当前宿主体检与 verify-<app> 生成引导
```

---

## 推荐配合用法

```text
# 1. 先访谈想清楚，再沉淀计划文档（完全不动代码）
/zee-plan 重构任务队列并支持优先级调度

# 2. 看完 plan.md 满意后，直接交给 zee 白天跑或过夜跑（跳过重复问答与重画）
/zee 执行 .scratch/job-queue/plan.md
/zee-night 执行 .scratch/job-queue/plan.md
```

## 开源协议

MIT
