---
name: zee-review
description: >-
  对当前分支 diff 或指定提交执行 zee 跨家族三轴实证对抗审查（Spec 贴合度 + 规范/坏味道 + 真实命令证伪 Bug + UI 截图检查），纯只读不改代码。
disable-model-invocation: true
---

# zee-review — 跨家族对抗审查（只审不改）

This is the shortcut entry for `zee` **`review` mode** (supports **`--strict`** [default] and **`--quick`**).

> **Zero-Config Standalone（单兵开箱即用）**：若未配置 `~/.agents/zee-config.json`，调用 `zee-tool.mjs resolve-model --allow-standalone --role reviewer` 退化为当前会话模型执行单机只读三轴审查（向用户输出一句简短中文提示说明当前为同源单兵审查、如需异构跨家族审查可运行 `/zee-setup`，绝不阻塞）。

1. Read sibling `../zee/SKILL.md`, `../zee/references/protocols.md`, and `../zee/roles/reviewer.md` in full.
2. **Choose Mode Explicitly (`--strict` vs `--quick`)**:
   - **`--strict`（默认）**：**Always initialize a dedicated independent run bus** via `node "<zeeDir>/scripts/zee-tool.mjs" init-run "<repoRoot>" "review-<short-slug>"` (on Pi, `/zee-review` automatically creates `<busDir>` before dispatching `[MANDATORY_BUS_DIR]` — NEVER reuse an old bus), spawn cross-family `Reviewer` delegate(s) (passing `authorFamily` on Pi when known), run `zee-tool.mjs gate-tamper-diff` + sandbox repro (`sandbox-export` + `sandbox-clean`) + Lead Verifier Rerun on dynamic Axis 3 `P0/P1` repros, queue `P2` findings via `queue-finding` into `.agents/gardening-queue.jsonl`, and finalize `state.json` (`--status completed`) + `decisions.tsv`.
   - **`--quick`（轻量快轨，目标 `<45s`）**：keep `review🔒` read-only protection active; run `gate-tamper-diff` + targeted static/test checks and optionally a single concise read-only verification/review pass without full sandbox export; ideal for `≤3` file clear small diffs.
3. Touch **zero** repo source files (`sandbox-export` under `/tmp/zee-*`, `git -C /tmp/zee-* apply`, and `cp` to `/tmp/zee-*` are permitted by `guard-core.mjs`), and present the verdict in Simplified Chinese.
