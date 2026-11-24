# zee — 通用多模型全自动工程工作流

`zee` 是一套按标准 [Agent Skills](https://agentskills.io) 编写的**通用多模型全自动研发工作流**。

**核心理念：**
- **一次装配，长期自动**：只需通过 `/zee-setup` 配置一次各角色的模型、思考强度与预授权备胎，后续自动按任务难度调度执行。
- **装在哪就管哪个 Harness**：不绑死特定总控，也不越界改动其他框架。你安装在 Pi、T3 Code、Claude Code、Codex、Cursor、OpenCode 或 Antigravity 中的哪一个，就只管理当前这一个宿主环境。
- **内部指令严谨、对外提示全中文**：底层工程契约与跨模型 worker 协议保持英文以确保各家模型执行稳定；所有面向用户的提问、进度播报、方案确认、风险提醒、最终报告和过夜晨报一律使用简体中文。

---

## 安装方式

使用 `skills` CLI 安装到你想使用的宿主目录：

```bash
npx skills add zee820232/zee
```

或手动复制到指定 Harness 的 skills 目录（例如仅给 Pi 使用）：

```bash
git clone https://github.com/zee820232/zee.git
cp -R zee/skills/zee* ~/.pi/agent/skills/
```

安装完成后，在对应宿主里运行一次 **`/zee-setup`**（Pi 中为 `/skill:zee-setup`）完成模型装配即可开用。

---

## 斜杠命令一览（共 6 个，简洁无冗余）

> 在 Pi 中原生命令格式为 `/skill:<名>`，在支持简写的界面（T3 Code / Claude Code / Cursor）中可直接用 `/<名>`。

| 命令 | 定位 | 典型用法 |
| :--- | :--- | :--- |
| **`/zee`** | 全自动主入口（按风险自动定级，也可直接接棒已确认的 `plan.md`） | `/zee 修复重试超时导致的重复提交` |
| **`/zee-plan`** | **先 Grill 访谈 → 沉淀正式计划文档并停机**（不写代码；加 `L3` 跑 Arena） | `/zee-plan 给面板加多账户支持` |
| **`/zee-init`** | **项目 0→1 模式**：从想法访谈到可运行、冷启动验收通过的 v1 | `/zee-init 做一个本地书签管理 CLI` |
| **`/zee-review`** | **只读跨家族三轴对抗审查**（仅保留实证问题，不改代码） | `/zee-review` |
| **`/zee-night`** | **无人值守过夜模式**（独立分支、断点日志、预算熔断、中文晨报） | `/zee-night 执行 .scratch/auth/plan.md` |
| **`/zee-setup`** | 一次配置 6 个角色模型与思考强度、审计当前宿主规则冲突 | `/zee-setup` |

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
skills/
├── zee/                          # 核心工作流（唯一真源）
│   ├── SKILL.md                  # 宿主无关总控内核
│   ├── worker.md                 # 子代理通用前置契约
│   ├── agents/openai.yaml        # Codex 触发策略
│   ├── roles/                    # scout / architect / ui / coder / verifier / reviewer
│   ├── references/               # harness / protocols / plan-mode / greenfield / overnight
│   └── scripts/zee-tool.mjs      # 零依赖工具：配置校验、单端规则审计、总线初始化与 TSV 日志
├── zee-plan/                     # 快捷入口：Grill 深度访谈 → 沉淀计划文档（只规划不写码）
├── zee-init/                     # 快捷入口：项目 0→1 全自动建项
├── zee-review/                   # 快捷入口：只读跨家族对抗审查
├── zee-night/                    # 快捷入口：无人值守过夜模式
└── zee-setup/                    # 一次模型装配与当前宿主配置引导
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
