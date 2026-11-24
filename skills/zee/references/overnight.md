# Overnight / Unattended Mode (`night`)

Loaded when the user activates `night` / "going to bed" / "过夜" / "跑完为止" on either a 0→1 milestone roadmap or a 1→100 multi-unit program. **All pre-launch checklists, pause notices, and Morning Reports shown to the user MUST be in Simplified Chinese (简体中文).**

## 1. Pre-Launch Trust Gate (Mandatory Before Unattended Run)
Do not start unattended execution until all 5 invariants are locked (confirm with user in Chinese):
1. **Falsifiable Done Predicate**: concrete machine-checkable exit criteria ("run for 4 hours" is never a valid predicate).
2. **Open Decisions Cleared**: run final `grilling` round in Chinese on any genuine product/preference forks before the user leaves.
3. **Isolated Integration Branch**: switch/create branch `zee/<slug>` (never commit unattended work directly onto `main`/trunk).
4. **Domain Redlines Verified**: confirm `denyCommands` in `zee.project.json` blocks `--live`, signing, deploys, and secrets.
5. **Hard Budget Caps Recorded in `state.json`**: default `maxUnits: 12`, `maxDelegates: 40`, `maxHeavyEscalations: 6`, `maxConsecutiveParked: 2`.

## 2. Unit 0 (Harness & Baseline) + Unit 1 (Canary)
- **Unit 0**: verify an automated Verification Harness exists; if missing, build minimal runnable verification script and capture pre-change Baseline (test counts, metrics, or baseline UI screenshots). Log baseline row to `decisions.tsv`.
- **Unit 1 (Canary)**: run the first vertical slice end-to-end by itself before enabling any parallel fan-out. Confirm worktree checkout, bus reads, Verifier gates, and merge work cleanly.

## 3. Execution Loop, Context Hygiene & Idempotency
- Run each DAG unit through L1/L2 (L3 only for flagged high-risk units), committing each verified unit onto `zee/<slug>`.
- Append one row per meaningful decision/unit/pivot/revert via:
  `node "<zeeDir>/scripts/zee-tool.mjs" log-decision "<busDir>" "<unit>" "<phase>" "<decision>" "<why>" "<evidence>" "<result>"`
- **Context-Rot Defense**: keep main thread lean — read only ≤30-line worker receipts, never full logs. On every wakeup or post-compaction resume, re-read `references/overnight.md`, `<busDir>/state.json`, and the last 10 lines of `decisions.tsv`.
- **Idempotent Dispatch**: use deterministic `clientRequestId` (`zee-<slug>-<unit>-<role>-a<attempt>`) when supported by the harness, and record `{ taskId, branch, headSha, attempt, verdict }` atomically in `state.json`.
- **Turn-End Invariant**: never end an unattended turn silently without either (a) active async delegates running, (b) a one-shot morning-report fallback armed via `SCHEDULE` (where supported), or (c) the final Chinese Morning Report delivered.

## 4. Pause-Safely & Session-Pickup
- **Pause-Safely** (on `pause`, quota exhaustion, irreversible gate, or budget/plateau fuse): cancel in-flight delegates, save any dirty work as `wip: pause <unit>` commit (never discard verified commits), update `state.json` (`status: "paused"`, `resumeNext: <unit>`), and log a `pause` row in `decisions.tsv`.
- **Session-Pickup** (resuming an existing bus): first run `node "<zeeDir>/scripts/zee-tool.mjs" list-runs "<repoRoot>"` to locate the exact paused/active `<busDir>` without guessing; then read `state.json`, `git log`, and `decisions.tsv`, append a `phase=start` marker row naming the resume point, treat prior verified commits as authoritative, and continue from `resumeNext`.

## 5. Cross-Family Trail Audit & Morning Report (in Chinese)
Before concluding `night` mode:
1. Spawn 1 independent **Audit Judge** from a `family` that wrote zero code during the run. It inspects `decisions.tsv`, `git log`, test logs, and screenshots to verify every logged `evidence` pointer resolves and flags skipped checks, relaxed assertions, or risky shortcuts.
2. Deliver a concise **中文晨报** covering:
   - **目标与最终验收状态**（已达成 / 部分完成 / 已安全暂停）
   - **已落盘单元**（Commit SHA + 改动前后验证证据）
   - **搁置或丢弃的尝试**（停止原因与精确阻断点）
   - **异构终审重点提示（Attention）**：标明审计模型 + 标记项或「无异常」
   - **待你拍板的事项**（每项附推荐方案、证据与风险）
   - **工程改进建议（Retro）**（1–3 条可固化为 lint / 测试 / CI 的防呆措施）

## 6. Five-Item Pre-Night Canary Checklist (Run Once on a New Machine/Repo)
1. Delegate worker respects `worker.md` (no nested subagents, no ambient playbook hijack).
2. Worktree worker reads/writes absolute Out-of-Tree Bus path cleanly.
3. Reviewer/Verifier checks out Coder's detached `PINNED_SHA` from shared git object store.
4. Explicit target `options` take effect (no silent `thinking: max` inheritance).
5. Verifier starts UI on isolated free port, captures PNG, closes tab (if used), and kills only its own process.
