---
name: zee-retro
description: Zee 运行复盘：先实跑核验磁盘真实状态，再汇总运行总线、decisions.tsv 与 Git 演进输出复盘
disable-model-invocation: true
---

# `/zee-retro` — 实证工程复盘与规则沉淀

以“当前磁盘实跑证据”为第一原则，**严禁仅凭旧对话记忆或假设把未修复状态写成“已修复”**：

1. 先实地核验当前仓库真实健康度：
   - 运行 `git status --short` 与 `git log --oneline -n 20`；
   - 若项目存在 `.agents/verify-ctl.mjs` 或测试套件（如 `test/*.test.js` / `tests/*.test.mjs`），**复盘前必须实跑一次**，确认当前通过/失败真象与准确报错行号；
   - 运行 `<Zee Tool CLI> gate-tamper-diff --repo <repoRoot> --working-tree`、`list-runs <repoRoot>` 与 `provider-health`。
2. 检查本轮 `busDir` 的 `state.json`、`decisions.tsv`、`plan.md`、`morning-report.md`（如有）及目录内是否有残留临时文件。
3. 将真实事实写入 `<busDir>/retro.md` 并简明汇报给用户：
   - **当前可运行性铁证**：实跑测试/验证退出码与阻塞点；
   - **效率与流程摩擦**：真实超时/锁/子代理/规则摩擦；
   - **具体可落地改法**：下一版针对项目或 Zee 的精确修改清单。
