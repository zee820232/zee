# Core Protocols: Bus, Pinned SHA, Arena & Merge (`zee`)

## 1. Three-Tier Configuration Resolution
1. `~/.agents/zee-config.json` — machine-wide canonical role models, families, authorized `backup`s, and `budget`.
2. `<repo>/.agents/zee.project.json` (committable) — project contract:
   ```json
   {
     "testCmds": ["go test ./... -count=1"],
     "buildCmd": "go build ./...",
     "lintCmd": "go vet ./...",
     "riskPaths": ["internal/auth/**", "internal/payments/**"],
     "uiGlobs": ["web/**", "src/components/**"],
     "denyCommands": ["--live", "live-session", "deploy --prod"]
   }
   ```
3. `<repo>/.agents/zee.local.json` (gitignored) — optional machine-local overrides for this repo.

## 2. Out-of-Tree Run Bus (`~/.local/state/zee/runs/<repo-key>/<slug>/`)
Create via `node ~/.agents/skills/zee/scripts/zee-tool.mjs init-run "<repoRoot>" "<slug>"`.
- **Why outside the repo**: uncommitted files inside `<repo>/.scratch/` are not copied into `isolation: "worktree"` checkouts and can collide with repo issue trackers.
- **Single-Writer Ownership**:
  - Orchestrator is the **sole writer** of `state.json` (atomic tmp+rename) and `decisions.tsv` (via `zee-tool.mjs log-decision`).
  - Parallel workers write only to their own slot-named artifact (`artifacts/sketch-<id>.md`, `artifacts/review-<family>-r<N>.md`, `artifacts/verify-r<N>.log`, `screenshots/<name>.png`) and return a ≤30-line receipt.
- **Promotion**: if the repository has its own `.scratch/<slug>/` doc convention, only the Orchestrator copies finalized `SPEC.md` or `plan.md` there at milestone close.

## 3. Universal Worker Brief Envelope
Start every delegated `SPAWN` prompt with this exact English header (ensures cross-model compliance and neutralizes ambient plugin/CLAUDE.md interference):
```text
[zee-worker] Read ~/.agents/skills/zee/worker.md before anything else.
You are already running as a delegate. Do this directly, no subagents. Do not invoke zee, poteto-mode, or omc.
Do not create implementation_plan.md or request user feedback. This brief is the whole bar.
Use the repository's existing language and the exact gate commands below, not generic templates.
Never ask the user anything. Never run denyCommands, sign, broadcast, --live, or read secrets/keys.
Role: <abs-path-to-role.md> | Bus: <abs-busDir> | Base/Pinned SHA: <sha> | Return: ≤30-line receipt
```
Follow the header with: **Goal**, **Relevant Bus Paths**, **Exact Gate Commands**, **`denyCommands`**, **Assigned File Lane / Scope**, and (on retry) **Prior Directives + Findings + Root-Cause Requirement**.

## 4. Pinned SHA & Sequential Grafting (Worktree Integration)
1. Every writing worker (`Coder` / `UI`) commits its changes on its worktree branch and returns `BRANCH` + `HEAD_SHA`.
2. `Verifier` and `Reviewer` run against that exact `HEAD_SHA` (`git checkout --detach <HEAD_SHA>` in a clean worktree). Every verdict is valid **only** for its `PINNED_SHA`.
3. Before integrating, Orchestrator verifies `git rev-parse <branch>` equals the last `PASS` `PINNED_SHA` and reads the diff directly (never rubber-stamp worker summaries).
4. **Sequential Grafting**: merge multiple verified branches one at a time (`git merge --no-ff` or `cherry-pick`) onto the integration branch; run `Verifier` smoke check after each merge before merging the next. Resolve >15-line conflicts via a fresh `Coder` delegate. Prune merged worktree branches on completion.

## 5. L3 Orthogonal Arena, Cross-Judge & Orchestrator Graft
1. **Frame**: define 3–5 concrete rubric criteria (kept hidden from candidates) and assign orthogonal optimization axes (`Axis A / B / C` from `roles/architect.md`). Under `eco` budget, one strong model may emit 2 differently constrained sketches instead of 3 vendors.
2. **Fan-Out**: launch 2–3 distinct-family `Architect` candidates in parallel writing to `artifacts/sketch-<id>.md`.
3. **Anonymous Cross-Judge**: spawn 1 read-only `Judge` from a `family` **different from the Orchestrator's family** (using `roles.judge` if set, else first eligible entry in `roles.reviewers`). Pass rubric + anonymized candidate paths (`Candidate 1/2/3`). Judge scores criterion-by-criterion and recommends a base — **Judge never merges text**.
4. **Orchestrator Graft**: Orchestrator reads all sketches and the Judge verdict, selects the strongest base, and manually folds 1–2 high-value ideas from losing candidates into one coherent `<busDir>/plan.md`. If candidates diverge wildly, the problem is underspecified — return to Intake to reframe instead of averaging.
