# zee

Universal, harness-agnostic multi-model autonomous engineering workflow packaged as plain [Agent Skills](https://agentskills.io).

Configure your per-role models and thinking effort **once**, then run the same workflow from **any harness** (T3 Code, Pi, Cursor, OpenCode, Claude Code, Codex, or Antigravity) across **0-to-1 greenfield builds**, **1-to-100 risk-routed iteration**, **multi-model architecture debate (Arena)**, **cross-family adversarial reviews**, and **overnight unattended runs**.

---

## Install

```bash
npx skills add zee820232/zee
```

Or clone manually into your harness skills directory (e.g. `~/.agents/skills/` or `~/.pi/agent/skills/`):

```bash
git clone https://github.com/zee820232/zee.git
cp -R zee/skills/zee zee/skills/zee-setup ~/.agents/skills/
```

Then run `/zee-setup` once inside your agent session to detect available models, pick a budget preset (`eco` / `balanced` / `max`), audit conflicting always-on rules, and write `~/.agents/zee-config.json`.

---

## Architecture Highlights

### 1. Assign Models Once, Run on Any Harness
`~/.agents/zee-config.json` stores canonical role intent (`family`, `modelHint`, `tier`, `effort`, and authorized `backup`) plus optional harness-specific bindings. [`skills/zee/references/harness.md`](skills/zee/references/harness.md) translates abstract orchestration ops (`PROBE`, `SPAWN`, `ISOLATE`, `ASK`, `VISUAL_CHECK`, `SCHEDULE`) to whichever host you start `/zee` in:

- **T3 Code** (any active provider thread): native cross-provider `delegate_task` with live `orchestrator_capabilities` option clamping (`thought_level` / `thinking` / `effort`) and `isolation: "worktree"`.
- **Cursor / OpenCode / Claude Code / Codex / Antigravity / bare Pi**: automatic adapter mapping with transparent single-vendor degradation when cross-vendor dispatch is unavailable.

### 2. Two-Track Routing: Project 0→1 & 1→100 Risk Routing

- **Track A · Project 0→1 (`/zee init` or empty repo)** — [`greenfield.md`](skills/zee/references/greenfield.md):
  1. **Product Shaping**: multi-round recommendation-first grilling -> `SPEC.md` (MVP + explicit Out-of-Scope) with default human sign-off.
  2. **Foundation**: `Scout` toolchain/docs research + `Architect` (`ARCHITECTURE.md`, `GLOSSARY.md`, vertical milestone DAG) + `UI` (`DESIGN.md` + optional `?variant=` prototypes).
  3. **M0 + M1**: initial runnable scaffold + smoke test + `.agents/zee.project.json` + **Initial Foundation Commit** (unlocking worktrees) -> single-owner thinnest end-to-end **Walking Skeleton**.
  4. **M2..Mk**: autonomous vertical slices, commit per green unit (can transition into `night` mode).
  5. **Delivery**: polish pass, cold-start install/build/start check, E2E + UI screenshots, `README.md`, cross-family final audit.

- **Track B · 1→100 Risk × Intent × Mode**:
  - `L0`: trivial non-risk edit handled directly by Orchestrator.
  - `L1`: low-risk local slice (`Coder` or `UI` -> `Verifier`).
  - `L2`: standard feature, bug fix (**red-repro-first fast track**), refactor, or any touch to `riskPaths` -> full loop + 1 cross-family `Reviewer`.
  - `L3`: high-stakes architecture / `debate` -> orthogonal **Arena** (2–3 constrained sketches + anonymous cross-vendor `Judge` + Orchestrator `Graft`) + `Verifier` Gate 1 + 2–3 cross-family `Reviewers` Gate 2.
  - `+ night`: orthogonal unattended mode (`zee/<slug>` branch, Unit 0 harness + baseline, Canary first unit, Out-of-Tree `state.json` & append-only `decisions.tsv`, budget fuse, cross-family trail audit, Morning Report).

### 3. Six Orthogonal Roles

| Role | Responsibility | Key Discipline |
| :--- | :--- | :--- |
| **`scout`** | Read-only codebase/env mapping | `file:line` pointers, real test commands, `riskPaths`, non-grep readers |
| **`architect`** | Contracts, seams & slice DAG | Data shape first, Test Seam, Throughput Checkpoint, orthogonal Arena, `Scrap` redesign |
| **`ui`** | Design Engineer (visuals + frontend) | `DESIGN.md` / `ui-spec.md`, Anti-Slop checklist, `?variant=` prototypes, 4-quadrant headless screenshot self-check |
| **`coder`** | Isolated worktree implementation | Seam TDD (features), red-first repro (bugs), Expand–Contract (wide refactors), reports **Pinned SHA** |
| **`verifier`** | Cold-start machine gate (Gate 1) | Checks out exact Pinned SHA; strict `PASS \| FAIL \| INCONCLUSIVE`; captures raw logs & UI screenshots |
| **`reviewer`** | Cross-family auditor (Gate 2) | Dynamically excludes author's model `family`; isolated `Spec`, `Standards/Smells`, and evidence-only `Break` axes + Gate Tampering audit |

### 4. Built-In Engineering Guardrails
- **Out-of-Tree Run Bus**: `~/.local/state/zee/runs/<repo-key>/<slug>/` shared safely across git worktrees without polluting repos or colliding with `.scratch/`.
- **Pinned SHA & Sequential Grafting**: every verdict binds to one commit SHA; verified branches merge sequentially with per-merge verification.
- **Four-Level Failure Ladder**: micro-fixes (≤15 lines) handled directly by Orchestrator -> 1st failure retries same tier with 5-line root-cause reflection & objection right -> 2nd same-root failure checks shared premise (`Scrap` back to Architect vs escalate to `heavy`) -> 3rd failure trips circuit breaker.
- **Domain Redlines**: committable `<repo>/.agents/zee.project.json` defines `testCmds`, `riskPaths`, `uiGlobs`, and `denyCommands` (hard-blocking live signing, deploys, or destructive ops).

---

## Repository Layout

```text
skills/
├── zee/
│   ├── SKILL.md                  # Harness-agnostic Orchestrator kernel
│   ├── worker.md                 # Standing delegate contract
│   ├── agents/openai.yaml        # Codex invocation policy
│   ├── roles/                    # scout, architect, ui, coder, verifier, reviewer
│   ├── references/               # harness, protocols, greenfield, overnight
│   └── scripts/zee-tool.mjs      # Zero-dep config validator, symlink helper, bus & TSV logger
└── zee-setup/
    ├── SKILL.md                  # One-time setup & always-on rule conflict audit
    └── agents/openai.yaml
```

---

## Usage Examples

```text
/zee-setup                                      # Configure per-role models & thinking effort once
/zee init Build a local bookmark manager CLI    # 0-to-1 project mode
/zee Fix the retry timeout bug                  # Auto-routed (Bug fast-track)
/zee L3 Redesign the job queue architecture     # Force L3 Arena + multi-model adversarial review
/zee review                                     # Read-only cross-family adversarial review of current diff
/zee night Migrate storage layer to SQLite      # Unattended overnight mode on isolated branch
```

## License

MIT
