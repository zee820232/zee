# Zee v5.3.0

**下载即用 · 全场景零干扰自动驾驶工程工作流** — 面向 Pi CLI、Google Antigravity (AGY)、Codex、Claude Code 与 T3 Code 的极简多模型工程系统。

## 核心特点

1. **下载即可用，零配置自然语言自动唤醒**：
   - 安装后无需先跑复杂配置或背诵斜杠命令：Pi 默认开启 `auto` 模式、AGY 内置极薄 `rules/AGENTS.md`、主技能 `skills/zee` 开放自然语言隐式调用，零配置文件自动单兵直通，纯问答绝不劫持。
2. **五大高频场景全自动无干扰直通**：
   - **创建项目（0→1）**：自动体检目录，无 Git/HEAD 时 `init-run --ensure-git` 自举基线，按 RGDD 轻前置（用户视角用法 + `GLOSSARY.md` `_Avoid_` + 3 条件 ADR）直接施工并自举 `.agents/verify-ctl.mjs` 与 Feature Map；
   - **新增需求**：`doctor --repo` 秒出 `projectProfile`（包管理器/测试/Lint/形态、`effectiveTrust` 与信任闸门缺口），小改直做、多域并发 worktree + 实机验证 + 跨家族审查；
   - **修改设计（UI / 交互 / 架构改版）**：专属 `design.md` 剧本，先锁基线契约；UI 改版必跑真实渲染 + 桌面/移动双视口 + `--fuzz` 探索压测消灭肉身代理；架构重设计走 2-Shape 对比与小步迁移；
   - **Bug 修复**：用 `recall` 单仓召回历史 `decisions`/园艺簇/ADR 防重踩旧坑、多报错先聚类再修、并发偶发连跑验证、两败自动转轨 `understand` 溯源；
   - **性能迭代**：冻结基准 7 验（含物理极限算术）+ 7 条性能口诀由廉至贵排序 + 成对 `--predicate`（目标+最小轮次）+ 单变量 `hillclimb` 爬坡。
3. **跨平台确定性基础设施与自我进化飞轮**：
   - 15 个零依赖 CLI 原语（`zee-tool.mjs`）：包含 Windows 安全的 UUID 原子文件锁、跨平台 `guard-core.mjs`、区分纯新增测试与篡改门禁的 `gate-tamper-diff`、园艺缓冲队列 `finding add|list|resolve`、单仓只读召回 `recall`、`trustLevel` 可验证性硬闸门与外部副作用守夜止损（`agy-guard.mjs`），配套反观察者效应盲测 `tests/eval/blind-eval.mjs`。

## 30 秒安装与开箱自检

```bash
# 推荐：自动探测本机已装的 pi / agy / npx 一键全装（不破坏跨宿主 ~/.agents/skills）
node scripts/install.mjs --target auto

# 或指定单一/多目标：auto | pi | agy | skills | both | all（可先加 --dry-run 预览）
node scripts/install.mjs --target agy --dry-run

# 零配置开箱体检、类型/语法自检与全链路自举验证
node skills/zee/scripts/zee-tool.mjs doctor --repo .
npm run typecheck && npm test && npm run verify
```

装完直接用自然语言发需求即可自动运行；如需开启多模型异构分工与跨家族审查，按需运行 `/zee-setup` 写入 `~/.agents/zee-config.json`。

## 快捷命令（按需直达专项模式）

- `/zee` — 全场景自动驾驶主入口（9 份按需剧本：`plan` / `feature` / `design` / `bug-fix` / `perf` / `understand` / `verify` / `overnight` / `ship`）
- `/zee-plan` — 显式纯规划模式（原型探针、2-Shape 对比、落盘 `plan.md` 与 `units` 后停门等确认）
- `/zee-verify` — `init` 自建并双向验真 `.agents/verify-ctl.mjs`、`maintain` 防腐保鲜、`run [--fuzz]` 实机验收与防篡改
- `/zee-review` — 只读跨家族实证对抗审查与爆炸半径校验（`--strict` / `--quick`）
- `/zee-night` — 过夜无人值守循环（两败停损 + `decisions.tsv` + `wip:` 接棒 + 3 分钟中文晨报）
- `/zee-retro` — 实跑验盘 + 跨 Run 决策与园艺队列聚类 + 4+1 级环境固化（架构/Lint/测试/文档/Skill + Bite Proof）
- `/zee-setup` — 按能力梯队与预算档位为当前宿主配置 `fast` / `workhorse` / `adversary` 三槽位（单宿主隔离）
- `/zee-mode`（Pi）— 切换 `auto`（默认）| `strict` | `off` | `status`
