# Discipline: Phase Boundaries, Smart Zone & Ketchup Reporting (`phase-boundaries.md`)

Loaded by the Orchestrator to maintain crisp context hygiene across multi-phase sessions and deliver effortless human decision-making.

## 1. Smart Zone (~150k Context) & 5-Option Phase Boundary Decision Tree
Treat ~150k tokens (or ~60% of host context window) as the **Smart Zone** ceiling. At every major phase boundary (after Grill/Plan, after M1, after a completed slice, or after an investigation), pick deliberately from 5 options in order:
1. **Continue**: still comfortably inside Smart Zone AND next step directly reuses current working context.
2. **`/clear` (Fresh Thread)**: next task is unrelated OR prior artifact (`plan.md` / `SPEC.md` / `state.json`) is already persisted on disk.
3. **`handoff`**: switching harnesses, pivoting to a new branch/directory, or handing off cleanly mid-stream — emit a pointer-only handoff note (bus path, git SHA, open forks, exact next command; never paste whole files, redact secrets).
4. **Subagent**: next step is a self-contained exploration, build slice, verification, or review whose bulky tool logs should stay off the main thread.
5. **Directed `/compact`**: only when context approaches ceiling mid-phase AND you supply explicit preservation instructions (keep active bus path, locked decisions, pinned SHAs, and remaining slices).

## 2. Ketchup-Style Briefs & Visual PR Standard
Apply to Morning Reports (`/zee-night`), milestone handoffs, and PR descriptions (≤40 lines):
1. **Lead With Visual / Concrete Proof**: pick the smallest high-signal visual — Before/After screenshots (S-tier), execution output receipts with exit codes + Pinned SHA (A-tier), or a 5-line flow/file-tree/Mermaid sketch.
2. **Merge Danger & Blast Radius**: explicitly classify changes as **Two-Way Door** (cheap revert) vs **One-Way Door** (migration, public contract, destructive op, external side effect) and list exact blast radius.
3. **Self-Contained Decision Cards (≤30 Chinese chars each)**: every open question needing human sign-off MUST carry `问题 + 推荐选项 + 关键风险` so the user can decide in a single reply without hunting through logs; phrase recommendations so replying **`是` / `yes` / `按推荐`** cleanly adopts defaults.
4. **Plain Language**: explain technical trade-offs directly in clear Simplified Chinese using the repo's `GLOSSARY.md` terms — skip robotic filler and redundant boilerplate.
