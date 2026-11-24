# Specialized Modes: Investigate, Perf/Hillclimb, Prototype & Sweep (`specialized.md`)

Loaded only when the task matches one of these 4 specialized workflows. **All reports, tables, and recommendations shown to the user MUST be in Simplified Chinese (简体中文).**

## 1. Read-Only Investigation (`investigate`)
Triggered by "怎么工作的 / 为什么这样设计 / 查一下影响面 / 只看不改" or `/zee investigate <question>`.
1. Spawn 1 `Scout(Deep)` (or N parallel Scouts for multi-subsystem questions) with strictly read-only tools.
2. Require every claim to cite exact `file:line`, verbatim key signatures, git history rationale (`git log`), and non-grep readers (wire keys, DB columns, parity scripts).
3. Synthesize one clear Chinese explanation with verified evidence labels (**实测 / 代码证据 / 推断**) and **zero repository edits**.

## 2. Performance Optimization & Metric Hillclimb (`perf` / `hillclimb`)
Triggered when the goal is improving a measurable metric (latency, throughput, memory, backtest score, eval accuracy) or `/zee perf|hillclimb <target>`.
1. **Define & Freeze Harness First (Mandatory)**:
   - Agree on **one primary metric**, direction (higher/lower is better), target threshold, and a **regression gate** (tests that must stay green).
   - Build or verify a single repeatable benchmark command that prints **median of N runs**, error count, and work done; vet it against confounds (warm-up, caching, CPU contention, identical workload).
   - Capture and log the **pre-change Baseline** to `decisions.tsv` before touching production code. Never optimize from source inspection alone.
2. **One-Change Scientific Loop**:
   - Follow cheapest-first optimization order: eliminate unnecessary work -> reduce algorithmic/IO amplification -> tune hot path.
   - Each iteration makes **one smallest hypothesis-driven change** via `Coder` -> runs regression gate + frozen benchmark via `Verifier` -> **keep & commit** only if metric improved beyond noise AND regression gate is green; **revert immediately** if flat, regressed, or noisy.
   - Log every kept/reverted experiment row in `decisions.tsv` (`metric before -> after`). Stop when target is met or 3 consecutive experiments fail to improve (plateau -> pivot premise or halt and report).

## 3. Throwaway Technical Prototype (`prototype`)
Triggered to settle an empirical technical fork (e.g., library A vs B, protocol/API feasibility, perf behavior) instead of guessing or asking the user.
1. Isolate throwaway code on branch `prototype/<slug>` or inside `<busDir>/artifacts/proto/` — never mix prototype hacks into production branches.
2. Run the minimal experiment to observe real behavior/output/timing and record the measured result in `<busDir>/artifacts/proto-result.md`.
3. Clean up throwaway branch/files after the decision is locked, then proceed with clean production design.

## 4. Parallel Read-Only Sweep (`sweep`)
Triggered when auditing, migrating-analysis, or checking a pattern across many independent files/modules (e.g., ≥5 disjoint slices) to produce one consolidated report.
1. Frame the exact **Done Predicate**, slice boundaries, and required evidence format (`PASS | ISSUES | BLOCKED` + `file:line` / command output + target SHA).
2. Fan out parallel read-only workers across disjoint slices (cap local concurrency conservatively for CPU/rate limits).
3. **Aggregate Strictly**: drop any worker result missing required evidence or SHA (respawn once max; record a gap after 2nd miss — a gap never counts as `PASS`). Never dump raw worker logs; deliver one consolidated Chinese summary table + proven issue one-liners + gaps.
