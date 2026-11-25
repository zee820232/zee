---
name: zee-review
description: >-
  对当前分支 diff 或指定提交执行 zee 跨家族三轴实证对抗审查（Spec 贴合度 + 规范/坏味道 + 真实命令证伪 Bug + UI 截图检查），纯只读不改代码。
disable-model-invocation: true
---

# zee-review — 跨家族对抗审查（只审不改）

This is the shortcut entry for `zee` **`review` mode**.

> **Zero-Config Standalone（单兵开箱即用）**：若未配置 `~/.agents/zee-config.json`，调用 `zee-tool.mjs resolve-model --allow-standalone --role reviewer` 退化为当前会话模型执行单机只读三轴审查（向用户输出一句简短中文提示说明当前为同源单兵审查、如需异构跨家族审查可运行 `/zee-setup`，绝不阻塞）。

1. Read sibling `../zee/SKILL.md`, `../zee/references/protocols.md`, and `../zee/roles/reviewer.md` in full.
2. **Always initialize a dedicated independent run bus** via `node "<zeeDir>/scripts/zee-tool.mjs" init-run "<repoRoot>" "review-<short-slug>"` (NEVER reuse or mix artifacts into an old feature/init bus).
3. Execute `zee` strictly in **standalone read-only `review` mode** on the requested scope/SHA (default: current branch diff against base branch or uncommitted working-tree changes).
4. Spawn `Reviewer` delegate(s) (cross-family when `zee-config.json` exists, passing `authorFamily` on Pi when known): run `zee-tool.mjs gate-tamper-diff` first, run break tests inside `zee-tool.mjs sandbox-export` + `sandbox-clean`, perform Lead Verifier Rerun on dynamic Axis 3 `P0/P1` repro commands, keep only evidence-backed findings across the 3 isolated axes (5-level blast-radius certainty + UI screenshot audit if applicable), persist non-blocking `P2` smells via `zee-tool.mjs queue-finding` into `.agents/gardening-queue.jsonl`, touch **zero** repo source files, mark the bus `completed` via `zee-tool.mjs update-state "<busDir>" --status completed` + `log-decision`, and present the verdict in Simplified Chinese.
