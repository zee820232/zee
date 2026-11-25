---
name: zee-retro
description: >-
  会话复盘与结构化纠错飞轮：从跨宿主对话轨迹（mine-transcripts）、花园队列（list-findings）、总线 decisions.tsv 与近期提交聚类重复错因，按「架构 > 类型/Lint/Hook/CI > 行为测试 > 精简文档 > 新建技能/裁剪死规则」机械化固化并验证咬合力。仅在用户显式调用 /zee-retro 或要求复盘固化时启用。
disable-model-invocation: true
---

# zee-retro — 会话复盘与 4+1 结构化纠错飞轮

Read sibling `../zee/SKILL.md` and `../zee/disciplines/phase-boundaries.md`. **All findings, hardening proposals, and summaries shown to the user MUST be in Simplified Chinese (简体中文).**

> **Core Principle**: Optimize the **engineering environment and guardrails**, not just one line of product code. A mechanical mistake fixed only by adding another prompt sentence will happen again.
>
> **Zero-Config Standalone（单兵开箱即用）**：若未配置 `~/.agents/zee-config.json`，调用 `zee-tool.mjs resolve-model --allow-standalone --role architect` 退化为当前会话模型执行（附一句简短中文提示即可，绝不阻塞）。

## Pipeline
1. **Collect Real Failure Evidence (Read-Only First)**:
   - Run `node "<zeeDir>/scripts/zee-tool.mjs" mine-transcripts --mode retro --repo "<repoRoot>"` to mine recent human corrections, interruptions, retries, and failures across local session transcripts & buses (secrets automatically `<REDACTED>`).
   - Run `node "<zeeDir>/scripts/zee-tool.mjs" list-findings --repo "<repoRoot>"` to inspect `.agents/gardening-queue.jsonl` (highlighting `systemic: true` patterns with `count >= 3`).
   - Run `node "<zeeDir>/scripts/zee-tool.mjs" list-runs "<repoRoot>"` to inspect `decisions.tsv`, retry reflections, `ROLE_VIOLATION` flags, and review blockers.
   - Inspect recent `git log` for reverts, fixup commits, repeated hotfixes, and test/lint escapes; check `.agents/zee.project.json`, `CODING_STANDARDS.md`, `GLOSSARY.md`, `.agents/skills/verify-*/`, lint/CI configs, and `AGENTS.md` / `CLAUDE.md` bloat.
2. **Cluster & Classify Root Causes**:
   - Group failures into concrete failure classes (prioritize patterns occurring ≥2 times, `systemic: true` gardening clusters, or 1 high-blast-radius near-miss).
   - Separate **mechanical failures** (enforceable by code/types/lint/hook/test) from **judgment/context failures** (best turned into a lean on-demand skill or `CODING_STANDARDS.md` / `GLOSSARY.md`).
3. **Propose Fixes Strictly Along the Hardening Ladder + 5th Evolution Output Option**:
   1. **Architecture / Boundary Constraint**: deepen module, encode invariant in types/sum types, or enforce import boundary rules.
   2. **Automated Tooling / Hook / Linter / CI**: ESLint/Ruff/tsc rule, pre-commit hook, `zee.project.json` `denyCommands`/`riskPaths`, or `verify-<app>` check.
   3. **Behavioral Seam Regression Test**: deterministic test killing the failure class at the public Seam.
   4. **Lean Docs / Standards**: concise entry in `CODING_STANDARDS.md` / `GLOSSARY.md` (with zero redundant boilerplate).
   5. **Skill Creation / Dead-Rule Pruning（第 5 演化选项）**: turn repeated human interventions or recurring context transfers into a lean on-demand skill (or `pathSkills` entry in `zee.project.json`), AND actively delete obsolete/no-op/contradictory rules from `AGENTS.md`, `CLAUDE.md`, or skills.
4. **Present Ketchup Decision Cards in Chinese**:
   - Present 1–5 concrete proposals (each ≤30 Chinese chars: `错因类别 + 固化层级/选项 + 建议改动 + 风险`). Wait for user approval before applying edits.
5. **Apply & Prove It Bites**:
   - After approval, implement the selected guardrail(s) / skill / dead-rule pruning cleanly.
   - **Mandatory Bite Proof**: for every new automated check, lint rule, or regression test, prove it actually **FAILS** against a concrete historical failure example (in a `sandbox-export` or `/tmp/zee-retro-*` probe) and **PASSES** on clean HEAD.
   - Record a concise `Rule <-> Enforcer` summary in the final Chinese report (and `decisions.tsv` if tied to an active bus).
