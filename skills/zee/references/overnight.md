# Overnight / Unattended Mode (`night` v4.2)

Loaded when the user activates `night` / "going to bed" / "过夜" / "跑完为止" on either a 0→1 milestone roadmap or a 1→100 multi-unit program. **All pre-launch checklists, pause notices, and Morning Reports shown to the user MUST be in Simplified Chinese (简体中文).** *(Runtime write locks, `denyCommands`, and AGY `Stop` continuation are enforced physically by `guard-core.mjs` / `agy-guard.mjs` / `worker-guard.ts`.)*

## 1. Pre-Launch Trust Gate & Readiness (Mandatory Before Unattended Run)
Do not start unattended execution until all 5 invariants are locked (confirm with user in Chinese):
1. **Falsifiable Done Predicate**: concrete machine-checkable exit criteria ("run for 4 hours" is never a valid predicate).
2. **Open Decisions Cleared**: run final `grilling` round in Chinese on any genuine product/preference forks before the user leaves.
3. **Isolated Integration Branch**: switch/create branch `zee/<slug>` (never commit unattended work directly onto `main`/trunk).
4. **Domain Redlines & Trust Readiness Verified**: run `node "<zeeDir>/scripts/zee-tool.mjs" readiness "<repoRoot>"` to verify `denyCommands`, `verifySkill`, and clamp configured `trustLevel` (`T1`/`T2`/`T3`) to `effectiveTrustLevel`.
5. **Hard Budget Caps Recorded in `state.json`**: default `maxUnits: 12`, `maxDelegates: 40`, `maxHeavyEscalations: 6`, `maxConsecutiveParked: 2`, plus **70% cutoff threshold** (`zee-tool.mjs update-state "<busDir>" --budget '{"maxUnits":12,"maxDelegates":40,"maxHeavyEscalations":6,"maxConsecutiveParked":2,"cutoffRatio":0.7}'`).

## 2. Unit 0 (Harness, Verify Skill & Baseline) + Unit 1 (Canary)
- **Unit 0**: verify `<projectSkillsDir>/verify-<app>/SKILL.md` (and `scripts/verify-ctl.*`) exists; if missing, build a minimal runnable verification harness and capture pre-change Baseline. Log baseline row to `decisions.tsv` and ONLY AFTER Pre-Launch Trust Gate approval transition state to `running`:
  `zee-tool.mjs update-state "<busDir>" --mode night --status running --conversation-id "<cid>"`
- **Unit 1 (Canary)**: run the first vertical slice end-to-end by itself before enabling parallel fan-out (never nest unit branch names under the integration branch ref — use `zee/night-u1`, not `zee/<slug>/u1`). Confirm worktree checkout, bus reads, Gate 1 `Verifier` `PASS` -> Gate 2 `Reviewer` `PASS`, and merge cleanly.

## 3. Execution Loop, Trust Ladder (`T1`/`T2`/`T3`), 70% Cutoff & Idempotency
- **Gate Progression by Effective `trustLevel`** (`readiness` clamped):
  - **`T1` (default)**: strict serial **Gate 1 (`Verifier`) `PASS` -> Gate 2 (`Reviewer`)** per unit onto `zee/<slug>` (if `reviewers[0]` hits 429/5xx or its `backup` matches `authorFamily`, continue down `reviewers[1..N]` to preserve cross-family coverage).
  - **`T2`**: non-`riskPaths`, non-UI two-way-door units merge onto `zee/<slug>` after Gate 1 (`verify-<app>` `PASS`), with cross-family `Reviewer` running batch sampling at milestone close (`riskPaths`, UI, or `GATE_CHANGE_RATIONALE` stays strict Gate 1 -> Gate 2).
  - **`T3`**: high-trust autopilot on `zee/<slug>` with Gate 1 + `--fuzz` + post-merge morning sampling + zero-code cross-family `Audit Judge` (`riskPaths` / `GATE_CHANGE_RATIONALE` still stays strict).
- **Mandatory `uiGlobs` Visual Screenshot Gate (Non-Negotiable)**: whenever a unit diff touches `uiGlobs` (or UI/HUD/render code), Gate 1 `Verifier` MUST capture fresh PNGs into `<busDir>/screenshots/` (never repo scratch), and Gate 2 `Reviewer` / `Audit Judge` MUST open and visually inspect every new PNG.
- **70% Cutoff & Idempotent Delegate Accounting**: once elapsed time or `delegatesDispatched` reaches **70%** (or Pi `zee_subagent` emits `[ZEE_BUDGET_CUTOFF]`), STOP opening new units, finish integrating verified work, run `cleanup-worktrees --prune-safe`, run the Cross-Family Trail Audit, and deliver the Chinese Morning Report.
  - **No 2x Double-Counting**: on Pi, `zee_subagent` **auto-records** `delegatesDispatched` (deduplicated by `toolCallId`). When calling `update-state` manually alongside Pi or on non-Pi harnesses, pass `--delegate-id <id>` (never pass blind `--inc-delegates` on Pi after `zee_subagent`)!
- **Decision Trail & Gardening Queue**:
  - `node "<zeeDir>/scripts/zee-tool.mjs" log-decision --bus "<busDir>" --unit "<unit>" --phase "<phase>" --decision "<decision>" --why "<why>" --evidence "<evidence>" --result "<result>"`
  - Append overturned decisions with `phase=supersede` (never edit old rows). Persist non-blocking `P2` smells / missing seams via `zee-tool.mjs queue-finding`.
- **Context-Rot Defense**: read only ≤30-line worker receipts, never full logs. On every wakeup or post-compaction resume, re-read `references/overnight.md`, `<busDir>/state.json`, and the last 10 lines of `decisions.tsv`.
- **Turn-End Invariant**: never end an unattended turn silently without either (a) active async delegates running, (b) a one-shot fallback armed via `SCHEDULE`, or (c) `state.json` updated to `completed`/`paused` and the Chinese Morning Report delivered.

## 4. Pause-Safely & Session-Pickup
- **Pause-Safely** (on `pause`, quota exhaustion, irreversible gate, 70% cutoff, or plateau fuse): cancel active delegates, commit any dirty WIP as `wip: pause <unit>` (never discard verified commits), update state (`--status paused --resume-next "<unit>"`), and log `phase=pause` in `decisions.tsv`.
- **Session-Pickup**: run `node "<zeeDir>/scripts/zee-tool.mjs" list-runs "<repoRoot>"` to locate the exact paused/active `<busDir>`, inspect `state.json`, `git log`, and `decisions.tsv`, log `phase=start`, and resume from `resumeNext`.

## 5. Cross-Family Trail Audit & Morning Report (in Chinese)
Before concluding `night` mode:
1. Spawn 1 independent **Audit Judge** from a `family` that wrote zero code during the run to inspect `decisions.tsv`, `git log`, test logs, and screenshots (verifying every `evidence` pointer resolves and flagging skipped checks or relaxed assertions).
2. Update `state.json` (`--status completed` or `paused`), mirror `morning_report.md` + `decisions.tsv` into AGY Brain Artifacts when on AGY (`RequestFeedback: false`), and deliver a concise **中文晨报** covering:
   - **目标与最终验收状态**（已达成 / 部分完成 / 已安全暂停）
   - **已落盘单元**（Commit SHA + 改动前后验证证据）
   - **搁置或丢弃的尝试**（停止原因与精确阻断点）
   - **异构终审重点提示（Attention）**：标明审计模型 + 标记项或「无异常」
   - **待你拍板的事项**（≤30 字决策卡：问题 + 推荐选项 + 关键风险）
   - **复盘与防再犯建议（Retro）**（基于 `decisions.tsv` 与 `.agents/gardening-queue.jsonl` 给出 1–3 条固化措施）

## 6. Low-Risk Scheduled Outer-Loop Routine (Read-Only Cron Recipe)
For continuous repo health outside active coding runs, wire host recurring scheduling (`schedule_task` on T3 Code, or `schedule(CronExpression: "0 3 * * *", IsDaemon: true)` on Antigravity) strictly as a **read-only outer-loop check** (never mutating product source unattended):
1. Run `node "<zeeDir>/scripts/zee-tool.mjs" list-findings --repo "<repoRoot>"` to inspect `systemic: true` (`count >= 3`) gardening clusters.
2. Run read-only `/zee-verify maintain` (or `verify-ctl doctor` + `verify-ctl snapshot` in `/tmp/zee-verify-*` without touching repo files) to catch app regressions or doc drift early.
3. Emit one concise Chinese morning alert/triage card (ready for `/zee triage` or `/zee-plan`) only when regressions or systemic clusters appear.

## 7. Five-Item Pre-Night Canary Checklist (New Machine/Repo)
1. Delegate worker honors `worker.md` (no nested subagents, no ambient playbook hijack).
2. Atomic worktree worker resolves `<busDir>` cleanly without polluting Desktop or repo scratch.
3. Gate 1 `Verifier` & Gate 2 `Reviewer` check out detached `PINNED_SHA` from shared git object store (`edit` stripped).
4. Explicit target `options` / `thinkingLevel` take effect (no silent `thinking: max` inheritance).
5. `verify-ctl` / `Verifier` isolates outputs in `/tmp/zee-verify-*` or `<busDir>`, closes spawned tabs/ports, and kills only its own process.
