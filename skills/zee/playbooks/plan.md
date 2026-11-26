# 剧本：0→1 建项、规划与单元拆解 (`plan`)

适用场景：全新项目建项（0→1）、跨模块需求立项、`/zee-plan`、准备 `/zee-night` 过夜任务队列。

## 双模式分界（默认直通，显式才停门）
- **自动驾驶模式（默认，由 `/zee` 或自然语言交付触发）**：不反问可逆选型、不停在规划门口、不挂 `plan🔒` 锁死施工；将选型理由写入 `decisions.tsv` 与 `<busDir>/plan.md` 后**立即进入施工与实机验证闭环**。
- **纯规划模式（仅当用户显式调用 `/zee-plan` 或明说“只出方案/先确认”）**：最多一次性提出 3–5 个不可逆/产品权衡（附推荐项），落盘后停在规划门口等批准。

## 执行步骤
1. **体检与基线自举**：
   - 运行 `<ZEE_TOOL> doctor --repo <repoRoot>` 拿到 `projectProfile`；
   - 若目录尚无 `.git` 或 `hasHeadCommit: false`（空目录 0→1），直接运行 `<ZEE_TOOL> init-run <repoRoot> <slug> --ensure-git` 自动建总线并初始化空基线提交（避免后续 `worktree` 与 `git diff` 报错）；已有基线则运行 `<ZEE_TOOL> init-run <repoRoot> <slug>`。
2. **极速摸底 + 原型探针先行（Prototype-First）**：
   - 仓库非空时借助 `projectProfile` 快速定位入口与测试（空目录跳过侦察，禁止刷外部 `todo` 空耗，争取 1–2 轮完成拆单）；
   - **能实测就不问人**：凡可通过 30 秒探针脚本裁决的技术/兼容性分叉，直接用 `<ZEE_TOOL> sandbox-export --repo <repoRoot> --working-tree --prefix probe`（已支持非 Git 空目录）实测取证再 `sandbox-clean`，以 `[实测]` 拍板。
3. **双追问收敛与 2-Shape 架构对比**：
   - 规划前自问两句（`sharpen`）：① 领域专家默认会做但需求未明说的一件事是什么？② 如何用外部客观标准证明做对了？
   - 核心边界或复杂系统由 `architect` 对比 **2 种设计形态**（按状态唯一 Owner、调用方心智负担最小、最易机测择优；重大分歧可派跨家族 `judge` 盲审选 `BASE` + `GRAFT`）。
4. **拆解原子 Unit 并批量落盘**：
   - 每个 unit 明确 `id`、互不重叠的 `files` 边界、可机测验收口径与推荐 `role`，蓝图写入 `<busDir>/plan.md`；
   - 用 `<ZEE_TOOL> update-state <busDir> --status planned --units-file <path|->`（规避 Windows PowerShell JSON 引号转义）一次性登记。
5. **直通交付或停门**：
   - **自动驾驶模式**：直接切入 `feature.md`（或 `design.md`）按单元施工，并在首单元跑通后按 `verify.md` (`init`) 自举 `.agents/verify-ctl.mjs`；
   - **纯规划模式**：呈报 `<busDir>/plan.md`、单元清单与核心取舍，等待确认后解锁执行。
