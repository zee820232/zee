# Zee v5.0.1

**个人主厨 + 可过夜（Personal Head Chef + Overnight Ready）** — 面向 Pi CLI、Antigravity (AGY) 与 Codex / Claude Code 的极简多模型工程工作流。

## 核心理念

1. **三档路由，绝不为了派人而派人**：小改直做（0 子代理）；常规开发按需拆单并实时实测；0→1 与过夜任务才启用多线 `worktree` 隔离、跨家族对抗与自动熔断。
2. **三槽位配置，支持单兵兜底**：在 `~/.agents/zee-config.json` 配置 `fast`、`workhorse`、`adversary`（不同模型家族）三槽位；未配文件时带 `--allow-standalone` 自动单模型降级。
3. **不撒谎的物理门禁**：保留并发安全状态锁、`log-decision` 决策账本、破坏性命令拦截、只读角色越权回滚、`.agents/verify-ctl.mjs` 实跑闭环，以及 `gate-tamper-diff`（监控 `test/`/`tests/`/`.agents/verify-ctl*`/`.agents/zee.project.json`、抑制注解、硬编码密钥与 `\uFFFD` 乱码）。

## 快捷命令

- `/zee` — 按复杂度分级路由进入主流程
- `/zee-plan` — 0→1 探索、决策收敛与 `plan.md` / `units` 落盘
- `/zee-verify` — `init` 生成项目自检脚本、`run` 实跑并核对防篡改
- `/zee-review` — 隔离沙盒 + 跨家族 `adversary` 只读对抗审查
- `/zee-night` — 过夜无人值守循环（两败停损 + `decisions.tsv` + 晨报）
- `/zee-retro` — 读取总线与 Git 历史输出真实运行复盘
- `/zee-mode`（Pi）— 手动切换 `auto | strict | off | status` 状态栏模式

## 安装与自检

```bash
node scripts/install.mjs --dry-run
node skills/zee/scripts/zee-tool.mjs doctor
node --test tests/*.test.mjs
```
