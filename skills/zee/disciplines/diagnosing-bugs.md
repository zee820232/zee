# Discipline: 6-Phase Tight-Loop Bug Diagnosis (`diagnosing-bugs.md`)

Loaded by `Coder` on Bug Fast-Track and during hard debugging to eliminate blind guessing and shotgun patches.

## 0. Redact First (Mandatory)
Replace secrets, tokens, cookies, API keys, and PII with `<REDACTED>` in every probe log, bus artifact, and receipt.

## Phase 1 · Build a Tight Red Feedback Loop (No Guessing Before Red)
Never edit production code to "try a fix" before observing a deterministic **red reproduction**. Climb the 10-rung ladder from fastest to heaviest until red reproduces reliably:
1. Pure function / unit seam test
2. Module integration test with temp state
3. Isolated CLI / script invocation
4. Local HTTP / RPC replay (`curl` / node fetch)
5. Headless browser E2E (`verify-<app>` / Playwright)
6. Seeded deterministic RNG / fake clock
7. **Frequency amplification** (for flaky / race / timing bugs: loop N=50–200×, tighten timers, or run parallel workers to force reliable failure)
8. Captured payload / trace replay
9. Container / clean-env cold start
10. Instrumented staging/local runtime log capture

## Phase 2 · Minimal Repro Fixture
Shrink the failing input, state, or sequence until removing any remaining piece stops the failure. A minimal repro collapses the hypothesis space.

## Phase 3 · 3–5 Ranked Falsifiable Hypotheses
Before instrumenting or patching, write 3–5 concrete hypotheses ranked by likelihood. Every hypothesis MUST state:
- **Mechanism**: why this code path produces the observed symptom.
- **Falsifiable Prediction**: exact value/log/behavior expected if true vs if false.

## Phase 4 · Tagged Probes (`[DEBUG-xxxx]`)
Insert targeted, low-noise instrumentation tagged with a unique run ID (e.g., `[DEBUG-9a4f]`) to test the top hypothesis first. Narrow to the exact causal line using measured values, not intuition.

## Phase 5 · Fix at Root Cause + Seam Regression + Mutation Proof
- Fix the underlying invariant rather than papering over downstream symptoms.
- Add a permanent regression test at the **highest clean Test Seam** (if no clean Seam exists to test the bug without brittle mocks, explicitly record that as an **architecture finding** in your receipt!).
- Prove the test is real: confirm it fails before the fix (or under a temporary revert) and exits 0 after.

## Phase 6 · Zero-Residue Cleanup
Grep your diff to verify **zero `[DEBUG-xxxx]` probes**, stray temp fixtures, or relaxed assertions remain before committing.
