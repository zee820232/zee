---
name: zee-setup
description: >-
  为 zee 多模型工作流配置各角色模型、思考强度档位、当前宿主冲突规则审计与项目级安全契约。安装在哪个 Harness 就只管理当前这一个宿主，全程使用中文交互引导。
disable-model-invocation: true
---

# zee-setup — 模型装配与当前宿主初始化

Configure `~/.agents/zee-config.json` (canonical role-model intent + runtime bindings), audit rules **for the current harness only**, and optionally scaffold `<repo>/.agents/zee.project.json`.

## User-Facing Language & Single-Harness Scope (Mandatory)
- **All user-facing questions, preset descriptions, role tables, conflict warnings, and completion summaries MUST be presented in clear Simplified Chinese (简体中文).**
- **Manage ONLY the active harness where `zee` is installed** (`<zeeDir>` = sibling `zee/` directory next to this `zee-setup/`). Do NOT touch, link, or audit other harnesses unless the user explicitly asks to sync across multiple harnesses.

## Step 1: Inspect Active Harness & Available Models

1. Locate `<zeeDir>` (the sibling `zee` directory beside this `zee-setup/SKILL.md`). Run the helper scoped strictly to the active harness:
   ```bash
   node "<zeeDir>/scripts/zee-tool.mjs" audit-rules
   ```
   *(The script automatically detects the installed harness from its own path and audits only that harness.)*
2. Detect live available models in the active harness:
   - **T3 Code**: call `orchestrator_capabilities` once (filter `canRunChildTask === true`; note each model's exact `options[].id` and `options[].values`; use `search` if omitted models are needed).
   - **Other Harnesses**: inspect the harness model catalog (`pi --list-models`, `opencode models`, or built-in subagent slugs). Never write unverified model IDs.
3. Read existing `~/.agents/zee-config.json` if present so prior choices are preserved.

## Step 2: Guide User in Chinese to Pick Budget & 6 Role Slots

Present **3 budget presets** in Chinese (routine effort caps at `xhigh`; `max` is reserved for explicit user override or 2x-failed escalations):

- **`eco（省钱日常）`**：各角色思考强度在合法档位下移 1 阶，L3 默认 2 席审查。
- **`balanced（均衡主力，推荐）`**：`scout` 低/中思考、`architect` 高思考、`ui` 高思考、`coder.standard` 高思考、`coder.heavy` 超高思考、`verifier` 中思考、`reviewers` 2–3 个不同家族高思考。
- **`max（满血攻坚）`**：`architect`、`ui.heavy`、`coder.heavy`、`reviewers` 拉满至各模型合法上限（日常封顶 `xhigh`），启用完整 3 家族审查池。

Display a clean Chinese table of the **6 core slots** (plus optional `judge` override) and ask the user whether to accept or adjust specific slots:
1. **`scout`（侦察兵）** — 快速低成本只读调研。
2. **`architect`（架构师）** — `primary`（日常架构）+ `arenaPool`（2–3 个不同家族模型用于 L3 辩论）。
3. **`ui`（前端设计工程师）** — 需支持看图的多模态模型（`standard` + `heavy`）。
4. **`coder`（实现者）** — `standard`（主力）+ `heavy`（失败升档 / L3 攻坚）。
5. **`verifier`（验收官）** — 快速稳定的构建/测试/E2E 执行模型。
6. **`reviewers`（异构审查池）** — 2–3 个**不同底层模型家族**的有序列表（切勿把代理网关名称当模型家族）。

For every slot, store:
- **`prefer`**: `{ family, modelHint, tier, effort }`
- **`backup`**: user-authorized fallback `{ family, modelHint, tier, effort }` (prefer crossing gateways/providers).
- **`bindings.<harness>`**: resolved target for the current harness (e.g. `bindings.t3`).

## Step 3: Write & Validate Config

1. Write `~/.agents/zee-config.json` (schema v2) with `authorizedFallback: true` only after user confirms the `backup` entries.
2. Validate deterministically:
   ```bash
   node "<zeeDir>/scripts/zee-tool.mjs" validate ~/.agents/zee-config.json
   ```
   Fix any reported errors before continuing.

## Step 4: Active-Harness Rule Conflict Review (Approval Required)

Present ONLY the conflicts relevant to the active harness surfaced by `audit-rules`, explaining each risk in Chinese.
- **Never modify user rules or settings silently.** Ask the user in Chinese before applying any change (for example, excluding conflicting global skills in `~/.pi/agent/settings.json`, disabling `agystack` in `~/.gemini/config/config.json`, or moving project-specific commands out of `~/CLAUDE.md`).
- Only if the user explicitly asks to replicate `zee` into other harnesses, run:
  ```bash
  node "<zeeDir>/scripts/zee-tool.mjs" symlinks --apply
  ```

## Step 5: Optional Project Contract & Summary

1. If inside a git repo without `<repo>/.agents/zee.project.json`, ask in Chinese whether to generate it with discovered `testCmds`, `buildCmd`, `lintCmd`, `riskPaths`, `uiGlobs`, and `denyCommands`.
2. Summarize the saved config path, active harness, budget preset, and usage examples in Chinese (`/zee init`、`/zee <需求>`、`/zee review`、`/zee night`).
