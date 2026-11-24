---
name: zee-setup
description: >-
  Configure models, thinking effort budgets, harness symlinks, rule-conflict audits,
  and project settings for the universal zee multi-model workflow. Run once to assign
  per-role models across any harness (T3 Code, Claude Code, Codex, Cursor, OpenCode,
  Pi, Antigravity) and re-run anytime to adjust presets or models.
disable-model-invocation: true
---

# zee-setup — One-Time Universal Model & Harness Setup

Configure `~/.agents/zee-config.json` (machine-wide canonical role-model intent + runtime bindings), symlink `zee` across installed harnesses, audit conflicting always-on rules, and optionally scaffold `<repo>/.agents/zee.project.json`.

## Step 1: Inspect Environment & Available Models

1. Run the local audit helper to inspect installed harnesses, existing config, and always-on rules:
   ```bash
   node ~/.agents/skills/zee/scripts/zee-tool.mjs audit-rules
   node ~/.agents/skills/zee/scripts/zee-tool.mjs symlinks
   ```
2. Detect live available models for the active harness:
   - **T3 Code**: call `orchestrator_capabilities` once (filter providers where `canRunChildTask === true`; note each model's exact `options[].id` and `options[].values`; use `search` if omitted models are needed).
   - **Other Harnesses**: read the harness model catalog (`pi --list-models`, `opencode models`, or built-in subagent slugs). Never invent unverified model IDs.
3. Load existing `~/.agents/zee-config.json` if present to preserve user choices.

## Step 2: Choose Budget Preset & 6 Core Role Slots

Present 3 clear presets (daily effort caps at `xhigh`; `max` is reserved for explicit user override or 2x-failed escalations):

- **`eco`**: cost-optimized — shifts every role down 1 step on its model's valid option ladder; L3 defaults to 2-seat review.
- **`balanced` (Recommended)**: `scout` low/med, `architect` high, `ui` high, `coder.standard` high, `coder.heavy` xhigh, `verifier` medium, `reviewers` 2–3 distinct families at high.
- **`max`**: maximum rigor — `architect`, `ui.heavy`, `coder.heavy`, and `reviewers` push up to `xhigh` (clamped to each model's max legal option) with full 3-family review panels.

Confirm the **6 core slots** (plus optional `judge` override; default `judge` reuses `reviewers` excluding the Orchestrator family):
1. **`scout`** — fast, low-cost reader (fast locate + deep trace fallback).
2. **`architect`** — `primary` + `arenaPool` (2–3 distinct families for L3 design bakeoffs).
3. **`ui`** — multimodal-capable Design Engineer (`standard` + `heavy`; confirm vision capability).
4. **`coder`** — `standard` (daily workhorse) + `heavy` (escalation / L3; prefer different family if available).
5. **`verifier`** — fast, reliable command & E2E runner.
6. **`reviewers`** — ordered pool of 2–3 **distinct underlying model families** (e.g., `openai`, `gemini`, `claude`; never equate proxy provider ID with family).

For each slot, store:
- **`prefer`**: `{ family, modelHint, tier, effort }` (universal across all harnesses!)
- **`backup`**: explicit user-authorized fallback `{ family, modelHint, tier, effort }` (prefer crossing provider/gateway boundaries so a single gateway outage does not knock out both primary and backup).
- **`bindings.<harness>`**: exact resolved target for the current harness (e.g., `bindings.t3: { providerInstanceId, model, options }`).

## Step 3: Write & Validate Global Config

1. Write `~/.agents/zee-config.json` (schema v2) with `authorizedFallback: true` recorded only after user confirms the `backup` entries.
2. Validate deterministically:
   ```bash
   node ~/.agents/skills/zee/scripts/zee-tool.mjs validate ~/.agents/zee-config.json
   ```
   Fix any reported schema, missing-family, or single-family-reviewer warnings before continuing.

## Step 4: Link Across Installed Harnesses

Ask the user whether to install globally across all detected harnesses (Recommended) or project-locally (`.agents/skills/`).
- For global install, apply symlinks from the active skills root into every detected harness skill directory (`~/.agents/skills`, `~/.gemini/config/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.pi/agent/skills`, `~/.cursor/skills`):
  ```bash
  node ~/.agents/skills/zee/scripts/zee-tool.mjs symlinks --apply
  ```
- For project-local install, copy or symlink into `<repo>/.agents/skills/`.

## Step 5: Resolve Always-On Rule Conflicts (With User Approval Only)

Present every conflict surfaced by `audit-rules` (e.g., `~/.gemini/config/plugins/agystack/rules/AGENTS.md`, hardcoded `pnpm`/model rules in `~/CLAUDE.md`, OMC in `~/.claude/CLAUDE.md`, `use-bend`).
- **Never edit these files silently.** Ask the user which conflicts to neutralize:
  - For Antigravity `agystack`: recommend disabling via `~/.gemini/config/config.json` (`"plugins": { "agystack": { "enabled": false } }`), which removes global interception while keeping standalone skills in `~/.agents/skills/`.
  - For `~/CLAUDE.md`: recommend moving repo-specific test commands (`pnpm test`) out of the home-dir global file.

## Step 6: Optional Project Contract & Canary Check

1. If inside a git repository without `<repo>/.agents/zee.project.json`, offer to scaffold it with discovered `testCmds`, `buildCmd`, `lintCmd`, `riskPaths`, `uiGlobs`, and `denyCommands` (especially flagging any `--live`, deployment, or signing commands). Add `.agents/zee.local.json` to `.gitignore` if local overrides are used.
2. Before the user's first `night` (overnight) run, recommend running the 5-item Canary verification checklist in `zee/references/overnight.md`.
