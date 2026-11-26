# Zee v5.1.0

**个人主厨 + 可过夜（Personal Head Chef + Overnight Ready）** — 面向 Pi CLI、Antigravity (AGY) 与 Codex / Claude Code 的极简多模型工程工作流。

## 核心理念

1. **三档路由，绝不为了派人而派人**：小改直做（0 子代理）；常规开发按需拆单并实时实测；0→1 与过夜任务才启用原型探针、2-Shape 对比、多线 `worktree` 隔离、跨家族实证对抗与自动熔断。
2. **三槽位配置，单宿主严格隔离**：在 `~/.agents/zee-config.json` 按宿主分区 `harnesses.<h>.slots` 配置 `fast`、`workhorse`、`adversary`（不同模型家族，最低思考档位 `medium`）；各宿主互不串读，非 Pi 宿主亦可通过 `provider-health --record` 共享 429 冷却。
3. **不撒谎的物理门禁**：并发安全状态锁、`log-decision` 决策账本（防公式注入与 ANSI 污染）、破坏性命令拦截、只读角色越权回滚、Pi 锁期间增量脏树告警、Windows 进程树超时强杀、`.agents/verify-ctl.mjs` 双向验真闭环，以及 `gate-tamper-diff`。

## 快捷命令

- `/zee` — 按复杂度分级路由进入主流程（8 份按需剧本：`understand` / `plan` / `feature` / `bug-fix` / `perf` / `verify` / `overnight` / `ship`）
- `/zee-plan` — 0→1 摸底、原型探针、2-Shape 对比与 `plan.md` / `units` 落盘
- `/zee-verify` — `init` 生成并双向验真 `.agents/verify-ctl.mjs`、`maintain` 防腐保鲜、`run` 实跑并核对防篡改
- `/zee-review` — 只读跨家族实证对抗审查与爆炸半径校验（`--strict` / `--quick`）
- `/zee-night` — 过夜无人值守循环（两败质疑前提 + `decisions.tsv` + `wip:` 挂起接棒 + 可直接拍板中文晨报）
- `/zee-retro` — 先实跑验磁盘真相，再按 4 级环境固化阶梯（架构/Lint/测试/文档 + Bite Proof）沉淀防线
- `/zee-setup` — 按能力梯队与预算档位为当前宿主分配 `fast` / `workhorse` / `adversary` 三槽位写入 `zee-config.json`
- `/zee-mode`（Pi）— 手动切换 `auto | strict | off | status` 状态栏模式

## 安装与自检

```bash
node scripts/install.mjs --dry-run
node skills/zee/scripts/zee-tool.mjs doctor
node --test tests/*.test.mjs
```
