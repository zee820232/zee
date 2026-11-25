# Core Protocols: Bus, Pinned SHA, Trust Ladder, Arena & Single-Writer (`zee` v4.2)

*(Note: `<zeeDir>` means the absolute directory containing `zee/SKILL.md` in the active harness. All messages shown to the user MUST be in Simplified Chinese. Runtime locks and redlines in `guard-core.mjs` / `worker-guard.ts` / `agy-guard.mjs` enforce write boundaries and `denyCommands` physically.)*

## 1. Three-Tier Configuration, Trust Ladder & Readiness Gate
1. `~/.agents/zee-config.json` — machine-wide canonical role models, families, authorized `backup`s, and `budget` (optional for standalone single-model skills via `resolve-model --allow-standalone`).
2. `<repo>/.agents/zee.project.json` (committable) — project contract:
   ```json
   {
     "testCmds": ["npm test"],
     "buildCmd": "npm run build",
     "lintCmd": "npm run lint",
     "riskPaths": ["src/auth/**", "src/payments/**"],
     "uiGlobs": ["src/ui/**", "src/components/**"],
     "denyCommands": ["--live", "live-session", "deploy --prod"],
     "trustLevel": "T1",
     "pathSkills": [
       { "glob": "src/ui/**", "skill": "verify-app", "roles": ["coder", "ui"] }
     ]
   }
   ```
3. `<repo>/.agents/zee.local.json` (gitignored) — optional machine-local overrides for this repo.

### Autopilot Trust Ladder (`T1` / `T2` / `T3`) & Mechanical `readiness` Clamping
Always check effective trust before scaling autonomy via `node "<zeeDir>/scripts/zee-tool.mjs" readiness "<repoRoot>"`:
- `readiness` inspects `projectJson`, `testCmds`, `lintCmd`, `denyCommands`, `riskPaths`, `verifySkill` (`<projectSkillsDir>/verify-*/SKILL.md`), and `verifyCtl` (`scripts/verify-ctl.*`), clamping configured `trustLevel` down to `effectiveTrustLevel`:
  - **`T1` (Default)**: **Strict Serial Gate 1 -> Gate 2** per slice (`Verifier` `PASS` -> cross-family `Reviewer` `PASS` -> merge).
  - **`T2` (Two-Way-Door Velocity)**: requires `projectJson && testCmds && lintCmd && denyCommands && verifySkill`. Non-`riskPaths`, non-UI two-way-door slices merge onto integration branch `zee/<slug>` after Gate 1 (`verify-<app>` `PASS`), with cross-family `Reviewer` running **batch sampling at milestone close**. Any slice touching `riskPaths`, UI screenshots, or declaring `GATE_CHANGE_RATIONALE` **stays strict Gate 1 -> Gate 2 per slice**.
  - **`T3` (High-Trust Autopilot)**: requires `T2 && verifyCtl && riskPaths`. Runs on isolated branch `zee/<slug>` with Gate 1 + `--fuzz` + post-merge morning sampling + zero-code cross-family `Audit Judge` (`riskPaths` / `GATE_CHANGE_RATIONALE` still require strict Gate 1 -> Gate 2, and one-way doors always pause for human approval).

## 2. Out-of-Tree Run Bus (`~/.local/state/zee/runs/<repo-key>/<slug>/`)
Create via `node "<zeeDir>/scripts/zee-tool.mjs" init-run "<repoRoot>" "<slug>"`.
- **Single-Writer Ownership & Idempotent Delegate Accounting**:
  - Orchestrator is the sole writer of `state.json` and `decisions.tsv` (`zee-tool.mjs log-decision`).
  - **Preventing 2x Delegate Double-Counting**: on Pi, `zee_subagent` **automatically records** `delegatesDispatched` (deduplicated by `toolCallId`). When Orchestrator calls `zee-tool.mjs update-state` manually alongside Pi `zee_subagent` OR on non-Pi harnesses, pass `--delegate-id <id>` (idempotent via `countedDelegateIds`, retaining last 200 IDs) and NEVER combine blind `--inc-delegates` with Pi auto-accounting so budget / 70% cutoff never counts 2x!
  - Parallel workers write ONLY to slot-named bus artifacts (`artifacts/sketch-<id>.md`, `artifacts/review-<family>-r<N>.md`, `artifacts/verify-r<N>.log`, `screenshots/<name>.png`) and return a ≤30-line receipt.
  - **Repo-Wide Shared Index Files & Gardening Queue**: `CHANGELOG.md`, `README.md`, and global test/barrel registries belong exclusively to the Orchestrator/integration writer. Non-blocking `P2` smells, missing Test Seams, and repeated workarounds go into `<repo>/.agents/gardening-queue.jsonl` via `zee-tool.mjs queue-finding` instead of mid-task scope creep.
- **Promotion**: if the repo uses `.scratch/<slug>/`, only the Orchestrator copies finalized `SPEC.md` or `plan.md` there at milestone close.

## 3. Universal Worker Brief Envelope
Start every delegated `SPAWN` prompt with this exact English header (the `[zee-worker]` and `You are already running as a delegate` markers activate worker isolation in `guard-core` / `worker-guard.ts` / `agy-guard.mjs`):
```text
[zee-worker] Read <zeeDir>/worker.md before anything else.
You are already running as a delegate. Execute directly without subagents or any competing orchestrator.
This brief is the whole bar: use the repository's existing language and exact gate commands below.
Leave shared index files (CHANGELOG.md/README.md) untouched unless explicitly assigned.
Role: <zeeDir>/roles/<role>.md | Bus: <abs-busDir> | Base/Pinned SHA: <sha> | Return: ≤30-line receipt
```
Follow the header with: **Goal**, **Relevant Bus Paths**, **Exact Gate Commands**, **`denyCommands`**, **Assigned File Lane / Scope**, **Matched `pathSkills`** (from `zee-tool.mjs match-skills`), (on AGY) **Parent Conversation ID**, and (on retry) **Prior Directives + Findings + Root-Cause Requirement**.

## 4. Pinned SHA, Atomic Worktrees & Sequential Grafting
1. **Atomic Worktree Creation**: on Pi pass `worktree: { repoRoot, slug, lane, baseRef, branch?, autoCleanup? }` to `zee_subagent` (creates under `~/.local/state/zee/runs/<repo-key>/<slug>/worktrees/<lane>` before spawning). On AGY use `Workspace: "share"`. On standalone harnesses use `zee-tool.mjs worktree-create`.
2. Every writing worker (`Coder` / `UI`) commits its changes on its worktree branch and returns `BRANCH` + `HEAD_SHA`.
3. **Gate Progression by `trustLevel`**: under `T1` (default) or any `riskPaths` / UI / `GATE_CHANGE_RATIONALE` slice, run `Verifier` (Gate 1) detached on `<HEAD_SHA>` first, then cross-family `Reviewer`(s) (Gate 2) strictly after `VERDICT: PASS`. Under verified `T2`/`T3` non-risk slices, Gate 1 (`verify-<app>` `PASS`, plus `--fuzz` on `T3`) unlocks integration onto `zee/<slug>` with cross-family batch sampling at milestone close.
4. **Pure-Rebase `git patch-id` Freshness**: if a verified branch is rebased onto updated trunk with zero conflict edits and `git diff <base>..<head> | git patch-id --stable` matches the already-reviewed `PINNED_SHA`, re-run `Verifier` (Gate 1) without redundant Gate 2 re-review.
5. **Sequential Grafting**: verify `git rev-parse <branch>` equals the last `PASS` `PINNED_SHA`, merge one by one (`git merge --no-ff` or `cherry-pick`), run `Verifier` smoke check after each merge, and prune safe worktrees via `zee-tool.mjs cleanup-worktrees "<repoRoot>" --prune-safe`.

## 5. L3 Orthogonal Arena, Cross-Judge & Orchestrator Graft
1. **Frame**: define 3–5 concrete rubric criteria (hidden from candidates) and assign orthogonal optimization axes (`Axis A / B / C` from `roles/architect.md`). Under `eco` budget, one strong model may emit 2 differently constrained sketches instead of 3 vendors.
2. **Fan-Out**: launch 2–3 distinct-family `Architect` candidates in parallel writing to `artifacts/sketch-<id>.md`.
3. **Anonymous Cross-Judge**: spawn 1 read-only `Judge` from a `family` different from the Orchestrator's family (`roles.judge` or `roles.reviewers[0]`). Pass rubric + anonymized candidate paths (`Candidate 1/2/3`). Judge scores criterion-by-criterion and recommends a base — **Judge never merges text**.
4. **Orchestrator Graft**: Orchestrator reads all sketches and the Judge verdict, selects the strongest base, and folds 1–2 high-value ideas from losing candidates into `<busDir>/plan.md`. If candidates diverge wildly, reframe with the user in Chinese.

## 6. Optional Delivery, PR Babysit & Review Triage (Only When Requested)
Execute only when asked to open or shepherd a PR (after confirming the push one-way door):
1. **Commit Hygiene**: ensure clean, logical commits on the feature branch (no stray logs, no force-push to shared branches).
2. **Push & Open PR**: push and open a concise Ketchup-style PR (`gh pr create`, ≤40 lines, see `disciplines/phase-boundaries.md`) covering Visual Summary, Evidence (screenshots + exact commands + Pinned SHA), Merge Danger, and Cross-Family Review Verdict.
3. **CI Watch & Comment 3-Way Triage**: watch checks natively (`watch_pull_request` on T3), separate base CI flakes from branch regressions, triage every comment into **`fix`** / **`dismiss`** (evidence reply) / **`ask`** (Chinese user decision), and apply `git patch-id --stable` freshness on clean rebases.
