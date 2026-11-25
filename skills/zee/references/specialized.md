# Specialized Modes: Investigate, Perf/Hillclimb, Loop, Prototype, Sweep, Verify, Recall & Triage (`specialized.md` v4.2)

Loaded only when the task matches one of these specialized workflows. **All reports, tables, briefs, and recommendations shown to the user MUST be in Simplified Chinese (简体中文).**

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
   - **Profiler Forensics**: capture a real profile (`cpuprofile`, `spindump`, Chrome trace, heap snapshot); for large trace dumps, import sampled events into a temporary `/tmp/zee-*` SQLite table and query hot stacks/leak chains with SQL rather than guessing from raw JSON.
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

## 4. Dual-Mode Throwaway Prototype (`prototype`)
Triggered to settle an empirical technical, logic, or UI fork instead of guessing or debating abstractly:
1. **Logic / State-Machine Prototype**: emit a zero-dependency, single-file double-clickable pure HTML sandbox (`<busDir>/artifacts/proto/<slug>.html`) with guided scenario tabs where the core transition logic lives as clean pure functions directly portable into production.
2. **UI / Layout Prototype**: prefer embedding genuinely distinct structural variants (never cosmetic recolors) on the real host page via `?variant=a|b|c` + a minimal floating switcher bar so stakeholders judge in real layout context.
3. Isolate throwaway code on branch `prototype/<slug>` (or `<busDir>/artifacts/proto/`), record measured observations in `<busDir>/artifacts/proto-result.md`, archive or clean up throwaway edits cleanly before merging into production branches.

## 5. Parallel Read-Only Sweep (`sweep`)
Triggered when auditing, migrating-analysis, or checking a pattern across many independent files/modules (e.g., ≥5 disjoint slices) to produce one consolidated report.
1. Frame the exact **Done Predicate**, slice boundaries, and required evidence format (`PASS | ISSUES | BLOCKED` + `file:line` / command output + target SHA).
2. Fan out parallel read-only workers across disjoint slices:
   - **On Google Antigravity (`≥5` slices)**: prefer native **`run_workflow`** (`parallel(slices, lambda s: agent(..., type_name="zee-scout", model="flash", workspace="inherit", schema={...}))`) for schema-validated JSON results in one run.
   - **On Pi / T3 / other harnesses**: fan out parallel read-only `Scout` workers (cap concurrency conservatively for CPU/rate limits).
3. **Aggregate Strictly**: drop any worker result missing required evidence or SHA (respawn once max; record a gap after 2nd miss — a gap never counts as `PASS`). Never dump raw worker logs; deliver one consolidated Chinese summary table + proven issue one-liners + gaps.

## 6. Project Verification Skill Bootstrap & Anti-Rot Maintenance (`verify-init` / `verify-maintain`)
Load `<zeeDir>/disciplines/verification-skill.md`:
- **`verify-init`**: interview the repo (`Surface`, `Launch`, `Doctor`, `Drive`, `Evidence`, `Cleanup`), generate `<projectSkillsDir>/verify-<app>/SKILL.md` + `scripts/verify-ctl.(mjs|py|sh)` + `features/`, and **prove it live end-to-end on 1 real feature** (with zero repo scratch & confirming evidence survives cleanup) before declaring done.
- **`verify-maintain`**: run index hygiene -> parallel read-only `Scout` source wave per feature -> mandatory serial live pass (plus `--fuzz` if requested) holding all 3 invariants -> strict triage (**doc drift** / **harness gap** / **product regression** — never mask a product bug by weakening docs).

## 7. Historical Context Recall (`/zee recall <topic>`)
Triggered by `/zee recall <topic>` (or "以前为什么这么做 / 查一下历史上下文"). Runs **strictly read-only** (works standalone without `~/.agents/zee-config.json` via `resolve-model --allow-standalone`):
1. Run deterministic cross-source transcript & artifact search:
   `node "<zeeDir>/scripts/zee-tool.mjs" mine-transcripts --mode recall --repo "<repoRoot>" --query "<topic>" [--days 14] [--limit 20]`
   *(Searches local AGY/Pi/Claude/Codex session logs, Out-of-Tree Bus `decisions.tsv` / `artifacts/partial-*.md` / `context.md` / `plan.md`, `docs/adr/`, and `.agents/gardening-queue.jsonl` with automatic `<REDACTED>` secret scrubbing.)*
2. Optionally inspect matched `docs/adr/`, `git log -S`, or `context.md`/`plan.md` files cited in the top matches.
3. Synthesize and output a **`<= 40`-line** Simplified Chinese historical context brief (`核心结论 -> 关键历史决策/被否决方案 -> 关联 ADR/总线/文件 -> 当前仍有效的约束`), touching zero repo files.

## 8. Outer-Loop Issue & Finding Triage (`/zee triage`)
Triggered by `/zee triage` (or triaging queued bugs/gardening findings into clean work packages). Runs **read-only** first (supports zero-config standalone):
1. **Verify Repro on `main`**: run `node "<zeeDir>/scripts/zee-tool.mjs" list-findings --repo "<repoRoot>"` (plus `mine-transcripts --mode retro` or user-supplied issues/logs) and dispatch read-only `Scout` verification on current `main` to filter out already-fixed issues, doc drift, and non-reproducible noise.
2. **Cluster Shared Root Cause**: group confirmed reproductions and `gardening-queue.jsonl` findings by shared underlying module, invariant, or missing Test Seam (highlighting `systemic: true` patterns with `count >= 3` first).
3. **Emit Actionable Chief-of-Staff Output**: present a concise Chinese triage table and emit either:
   - a ready-to-run **`/zee-plan` or `/zee-night` execution brief** for the highest-leverage root-cause cluster, OR
   - persisted deferred `P2` entries via `node "<zeeDir>/scripts/zee-tool.mjs" queue-finding --repo "<repoRoot>" --category <cat> --pattern <slug> --summary "<text>" [--file <path>] --source triage`.
