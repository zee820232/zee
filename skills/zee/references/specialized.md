# Specialized Modes: Investigate, Perf/Hillclimb, Loop, Prototype & Sweep (`specialized.md` v4)

Loaded only when the task matches one of these 5 specialized workflows. **All reports, tables, and recommendations shown to the user MUST be in Simplified Chinese (简体中文).**

## 1. Read-Only Investigation (`investigate`)
Triggered by "怎么工作的 / 为什么这样设计 / 查一下影响面 / 只看不改" or `/zee investigate <question>`.
1. Spawn 1 `Scout(Deep)` (or N parallel Scouts for multi-subsystem questions) with strictly read-only tools.
2. Require every claim to cite exact `file:line`, verbatim key signatures, git history rationale (`git log`), non-grep readers (wire keys, DB columns, parity scripts), and (when relevant MCP tools like Linear/Sentry/Notion/GitHub exist) linked issue/incident history.
3. Synthesize one clear Chinese explanation with verified evidence labels (**实测 / 代码证据 / 推断**) and **zero repository edits**.

## 2. Performance Optimization & Metric Hillclimb (`perf` / `hillclimb`)
Triggered when the goal is improving a measurable metric (latency, throughput, memory, backtest score, eval accuracy) or `/zee perf|hillclimb <target>`.
1. **Define & Freeze Harness First (7-Question Benchmark Checklist)**:
   Before writing a single optimization line, verify all 7 benchmark questions:
   - **Metric & Direction**: one primary metric, direction (higher/lower), target threshold, and green regression gate.
   - **Work Done & Anti-Noop**: confirm the benchmark actually computes real output (cannot be dead-code eliminated or short-circuited by lazy evaluation).
   - **Warm-up & Cache State**: separate cold vs warm cache / JIT warm-up explicitly.
   - **ABAB Alternation**: interleave Baseline (A) and Candidate (B) runs (`A -> B -> A -> B`) on the same quiet machine to cancel thermal throttling and OS drift; report **median + IQR / min-max**, not cherry-picked single runs.
   - **Physical Ceiling (`explain-the-number`)**: estimate the hardware/algorithmic theoretical bound (bandwidth, syscalls, allocations, O(N)) so you know whether 10x headroom exists before micro-tuning.
   - **Profiler Forensics**: for CPU/memory/trace bottlenecks, capture a real profile (`cpuprofile`, `spindump`, Chrome trace, heap snapshot); for large trace dumps, import sampled events into a temporary `/tmp` SQLite table and query hot stacks/leak chains with SQL rather than guessing from raw JSON.
   - **Baseline Logged**: capture and log pre-change Baseline to `decisions.tsv` before touching code.
2. **One-Change Scientific Loop**:
   - Follow cheapest-first order: eliminate unnecessary work -> reduce algorithmic/IO amplification -> tune hot path.
   - Each iteration makes **one smallest hypothesis-driven change** via `Coder` -> runs regression gate + frozen ABAB benchmark via `Verifier` -> **keep & commit** only if metric improved beyond noise AND regression gate is green; **revert immediately** if flat, regressed, or noisy.
   - Log every kept/reverted experiment in `decisions.tsv` (`metric before -> after`). Stop when target is met or 3 consecutive experiments fail to improve (plateau -> pivot premise or halt and report).

## 3. Deterministic Verification Loop (`loop`)
Triggered when the user wants an iterative repair/convergence loop against a concrete pass/fail command (e.g., `/zee loop --verify "npm test"` — fixing cascading type errors, lint waves, migration failures, or flaky suites without a continuous metric).
1. Lock the exact `--verify <cmd>`, max iteration cap (default `8`), and `denyCommands`. Record initial failure baseline in `decisions.tsv`.
2. Each iteration: inspect the exact failing output -> dispatch bounded `Coder` fix -> run `Verifier` on the exact `--verify` command -> commit only if failure count strictly decreases or exits 0 (revert regressions immediately).
3. **Stagnancy Stop**: if the exact same failure signature repeats 2 rounds in a row, stop patching and escalate via the 4-Level Failure Ladder (`Scrap` or `heavy` tier) instead of spinning.
4. Once `--verify` exits 0 cleanly, run 1 cross-family `Reviewer` pass over the consolidated diff before reporting completion in Chinese.

## 4. Throwaway Technical Prototype (`prototype`)
Triggered to settle an empirical technical fork (e.g., library A vs B, protocol/API feasibility, perf behavior) instead of guessing or asking the user.
1. Isolate throwaway code on branch `prototype/<slug>` or inside `<busDir>/artifacts/proto/` — never mix prototype hacks into production branches.
2. Run the minimal experiment to observe real behavior/output/timing and record the measured result in `<busDir>/artifacts/proto-result.md`.
3. Clean up throwaway branch/files after the decision is locked, then proceed with clean production design.

## 5. Parallel Read-Only Sweep (`sweep`)
Triggered when auditing, migrating-analysis, or checking a pattern across many independent files/modules (e.g., ≥5 disjoint slices) to produce one consolidated report.
1. Frame the exact **Done Predicate**, slice boundaries, and required evidence format (`PASS | ISSUES | BLOCKED` + `file:line` / command output + target SHA).
2. Fan out parallel read-only workers across disjoint slices:
   - **On Google Antigravity (`≥5` slices)**: prefer native **`run_workflow`** (`parallel(slices, lambda s: agent(..., type_name="zee-scout", model="flash", workspace="inherit", schema={...}))`) for schema-validated JSON results in one run.
   - **On Pi / T3 / other harnesses**: fan out parallel read-only `Scout` workers (cap concurrency conservatively for CPU/rate limits).
3. **Aggregate Strictly**: drop any worker result missing required evidence or SHA (respawn once max; record a gap after 2nd miss — a gap never counts as `PASS`). Never dump raw worker logs; deliver one consolidated Chinese summary table + proven issue one-liners + gaps.
