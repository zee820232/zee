# Matt Pocock × Poteto 访谈深度解读、Skill 方法论提炼与 `zee` 工作流修改意见

- **视频来源**：[LIVE: Poteto (creator of pstack) on shipping 1,000's of PR's a month at SpaceX](https://www.youtube.com/watch?v=MN9dGgmLyso)（时长 `65:36`）
- **本地完整对谈归档**：[2026-11-26-poteto-matt-pocock-transcript.md](file:///C:/Users/47847/zee/docs/research/2026-11-26-poteto-matt-pocock-transcript.md)
- **对照工程基线**：`zee` v4.1.1（`C:\Users\47847\zee`）

---

## 一、整场对谈深度解读（7 大核心主线）

这场 65 分钟的直播本质上是对 Poteto（Lauren Tan，前 Meta React 核心团队成员、Netflix 工程师，现 SpaceX AI / Cursor 开发 Grokbot，开源技能库 `pstack` 作者）早前那场在 X 上获得约 300 万浏览量的演讲（“如何单月向生产环境合并 2,500 个 PR”）的深度拆解。两位都在开源 Agent Skills 社区极具影响力的作者，用一小时把“AI 编码提效”从早期的 Prompt 技巧拔高到了**工程环境设计、验证闭环与组织拓扑**层面。

### 1. 起点与信任阶梯：消灭「肉身代理（Meat Proxy）」`[00:00–06:37]`
- **早期的挫败感**：Poteto 离职休整期间写 side project（早期成果开源在 `poteto/noodle`），发现自己陷入每天花数小时**微管理单个 Agent** 的泥潭，且写出的 Skill 很难量化效果（“flying blind”）。
- **“肉身代理”瓶颈**：加入 Cursor 负责修复 Agents Window 卡顿时，她整天手动看 flame graphs 与 heap snapshots，意识到真正拖慢研发的是**她自己成了 Agent 与 Chrome DevTools 之间的“肉身代理（meat proxy）”**——人肉看报错、人肉转述上下文、人肉点击复现。
- **反捷径设计观**：即使是最前沿的模型（她在对谈中提到 Opus 5.5）天性依然会**抄近道（take shortcuts / do the easy thing）**。因此她写 Skill 的出发点是：**“How do I make the easy thing the right thing?”（如何让最省事的做法恰好是最正确的做法）**。

### 2. 领域专家与“高密度语言压缩” `[06:37–10:36]`
- **新瓶颈不是写代码，而是意图转译（Transfer of Intent）**：随着模型智力飙升，工程瓶颈已经转移到人类能否用极高清晰度把大脑中的愿景、工程品味和隐性约束表达出来。这反而放大了**真实领域专家（Domain Experts）**的优势。
- **精准词汇 = 高压缩比指令**：Matt 和 Poteto 共同着迷于用高度凝练的专业词汇直接重塑 Agent 的推理路径：
  - Matt 用 **`TDD`**、**`grilling`**（逼问式访谈把人脑中的隐性判断抽出来）；
  - Poteto 吸收了 Matt 的 **`tautological tests`**（同义反复测试——Agent 最爱写的毫无验证意义的废测试）。一个精确的词，本质上是在自然语言里“高倍率压缩了大量工程意图”。

### 3. 从「软件工厂」到「米其林厨房」`[10:36–15:27]`
- **为什么反对“软件工厂”隐喻**：工厂容易让人联想到流水线式的粗糙量产与忽视匠心。Poteto 用**米其林厨房（Michelin Kitchen）**对照研发信任阶梯（Trust Ladder）：
  1. **居家独厨**：自己洗菜、切菜、炒菜、刷锅（微管理 1 个 Agent）；
  2. **引入副厨（Sous Chefs）**：家人/多 Agent 涌入厨房，若没动线与工具规范只会一团糟；
  3. **行政总厨（Executive Chef）**：不再亲自炒每道菜，而是设计厨房动线、备料机制、刀具与品控，对端出去的每道菜声誉负总责；
  4. **开连锁餐厅（Chain of Restaurants）**：当第一家厨房系统打磨成熟，才有资格同时并行管理多家分店（多并发项目）。

### 4. 核心杠杆一：Verification Skill 与确定性 CLI 封装 `[15:27–24:59]`
- **Verification 是第一核心技能**：给 Agent 装上“眼睛和手”，让它能真实启动应用、像真用户一样点击交互、抓取 traces 与 snapshots。**没有自验证，就没有真正意义上的 Agent Loop**，更谈不上类似 Andrej Karpathy `autoresearch` 那样的量化 **Hill Climbing（指标爬坡）**。在 SpaceX AI / Cursor 内部，**每个 App 都有一份自动维护的 Verification Skill**，已成为团队级关键基础设施。
- **确定性–判断力梯度（Determinism–Judgment Gradient）**：早期 Poteto 为省上下文窗口把 Playwright / CDP 交互抽进内置 CLI，后来发现这背后有更根本的原理——**不要让非确定性的大模型每次都重新发明确定性脚本**。把确定性步骤（启动、CDP 抓帧、AST codemod 迁移、截图清理）下沉到 Skill 附带的 CLI/脚本里，Skill 正文只留“需要综合判断的部分”，速度、稳定性与上下文纯度同时暴涨。

### 5. 核心杠杆二：环境约束优于提示词规则 `[24:59–33:16]`
- **类比 TypeScript Type Narrowing**：两位资深 TS 工程师把工程环境设计比作“类型收窄”——通过类型系统、静态约束和目录约定，把合法解空间压缩到“只剩一种正确写法”。
- **内部框架 Dune 案例**：早期 Grokbot 曾长出 8 个超过 10,000 行的 God files。后来他们打造内部类 Next.js 的 Electron 框架 **Dune**，强制每个 Feature 放进独立约定目录、靠注册表自动发现、配合极严格的 Lint 规则。
- **环境约束 > 提示词规则**：把规矩塞进 `AGENTS.md` / Skill 会不断膨胀上下文，且模型容易忘；把规矩写进**代码库环境（类型、Lint、目录结构、架构约束）**，模型**零上下文税**，每次犯错都会在执行瞬间直接“撞墙反弹”。

### 6. 2,500 PR 的真实运转机制：双环 × 幕僚长 × 缓冲队列 × 抽样审查 `[33:16–59:43]`
Poteto 拆解了外界最容易误解的“2,500 个 PR 从何而来、如何敢合入”：
- **很大比例是「代码园艺（Gardening）」**：并非 2,500 个全新大功能，而是大量清理坏味道、补 Lint、加固边界、改善文档的园艺 PR，让整个代码库对人类新人与所有 Agent 都做到“第一天就能写出好代码”。
- **外环 × 内环架构（Outer Loop × Inner Loop）**：
  - **外环（Grokbot 等连接器）**：订阅 Slack、X、Email、Linear，持续把外部真实世界的 Bug 报告与约束喂给内环，贯彻 Netflix 管理哲学 **“Context, not Control（给足上下文，而非微观控制）”**。
  - **内环（Cursor Projects 协调者 / 幕僚长 Chief of Staff）**：协调 Agent 自己不直接写代码，专门统管任务并**跨工单见林不见木（see the forest）**。例如突发 30 条性能告警时，协调者先识别它们指向同一根因，而不是盲目派 30 个 Agent 各自修补造成重复劳动。
- **园艺缓冲队列（Append-to-Doc Buffer）`[47:35–49:18]`**：定期扫 React footguns 等坏味道的后台 Agent，**不直接开 PR 修单点代码，而是追加到同一份缓冲文档里**；每隔几天由人或协调者集中扫一眼，往往发现表面 10 个零散问题其实源于同一个坏设计，从而一次性用结构性改造或新 Lint 根除。
- **“调光开关（Dimmer Switch）”与抽样审查（Sampling instead of Blocking）`[49:18–59:43]`**：
  - 针对双向门改动，她开启 **Full Autopilot**——合并前不是人肉逐行看 diff，而是派出一批 Verifier（甚至多达 10 个）对应用做**探索式 Fuzzing**（真机乱点找回归并自修），直到验证通过自动合并；次日早上像工厂质检主管一样**查看 commit 历史做抽样检查（Sampling）**，发现系统性偏差就反手加一条 Lint 或改环境。
  - 针对**单向门（不可逆操作、强合规/高安全域）**，她坦承**关键前提在于该领域的“可验证性（Verifiability）”**：如果一件事能被测试或形式化证明（如 Bend、Lean、TLA+ 的思路）确定性证真，单向门才可能转化为双向门；否则仍不可盲目全自动合入。

### 7. 终极收束：Transcript 矿藏、`recall` 与主厨个人刀具库 `[59:43–65:25]`
- **历史对话（Transcripts）是最被低估的矿藏**：Past chats 是“物化了的真实流程（process materialized）”。应该定期让 Agent 翻看过去会话记录，找出**人类反复打断、纠偏、插手的片段**，把这些干预模式提炼成新 Lint 规则或新 Skill。
- **`recall` 技能案例**：在修复 Cursor 虚拟化疑难 Bug 时，每次开新对话都要重述大量前序背景，于是她写了 `recall` Skill 自动检索过往聊天记录压缩成上下文简报。
- **主厨个人刀具库（Own Set of Knives）**：两位作者一致鼓励开发者把公开 Skill（如 Matt 的 `grill-me` / `wayfinder` 和 Poteto 的执行/验证技能）拆开阅读、按自己工作流自由混搭，打磨出一套**自己真正信任的随身刀具**。

---

## 二、Matt Pocock & Poteto 关于「Skill」的 8 条核心理解提炼

1. **Skill 的本质是“物化流程 + 高压缩比自然语言”**：Skill 里没有任何黑魔法，它只是 Markdown 化的工作步骤（Process）与高度凝练的领域概念词（例如 `tautological tests`、`grilling`、`unslop`）；词选得越准，对模型推理路径的定向力就越强 `[03:58, 08:25–10:11, 61:04, 64:34–64:59]`。
2. **核心设计准则：让“最省事的路”等于“最正确的路”**：不要假设前沿模型会乖乖遵守长篇说教，模型默认倾向抄近道；好 Skill 用清晰步骤、现成工具和验证闭环，让模型按正确方式做事反而最顺手 `[05:44–06:10]`。
3. **随模型进化而“变薄、变小”，把确定性剥离给脚本/CLI**：遵循 **Determinism–Judgment Gradient**。去年写的 Skill 常塞满具体 CLI 参数和实现细节；随着模型变强，这些细枝末节应该删除，**确定性机械操作封装进 Skill 内置脚本/CLI，Markdown 只保留流程骨架与判断节点** `[19:39–24:59, 63:42–64:20]`。
4. **Verification Skill 是第一优先级基础设施，而非可选项**：不给 Agent 实机运行与自我证真的能力，所有上游规划与写码技能都得靠人类充当“肉身代理”。Verification Skill 必须自带隔离、确定性 CLI、实机交互能力，并具备**自动保鲜维护机制** `[16:00–19:39, 52:45–54:02]`。
5. **严格区分「Skill 的职责」与「环境的职责」**：如果某类错误可以通过 TypeScript 严格类型收窄、目录结构约定、自定义 Lint、Pre-commit Hook 或测试阻断来解决，就**坚决把它写进代码库环境，绝不塞进 Skill 提示词里**——环境规则零上下文税，且在撞墙瞬间实时生效 `[24:59–33:16, 50:09–51:27]`。
6. **Skill 应从真实历史对话（Transcripts）中开采，而不是凭空编写**：人类在对话中打断、纠正、重新解释上下文的每一次动作，都是现成的 Skill / Lint 原材料（包括像 `recall` 这样压缩“跨会话找背景”的元技能） `[60:36–63:42]`。
7. **可组合性与“个人刀具主权”**：Skill 是极具可塑性的乐高积木，用户应该看懂源码、按自身习惯裁剪拼接（如把访谈规划技能与执行/验证技能自由组合），而不是被绑定在封闭的黑盒框架里 `[61:04–64:59]`。
8. **以「人类介入率」和「信任阶梯」反向度量 Skill 有效性**：不要在没有反馈的情况下“盲飞”堆砌规则；用“抽样看错因 → 固化到环境或工具 → 提升验证密度 → 逐步下放双向门自治权”构成正反馈飞轮 `[03:04–03:39, 50:09–51:27]`。

---

## 三、对照 `zee` v4.1.1 现状诊断与修改意见

### 3.1 `zee` v4.1.1 已经高度对齐、表现扎实的部分

通过阅读 `zee` 当前源码可见，你的工作流在理念上与 Poteto / Matt Pocock 高度同频，甚至在多处工程细节上已经领先于常规 Skill 集合：

| 对谈核心原则 | `zee` v4.1.1 已有对应实现 |
| :--- | :--- |
| **Verification Skill 基础设施** | 已落地 `/zee-verify`（[skills/zee-verify/SKILL.md](file:///C:/Users/47847/zee/skills/zee-verify/SKILL.md)）+ [skills/zee/disciplines/verification-skill.md](file:///C:/Users/47847/zee/skills/zee/disciplines/verification-skill.md)，覆盖 `init`（强制真机跑通 1 条功能才交付）、`maintain`（三类漂移分流）与 `run` |
| **错误下沉环境而非堆提示词** | 已落地 `/zee-retro`（[skills/zee-retro/SKILL.md](file:///C:/Users/47847/zee/skills/zee-retro/SKILL.md)），自带「架构/类型 > Lint/Hook/CI > 行为测试 > 精简文档」4 级纠错阶梯及 **Mandatory Bite Proof** 咬合力实证 |
| **确定性基础设施下沉代码** | 已沉淀 [skills/zee/scripts/zee-tool.mjs](file:///C:/Users/47847/zee/skills/zee/scripts/zee-tool.mjs)（12 个确定性原语）、双端词法安全核 `guard-core.mjs` 与 `pi-extension/worker-guard.ts` |
| **高密度精准术语 + Grill 访谈** | `/zee-plan`（[skills/zee/references/plan-mode.md](file:///C:/Users/47847/zee/skills/zee/references/plan-mode.md)）已内置多轮决策树 Grill、实时 `GLOSSARY.md` 术语收敛、3 条件 ADR 门与 `tautological` 反废测纪律 |
| **量化爬坡 + 单向/双向门区分** | [skills/zee/references/specialized.md](file:///C:/Users/47847/zee/skills/zee/references/specialized.md) 的 `/zee perf` 已内置 7 问基准 + ABAB 交替爬坡；[skills/zee/disciplines/phase-boundaries.md](file:///C:/Users/47847/zee/skills/zee/disciplines/phase-boundaries.md) 与 `/zee-night` 明确区分 One-Way / Two-Way Doors |

---

### 3.2 基于两人理解对 `zee` 工作流提出的 7 条具体修改意见

#### [P0] 1. 对“重仪式 Markdown”做减法，把高频手拼 Shell 下沉进 `zee-tool.mjs`
- **对应理念**：*Determinism–Judgment Gradient & Skill 随模型进化持续变薄*（`[19:39–24:59, 63:42–64:20]`）。
- **当前 `zee` 问题定位**：
  1. **Markdown 规范膨胀且跨文件重复**：`zee` 目前包含 9 个技能、7 个 Agent、6 份 Disciplines、8 份 References、6 份 Roles。诸如“禁止 `edit`/只写 `<busDir>`”、“`GATE_CHANGE_RATIONALE`”、“≤30 行回执”、“简体中文要求”在 `SKILL.md`、`worker.md`、`protocols.md`、`roles/*.md` 中多处重复出现，容易让模型把注意力消耗在读仪式规则上。
  2. **仍存在要求模型现场手拼易错 Bash 模板的段落**：例如 [skills/zee/roles/verifier.md](file:///C:/Users/47847/zee/skills/zee/roles/verifier.md#L16) 与 [skills/zee/roles/reviewer.md](file:///C:/Users/47847/zee/skills/zee/roles/reviewer.md#L9-L22) 仍依赖 LLM 手拼 `TMP=$(mktemp -d /tmp/zee-mut-XXXXXX) && trap 'rm -rf "$TMP"' EXIT && git archive <PINNED_SHA> | tar -x -C "$TMP"`（或再手工 `git diff HEAD | apply` + 拷贝 untracked 文件），且 Windows PowerShell / Git Bash 下极易因语法差异出错；同时 [skills/zee/roles/reviewer.md](file:///C:/Users/47847/zee/skills/zee/roles/reviewer.md#L19-L33) 里的“Lint/类型抑制审计”与“Gate Tampering 检查”也全靠模型肉眼扫 diff。
- **具体修改建议**：
  1. 在 [skills/zee/scripts/zee-tool.mjs](file:///C:/Users/47847/zee/skills/zee/scripts/zee-tool.mjs) 新增两个确定性原语：
     - `sandbox-export [--sha <sha> | --working-tree] [--prefix mut|rev]`：跨平台（含 Windows/macOS/Linux）一键把目标快照或未提交工作区改动（含 untracked）干净导出到 `/tmp/zee-<prefix>-*` 并返回路径，结束时配合 `sandbox-clean <dir>` 清理；
     - `gate-tamper-diff <base> [head]`：用脚本确定性扫描 diff 是否触及测试/快照/CI/lint 配置，以及是否新增 `@ts-ignore`、`@ts-expect-error`、`as any`、`eslint-disable`、`# noqa`、`#[allow(...)]`、`//nolint`，直接输出 JSON 清单给 Reviewer 做判断，把判断与枚举彻底分离。
  2. 执行一次「**模型能力适配瘦身**」：各文件只保留单一真源（Single Source of Truth），删掉被 `worker-guard.ts` / `agy-guard.mjs` / `zee_subagent` 已经物理拦截的重复口头叮嘱，把长篇说明压缩成高密度触发词 + 1 行确定性工具调用。

#### [P0] 2. 升级 `/zee-retro` 接入「历史会话 Transcript 挖掘」，并新增轻量 `/zee recall`
- **对应理念**：*Past chats are process materialized & `recall` 技能*（`[60:36–63:42]`）。
- **当前 `zee` 问题定位**：
  1. [skills/zee-retro/SKILL.md](file:///C:/Users/47847/zee/skills/zee-retro/SKILL.md#L15-L18) 目前的证据来源只有 `decisions.tsv`、`git log` 和配置文件。但**最真实反映“Agent 哪里让人心累、人被迫多次打断纠偏/充当肉身代理”的数据，往往发生在聊天 Transcript 里**（很多人工纠正甚至发生在未入库、未跑通总线之前）。
  2. `zee` 有 `/zee resume`（续跑未完结的总线），但缺少一个像 `pstack recall` 那样**面向普通新会话的跨对话上下文召回机制**——当用户 `/clear` 后再修同类模块 Bug 时，难以低成本捞回过往已解决会话中的踩坑路径与有效线索。
- **具体修改建议**：
  1. 在 `zee-tool.mjs` 新增只读命令 `mine-transcripts [--repo <path>] [--days 14]`：按当前激活宿主探测本地历史会话日志（如 Antigravity 的 `transcript.jsonl`、Pi 的 session JSONL 等），脱敏后抽取“用户反复追问/打断/纠正命令/手动贴报错”的片段输出紧凑摘要；将其接入 `/zee-retro` Step 1，作为第四大证据源参与聚类。
  2. 在 `/zee-retro` 的 4 级阶梯之外增加一个明确的轻量分支动作：**第 5 类演化动作——「新 Skill 提炼 / 死规则删剪」**（发现重复出现的工作流或频繁肉身搬运的上下文，直接提炼成项目局部 Skill 或删除被证明无效的冗长规则）。
  3. 在 [skills/zee/references/specialized.md](file:///C:/Users/47847/zee/skills/zee/references/specialized.md) 新增 `/zee recall <topic>` 模式（或集成进 `Scout`），自动检索当前仓库相关的历史对话记录、过往总线 `context.md`/`decisions.tsv` 与 `docs/adr/`，输出 ≤40 行的上下文简报。

#### [P0] 3. 升级 `verify-<app>`（强制内置驱动 CLI + 可选探索式 Fuzz）并修复 `verify-map.md` 命名漂移
- **对应理念**：*每个 App 自带确定性 Verification CLI + Full Autopilot 探索式 Fuzz 验证*（`[16:00–24:59, 52:45–54:02]`）。
- **当前 `zee` 问题定位**：
  1. **已发现现存源码中的真实命名漂移 Bug**：`zee` v4.1.1 已将项目验证地图重构为 `<projectSkillsDir>/verify-<app>/SKILL.md` + `features/`，但多个角色卡中仍残留旧文件命名 `.agents/verify-map.md`：
     - [skills/zee/roles/coder.md](file:///C:/Users/47847/zee/skills/zee/roles/coder.md#L27)（要求改动路由/CLI/UI 时对照 `.agents/verify-map.md`）
     - [skills/zee/roles/scout.md](file:///C:/Users/47847/zee/skills/zee/roles/scout.md#L13)（要求读取 `.agents/verify-map.md`）
     - [skills/zee/roles/verifier.md](file:///C:/Users/47847/zee/skills/zee/roles/verifier.md#L8-L19)（优先查 `verify-*/SKILL.md`，后文仍把 `.agents/verify-map.md` 作为视觉状态兜底来源）
  2. [skills/zee/disciplines/verification-skill.md](file:///C:/Users/47847/zee/skills/zee/disciplines/verification-skill.md#L17) 对 `Helpers` 仅一句话带过，未强约束生成项目级确定性控制 CLI，导致不同轮次的 `Verifier` 仍可能各自重写 Playwright / 启动 / 清理脚本。
  3. 当前 `Verifier` 偏重“按既定清单验收”，缺乏 Poteto 强调的**“像真实用户一样随机探索点击（Fuzzing）寻找意外回归”**阶段。
- **具体修改建议**：
  1. **立即清理命名漂移**：将 `coder.md`、`scout.md`、`verifier.md` 中的 `.agents/verify-map.md` 统一对齐为 `<projectSkillsDir>/verify-<app>/`（保留对旧项目的向后兼容读取，但 `Coder` 提示与新项目约定全部指向 `verify-<app>/features/`）。当 `Coder` 改动路由/CLI/UI 状态时，要求在 receipt 中声明 `VERIFY_MAP_DELTA: <feature-file-or-none>`，便于主控自动提醒或增量刷新 `verify-<app>`。
  2. **升级 `verify-<app>` 模板为“薄 `SKILL.md` + 厚确定性 `scripts/verify-ctl.(mjs|py|sh)`”**：要求 `init` 必须封装好 `launch / doctor / snapshot / evidence / cleanup` 确定性子命令（例如自动找空闲端口、隔离临时数据目录、写 PID 文件只杀自己、清理绝不删截图）。
  3. **为 `/zee-verify run` 与 `roles/verifier.md` 增加可选 `--fuzz` 层**：在 `L3`、`Stage 5` 或高自治 `night` 模式下，跑完既定 feature 列表后，要求 `Verifier` 执行有限时间/步数（如 60s / 10 步）的边界输入与异常交互探索（乱点、快速连续操作、空状态/超长输入/窄屏），专门抓“测试列表没写到的真实回归”。

#### [P1] 4. 引入持久化「园艺缓冲队列（Gardening Buffer）」：先蓄水聚类，再一次性升级环境
- **对应理念**：*Append-to-Doc Buffer & See the Forest & Codebase Gardening*（`[45:54–49:18]`）。
- **当前 `zee` 问题定位**：
  - [skills/zee/roles/reviewer.md](file:///C:/Users/47847/zee/skills/zee/roles/reviewer.md#L45) 产出的 `P2_NON_BLOCKING`、[skills/zee/disciplines/diagnosing-bugs.md](file:///C:/Users/47847/zee/skills/zee/disciplines/diagnosing-bugs.md#L34) 要求 `Coder` 记录的“缺失 Test Seam 架构发现”、以及 `/zee sweep` 发现的非阻断坏味道，目前都只停留在单次 Out-of-Tree 总线报告里，任务结束后即沉没。没有一个跨会话累加的“缓冲池”，因此每次只能就事论事修单点，看不到跨多次开发的系统性病灶。
- **具体修改建议**：
  1. 在仓库约定一个轻量只追加缓冲文件（例如 `.agents/gardening-queue.md` 或 `.agents/findings-buffer.jsonl`），任何 `Reviewer` 的 `P2` 发现、`Coder` 标记的缺失 Seam / 重复 workaround、或巡检发现的坏味道，经主控一行命令（如 `zee-tool.mjs append-finding`）顺手写入队列，**当时绝不扩 scope 顺手重构**。
  2. 让 `/zee-arch` 和 `/zee-retro` 启动时默认读取该缓冲队列，按模块/错因自动聚类统计频次（同模式累积 ≥3 次自动置顶标红），推动开发者一次性用一条类型约束、Lint 规则或深模块重构彻底根治一整类问题。

#### [P1] 5. 引入显式「信任阶梯 / 调光开关（`trustLevel`）」与“可验证性体检”，避免所有任务一刀切高摩擦
- **对应理念**：*Trust Ladder + Dimmer Switch + Sampling instead of Blocking + Verifiability*（`[01:33–02:03, 49:18–59:43]`）。
- **当前 `zee` 问题定位**：
  - 当前 `zee` 对所有 `L2` 切片及 `night` 模式默认强制执行「隔离 worktree → Gate 1 `Verifier` → Gate 2 跨家族 `Reviewer` → 逐片串行合并」。这套高确定性流水线在安全敏感项目上非常可靠，但当某个项目本身已有强类型/强 Lint + 完备 `verify-<app>` 且只是做非核心双向门改动时，逐片等待跨家族 Reviewer 串行阻塞会显著拖慢吞吐量。
- **具体修改建议**：
  1. 在 `<repo>/.agents/zee.project.json` 增加显式可配置的信任级别 `trustLevel: "T1" | "T2" | "T3"`（默认保持 `T1` 不变）：
     - **`T1`（Strict Blocking，默认）**：维持现有所有切片 `Gate 1 Verifier -> Gate 2 Cross-Family Reviewer -> 串行合并`；
     - **`T2`（Gate 1 + Batch Sampling）**：允许**未命中 `riskPaths` 的纯双向门切片**在通过 `Gate 1 Verifier`（含 `verify-<app>` 实机跑通）后先合入集成分支 `zee/<slug>`，把跨家族 `Reviewer` 改为**每 N 个切片或批次收口时集中抽样/联合审计**（任何命中 `riskPaths` 或 `GATE_CHANGE_RATIONALE` 的切片依然强制实时阻断）；
     - **`T3`（High-Trust Autopilot + Post-Merge Sampling）**：仅限非 `riskPaths` 且在隔离集成分支上，由强 `Verifier`（含 `--fuzz`）全量过关后自动推进，由 `Audit Judge` 与人类在收口晨报做抽样复核与事后 `retro` 固化。
  2. **前置“可验证性体检（Verifiability Readiness Gate）”**：在 `zee-tool.mjs doctor` 中校验开启 `T2/T3` 的硬前置条件（必须存在 `verify-<app>`、真实 `testCmds` + `lintCmd`、非空 `denyCommands`），条件不齐时**拒绝升档并硬退回 `T1`**，彻底杜绝无护栏下的“盲飞”。

#### [P1] 6. 补齐「外环接入 + 幕僚长跨工单聚类（`/zee triage`）」与低风险定时巡检配方
- **对应理念**：*Outer Loop × Inner Loop + Chief of Staff（先聚合多条反馈看清共同根因再派单）*（`[35:05–47:35]`）。
- **当前 `zee` 问题定位**：
  - `zee` 目前是非常强大的 **Inner Loop 执行引擎**，但缺乏连接外部反馈源（GitHub Issues / Sentry / Linear / 用户批量粘贴的 Bug 列表）的“幕僚长入口”。如果用户一次丢进 10 条报错，现有流程要么拆成 10 个独立任务重复修补，要么手工整理后再进 `/zee-plan`。
- **具体修改建议**：
  1. 在 [skills/zee/references/specialized.md](file:///C:/Users/47847/zee/skills/zee/references/specialized.md) 新增 **`/zee triage`** 专项模式：
     - 接收一批外部 Issue / 日志 / 用户反馈（或通过可用只读 MCP 拉取）；
     - 先派 `Scout` / `Verifier` 验证这些报告在当前 `main` 是否真的可复现（过滤掉本地环境或过期报错）；
     - 将同根因、同模块的多条报告聚合成少数几个高杠杆修复主题，直接产出可接棒 `/zee-plan` / `/zee-night` 的 `triage-brief.md` 或写入园艺缓冲队列。
  2. 在 [skills/zee/references/overnight.md](file:///C:/Users/47847/zee/skills/zee/references/overnight.md) 补充一节**「低风险定时外环例行程序」**：说明如何配合宿主的 `schedule_task`（T3 Code）或 `schedule`（AGY），定期触发只读 `/zee-verify maintain` 或坏味道扫描追加到 `.agents/gardening-queue.md`（只记账、不自动改业务码），实现安全可控的半自动化外环。

#### [P2] 7. 解耦“单刀可用性”并支持按文件路径按需注入项目局部 Skill
- **对应理念**：*Own Set of Knives（每把刀独立锐利、可自由混搭与按需装载）*（`[61:04–64:59]`）。
- **当前 `zee` 问题定位**：
  - 目前 [skills/zee-verify/SKILL.md](file:///C:/Users/47847/zee/skills/zee-verify/SKILL.md#L10)、[skills/zee-retro/SKILL.md](file:///C:/Users/47847/zee/skills/zee-retro/SKILL.md#L10)、[skills/zee-arch/SKILL.md](file:///C:/Users/47847/zee/skills/zee-arch/SKILL.md#L10)、[skills/zee-review/SKILL.md](file:///C:/Users/47847/zee/skills/zee-review/SKILL.md#L12) 都要求一上来先读取完整的 `../zee/SKILL.md` 并执行 `zee-config.json` 全量 Preflight，导致哪怕只想单用 `/zee-verify` 或 `/zee-retro` 这“一把刀”，或者想把它们和外部其它 Skill 拼在一起，都必须背上整套多模型总控前置门槛。
- **具体修改建议**：
  1. 允许 `/zee-verify`、`/zee-retro`、`/zee-arch`、`/zee-review` 支持**「零配置单飞降级模式」**：若检测到用户尚未初始化 `~/.agents/zee-config.json`，不必强制阻断去跑 `/zee-setup`，而是自动降级为当前会话主模型直接跑完单刀闭环（已有配置时继续享受多模型异构路由）。
  2. 在 `<repo>/.agents/zee.project.json` 增加可选 `pathSkills` 映射（例如按 glob 将项目内的前端/状态机/迁移局部 Skill 仅在切片命中对应文件时精准注入 `Coder`/`Reviewer` 的 brief），做到平时零上下文开销、命中时精准赋能。

---

### 3.3 建议落地顺序

| 阶段 | 建议项 | 预期收益 |
| :--- | :--- | :--- |
| **第一波（立竿见影 · 零风险）** | 修复 `verify-map.md` 命名残留 + `zee-tool.mjs` 新增 `sandbox-export` 与 `gate-tamper-diff` + 瘦身重复规则 | 消除文档不一致，把易错手拼 Shell 彻底确定性化，显著降低子代理无效开销 |
| **第二波（补齐进化飞轮）** | `/zee-retro` 接入 `mine-transcripts` + `/zee recall` + `verify-<app>` 强制带 `verify-ctl` CLI + `--fuzz` + 园艺缓冲队列 | 真正打通“人类历史踩坑 → 自动识别规律 → 升级环境/验证工具”的闭环 |
| **第三波（高阶自治演进）** | `/zee triage` 外环聚类 + `trustLevel`（T1/T2/T3）调光开关 + 单刀零配置降级 | 在护栏完备的项目上安全放大吞吐量，并提升单技能的社区可组合性 |
