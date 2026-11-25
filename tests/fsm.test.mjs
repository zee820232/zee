import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 为 Pi 可选 peerDependencies 注册轻量内存桩（包含 @earendil-works/pi-tui）
module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { url: "zee-fsm-mock://pi-coding-agent", shortCircuit: true };
    }
    if (specifier === "@earendil-works/pi-tui") {
      return { url: "zee-fsm-mock://pi-tui", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "zee-fsm-mock://pi-coding-agent") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const DEFAULT_MAX_BYTES = 32768;
          export const DEFAULT_MAX_LINES = 500;
          export function copyToClipboard(text) {
            globalThis.__zeeFsmMockClipboard = String(text ?? "");
          }
          export function isToolCallEventType(name, evt) {
            return Boolean(evt && evt.toolName === name);
          }
          export function truncateHead(text, opts = {}) {
            return { truncated: false, content: String(text || ""), totalBytes: 0, outputBytes: 0 };
          }
        `,
      };
    }
    if (url === "zee-fsm-mock://pi-tui") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const Key = {
            ctrlAlt: (k) => "ctrl+alt+" + String(k).toLowerCase(),
            ctrl: (k) => "ctrl+" + String(k).toLowerCase(),
            shift: (k) => "shift+" + String(k).toLowerCase(),
            f2: "f2",
            escape: "escape",
            tab: "tab",
            left: "left",
            right: "right",
            up: "up",
            down: "down",
            enter: "enter",
            space: "space",
            backspace: "backspace",
          };
          export function matchesKey(data, key) {
            if (data === key) return true;
            const aliases = {
              escape: ["\\x1b"],
              tab: ["\\t"],
              "shift+tab": ["\\x1b[Z"],
              left: ["\\x1b[D"],
              right: ["\\x1b[C"],
              up: ["\\x1b[A"],
              down: ["\\x1b[B"],
              enter: ["\\r", "\\n"],
              space: [" "],
              backspace: ["\\x7f", "\\b"],
              "ctrl+c": ["\\x03"],
              f2: ["\\x1bOQ", "\\x1b[12~"],
              "ctrl+alt+h": ["\\x1b\\x08"],
            }[key];
            return Boolean(aliases && aliases.includes(data));
          }
          function charDisplayWidth(cp) {
            if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
            if (
              (cp >= 0x1100 && cp <= 0x115f) ||
              (cp >= 0x2e80 && cp <= 0xa4cf) ||
              (cp >= 0xac00 && cp <= 0xd7a3) ||
              (cp >= 0xf900 && cp <= 0xfaff) ||
              (cp >= 0xfe10 && cp <= 0xfe6f) ||
              (cp >= 0xff00 && cp <= 0xff60) ||
              (cp >= 0x1f000 && cp <= 0x1fbff)
            ) {
              return 2;
            }
            return 1;
          }
          export function visibleWidth(str) {
            const plain = String(str ?? "").replace(/\\x1b\\[[0-9;]*m/g, "");
            let w = 0;
            for (const ch of plain) {
              w += charDisplayWidth(ch.codePointAt(0) ?? 0);
            }
            return w;
          }
          export function truncateToWidth(str, maxWidth, ellipsis = "…") {
            if (maxWidth <= 0) return "";
            const s = String(str ?? "");
            if (visibleWidth(s) <= maxWidth) return s;
            const ellW = visibleWidth(ellipsis);
            const target = Math.max(0, maxWidth - ellW);
            const plain = s.replace(/\\x1b\\[[0-9;]*m/g, "");
            let out = "";
            let w = 0;
            for (const ch of plain) {
              const cw = charDisplayWidth(ch.codePointAt(0) ?? 0);
              if (w + cw > target) break;
              out += ch;
              w += cw;
            }
            return out + (ellW <= maxWidth ? ellipsis : "");
          }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const fsm = await import(pathToFileURL(path.join(REPO_ROOT, "pi-extension", "fsm.ts")).href);
const busSync = await import(pathToFileURL(path.join(REPO_ROOT, "pi-extension", "bus-sync.ts")).href);
const hubUi = await import(pathToFileURL(path.join(REPO_ROOT, "pi-extension", "hub-ui.ts")).href);
const { visibleWidth, Key } = await import("@earendil-works/pi-tui");

test("fsm.ts 纯净性：零 Pi 运行时 / TUI / Node fs 依赖，并完整声明 14 个 Workflow 与 9 个 WorkerLane 状态", () => {
  const fsmSource = fs.readFileSync(path.join(REPO_ROOT, "pi-extension", "fsm.ts"), "utf8");
  assert.equal(/@earendil-works\//.test(fsmSource), false, "fsm.ts 不得导入 Pi 运行时或 TUI");
  assert.equal(/node:(fs|path|os|child_process)/.test(fsmSource), false, "fsm.ts 不得导入 Node I/O 模块");

  assert.deepEqual(fsm.WORKFLOW_PHASES, [
    "IDLE",
    "PREFLIGHT",
    "SCOUTING",
    "PLANNING",
    "INIT_DESIGN",
    "AWAITING_APPROVAL",
    "EXECUTING",
    "VERIFYING",
    "REVIEWING",
    "MERGING",
    "CUTOFF_CLOSING",
    "COMPLETED",
    "PAUSED",
    "BLOCKED",
  ]);
  assert.equal(fsm.WORKFLOW_PHASES.length, 14);

  assert.deepEqual(fsm.WORKER_LANE_PHASES, [
    "QUEUED",
    "PREPARING_WT",
    "RUNNING",
    "STALLED_WARN",
    "COMPLETED",
    "PARTIAL_SALVAGED",
    "ROLE_VIOLATION",
    "FAILED",
    "ABORTED",
  ]);
  assert.equal(fsm.WORKER_LANE_PHASES.length, 9);

  // 遍历全部 14 个 Workflow 状态并校验 30 条 history 环形缓冲
  let snap = fsm.createInitialFsmSnapshot("auto", 1000);
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < fsm.WORKFLOW_PHASES.length; i++) {
      const target = fsm.WORKFLOW_PHASES[i];
      snap = fsm.reduceFsm(snap, { type: "SET_PHASE", phase: target, reason: `step-${round}-${i}` }, 2000 + round * 100 + i);
      assert.equal(snap.phase, target);
    }
  }
  assert.equal(snap.history.length, 30, "history 环形缓冲应封顶 30 条");

  // 覆盖全部 9 个 WorkerLane 状态
  snap = fsm.reduceFsm(snap, { type: "WORKER_QUEUE", worker: { id: "w-q", lane: "l1", role: "coder" } }, 3000);
  assert.equal(snap.activeWorkers.find((w) => w.id === "w-q").phase, "QUEUED");
  snap = fsm.reduceFsm(snap, { type: "WORKER_PREPARE", worker: { id: "w-q", lane: "l1", role: "coder" } }, 3001);
  assert.equal(snap.activeWorkers.find((w) => w.id === "w-q").phase, "PREPARING_WT");
  snap = fsm.reduceFsm(snap, { type: "WORKER_START", id: "w-q", model: "claude-sonnet-4" }, 3002);
  assert.equal(snap.activeWorkers.find((w) => w.id === "w-q").phase, "RUNNING");
  snap = fsm.reduceFsm(snap, { type: "WORKER_STALL_WARN", id: "w-q", stallReason: "60% idle" }, 3003);
  assert.equal(snap.activeWorkers.find((w) => w.id === "w-q").phase, "STALLED_WARN");
  snap = fsm.reduceFsm(snap, { type: "WORKER_PROGRESS", id: "w-q", turns: 1, streamChars: 50 }, 3004);
  assert.equal(snap.activeWorkers.find((w) => w.id === "w-q").phase, "RUNNING");
  snap = fsm.reduceFsm(snap, { type: "WORKER_FINISH", id: "w-q", outcome: "completed", cost: 0.1 }, 3005);
  assert.equal(snap.completedWorkers.at(-1).phase, "COMPLETED");

  for (const [id, outcome, expected] of [
    ["w-part", "partial_salvaged", "PARTIAL_SALVAGED"],
    ["w-rv", "role_violation", "ROLE_VIOLATION"],
    ["w-fail", "failed", "FAILED"],
    ["w-ab", "aborted", "ABORTED"],
  ]) {
    snap = fsm.reduceFsm(snap, { type: "WORKER_START", id }, 3100);
    snap = fsm.reduceFsm(snap, { type: "WORKER_FINISH", id, outcome }, 3101);
    assert.equal(snap.completedWorkers.at(-1).phase, expected);
  }
});

test("G-01..G-06 守卫与 checkGate2Precondition（L2/L3/night、strict/auto、T2/T3 抽检豁免、风险单调递增、30 条 violations 封顶）", () => {
  // G-01, G-03, G-06 告警入队与 30 条上限
  let snap = fsm.createInitialFsmSnapshot("strict", 100);
  snap = fsm.reduceFsm(snap, { type: "START_RUN", track: "build", riskLevel: "L2", pinnedSha: "sha1111" }, 200);
  for (let i = 0; i < 35; i++) {
    snap = fsm.reduceFsm(snap, { type: "RECORD_VIOLATION", guard: "G-01", severity: "block", message: `block-${i}` }, 300 + i);
  }
  assert.equal(snap.violations.length, 30, "violations 环形缓冲应封顶 30 条");

  // G-02: strict 模式缺 Gate 1 PASS -> block
  const g2Block = fsm.checkGate2Precondition(snap, "sha1111");
  assert.equal(g2Block.allowed, false);
  assert.equal(g2Block.severity, "block");
  assert.equal(g2Block.violation.guard, "G-02");

  // G-02: auto 模式缺 Gate 1 PASS -> allowed=true, severity="warn", 且 WORKER_PREPARE 自动记入 violations
  let autoSnap = fsm.reduceFsm(snap, { type: "SET_ROUTING_MODE", mode: "auto" }, 400);
  const g2Warn = fsm.checkGate2Precondition(autoSnap, "sha1111");
  assert.equal(g2Warn.allowed, true);
  assert.equal(g2Warn.severity, "warn");
  autoSnap = fsm.reduceFsm(
    autoSnap,
    { type: "WORKER_PREPARE", worker: { id: "rev-1", lane: "rev", role: "reviewer", pinnedSha: "sha1111" } },
    401,
  );
  assert.equal(autoSnap.violations.at(-1).guard, "G-02");

  // G-02: T2/T3 非高危抽检豁免，但 isRiskSlice=true 时仍强制拦阻
  let t2Snap = fsm.reduceFsm(snap, { type: "SET_TRUST_LEVEL", trustLevel: "T2" }, 410);
  assert.equal(fsm.checkGate2Precondition(t2Snap, "sha1111", { samplingAllowed: true }).allowed, true);
  assert.equal(fsm.checkGate2Precondition(t2Snap, "sha1111", { samplingAllowed: true, isRiskSlice: true }).allowed, false);

  // G-02: 独立 review 轨道豁免 Gate 1
  const reviewTrackSnap = fsm.reduceFsm(snap, { type: "START_RUN", track: "review", riskLevel: "L2" }, 420);
  assert.equal(fsm.checkGate2Precondition(reviewTrackSnap, "sha1111").allowed, true);

  // G-02: Gate 1 PASS 同 SHA 放行，不同 SHA 仍拦阻
  const passedSnap = fsm.reduceFsm(
    snap,
    { type: "RECORD_GATE_RESULT", gate: 1, role: "verifier", verdict: "PASS", pinnedSha: "sha1111" },
    430,
  );
  assert.equal(fsm.checkGate2Precondition(passedSnap, "sha1111").allowed, true);
  assert.equal(fsm.checkGate2Precondition(passedSnap, "sha2222").allowed, false);

  // G-04: CUTOFF_CLOSING 拦截 coder/ui 新开切片，放行 verifier/reviewer/judge 收口
  let cutoffSnap = fsm.reduceFsm(snap, { type: "BUDGET_TICK", dispatched: 28, maxDelegates: 40, cutoffTriggered: true }, 500);
  assert.equal(cutoffSnap.phase, "CUTOFF_CLOSING");
  assert.equal(cutoffSnap.budgetCutoffActive, true);
  assert.equal(fsm.checkCutoffPrecondition(cutoffSnap, "coder").allowed, false);
  assert.equal(fsm.checkCutoffPrecondition(cutoffSnap, "ui").allowed, false);
  assert.equal(fsm.checkCutoffPrecondition(cutoffSnap, "verifier").allowed, true);
  assert.equal(fsm.checkCutoffPrecondition(cutoffSnap, "reviewer").allowed, true);
  assert.equal(fsm.checkCutoffPrecondition(cutoffSnap, "judge").allowed, true);

  // G-05: 风险等级严格单调递增（不可从 L3 降为 L1）
  let monoSnap = fsm.reduceFsm(snap, { type: "SET_RISK_LEVEL", riskLevel: "L3" }, 600);
  assert.equal(monoSnap.riskLevel, "L3");
  monoSnap = fsm.reduceFsm(monoSnap, { type: "SET_RISK_LEVEL", riskLevel: "L1", reason: "attempt downgrade" }, 601);
  assert.equal(monoSnap.riskLevel, "L3");
  assert.equal(monoSnap.violations.at(-1).guard, "G-05");

  // G-06: role_violation 记录 G-06
  monoSnap = fsm.reduceFsm(monoSnap, { type: "WORKER_START", id: "rv-1", pinnedSha: "sha1111" }, 610);
  monoSnap = fsm.reduceFsm(monoSnap, { type: "WORKER_FINISH", id: "rv-1", roleViolation: true }, 611);
  assert.equal(monoSnap.violations.at(-1).guard, "G-06");
});

test("restoreFsmFromBranch：逆序恢复 zee-fsm 与兼容 legacy zee-mode / zee-gate 及 flagMode 优先级", () => {
  // 1. 无条目时使用 flagMode
  const defRes = fsm.restoreFsmFromBranch([], "strict");
  assert.equal(defRes.source, "default");
  assert.equal(defRes.snapshot.routingMode, "strict");

  // 2. 向后兼容 legacy zee-mode + zee-gate
  const legacyBranch = [
    { type: "custom", customType: "zee-mode", data: { mode: "auto" }, timestamp: 1000 },
    { type: "custom", customType: "zee-gate", data: { gate: "plan" }, timestamp: 2000 },
  ];
  const legRes = fsm.restoreFsmFromBranch(legacyBranch, "off");
  assert.equal(legRes.source, "legacy");
  assert.equal(legRes.snapshot.routingMode, "auto");
  assert.equal(legRes.snapshot.writeGate, "plan");
  assert.equal(legRes.snapshot.phase, "PLANNING");
  assert.equal(legRes.branchEntryTs, 2000);

  // 3. 恢复最新 zee-fsm entry
  const fsmSnap = fsm.reduceFsm(fsm.createInitialFsmSnapshot("strict", 5000), {
    type: "START_RUN",
    track: "night",
    riskLevel: "L3",
    slug: "demo-night",
    phase: "EXECUTING",
  }, 5000);
  const fsmBranch = [
    ...legacyBranch,
    { type: "custom", customType: "zee-fsm", data: fsmSnap, timestamp: 5000 },
  ];
  const resFsm = fsm.restoreFsmFromBranch(fsmBranch, "off");
  assert.equal(resFsm.source, "zee-fsm");
  assert.equal(resFsm.snapshot.routingMode, "strict");
  assert.equal(resFsm.snapshot.track, "night");
  assert.equal(resFsm.snapshot.riskLevel, "L3");
  assert.equal(resFsm.snapshot.phase, "EXECUTING");
  assert.equal(resFsm.branchEntryTs, 5000);
});

test("bus-sync.ts：mtimeMs 缓存只读水合 state.json + decisions.tsv 尾 15 行、/tree busAheadOfBranch 检测（绝不覆盖磁盘）、projectConfig & 异步 worktree 盘点", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zee-bussync-"));
  const repoDir = path.join(tmpRoot, "repo");
  const busDir = path.join(tmpRoot, "bus");
  try {
    fs.mkdirSync(path.join(repoDir, ".agents", "skills", "verify-app"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".agents", "zee.project.json"),
      JSON.stringify({ trustLevel: "T2", riskPaths: ["src/auth/**"] }),
    );
    fs.writeFileSync(path.join(repoDir, ".agents", "skills", "verify-app", "SKILL.md"), "# verify-app\n");

    fs.mkdirSync(busDir, { recursive: true });
    const updatedIso = new Date(20000).toISOString();
    const stateJsonRaw = JSON.stringify({
      slug: "demo-sync",
      status: "running",
      level: "L2",
      updatedAt: updatedIso,
      delegatesDispatched: 3,
      units: [{ id: "U1", status: "done", sha: "abc1234" }],
    });
    fs.writeFileSync(path.join(busDir, "state.json"), stateJsonRaw);

    const rows = ["ts\tunit\tphase\tdecision\twhy\tevidence\tresult"];
    for (let i = 1; i <= 20; i++) {
      rows.push(`${new Date(1000 * i).toISOString()}\tU${i}\tverify\tPASS\treason-${i}\tlog-${i}\tok`);
    }
    fs.writeFileSync(path.join(busDir, "decisions.tsv"), rows.join("\n") + "\n");

    const reader = new busSync.BusSyncReader();
    // 第一次水合：branchEntryTs=10000，disk=20000 -> 20000 > 10000 + 5000 -> busAheadOfBranch=true
    const h1 = reader.hydrateBus(busDir, 10000);
    assert.equal(h1.busAheadOfBranch, true);
    assert.equal(h1.cachedStateHit, false);
    assert.equal(h1.decisionsTail.length, 15);
    assert.equal(h1.decisionsTail[0].unit, "U6");
    assert.equal(h1.decisionsTail[14].unit, "U20");
    // 磁盘 state.json 必须保持原样未被覆写
    assert.equal(fs.readFileSync(path.join(busDir, "state.json"), "utf8"), stateJsonRaw);

    // 第二次水合命中 mtimeMs 缓存，且 branchEntryTs=18000 -> busAheadOfBranch=false
    const h2 = reader.hydrateBus(busDir, 18000);
    assert.equal(h2.cachedStateHit, true);
    assert.equal(h2.cachedDecisionsHit, true);
    assert.equal(h2.busAheadOfBranch, false);

    // 读取项目配置 trustLevel 与 verify-* 技能存在性
    const pCfg = reader.readProjectConfig(repoDir);
    assert.equal(pCfg.exists, true);
    assert.equal(pCfg.trustLevel, "T2");
    assert.equal(pCfg.hasVerifySkill, true);

    // 真实 Git 仓库异步 worktree 盘点（绝不阻塞 render）
    execFileSync("git", ["-C", tmpRoot, "init", "-b", "main", "gitrepo"], { stdio: "ignore" });
    const gitRepo = path.join(tmpRoot, "gitrepo");
    execFileSync("git", ["-C", gitRepo, "config", "core.autocrlf", "false"], { stdio: "ignore" });
    execFileSync("git", ["-C", gitRepo, "config", "user.email", "t@zee.dev"], { stdio: "ignore" });
    execFileSync("git", ["-C", gitRepo, "config", "user.name", "zee"], { stdio: "ignore" });
    fs.writeFileSync(path.join(gitRepo, "a.txt"), "1\n");
    execFileSync("git", ["-C", gitRepo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", gitRepo, "commit", "-m", "init"], { stdio: "ignore" });

    const inv = await busSync.fetchWorktreeInventoryAsync(
      gitRepo,
      path.join(REPO_ROOT, "skills", "zee", "scripts", "zee-tool.mjs"),
    );
    assert.equal(inv.ok, true);
    assert.equal(inv.bucketCounts.primary, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("hub-ui.ts：Layer 0 徽章、Layer 1 HUD 80/120/50 列宽度不变量、HubStore 定时器与 5-Tab Hub 键盘导航与控制动作", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-hubui-"));
  const partialPath = path.join(tmpDir, "partial-coder.md");
  fs.writeFileSync(partialPath, "PARTIAL_LINE_1\nPARTIAL_LINE_2\nPARTIAL_LINE_3\n");

  try {
    // 1. IDLE 且无锁时 HUD 返回 []
    const idleSnap = hubUi.createInitialHubSnapshot(tmpDir, fsm.createInitialFsmSnapshot("off"));
    assert.deepEqual(hubUi.renderZeeHudLines(idleSnap, 120, 40), []);
    assert.deepEqual(hubUi.renderRpcHudLines(idleSnap), []);
    assert.equal(hubUi.formatCompactStatusBadge(idleSnap), undefined);

    // 2. 构造活跃运行态 + 3 个活跃 Worker + partial 已完成 Worker + 漂移 + 违规 + 成本
    const now = Date.now();
    let activeFsm = fsm.reduceFsm(
      fsm.createInitialFsmSnapshot("auto", now),
      { type: "START_RUN", track: "build", riskLevel: "L2", trustLevel: "T2", slug: "hub-demo", phase: "EXECUTING", pinnedSha: "1234567890" },
      now,
    );
    activeFsm = fsm.reduceFsm(
      activeFsm,
      { type: "RECORD_GATE_RESULT", gate: 1, role: "verifier", verdict: "PASS", pinnedSha: "1234567890" },
      now,
    );
    activeFsm = fsm.reduceFsm(
      activeFsm,
      { type: "WORKER_START", id: "w1", model: "claude-sonnet-4", pinnedSha: "1234567890" },
      now - 5000,
    );
    activeFsm = fsm.reduceFsm(
      activeFsm,
      { type: "WORKER_PROGRESS", id: "w1", turns: 2, cost: 0.15, streamChars: 340, inFlightTool: "bash", lastActions: ["read", "bash"] },
      now - 1000,
    );
    activeFsm = fsm.reduceFsm(activeFsm, { type: "WORKER_START", id: "w2", model: "gemini-4-neon" }, now - 4000);
    activeFsm = fsm.reduceFsm(activeFsm, { type: "WORKER_STALL_WARN", id: "w2", stallReason: "60% idle" }, now - 500);
    activeFsm = fsm.reduceFsm(activeFsm, { type: "WORKER_START", id: "w3", model: "gpt-5" }, now - 3000);
    activeFsm = fsm.reduceFsm(activeFsm, { type: "WORKER_START", id: "w-done", model: "claude-opus-4" }, now - 10000);
    activeFsm = fsm.reduceFsm(
      activeFsm,
      { type: "WORKER_FINISH", id: "w-done", outcome: "partial_salvaged", cost: 0.42, partialArtifactPath: partialPath },
      now - 2000,
    );

    const richSnap = {
      ...hubUi.createInitialHubSnapshot(tmpDir, activeFsm),
      busAheadOfBranch: true,
      decisionsTail: [
        { ts: "2026-11-26T00:00:00Z", unit: "U1", phase: "verify", decision: "PASS", why: "green", evidence: "test", result: "merged" },
      ],
      worktreeInventory: {
        ok: true,
        repoRoot: tmpDir,
        worktrees: [
          { path: tmpDir, branch: "main", head: "1234567", dirtyFiles: 0, wipFiles: 0, scratchFiles: 0, mergedIntoBase: true, mergeMethod: null, activeLocked: false, bucket: "primary", pruned: false, pruneHint: null },
        ],
        bucketCounts: { primary: 1, active_hold: 0, keep_dirty: 0, safe_to_prune: 0, safe_to_prune_detached: 0, review_unmerged: 0 },
        fetchedAt: now,
      },
    };

    // Layer 0 徽章 <= 18 cols
    const badge = hubUi.formatCompactStatusBadge(richSnap);
    assert.ok(badge && visibleWidth(badge) <= 18, `徽章超宽: ${badge}`);

    // Layer 1 HUD：120 列全尺寸卡片 (2-4 行 + ╭─ / ╰─ + +1 more)
    const hud120 = hubUi.renderZeeHudLines(richSnap, 120, 40, undefined, now);
    assert.ok(hud120.length >= 2 && hud120.length <= 4, `全尺寸卡片应为 2-4 行，实际 ${hud120.length}`);
    assert.ok(hud120[0].startsWith("╭"));
    assert.ok(hud120.at(-1).startsWith("╰"));
    assert.ok(hud120.at(-1).includes("+1 more"));
    for (const line of hud120) {
      assert.ok(visibleWidth(line) <= 120, `120 列越界 (${visibleWidth(line)}): ${line}`);
    }

    // 80 列紧凑退化 (1-2 行 ▌zee[...])
    const hud80 = hubUi.renderZeeHudLines(richSnap, 80, 40, undefined, now);
    assert.ok(hud80.length >= 1 && hud80.length <= 2);
    assert.ok(hud80[0].startsWith("▌zee["));
    for (const line of hud80) {
      assert.ok(visibleWidth(line) <= 80, `80 列越界 (${visibleWidth(line)}): ${line}`);
    }

    // 50 列窄屏与 rows < 22 均折叠为 1 行
    const hud50 = hubUi.renderZeeHudLines(richSnap, 50, 40, undefined, now);
    assert.equal(hud50.length, 1);
    assert.ok(visibleWidth(hud50[0]) <= 50);
    const hudShort = hubUi.renderZeeHudLines(richSnap, 100, 20, undefined, now);
    assert.equal(hudShort.length, 1);
    assert.ok(visibleWidth(hudShort[0]) <= 100);

    // hidden 密度返回 0 行
    assert.deepEqual(hubUi.renderZeeHudLines({ ...richSnap, hudDensity: "hidden" }, 120, 40), []);

    // RPC 降级 <= 3 行
    const rpcLines = hubUi.renderRpcHudLines(richSnap, now);
    assert.ok(rpcLines.length >= 1 && rpcLines.length <= 3);

    // HubStore 订阅 + dispose 幂等
    const store = new hubUi.HubStore(richSnap);
    let renderCalls = 0;
    const fakeTui = { terminal: { rows: 40 }, requestRender: () => { renderCalls += 1; } };
    const hudComp = hubUi.createZeeHudComponent(store, fakeTui, {});
    assert.equal(hudComp.render(100).length, 4);
    store.notify(true);
    assert.ok(renderCalls >= 1);
    hudComp.dispose();

    // 5-Tab Hub 键盘导航、partial-*.md 预览、Controls 动作与 80/120 列宽度校验
    let closed = false;
    let modeCycled = 0;
    let gateUnlocked = 0;
    let refreshed = 0;
    const hub = new hubUi.ZeeHubOverlayComponent(
      store,
      fakeTui,
      {},
      {
        onRefresh: () => { refreshed += 1; },
        onCycleMode: () => { modeCycled += 1; },
        onUnlockGate: () => { gateUnlocked += 1; },
        onCycleHudDensity: () => {
          const next = store.getHudDensity() === "full" ? "compact" : "full";
          store.setHudDensity(next, true);
        },
      },
      () => { closed = true; },
    );

    // 校验所有 5 个 Tab 在 80 与 120 列下的宽度不变量
    for (let t = 0; t < 5; t++) {
      hub.handleInput(String(t + 1));
      assert.equal(hub.getActiveTab(), t);
      for (const w of [80, 120]) {
        const rendered = hub.render(w);
        assert.ok(rendered.length >= 10);
        for (const l of rendered) assert.ok(visibleWidth(l) <= w, `Tab${t + 1} ${w}列越界: ${l}`);
      }
    }

    // 切到 Tab 2 Workers，用 ↓ 选到含 partial 的 w-done 并按 Enter 预览，再 Esc 退出预览
    hub.handleInput("2");
    assert.equal(hub.getActiveTab(), 1);
    hub.handleInput(Key.down);
    hub.handleInput(Key.down);
    hub.handleInput(Key.down);
    hub.handleInput(Key.enter);
    assert.equal(hub.isPreviewOpen(), true);
    assert.ok(hub.render(100).some((l) => l.includes("PARTIAL_LINE_1")));
    hub.handleInput(Key.escape);
    assert.equal(hub.isPreviewOpen(), false);
    assert.equal(closed, false);

    // Tab / Shift+Tab 切到 Tab 3 Gates & Tab 4 Worktrees & Cost
    hub.handleInput(Key.tab);
    assert.equal(hub.getActiveTab(), 2);
    assert.ok(hub.render(100).some((l) => l.includes("Gate 1")));
    hub.handleInput(Key.right);
    assert.equal(hub.getActiveTab(), 3);
    assert.ok(hub.render(100).some((l) => l.includes("Worktree")));

    // r 触发刷新
    hub.handleInput("r");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(refreshed, 1);

    // Tab 5 Controls: m / c (copyToClipboard) / d / l (带确认) / q 关闭
    hub.handleInput("5");
    assert.equal(hub.getActiveTab(), 4);
    hub.handleInput("m");
    hub.handleInput("d");
    hub.handleInput("c");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(modeCycled, 1);
    assert.equal(globalThis.__zeeFsmMockClipboard, "/zee resume hub-demo");

    // 锁未开时 l 不会报错；置为 plan 锁后按 l 弹出确认再按 y 确认解锁
    store.update((s) => ({ ...s, writeGate: "plan" }), true);
    hub.handleInput("l");
    assert.ok(hub.getPendingConfirm());
    hub.handleInput("y");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(gateUnlocked, 1);

    // q 关闭 Hub 且清理 store 定时器
    hub.handleInput("q");
    assert.equal(closed, true);
    store.dispose();
    store.dispose(); // 幂等验证
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
