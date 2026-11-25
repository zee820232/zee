---
name: zee-verify
description: >-
  项目级实机验证技能全生命周期（对标 pstack verify）：接手已有项目或新项目时，生成并真机跑通 verify-<app>/SKILL.md + scripts/verify-ctl.* + features/ 地图（init）、定期防腐维护抓回归（maintain）、或按地图立即冷启动实机验证当前改动（run，支持 --fuzz）。仅在用户显式调用 /zee-verify 或要求创建/维护/执行项目验证技能时启用。
disable-model-invocation: true
---

# zee-verify — 项目级实机验证技能（`verify-<app>`）全生命周期

Read sibling `../zee/SKILL.md`, `../zee/disciplines/verification-skill.md`, and `../zee/roles/verifier.md`. **All questions, summaries, triage tables, and reports shown to the user MUST be in Simplified Chinese (简体中文). Never weaken tests/docs to mask a real product bug.**

> **Zero-Config Standalone（单兵开箱即用）**：若未配置 `~/.agents/zee-config.json`，调用 `zee-tool.mjs resolve-model --allow-standalone --role verifier` 优雅退化为当前会话模型执行（向用户输出一句简短中文提示即可，绝不阻塞）。

## Mandatory Output Isolation & `verify-ctl` Contract
- **Zero Repo Scratch**: ALL test outputs, temp dirs, Playwright reports/traces, and build/test scratch MUST live in `/tmp/zee-verify-*` or `<busDir>` whenever possible. In brownfield repos whose existing scripts still emit standard `.gitignore`-ignored, zero-tracked build/test folders (e.g., `test-results/`, `playwright-report/`, `dist/`, `coverage/`), `guard-core.mjs` safely allowlists cleaning those ignored artifact dirs under `review🔒` without touching tracked files, `node_modules`, `.git`, or `.env*`.
- **Control Script**: every `verify-<app>` skill MUST ship `<projectSkillsDir>/verify-<app>/scripts/verify-ctl.(mjs|py|sh)` exposing deterministic `launch / doctor / snapshot / evidence / cleanup` commands.

## Mode Dispatch

Inspect `<projectSkillsDir>/verify-*/SKILL.md` (checking `.agents/skills/`, `.pi/skills/`, `.claude/skills/`, `.cursor/skills/`):

1. **`/zee-verify init`（或直接输入 `/zee-verify` 且仓库尚无 `verify-<app>`）— 生成并真机证真**
   - Follow `disciplines/verification-skill.md` §3 (`create` flow):
     1. Interview the **repository source** (not the user) across all 5 dimensions: `Surface`, `Launch` (empty `/tmp/zee-verify-*` data dir + true usability readiness), `Doctor`, `Drive` (stable handles, never brittle coordinates), and `Isolate & Cleanup` (free port, PID-only teardown, cleanup never deletes `<busDir>` proof artifacts).
     2. Write `<projectSkillsDir>/verify-<app>/SKILL.md`, `scripts/verify-ctl.(mjs|py|sh)` (`launch / doctor / snapshot / evidence / cleanup`), `features/README.md`, and 3–5 top user-facing `features/<name>.md` files.
     3. **Hard Live Proof Gate (Non-Negotiable)**: execute `launch -> doctor -> drive 1 mapped feature -> evidence -> cleanup -> confirm evidence survives` live end-to-end before reporting done. Never touch product source code.
2. **`/zee-verify maintain [--fuzz]` — 定期防腐与真机回归巡检**
   - Follow `disciplines/verification-skill.md` §4 (`maintain` flow):
     1. Reconcile `features/README.md` against actual files and confirm `verify-ctl.*` works.
     2. Run a read-only `Scout` wave checking source drift per feature.
     3. Drive every mapped feature live serially (optionally followed by `--fuzz`), enforcing: `Doctor` before first drive & after failures; captured evidence survives cleanup; failed runs clean up `/tmp/zee-verify-*` residue without touching repo scratch.
     4. Strictly triage findings into **文档漂移（修 `features/`）** / **驱动脚本缺口（修 `verify-ctl.*`/helper 并重跑证真）** / **产品真实回归（原样汇报给用户，严禁改弱文档掩盖 Bug）**。
3. **`/zee-verify run [feature] [--fuzz]`（或直接输入 `/zee-verify` 且仓库已有 `verify-<app>`）— 立即冷启动实机验收**
   - Strictly read-only on repository source (`review` lock active).
   - Initialize an independent run bus (`zee-tool.mjs init-run "<repoRoot>" "verify-live"`), dispatch cold-start `Verifier` following `<projectSkillsDir>/verify-<app>/SKILL.md` and `scripts/verify-ctl.*` verbatim (keeping ALL outputs/Playwright reports inside `/tmp/zee-verify-*` or `<busDir>`), run time-boxed exploratory `--fuzz` after scripted features when `--fuzz` is requested (or by default on `L3` / `Stage 5` / `T3` autopilot), visually inspect captured screenshots if UI was touched, update `state.json` to `completed`, and report the 3-state verdict (`PASS / FAIL / INCONCLUSIVE`) in Simplified Chinese.
