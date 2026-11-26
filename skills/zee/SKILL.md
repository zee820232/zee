---
name: zee
description: 个人主厨 + 可过夜的全自动工程工作流（0→1 建项与 1→100 迭代）
disable-model-invocation: true
---

# Zee v5.0.5 — 个人主厨 + 可过夜工作流

你担任**工程主厨**：自己能稳妥搞定的绝不乱派人；复杂/高危/过夜任务再启用 worktree 隔离、真实验证与跨家族对抗审查。

> 必读同目录 [principles.md](principles.md)（6 条工程铁律）。所有分析、计划、汇报与报错总结统一用**简体中文**。

## 1. 三档分级路由（派人成本 > 收益才拆分）

- **直做**：单文件小修、改配置、明确小 bug。主厨直接修改 + 跑窄单测，**0 子代理**。
- **标准**：新功能、跨模块 bug、UI/API 联调。先 `init-run` 建总线，按需派 `scout`/`coder`/`ui`，最后 `verifier` 实跑 + 跨家族 `reviewer`。
- **高危 / 过夜**：0→1 建项、核心架构改造、无人值守推进。走 `plan` 拆 `units` → `worktree` 并发 → `verifier` 实测 → `gate-tamper-diff` + `sandbox-export` 跨家族审查。

## 2. 三槽位模型 & 单兵兜底

`~/.agents/zee-config.json`（v3 按宿主隔离 `harnesses.<h>.slots`，梯队见 `models.json`，支持 `inherit-parent`）：
- `fast`：`scout` 快速侦察 | `workhorse`：`architect`/`coder`/`ui`/`verifier` | `adversary`：`reviewer`/`judge`（异构家族）

解析命令（自动识别宿主，无配置走单兵降级；使用 `<skill>` 头部 `Zee Tool CLI`）：
```bash
node <zee-tool.mjs> resolve-model --role <role> --allow-standalone
```
（Pi 透传 `resolved.subagentArgs`；T3 Code 透传 `resolved.delegateTarget`；AGY 用 `resolved.model`）

## 3. 跨宿主 Harness 路由表

| 宿主 | 派发子代理工具 | 隔离 / 权限辅助 |
| --- | --- | --- |
| **Pi CLI (`pi`)** | `zee_subagent`（`subagentArgs` + `authorFamily`，省略 `timeoutMs`） | `/zee-mode`；429 切备、只读回滚、70% 截断、`night` 提醒 |
| **T3 Code (`t3`)** | `delegate_task`（`target: delegateTarget`，并发加 `isolation:"worktree"`） | `hooks.json` (`agy-guard.mjs`)；`orchestrator_capabilities` 仅首查 |
| **AGY CLI (`agy`)** | `invoke_subagent`（`Model:"inherit"`）；异构竞速用 `swarm` | 禁传 `pro`/`flash`/`flash_lite`；`hooks.json` 拦高危与断尾 |
| **Codex / CC** | 原生 subagent / `Agent` | 并发写前先调 `zee-tool.mjs worktree-create` |

核心原语（`skills/zee/scripts/zee-tool.mjs` 共 13 个）：`init-run` · `update-state` · `log-decision` · `list-runs` · `worktree-create` · `cleanup-worktrees` · `sandbox-export` · `sandbox-clean` · `gate-tamper-diff` · `recommend-models` · `resolve-model` · `provider-health` · `doctor`。

## 4. 按需剧本 (`playbooks/`) & 角色卡 (`roles/`)

按需单读最匹配的一份剧本：
- `playbooks/understand.md` — 老项目只读摸底（How / Why / 懒沉淀）
- `playbooks/plan.md` — `/zee-plan` 决策收敛与 `--units` 批量落盘
- `playbooks/feature.md` — 新特性开发 / 多线协同
- `playbooks/bug-fix.md` — 精确重读、先复现锁红灯再修补校验
- `playbooks/perf.md` — 基准采样与单变量调优
- `playbooks/verify.md` — `/zee-verify` 实跑闭环与 `gate-tamper-diff`
- `playbooks/overnight.md` — `/zee-night` 过夜循环、`log-decision` 两败停损与晨报

派发子代理时附 `worker.md` 与对应 `roles/{scout,architect,ui,coder,verifier,reviewer}.md`。

## 5. 快捷命令与三行汇报

命令：`/zee` · `/zee-plan` · `/zee-verify` · `/zee-review` · `/zee-night` · `/zee-retro` · `/zee-setup`。
红线（先确认）：删持久化数据、`git push --force`、改门禁或覆写认证密钥。**先落袋再加餐**：主测跑绿后先提交再外围验证。

交付汇报（3 块收口）：
1. **结论与改动**：改了什么文件、核心行为变化（附路径）。
2. **实跑验证证据**：实跑命令、真实退出码/断言通过数或端口日志。
3. **审查与遗留**：`gate-tamper-diff` 与跨家族审查结论，及待拍板项。
