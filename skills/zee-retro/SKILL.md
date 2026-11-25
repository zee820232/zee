---
name: zee-retro
description: >-
  会话复盘与 4 级结构化纠错飞轮：从本仓近期提交、回滚、审查阻塞与总线 decisions.tsv 聚类重复错因，按「架构 > 类型/Lint/Hook/CI > 行为测试 > 规范文档」机械化固化并验证新规则真能咬住历史错例。仅在用户显式调用 /zee-retro 或要求复盘固化时启用。
disable-model-invocation: true
---

# zee-retro — 会话复盘与 4 级结构化纠错飞轮

Read sibling `../zee/SKILL.md` and `../zee/disciplines/phase-boundaries.md`. **All findings, hardening proposals, and summaries shown to the user MUST be in Simplified Chinese (简体中文).**

> **Core Principle**: Optimize the **engineering environment and guardrails**, not just one line of product code. A mechanical mistake fixed only by adding another prompt sentence will happen again.

## Pipeline
1. **Collect Real Failure Evidence (Read-Only First)**:
   - Run `zee-tool.mjs list-runs "<repoRoot>"` to locate recent run buses and inspect `decisions.tsv`, retry reflections, `ROLE_VIOLATION` flags, and review blockers.
   - Inspect recent `git log` for reverts, fixup commits, repeated hotfixes, and test/lint escapes.
   - Check project guardrails: `.agents/zee.project.json`, `CODING_STANDARDS.md`, `GLOSSARY.md`, `.agents/skills/verify-*/`, lint/typecheck/CI configs, and `AGENTS.md` / `CLAUDE.md` bloat.
2. **Cluster & Classify Root Causes**:
   - Group failures into concrete failure classes (prioritize patterns occurring ≥2 times or 1 high-blast-radius near-miss).
   - Separate **mechanical failures** (enforceable by code/types/lint/hook/test) from **judgment failures** (truly requiring human/agent taste in `CODING_STANDARDS.md` or `GLOSSARY.md`).
3. **Propose Fixes Strictly Along the 4-Level Hardening Ladder** (highest level first):
   1. **Architecture / Boundary Constraint**: deepen module, encode invariant in types/sum types, or enforce import boundary rules.
   2. **Automated Tooling / Hook / Linter / CI**: ESLint/Ruff/tsc rule, pre-commit hook, `zee.project.json` `denyCommands`/`riskPaths`, or `verify-<app>` check.
   3. **Behavioral Seam Regression Test**: deterministic test killing the failure class at the public Seam.
   4. **Lean Docs / Standards Pruning**: concise entry in `CODING_STANDARDS.md` / `GLOSSARY.md` (and prune dead/no-op prompt rules so `AGENTS.md` stays lean).
4. **Present Ketchup Decision Cards in Chinese**:
   - Present 1–5 concrete proposals (each ≤30 Chinese chars: `错因类别 + 固化层级 + 建议改动 + 风险`). Wait for user approval before applying edits.
5. **Apply & Prove It Bites**:
   - After approval, implement the selected guardrail(s) cleanly.
   - **Mandatory Bite Proof**: for every new automated check, lint rule, or regression test, prove it actually **FAILS** against a concrete historical failure example (in `/tmp/zee-retro-*` or temporary probe) and **PASSES** on clean HEAD.
   - Record a concise `Rule <-> Enforcer` summary in the final Chinese report (and `decisions.tsv` if tied to an active bus).
