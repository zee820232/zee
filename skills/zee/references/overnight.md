# Overnight / Unattended Mode (`night` v4)

Loaded when the user activates `night` / "going to bed" / "过夜" / "跑完为止" on either a 0→1 milestone roadmap or a 1→100 multi-unit program. **All pre-launch checklists, pause notices, and Morning Reports shown to the user MUST be in Simplified Chinese (简体中文).**

## 1. Pre-Launch Trust Gate (Mandatory Before Unattended Run)
Do not start unattended execution until all 5 invariants are locked (confirm with user in Chinese):
1. **Falsifiable Done Predicate**: concrete machine-checkable exit criteria ("run for 4 hours" is never a valid predicate).
2. **Open Decisions Cleared**: run final `grilling` round in Chinese on any genuine product/preference forks before the user leaves.
3. **Isolated Integration Branch**: switch/create branch `zee/<slug>` (never commit unattended work directly onto `main`/trunk).
4. **Domain Redlines Verified**: confirm `denyCommands` in `zee.project.json` blocks `--live`, signing, deploys, and secrets.
5. **Hard Budget Caps Recorded in `state.json`**: default `maxUnits: 12`, `maxDelegates: 40`, `maxHeavyEscalations: 6`, `maxConsecutiveParked: 2`, plus **70% cutoff threshold** (`zee-tool.mjs update-state "<busDir>" --budget '{"maxUnits":12,"maxDelegates":40,"maxHeavyEscalations":6,"maxConsecutiveParked":2,"cutoffRatio":0.7}'`).

## 2. Unit 0 (Harness, Verify Skill & Baseline) + Unit 1 (Canary)
- **Unit 0**: verify an automated Verification Harness (or `<projectSkillsDir>/verify-<app>/SKILL.md`) exists; if missing, build a minimal runnable verification harness and capture pre-change Baseline (test counts, metrics, or baseline UI screenshots). Log baseline row to `decisions.tsv` and ONLY AFTER Pre-Launch Trust Gate approval transition state to `running` via:
  `zee-tool.mjs update-state "<busDir>" --mode night --status running --conversation-id "<cid>"`
  *(On Antigravity, the bundled `Stop` hook guards ONLY `status === "running"` bound to `<cid>`, so waiting for human approval during `initialized` never triggers premature continuation.)*
- **Unit 1 (Canary)**: run the first vertical slice end-to-end by itself before enabling any parallel fan-out. Confirm atomic worktree checkout (never nest unit branch names under the integration branch ref — e.g. use `zee/night-u1`, not `zee/<slug>/u1`), bus reads, Gate 1 `Verifier` `PASS` -> Gate 2 `Reviewer` `PASS`, and merge work cleanly.

## 3. Execution Loop, 70% Cutoff, UI Visual Gate, Context Hygiene & Idempotency
- Run each DAG unit through **Gate 1 (`Verifier`) `PASS` -> Gate 2 (`Reviewer`)** strictly serially, committing each verified unit onto `zee/<slug>`.
- **Mandatory `uiGlobs` Visual Screenshot Gate (Non-Negotiable)**: whenever a unit diff touches any path matching `.agents/zee.project.json` `uiGlobs` (or UI/HUD/render/screen code), **Gate 1 `Verifier` MUST capture fresh post-change PNG screenshots into `<busDir>/screenshots/`**, and **Gate 2 `Reviewer` AND/OR the Cross-Family Audit Judge MUST open and visually inspect every new PNG** to confirm every newly added UI element is actually drawn and unobstructed (layout unit tests or keyboard-state E2E tests alone NEVER prove pixel visibility!).
- **70% Budget / Wall-Clock Cutoff**: once elapsed time OR `delegatesDispatched` crosses **70%** of the configured budget (or `zee_subagent` emits `[ZEE_BUDGET_CUTOFF]`), STOP opening new units; finish merging verified work, run `cleanup-worktrees --prune-safe`, run the Cross-Family Trail Audit, update `state.json`, and deliver the Chinese Morning Report before hitting wall-clock timeout!
- Record every meaningful decision/unit/pivot/revert atomically:
  - `node "<zeeDir>/scripts/zee-tool.mjs" update-state "<busDir>" --status running --resume-next "<nextUnit>" --unit-upsert '{"id":"U1","status":"done","sha":"..."}' --inc-delegates 1`
  - `node "<zeeDir>/scripts/zee-tool.mjs" log-decision --bus "<busDir>" --unit "<unit>" --phase "<phase>" --decision "<decision>" --why "<why>" --evidence "<evidence>" --result "<result>"`
- **Decision Self-Correction (`phase=supersede`)**: never silently edit or delete old rows in `decisions.tsv`. If an earlier decision is overturned, append a new row with `phase=supersede` naming the superseded decision and concrete counter-evidence.
- **Context-Rot Defense**: keep main thread lean — read only ≤30-line worker receipts, never full logs. On every wakeup or post-compaction resume, re-read `references/overnight.md`, `<busDir>/state.json`, and the last 10 lines of `decisions.tsv`.
- **Turn-End Invariant**: never end an unattended turn silently without either (a) active async delegates running, (b) a one-shot morning-report fallback armed via `SCHEDULE` (on AGY also protected by the bundled `Stop` hook), or (c) `state.json` updated to `completed`/`paused` and the final Chinese Morning Report delivered.

## 4. Pause-Safely & Session-Pickup
- **Pause-Safely** (on `pause`, quota exhaustion, irreversible gate, 70% cutoff, or budget/plateau fuse): cancel in-flight delegates, save any dirty work as `wip: pause <unit>` commit (never discard verified commits), run `zee-tool.mjs update-state "<busDir>" --status paused --resume-next "<unit>"`, and log a `phase=pause` row in `decisions.tsv`.
- **Session-Pickup** (resuming an existing bus): first run `node "<zeeDir>/scripts/zee-tool.mjs" list-runs "<repoRoot>"` to locate the exact paused/active `<busDir>` without guessing; then read `state.json`, `git log`, and `decisions.tsv`, append a `phase=start` marker row naming the resume point, treat prior verified commits as authoritative, and continue from `resumeNext`.

## 5. Cross-Family Trail Audit & Morning Report (in Chinese)
Before concluding `night` mode:
1. Spawn 1 independent **Audit Judge** from a `family` that wrote zero code during the run. It inspects `decisions.tsv`, `git log`, test logs, and screenshots to verify every logged `evidence` pointer resolves and flags skipped checks, relaxed assertions, or risky shortcuts.
2. Update `state.json` (`--status completed` or `paused`), mirror `morning_report.md` + `decisions.tsv` into AGY Brain Artifacts when on AGY (`RequestFeedback: false`), and deliver a concise **中文晨报** covering:
   - **目标与最终验收状态**（已达成 / 部分完成 / 已安全暂停）
   - **已落盘单元**（Commit SHA + 改动前后验证证据）
   - **搁置或丢弃的尝试**（停止原因与精确阻断点）
   - **异构终审重点提示（Attention）**：标明审计模型 + 标记项或「无异常」
   - **待你拍板的事项**（每项用 ≤30 字决策卡概括：问题 + 推荐选项 + 关键风险，做到单回合可拍板）
   - **复盘与防再犯建议（Retro）**（基于 `decisions.tsv` 失败/重试记录给出 1–3 条固化措施，严格遵循四级固化阶梯：**代码/类型/自动化测试/Hook > 技能或项目契约文档 > 纯记忆提示**）

## 6. Five-Item Pre-Night Canary Checklist (Run Once on a New Machine/Repo)
1. Delegate worker respects `worker.md` (no nested subagents, no ambient playbook hijack).
2. Atomic worktree worker reads/writes absolute Out-of-Tree Bus path cleanly without touching Desktop.
3. Gate 1 `Verifier` & Gate 2 `Reviewer` check out Coder's detached `PINNED_SHA` from shared git object store (and cannot `edit` repo source).
4. Explicit target `options` / `thinkingLevel` take effect (no silent `thinking: max` inheritance).
5. Verifier starts UI on isolated free port, captures PNG, closes tab (if used), and kills only its own process.
