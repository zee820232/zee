# Core Protocols: Bus, Pinned SHA, Arena, Single-Writer & PR (`zee` v4)

*(Note: `<zeeDir>` means the absolute directory containing `zee/SKILL.md` in the active harness. All messages shown to the user MUST be in Simplified Chinese.)*

## 1. Three-Tier Configuration Resolution
1. `~/.agents/zee-config.json` — machine-wide canonical role models, families, authorized `backup`s, and `budget`.
2. `<repo>/.agents/zee.project.json` (committable) — project contract:
   ```json
   {
     "testCmds": ["npm test"],
     "buildCmd": "npm run build",
     "lintCmd": "npm run lint",
     "riskPaths": ["src/auth/**", "src/payments/**"],
     "uiGlobs": ["src/ui/**", "src/components/**"],
     "denyCommands": ["--live", "live-session", "deploy --prod"]
   }
   ```
3. `<repo>/.agents/zee.local.json` (gitignored) — optional machine-local overrides for this repo.

## 2. Out-of-Tree Run Bus (`~/.local/state/zee/runs/<repo-key>/<slug>/`)
Create via `node "<zeeDir>/scripts/zee-tool.mjs" init-run "<repoRoot>" "<slug>"`.
- **Why outside the repo**: uncommitted files inside `<repo>/.scratch/` are not copied into `isolation: "worktree"` checkouts and can collide with repo issue trackers.
- **Single-Writer Ownership (Bus + Repo Shared Files)**:
  - Orchestrator is the **sole writer** of `state.json` (always use `node "<zeeDir>/scripts/zee-tool.mjs" update-state "<busDir>" --status ... --resume-next ... --unit-upsert '<json>' --inc-delegates`) and `decisions.tsv` (via `zee-tool.mjs log-decision --bus ... --unit ... --phase ... --decision ... --why ... --evidence ... --result ...`).
  - Parallel workers write only to their own slot-named artifact (`artifacts/sketch-<id>.md`, `artifacts/review-<family>-r<N>.md`, `artifacts/verify-r<N>.log`, `screenshots/<name>.png`) and return a ≤30-line receipt.
  - **Repo-Wide Shared Index Files**: `CHANGELOG.md`, `README.md`, and global test/barrel registries belong exclusively to the Orchestrator or final integration step — parallel `Coder`/`UI` worktrees MUST NOT edit them (eliminates merge conflicts caused by ambient `~/CLAUDE.md` rules).
- **Promotion**: if the repository has its own `.scratch/<slug>/` doc convention, only the Orchestrator copies finalized `SPEC.md` or `plan.md` there at milestone close.

## 3. Universal Worker Brief Envelope
Start every delegated `SPAWN` prompt with this exact English header (ensures cross-model compliance and neutralizes ambient plugin/CLAUDE.md interference):
```text
[zee-worker] Read <zeeDir>/worker.md before anything else.
You are already running as a delegate. Do this directly, no subagents. Do not invoke zee, poteto-mode, or omc.
Do not create implementation_plan.md or request user feedback. This brief is the whole bar.
Use the repository's existing language and the exact gate commands below, not generic templates.
Never ask the user anything. Never edit CHANGELOG.md/README.md unless explicitly assigned.
Never run denyCommands, sign, broadcast, --live, or read secrets/keys.
Role: <zeeDir>/roles/<role>.md | Bus: <abs-busDir> | Base/Pinned SHA: <sha> | Return: ≤30-line receipt
```
Follow the header with: **Goal**, **Relevant Bus Paths**, **Exact Gate Commands**, **`denyCommands`**, **Assigned File Lane / Scope**, (on AGY) **Parent Conversation ID**, and (on retry) **Prior Directives + Findings + Root-Cause Requirement**.

## 4. Pinned SHA, Atomic Worktrees & Sequential Grafting
1. **Atomic Worktree Creation**: on Pi pass `worktree: { repoRoot, slug, lane, baseRef, branch?, autoCleanup? }` directly to `zee_subagent` (creates under `~/.local/state/zee/runs/<repo-key>/<slug>/worktrees/<lane>` before spawning — never pollute Desktop and never race `bash(git worktree add)` against `zee_subagent`). On AGY use `Workspace: "share"`. On standalone harnesses use `zee-tool.mjs worktree-create`.
2. Every writing worker (`Coder` / `UI`) commits its changes on its worktree branch and returns `BRANCH` + `HEAD_SHA`.
3. **Strict Serial Gates**: `Verifier` (Gate 1) checks out `<HEAD_SHA>` detached in a clean worktree first. Only after `VERDICT: PASS` do cross-family `Reviewer`(s) (Gate 2) audit that exact `<HEAD_SHA>`. Every verdict is valid **only** for its `PINNED_SHA`.
4. **Pure-Rebase `git patch-id` Freshness**: if a verified branch is rebased onto updated trunk with zero conflict edits and `git diff <base>..<head> | git patch-id --stable` matches the already-reviewed `PINNED_SHA`, re-run `Verifier` (Gate 1) on the new base without wasting a redundant multi-model Gate 2 re-review.
5. **Sequential Grafting**: before integrating, Orchestrator verifies `git rev-parse <branch>` equals the last `PASS` `PINNED_SHA` and reads the diff directly. Merge multiple verified branches one at a time (`git merge --no-ff` or `cherry-pick`), running `Verifier` smoke check after each merge. Prune safe worktrees via `zee-tool.mjs cleanup-worktrees "<repoRoot>" --prune-safe`.

## 5. L3 Orthogonal Arena, Cross-Judge & Orchestrator Graft
1. **Frame**: define 3–5 concrete rubric criteria (kept hidden from candidates) and assign orthogonal optimization axes (`Axis A / B / C` from `roles/architect.md`). Under `eco` budget, one strong model may emit 2 differently constrained sketches instead of 3 vendors.
2. **Fan-Out**: launch 2–3 distinct-family `Architect` candidates in parallel writing to `artifacts/sketch-<id>.md`.
3. **Anonymous Cross-Judge**: spawn 1 read-only `Judge` from a `family` **different from the Orchestrator's family** (using `roles.judge` if set, else first eligible entry in `roles.reviewers`). Pass rubric + anonymized candidate paths (`Candidate 1/2/3`). Judge scores criterion-by-criterion and recommends a base — **Judge never merges text**.
4. **Orchestrator Graft**: Orchestrator reads all sketches and the Judge verdict, selects the strongest base, and manually folds 1–2 high-value ideas from losing candidates into one coherent `<busDir>/plan.md`. If candidates diverge wildly, reframe with the user in Chinese instead of averaging.

## 6. Optional Delivery, PR Babysit & Review Triage (Only When Requested)
Execute only when the user asks to open or shepherd a PR (or after confirming the push one-way door):
1. **Commit Hygiene**: ensure verified changes are organized into clean, logical commits on the feature branch (no stray debug logs, no unrequested files, no force-push to shared branches).
2. **Push & Open PR**: push the feature branch and open a concise PR (`gh pr create`, ready unless user asked for draft) whose body stays ≤40 lines covering: **Why / Goal**, **Key Changes**, **Verification Receipts** (commands + exit codes + Pinned SHA), **Blast Radius & One-Way Doors**, and **Cross-Family Review Verdict**.
3. **CI Watch & Comment 3-Way Triage**:
   - Use native watch tools (e.g. T3 `watch_pull_request`) when asked to babysit checks; distinguish pre-existing base CI flakes from regressions introduced by the branch.
   - Triage every human or bot PR comment strictly into 3 buckets: **`fix`** (valid bug/defect -> fix, re-verify, reply with commit SHA), **`dismiss`** (false positive or out-of-scope -> reply once with factual code/test evidence), or **`ask`** (genuine product/API trade-off -> surface to user in Chinese).
   - When rebasing a reviewed PR onto latest `main`, apply the `git patch-id --stable` freshness rule above.
