---
name: zee-verify
description: >-
  项目级实机验证技能全生命周期（对标 pstack verify）：接手已有项目或新项目时，生成并真机跑通 verify-<app>/SKILL.md + features/ 地图（init）、定期防腐维护抓回归（maintain）、或按地图立即冷启动实机验证当前改动（run）。仅在用户显式调用 /zee-verify 或要求创建/维护/执行项目验证技能时启用。
disable-model-invocation: true
---

# zee-verify — 项目级实机验证技能（`verify-<app>`）全生命周期

Read sibling `../zee/SKILL.md`, `../zee/disciplines/verification-skill.md`, and `../zee/roles/verifier.md`. **All questions, summaries, triage tables, and reports shown to the user MUST be in Simplified Chinese (简体中文). Never weaken tests/docs to mask a real product bug.**

## Mode Dispatch

Inspect `<projectSkillsDir>/verify-*/SKILL.md` (checking `.agents/skills/`, `.pi/skills/`, `.claude/skills/`, `.cursor/skills/`):

1. **`/zee-verify init`（或直接输入 `/zee-verify` 且仓库尚无 `verify-<app>`）— 生成并真机证真**
   - Follow `disciplines/verification-skill.md` §2 (`create` flow):
     1. Interview the **repository source** (not the user) across all 5 dimensions: `Surface`, `Launch` (empty data dir + true usability readiness), `Doctor`, `Drive` (stable handles, never brittle coordinates), and `Isolate & Cleanup` (free port, PID-only teardown, cleanup never deletes proof artifacts).
     2. Write `<projectSkillsDir>/verify-<app>/SKILL.md` (with `Launch`, `Doctor`, `Drive`, `Evidence`, `Cleanup`, `Helpers`) + `features/README.md` + 3–5 top user-facing `features/<name>.md` files.
     3. **Hard Live Proof Gate (Non-Negotiable)**: execute `Launch -> Doctor -> Drive 1 mapped feature -> Capture evidence -> Cleanup -> Confirm evidence survives` live end-to-end before reporting done. Never touch product source code.
2. **`/zee-verify maintain` — 定期防腐与真机回归巡检**
   - Follow `disciplines/verification-skill.md` §3 (`maintain` flow):
     1. Reconcile `features/README.md` against actual files.
     2. Run a read-only `Scout` wave checking source drift per feature.
     3. Drive every mapped feature live serially, enforcing: `Doctor` before first drive & after failures; captured evidence survives cleanup; failed runs clean up residue.
     4. Strictly triage findings into **文档漂移（修 `features/`）** / **驱动脚本缺口（修 helper 并重跑证真）** / **产品真实回归（原样汇报给用户，严禁改弱文档掩盖 Bug）**。
3. **`/zee-verify run [feature]`（或直接输入 `/zee-verify` 且仓库已有 `verify-<app>`）— 立即冷启动实机验收**
   - Strictly read-only on repository source (`review` lock active).
   - Initialize an independent run bus (`zee-tool.mjs init-run "<repoRoot>" "verify-live"`), dispatch cold-start `Verifier` following `<projectSkillsDir>/verify-<app>/SKILL.md` verbatim, save logs to `<busDir>/artifacts/verify-r1.log` and screenshots to `<busDir>/screenshots/`, visually inspect captured screenshots if UI was touched, update `state.json` to `completed`, and report the 3-state verdict (`PASS / FAIL / INCONCLUSIVE`) in Simplified Chinese.
