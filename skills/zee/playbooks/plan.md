# 剧本：0→1 规划与单元拆解 (`plan`)

适用场景：`/zee-plan`、全新项目建项、跨模块需求立项、准备 `/zee-night` 过夜任务队列。

## 执行步骤
1. **建总线**：运行 `node <scripts>/zee-tool.mjs init-run <repoRoot> <slug>` 拿到 `busDir`（所有产物写入 `busDir`，不污染项目根目录）。
2. **极速摸底 + 原型探针先行（Prototype-First）**：
   - 仓库非空时快速定位技术栈与测试入口（空目录跳过侦察，禁止刷外部 `todo` 空耗，争取 1–3 轮落盘）。
   - **能实测就不问人**：凡可通过 30 秒探针脚本裁决的技术/兼容性分叉，先用 `zee-tool.mjs sandbox-export --repo <repoRoot> --working-tree --prefix probe` 在隔离沙盒实测拿到数据后再清理（`sandbox-clean`），带着 `[实测]` 结论汇报。
3. **双追问收敛与 2-Shape 架构对比**：
   - 规划前先自问两句（`sharpen`）：① 领域专家默认会做但需求未明说的一件事是什么？② 如何用外部客观标准证明做对了？
   - 核心边界或复杂重构由 `architect` 至少对比 **2 种设计形态**（按状态唯一 Owner 与最小调用方心智负担择优；重大分歧可派跨家族 `judge` 盲审选 `BASE` 并手工吸收 `GRAFT` 亮点）。
   - 仅把实验无法裁决的 **3–5 个产品/不可逆权衡**一次性问清用户（附推荐项；若用户指定按推荐推进则立即敲定）。
4. **拆解原子 Unit 并批量落盘**：
   - 每个 unit 明确 `id`、互不重叠的 `files` 边界、可机测验收口径与推荐 `role`，完整蓝图写入 `<busDir>/plan.md`；
   - 用 `zee-tool.mjs update-state <busDir> --status planned --units '[...]'`（Windows PowerShell 复杂 JSON 推荐写入临时文件或管道走 `--units-file <path|->`）一次性批量登记。
5. **停在规划门口**：呈报 `<busDir>/plan.md` 路径、单元清单与核心取舍，确认后切入 `/zee` 或 `/zee-night`。
