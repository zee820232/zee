---
name: zee-setup
description: >-
  为 zee 多模型工作流配置各角色模型、思考强度档位、当前宿主全面健康体检（doctor + readiness）与项目级安全/信任梯度契约（trustLevel + pathSkills）。安装在哪个 Harness 就只管理当前这一个宿主，全程使用中文交互引导。
disable-model-invocation: true
---

# zee-setup — 模型装配、宿主健康体检与当前宿主初始化

Configure `~/.agents/zee-config.json` (canonical role-model intent + runtime bindings), run single-harness health diagnostics (`doctor` + `audit-rules` + `readiness`), and optionally scaffold `<repo>/.agents/zee.project.json` (including `trustLevel` and `pathSkills`). *(Note: standalone/read-only skills also work without `zee-config.json` via `resolve-model --allow-standalone`; `/zee-setup` unlocks full multi-model & cross-family execution.)*

## User-Facing Language & Single-Harness Scope (Mandatory)
- **All user-facing questions, preset descriptions, role tables, conflict warnings, and completion summaries MUST be presented in clear Simplified Chinese (简体中文).**
- **Manage ONLY the active harness where `zee` is installed** (`<zeeDir>` = sibling `zee/` directory next to this `zee-setup/`). Do NOT touch, link, or audit other harnesses unless the user explicitly asks to sync across multiple harnesses.

## Step 1: Active-Harness Doctor, Readiness & Live Model Probe

1. Resolve `<skillDir>` (the directory containing this `zee-setup/SKILL.md`). The helper script ALWAYS lives at sibling `../zee/scripts/zee-tool.mjs`. Run the one-stop single-harness diagnostic directly (pass `--repo "<repoRoot>"` when inside a git repo to include `readiness`):
   ```bash
   node "<skillDir>/../zee/scripts/zee-tool.mjs" doctor [--repo "<repoRoot>"]
   ```
   *(Automatically checks config validity, Pi `enabledModels` `CONFIG_DRIFT` masking, active-harness rule/double-install conflicts across `~/CLAUDE.md`/`~/.claude/CLAUDE.md`/`~/.pi/agent/AGENTS.md`, bus writability, AGY Hook live probe, repo `readiness` for `T1/T2/T3`, and cross-session 429/5xx `providerHealth` cooldowns.)*
2. Detect live available models in the active harness:
   - **T3 Code**: call `orchestrator_capabilities` once (filter `canRunChildTask === true`; note each model's exact `options[].id` and `options[].values`).
   - **Pi**: inspect `pi --list-models` AND check `~/.pi/agent/settings.json` `enabledModels` (alert immediately if `doctor` reports `CONFIG_DRIFT` hiding configured models!).
   - **Google Antigravity**: verify `agy` tiers (`pro`/`flash`/`flash_lite`/`inherit`) and test `zee-tool.mjs resolve-model --harness agy --role coder.standard`.
   - **Other Harnesses**: inspect the host model catalog. Never write unverified model IDs.
3. Read existing `~/.agents/zee-config.json` if present so prior choices are preserved.

## Step 2: Guide User in Chinese to Pick Budget & 6 Role Slots

Present **3 budget presets** in Chinese (routine effort caps at `xhigh`; `max` is reserved for explicit user override or 2x-failed escalations):

- **`eco（省钱日常）`**：各角色思考强度在合法档位下移 1 阶，L3 默认 2 席审查。
- **`balanced（均衡主力，推荐）`**：`scout` 低思考、`architect.primary` 旗舰模型**低思考（`low`，常规 L2/L3 提速 2–4× 且质量稳，中/高思考留给 L3 Arena 辩论池）**、`ui` 中思考、**`coder.standard` 中思考（`medium`，实测耗时降 4–5 倍且质量稳）**、`coder.heavy` 高思考（**备胎优先高速异构模型，避免把单次 >10 分钟的慢思考模型设为长切片编码备胎**）、`verifier` 低/中思考、`reviewers` 2–3 个不同家族（常规审查优先高速稳定模型 `medium`，深度模型 `low`/`medium` 按需使用）。
- **`max（满血攻坚）`**：`architect`、`ui.heavy`、`coder.heavy`、`reviewers` 拉满至各模型合法上限（日常封顶 `xhigh`），启用完整 3 家族审查池。

Display a clean Chinese table of the **6 core slots** (plus optional `judge` override) and ask the user whether to accept or adjust specific slots:
1. **`scout`（侦察兵）** — 快速低成本只读调研。
2. **`architect`（架构师）** — `primary`（日常架构）+ `arenaPool`（2–3 个不同家族模型用于 L3 辩论）。
3. **`ui`（前端设计工程师）** — 需支持看图的多模态模型（`standard` + `heavy`）。
4. **`coder`（实现者）** — `standard`（主力，推荐 `medium`）+ `heavy`（失败升档 / L3 攻坚）。
5. **`verifier`（验收官）** — 快速稳定的构建/测试/E2E 执行模型。
6. **`reviewers`（异构审查池）** — 2–3 个**不同底层模型家族**的有序列表（切勿把代理网关名称如 `pi`/`vm`/`devin` 当模型家族）。

For every slot, store `prefer`, authorized `backup`, and `bindings.<harness>`.

## Step 3: Write & Live-Validate Config

1. Write `~/.agents/zee-config.json` (schema v2) with `authorizedFallback: true` only after user confirms the `backup` entries.
2. Validate deterministically with live drift checking:
   ```bash
   node "<zeeDir>/scripts/zee-tool.mjs" validate ~/.agents/zee-config.json --check-live
   ```
   Fix any reported errors or `CONFIG_DRIFT` before continuing.

## Step 4: Active-Harness Conflict Review & Optional AGY Auto-Routing (Approval Required)

Present ONLY the conflicts relevant to the active harness surfaced by `doctor` / `audit-rules`, explaining each risk in Chinese.
- **Never modify user rules or settings silently.** Ask the user in Chinese before applying any change (unblocking masked models in `~/.pi/agent/settings.json` `enabledModels`, excluding conflicting orchestrator skills, disabling conflicting global-rule plugins in `~/.gemini/config/config.json`, or cleaning hardcoded rules in `~/CLAUDE.md` / `~/.pi/agent/AGENTS.md`). Note: Pi Package `v4.2.1` exposes 11 non-duplicated commands (`/zee*` + `/zee-mode` + `/zee-hub`) without duplicate `/skill:zee*` menu entries.
- **Google Antigravity Only (Opt-In, Default OFF)**: ask whether the user wants to enable `~/.gemini/config/rules/zee-auto.md` (≤15 lines, exempting casual chat and ≤1-file trivial edits). Default recommendation is **关闭（仅用 `agy --agent zee` 与显式 `/zee*` 命令，零打扰）**.
- Only if the user explicitly asks to replicate `zee` into other harnesses, run `node "<zeeDir>/scripts/zee-tool.mjs" symlinks --apply`.

## Step 5: Optional Project Contract (`trustLevel` + `pathSkills`), `verify-<app>` & Summary

1. If inside a git repo without `<repo>/.agents/zee.project.json`, ask in Chinese whether to generate it with discovered `testCmds`, `buildCmd`, `lintCmd`, `riskPaths`, `uiGlobs`, `denyCommands`, plus optional:
   - **`trustLevel`** (`"T1"` 默认严格逐片双门禁 | `"T2"` 非高危双向门切片过 Gate 1 后并入并在里程碑抽检 | `"T3"` 隔离分支过夜全自动 + `--fuzz` + 晨间抽检；实际运行期由 `zee-tool.mjs readiness` 按门禁完备度自动向下钳位！)
   - **`pathSkills`**（`[{ "glob": "...", "skill": "...", "roles": [...] }]`：仅当改动文件命中 glob 时按需注入子代理 Brief，零常驻上下文税）
2. Run `node "<zeeDir>/scripts/zee-tool.mjs" readiness "<repoRoot>"` to display the repo's `configuredTrustLevel` -> `effectiveTrustLevel` and any missing blockers (`verifySkill`, `verifyCtl`, `riskPaths`, etc.).
3. If the repo is a real UI, CLI/TUI, game, desktop, or service app without `<projectSkillsDir>/verify-<app>/SKILL.md`, offer in Chinese to run `/zee-verify init` (`disciplines/verification-skill.md`) to generate and **live-prove** `verify-<app>/` + `scripts/verify-ctl.*` + `features/`.
4. Summarize the saved config path, active harness, `doctor` + `readiness` status, budget preset, and usage examples in Chinese (`/zee-plan`、`/zee-init`、`/zee <需求>`、`/zee-review`、`/zee-verify`、`/zee-arch`、`/zee-retro`、`/zee recall`、`/zee triage`、`/zee-night`，以及 Pi 宿主下的 `/zee-hub` / `Ctrl+Alt+H` / `F2` 交互控制台).
