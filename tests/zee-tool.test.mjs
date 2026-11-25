import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(REPO_ROOT, "skills", "zee", "scripts", "zee-tool.mjs");

function runTool(args, expectOk = true) {
  const res = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
  if (expectOk) {
    assert.equal(res.status, 0, `zee-tool ${args.join(" ")} failed: ${res.stderr}\n${res.stdout}`);
  }
  return { status: res.status, json: res.stdout.trim() ? JSON.parse(res.stdout) : null, stderr: res.stderr };
}

test("init-run / update-state / log-decision（位置+具名）全链路原子操作", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-tool-repo-"));
  let busDir = "";
  try {
    const init = runTool(["init-run", tmpRepo, "mario-test"]);
    assert.equal(init.json.ok, true);
    busDir = init.json.busDir;

    const updated = runTool([
      "update-state",
      busDir,
      "--status",
      "running",
      "--mode",
      "night",
      "--level",
      "L2",
      "--resume-next",
      "U2",
      "--inc-delegates",
      "--unit-upsert",
      JSON.stringify({ id: "U1", status: "done", sha: "abc1234" }),
    ]);
    assert.equal(updated.json.state.status, "running");
    assert.equal(updated.json.state.mode, "night");
    assert.equal(updated.json.state.resumeNext, "U2");
    assert.equal(updated.json.state.delegatesDispatched, 1);
    assert.equal(updated.json.state.units.length, 1);

    // 具名参数 log-decision
    const namedLog = runTool([
      "log-decision",
      "--bus",
      busDir,
      "--unit",
      "U1",
      "--phase",
      "verify",
      "--decision",
      "PASS",
      "--why",
      "all tests green",
      "--evidence",
      "npm test -> 0",
      "--result",
      "merged",
    ]);
    assert.equal(namedLog.json.ok, true);

    // 兼容旧 7 位置参数
    const posLog = runTool(["log-decision", busDir, "U2", "start", "kickoff", "next slice", "state.json", "running"]);
    assert.equal(posLog.json.ok, true);

    const tsv = fs.readFileSync(path.join(busDir, "decisions.tsv"), "utf8").trim().split("\n");
    assert.equal(tsv.length, 3);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    if (busDir) fs.rmSync(path.dirname(busDir), { recursive: true, force: true });
  }
});

test("worktree-create 与 cleanup-worktrees --prune-safe 识别干净 detached 与 squash-merge", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-wt-repo-"));
  let wtPath = "";
  try {
    execFileSync("git", ["-C", tmpRepo, "init", "-b", "main"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.email", "test@zee.dev"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.name", "zee"], { stdio: "ignore" });
    fs.writeFileSync(path.join(tmpRepo, "README.md"), "# demo\n");
    execFileSync("git", ["-C", tmpRepo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "commit", "-m", "init"], { stdio: "ignore" });

    const created = runTool(["worktree-create", tmpRepo, "mario-wt", "verify-r1", "HEAD"]);
    assert.equal(created.json.ok, true);
    wtPath = created.json.worktreePath;
    assert.equal(fs.existsSync(wtPath), true);

    const audited = runTool(["cleanup-worktrees", tmpRepo]);
    const entry = audited.json.worktrees.find((w) => w.path === wtPath);
    assert.ok(entry);
    assert.equal(entry.bucket, "safe_to_prune");

    const pruned = runTool(["cleanup-worktrees", tmpRepo, "--prune-safe"]);
    assert.equal(pruned.json.prunedCount, 1);
    assert.equal(fs.existsSync(wtPath), false);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    if (wtPath) fs.rmSync(path.dirname(path.dirname(path.dirname(wtPath))), { recursive: true, force: true });
  }
});

test("check-plan 校验必填章节并对超预算切片发出告警", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-plan-check-"));
  try {
    const goodPlan = path.join(tmpDir, "good.md");
    fs.writeFileSync(
      goodPlan,
      `# Plan
## 目标与 Out-of-Scope
明确不做多人联机。
## 数据形状与文件归属 (Data Shape & Lanes)
GameState, Entity.
## Test Seam 与 Done Predicate
npm test 退出 0。
## Throughput Checkpoint
- Blocking first steps: shared types
## 垂直切片 (Vertical Slices)
- Slice 1 (3 files, 220 LOC, blockedBy: none)
`,
    );
    const okRes = runTool(["check-plan", goodPlan]);
    assert.equal(okRes.json.ok, true);
    assert.equal(okRes.json.warnings.length, 0);

    const badPlan = path.join(tmpDir, "bad.md");
    fs.writeFileSync(badPlan, `# Incomplete\n- Slice 1 (12 files, 900 LOC)\n`);
    const badRes = runTool(["check-plan", badPlan], false);
    assert.equal(badRes.status, 1);
    assert.equal(badRes.json.ok, false);
    assert.ok(badRes.json.missing.length >= 3);
    assert.ok(badRes.json.warnings.length >= 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolve-model 确定性翻译 AGY invoke_subagent 与 swarm 模型面", () => {
  const tmpCfg = path.join(os.tmpdir(), `zee-cfg-${process.pid}.json`);
  try {
    fs.writeFileSync(
      tmpCfg,
      JSON.stringify({
        version: 2,
        budget: "balanced",
        roles: {
          scout: { prefer: { family: "gemini", modelHint: "gemini-4-hydrogen", tier: "fast", effort: "low" } },
          architect: {
            primary: { prefer: { family: "gemini", modelHint: "gemini-4-neon", tier: "pro", effort: "xhigh" } },
            arenaPool: [],
          },
          coder: {
            standard: { prefer: { family: "gemini", modelHint: "gemini-4-argon", tier: "standard", effort: "medium" } },
            heavy: { prefer: { family: "gemini", modelHint: "gemini-4-neon", tier: "pro", effort: "high" } },
          },
        },
      }),
    );

    const subScout = runTool(["resolve-model", "--harness", "agy", "--surface", "invoke_subagent", "--role", "scout", "--config", tmpCfg]);
    assert.equal(subScout.json.resolved.model, "flash");

    const subArch = runTool(["resolve-model", "--harness", "agy", "--surface", "invoke_subagent", "--role", "architect", "--config", tmpCfg]);
    assert.equal(subArch.json.resolved.model, "pro");

    const subArgon = runTool(["resolve-model", "--harness", "agy", "--surface", "invoke_subagent", "--role", "coder.standard", "--config", tmpCfg]);
    assert.equal(subArgon.json.resolved.model, "inherit");

    const swarmArch = runTool(["resolve-model", "--harness", "agy", "--surface", "swarm", "--role", "architect", "--config", tmpCfg]);
    assert.equal(swarmArch.json.resolved.model, "gemini-4-neon-xhigh");
  } finally {
    fs.rmSync(tmpCfg, { force: true });
  }
});

test("v4.1 回归 [M2/H6]：parseFlags 支持 -- 开头值、active_hold 保护在跑 worktree、check-plan 查环且不误报正文、resolve-model 全槽位与缺配失败", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v41-tool-"));
  let busDir = "";
  let wtPath = "";
  try {
    execFileSync("git", ["-C", tmpRepo, "init", "-b", "main"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.email", "test@zee.dev"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.name", "zee"], { stdio: "ignore" });
    fs.writeFileSync(path.join(tmpRepo, "README.md"), "# demo\n");
    execFileSync("git", ["-C", tmpRepo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "commit", "-m", "init"], { stdio: "ignore" });

    // 1. init-run 支持 --conversation-id，log-decision 支持 --why "--live blocked"
    const init = runTool(["init-run", tmpRepo, "v41-test", "--conversation-id", "conv-xyz-123"]);
    busDir = init.json.busDir;
    const st = JSON.parse(fs.readFileSync(path.join(busDir, "state.json"), "utf8"));
    assert.equal(st.conversationId, "conv-xyz-123");

    const logRes = runTool([
      "log-decision",
      "--bus",
      busDir,
      "--unit",
      "U1",
      "--phase",
      "guard",
      "--decision",
      "BLOCK",
      "--why",
      "--live blocked cleanly",
      "--evidence",
      "guard-core",
      "--result",
      "safe",
    ]);
    assert.equal(logRes.json.ok, true);
    assert.ok(logRes.json.appended.includes("'--live blocked cleanly"));

    // 2. active_hold 锁保护在跑 detached worktree 不被 --prune-safe 误删
    const wt = runTool(["worktree-create", tmpRepo, "v41-wt", "verify-live", "HEAD"]);
    wtPath = wt.json.worktreePath;
    const lockPath = `${wtPath}.zee-lock.json`;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const prunedWithLock = runTool(["cleanup-worktrees", tmpRepo, "--prune-safe"]);
    const lockedEntry = prunedWithLock.json.worktrees.find((w) => w.path === wtPath);
    assert.equal(lockedEntry.bucket, "active_hold");
    assert.equal(lockedEntry.pruned, false);
    assert.equal(fs.existsSync(wtPath), true);

    // 释放锁后正常回收
    fs.rmSync(lockPath, { force: true });
    const prunedAfterUnlock = runTool(["cleanup-worktrees", tmpRepo, "--prune-safe"]);
    assert.equal(prunedAfterUnlock.json.prunedCount, 1);

    // 3. check-plan 背景叙述大数字不误报 + 循环依赖必拦截
    const narrativePlan = path.join(tmpRepo, "narrative.md");
    fs.writeFileSync(
      narrativePlan,
      `# Plan
## 背景
当前仓库共 28 files，核心模块约 2400 lines。
## 目标与 Out-of-Scope
明确不做云同步。
## 数据形状与契约
State, Event.
## Test Seam 与 Done Predicate
npm test exit 0
## Throughput Checkpoint
blocking first steps: types
## 垂直切片
- Slice 1 (3 files, 180 LOC, blockedBy: none)
- Slice 2 (2 files, 120 LOC, blockedBy: Slice 1)
`,
    );
    const okNar = runTool(["check-plan", narrativePlan]);
    assert.equal(okNar.json.ok, true);
    assert.equal(okNar.json.warnings.length, 0);

    const cyclicPlan = path.join(tmpRepo, "cyclic.md");
    fs.writeFileSync(
      cyclicPlan,
      `# Plan
## 目标与 Out-of-Scope
明确不做
## 数据形状与契约
A
## Test Seam 与 Done Predicate
test
## Throughput Checkpoint
first
## 垂直切片
- Slice 1 (2 files, 100 LOC, blockedBy: Slice 2)
- Slice 2 (2 files, 100 LOC, blockedBy: Slice 1)
`,
    );
    const cycRes = runTool(["check-plan", cyclicPlan], false);
    assert.equal(cycRes.status, 1);
    assert.ok(cycRes.json.missing.some((m) => m.includes("循环依赖")));

    // 4. resolve-model 缺配置 fail-closed + 支持 judge / reviewer.2 / budget 降档
    const missingRes = runTool(["resolve-model", "--harness", "agy", "--role", "scout", "--config", path.join(tmpRepo, "nope.json")], false);
    assert.equal(missingRes.status, 1);
    assert.equal(missingRes.json.ok, false);

    const ecoCfg = path.join(tmpRepo, "eco.json");
    fs.writeFileSync(
      ecoCfg,
      JSON.stringify({
        version: 2,
        budget: "eco",
        roles: {
          judge: { prefer: { family: "claude", modelHint: "claude-opus-4", tier: "pro", effort: "xhigh" } },
          reviewers: [
            { prefer: { family: "claude", modelHint: "claude-sonnet-4", tier: "standard", effort: "medium" } },
            { prefer: { family: "openai", modelHint: "gpt-5", tier: "pro", effort: "high" } },
            { prefer: { family: "gemini", modelHint: "gemini-pro", tier: "pro", effort: "high" } },
          ],
        },
      }),
    );
    const judgeRes = runTool(["resolve-model", "--harness", "agy", "--surface", "swarm", "--role", "judge", "--config", ecoCfg]);
    assert.equal(judgeRes.json.resolved.effectiveEffort, "high");
    const rev2Res = runTool(["resolve-model", "--harness", "pi", "--role", "reviewer.2", "--config", ecoCfg]);
    assert.equal(rev2Res.json.resolved.family, "gemini");
    assert.equal(rev2Res.json.resolved.effort, "medium");

    // 5. v4.1.1: update-state --budget / 多次 --inc-delegates 累加 / --inc-aborted、check-plan 悬空依赖 & --strict-budget、嵌套分支扁平化
    const updV411 = runTool([
      "update-state",
      busDir,
      "--budget",
      JSON.stringify({ maxUnits: 4, maxDelegates: 12, cutoffRatio: 0.7 }),
      "--inc-delegates",
      "--inc-delegates",
      "--inc-aborted",
      "2",
    ]);
    assert.equal(updV411.json.state.budget.maxDelegates, 12);
    assert.equal(updV411.json.state.delegatesDispatched, 2);
    assert.equal(updV411.json.state.abortedDelegates, 2);

    const danglingPlan = path.join(tmpRepo, "dangling.md");
    fs.writeFileSync(
      danglingPlan,
      `# Plan\n## 目标与 Out-of-Scope\n明确不做\n## 数据形状与契约\nA\n## Test Seam 与 Done Predicate\ntest\n## Throughput Checkpoint\nfirst\n## 垂直切片\n- Slice 1 (2 files, 100 LOC, blockedBy: Slice 99)\n`,
    );
    const dangRes = runTool(["check-plan", danglingPlan], false);
    assert.equal(dangRes.status, 1);
    assert.ok(dangRes.json.missing.some((m) => m.includes("悬空依赖") && m.includes("SLICE99")));

    const overBudgetPlan = path.join(tmpRepo, "over.md");
    fs.writeFileSync(
      overBudgetPlan,
      `# Plan\n## 目标与 Out-of-Scope\n明确不做\n## 数据形状与契约\nA\n## Test Seam 与 Done Predicate\ntest\n## Throughput Checkpoint\nfirst\n## 垂直切片\n- Slice 1 (8 files, 200 LOC, blockedBy: none)\n`,
    );
    const strictRes = runTool(["check-plan", overBudgetPlan, "--strict-budget"], false);
    assert.equal(strictRes.status, 1);
    assert.ok(strictRes.json.missing.some((m) => m.includes("--strict-budget")));

    execFileSync("git", ["-C", tmpRepo, "branch", "zee/night-demo"], { stdio: "ignore" });
    const flatWt = runTool(["worktree-create", tmpRepo, "v411-wt", "u1", "HEAD", "--branch", "zee/night-demo/u1"]);
    assert.equal(flatWt.json.branch, "zee/night-demo-u1");
    assert.equal(flatWt.json.flattened, true);
    execFileSync("git", ["-C", tmpRepo, "worktree", "remove", "--force", flatWt.json.worktreePath], { stdio: "ignore" });
    fs.rmSync(path.dirname(path.dirname(path.dirname(flatWt.json.worktreePath))), { recursive: true, force: true });
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    if (busDir) fs.rmSync(path.dirname(busDir), { recursive: true, force: true });
    if (wtPath) fs.rmSync(path.dirname(path.dirname(path.dirname(wtPath))), { recursive: true, force: true });
  }
});

test("v4.2.0 sandbox-export / sandbox-clean / gate-tamper-diff 零污染沙盒与门禁篡改检测", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v420-sandbox-"));
  let shaBox = "";
  let wtBox = "";
  try {
    execFileSync("git", ["-C", tmpRepo, "init", "-b", "main"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.email", "test@zee.dev"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.name", "zee"], { stdio: "ignore" });
    fs.mkdirSync(path.join(tmpRepo, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "src", "app.ts"), "export const v = 1;\n");
    fs.writeFileSync(path.join(tmpRepo, "old.txt"), "remove me\n");
    execFileSync("git", ["-C", tmpRepo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "commit", "-m", "init"], { stdio: "ignore" });
    const headSha = execFileSync("git", ["-C", tmpRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    // 1. --sha 导出与拒绝越权清理
    const expSha = runTool(["sandbox-export", "--repo", tmpRepo, "--sha", headSha, "--prefix", "mut"]);
    assert.equal(expSha.json.ok, true);
    assert.equal(expSha.json.mode, "sha");
    shaBox = expSha.json.sandboxDir;
    assert.ok(path.basename(shaBox).startsWith("zee-mut-"));
    assert.equal(fs.readFileSync(path.join(shaBox, "src", "app.ts"), "utf8"), "export const v = 1;\n");

    const badCleanRepo = runTool(["sandbox-clean", tmpRepo], false);
    assert.equal(badCleanRepo.status, 1);
    const badCleanTmpRoot = runTool(["sandbox-clean", os.tmpdir()], false);
    assert.equal(badCleanTmpRoot.status, 1);

    const cleanedSha = runTool(["sandbox-clean", shaBox]);
    assert.equal(cleanedSha.json.removed, true);
    assert.equal(fs.existsSync(shaBox), false);
    shaBox = "";

    // 2. --working-tree 导出（含已修改文件、删除文件、未跟踪文件）及 gate-tamper-diff
    fs.writeFileSync(path.join(tmpRepo, "src", "app.ts"), "export const v = 2 as any; // @ts-ignore\n");
    fs.unlinkSync(path.join(tmpRepo, "old.txt"));
    fs.mkdirSync(path.join(tmpRepo, "tests"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "tests", "app.test.mjs"), "// eslint-disable-next-line\n");

    const expWt = runTool(["sandbox-export", "--repo", tmpRepo, "--working-tree", "--prefix", "rev"]);
    assert.equal(expWt.json.mode, "working-tree");
    assert.equal(expWt.json.ref, "WORKING_TREE");
    wtBox = expWt.json.sandboxDir;
    assert.ok(path.basename(wtBox).startsWith("zee-rev-"));
    assert.match(fs.readFileSync(path.join(wtBox, "src", "app.ts"), "utf8"), /v = 2/);
    assert.equal(fs.existsSync(path.join(wtBox, "old.txt")), false);
    assert.equal(fs.existsSync(path.join(wtBox, "tests", "app.test.mjs")), true);

    const tamperWt = runTool(["gate-tamper-diff", "--repo", tmpRepo, "--working-tree"]);
    assert.equal(tamperWt.json.requiresCountersign, true);
    assert.ok(tamperWt.json.gateFilesTouched.includes("tests/app.test.mjs"));
    assert.ok(tamperWt.json.suppressionsAdded.some((s) => s.file === "src/app.ts" && s.line.includes("@ts-ignore")));
    assert.ok(tamperWt.json.suppressionsAdded.some((s) => s.file === "src/app.ts" && s.line.includes("as any")));
    assert.ok(tamperWt.json.suppressionsAdded.some((s) => s.file === "tests/app.test.mjs" && s.line.includes("eslint-disable")));

    // 3. committed base..head 范围检测
    execFileSync("git", ["-C", tmpRepo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "commit", "-m", "tamper"], { stdio: "ignore" });
    const tamperRange = runTool(["gate-tamper-diff", "--repo", tmpRepo, "--base", headSha, "--head", "HEAD"]);
    assert.equal(tamperRange.json.requiresCountersign, true);
    assert.ok(tamperRange.json.gateFilesTouched.includes("tests/app.test.mjs"));

    const cleanClean = runTool(["sandbox-clean", wtBox]);
    assert.equal(cleanClean.json.removed, true);
    wtBox = "";
  } finally {
    if (shaBox) fs.rmSync(shaBox, { recursive: true, force: true });
    if (wtBox) fs.rmSync(wtBox, { recursive: true, force: true });
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("v4.2.0 mine-transcripts (retro+recall+脱敏)、queue-finding/list-findings、readiness、match-skills、--delegate-id、--allow-standalone", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v420-ops-"));
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v420-mine-"));
  let busDir = "";
  try {
    execFileSync("git", ["-C", tmpRepo, "init", "-b", "main"], { stdio: "ignore" });

    // 1. queue-finding & list-findings (>=3 systemic)
    const q1 = runTool(["queue-finding", "--repo", tmpRepo, "--category", "smell", "--pattern", "missing-seam", "--summary", "hard to test auth", "--file", "src/auth.ts"]);
    assert.equal(q1.json.patternCount, 1);
    assert.equal(q1.json.systemic, false);
    runTool(["queue-finding", "--repo", tmpRepo, "--category", "smell", "--pattern", "missing-seam", "--summary", "hard to test billing", "--file", "src/billing.ts"]);
    const q3 = runTool(["queue-finding", "--repo", tmpRepo, "--category", "smell", "--pattern", "missing-seam", "--summary", "hard to test checkout", "--file", "src/checkout.ts"]);
    assert.equal(q3.json.patternCount, 3);
    assert.equal(q3.json.systemic, true);
    runTool(["queue-finding", "--repo", tmpRepo, "--category", "doc", "--pattern", "stale-readme", "--summary", "typo"]);

    const listAll = runTool(["list-findings", "--repo", tmpRepo]);
    assert.equal(listAll.json.totalEntries, 4);
    assert.equal(listAll.json.clusters[0].pattern, "missing-seam");
    assert.equal(listAll.json.clusters[0].systemic, true);
    const listSys = runTool(["list-findings", "--repo", tmpRepo, "--min-count", "3"]);
    assert.equal(listSys.json.clusters.length, 1);

    // 2. mine-transcripts retro + recall + secrets redaction
    fs.writeFileSync(
      path.join(srcDir, "session.jsonl"),
      [
        JSON.stringify({
          role: "user",
          timestamp: new Date().toISOString(),
          content: "No, that's wrong — stop using sk-1234567890abcdef1234567890 and ghp_abcdef1234567890abcdef!",
        }),
        JSON.stringify({
          role: "assistant",
          timestamp: new Date().toISOString(),
          content: "Use Bearer supersecretjwtvalue12345 instead? Wait also pstack verify pattern failed.",
        }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(srcDir, "notes.md"),
      "Decision note: always run pstack verify before merge.\n\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----\n",
    );
    fs.writeFileSync(
      path.join(srcDir, "decisions.tsv"),
      "ts\tunit\tphase\tdecision\twhy\tevidence\tresult\n2026-11-25T00:00:00Z\tU1\tverify\tFAIL\tpstack smoke failed\texit 1\tREVISE\n",
    );

    const retro = runTool(["mine-transcripts", "--mode", "retro", "--repo", tmpRepo, "--source-dir", srcDir]);
    assert.equal(retro.json.ok, true);
    assert.ok(retro.json.totalScanned >= 3);
    const retroRaw = JSON.stringify(retro.json);
    assert.equal(retroRaw.includes("sk-1234567890abcdef1234567890"), false);
    assert.equal(retroRaw.includes("ghp_abcdef1234567890abcdef"), false);
    assert.ok(retroRaw.includes("<REDACTED>"));
    assert.ok(retro.json.snippets.some((s) => s.signal === "human_correction"));
    assert.ok(retro.json.snippets.some((s) => s.signal === "decision_failure"));

    const recall = runTool(["mine-transcripts", "--mode", "recall", "--repo", tmpRepo, "--source-dir", srcDir, "--query", "pstack verify", "--limit", "5"]);
    assert.equal(recall.json.ok, true);
    assert.ok(recall.json.matches.length >= 1);
    const recallRaw = JSON.stringify(recall.json);
    assert.equal(recallRaw.includes("supersecretjwtvalue12345"), false);
    assert.equal(recallRaw.includes("MIIEowIBAAKCAQEA1234567890"), false);

    // 3. readiness clamping: T3 configured without verify-* -> clamped to T1; then add T2 & T3 prerequisites
    fs.mkdirSync(path.join(tmpRepo, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, ".agents", "zee.project.json"),
      JSON.stringify({
        trustLevel: "T3",
        testCmds: ["node --test"],
        lintCmd: "npm run lint",
        denyCommands: ["--live"],
        pathSkills: [
          { glob: "src/auth/**", skill: "auth-guard", roles: ["coder", "reviewer"] },
          { glob: "docs/*.md", skill: "docs/style-skill.md" },
        ],
      }),
    );
    const r1 = runTool(["readiness", tmpRepo]);
    assert.equal(r1.json.configuredTrustLevel, "T3");
    assert.equal(r1.json.maxEligibleTrustLevel, "T1");
    assert.equal(r1.json.effectiveTrustLevel, "T1");
    assert.equal(r1.json.clamped, true);

    fs.mkdirSync(path.join(tmpRepo, ".agents", "skills", "verify-demo"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".agents", "skills", "verify-demo", "SKILL.md"), "# verify-demo\n");
    const r2 = runTool(["readiness", tmpRepo]);
    assert.equal(r2.json.maxEligibleTrustLevel, "T2");
    assert.equal(r2.json.effectiveTrustLevel, "T2");

    fs.mkdirSync(path.join(tmpRepo, ".agents", "skills", "verify-demo", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".agents", "skills", "verify-demo", "scripts", "verify-ctl.mjs"), "console.log('ok');\n");
    fs.writeFileSync(
      path.join(tmpRepo, ".agents", "zee.project.json"),
      JSON.stringify({
        trustLevel: "T3",
        testCmds: ["node --test"],
        lintCmd: "npm run lint",
        denyCommands: ["--live"],
        riskPaths: ["src/auth/**"],
        pathSkills: [
          { glob: "src/auth/**", skill: "auth-guard", roles: ["coder", "reviewer"] },
          { glob: "docs/*.md", skill: "docs/style-skill.md" },
        ],
      }),
    );
    const r3 = runTool(["readiness", tmpRepo]);
    assert.equal(r3.json.maxEligibleTrustLevel, "T3");
    assert.equal(r3.json.effectiveTrustLevel, "T3");
    assert.equal(r3.json.clamped, false);

    // doctor --repo exposes readiness without failing doctor due to readiness
    const doc = runTool(["doctor", "--repo", tmpRepo], false);
    assert.equal(doc.json.readiness.effectiveTrustLevel, "T3");

    // 4. match-skills
    fs.mkdirSync(path.join(tmpRepo, ".agents", "skills", "auth-guard"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".agents", "skills", "auth-guard", "SKILL.md"), "# auth-guard\n");
    fs.mkdirSync(path.join(tmpRepo, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "docs", "style-skill.md"), "# style\n");

    const msCoder = runTool(["match-skills", "--repo", tmpRepo, "--files", "src/auth/login.ts,docs/guide.md", "--role", "coder"]);
    assert.equal(msCoder.json.matched.length, 2);
    const msScout = runTool(["match-skills", "--repo", tmpRepo, "--files", "src/auth/login.ts,docs/guide.md", "--role", "scout"]);
    assert.equal(msScout.json.matched.length, 1);
    assert.equal(msScout.json.matched[0].skill, "docs/style-skill.md");

    // 5. update-state --delegate-id idempotent deduplication + 200 cap
    const init = runTool(["init-run", tmpRepo, "dedup-test"]);
    busDir = init.json.busDir;
    const d1 = runTool(["update-state", busDir, "--inc-delegates", "--delegate-id", "call-1"]);
    assert.equal(d1.json.state.delegatesDispatched, 1);
    const d2 = runTool(["update-state", busDir, "--inc-delegates", "--delegate-id", "call-1"]);
    assert.equal(d2.json.state.delegatesDispatched, 1);
    const d3 = runTool(["update-state", busDir, "--delegate-id", "call-2"]);
    assert.equal(d3.json.state.delegatesDispatched, 2);

    const statePath = path.join(busDir, "state.json");
    const stSeed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    stSeed.countedDelegateIds = Array.from({ length: 200 }, (_, i) => `id-${i}`);
    fs.writeFileSync(statePath, JSON.stringify(stSeed, null, 2));
    const dCap = runTool(["update-state", busDir, "--inc-delegates", "--delegate-id", "id-200"]);
    assert.equal(dCap.json.state.countedDelegateIds.length, 200);
    assert.equal(dCap.json.state.countedDelegateIds[0], "id-1");
    assert.equal(dCap.json.state.countedDelegateIds[199], "id-200");

    // 6. resolve-model --allow-standalone
    const stAgy = runTool(["resolve-model", "--harness", "agy", "--role", "scout", "--config", path.join(tmpRepo, "missing.json"), "--allow-standalone"]);
    assert.equal(stAgy.json.ok, true);
    assert.equal(stAgy.json.standalone, true);
    assert.equal(stAgy.json.resolved.model, "inherit");
    const stPi = runTool(["resolve-model", "--harness", "pi", "--role", "coder", "--config", path.join(tmpRepo, "missing.json"), "--allow-standalone"]);
    assert.equal(stPi.json.ok, true);
    assert.equal(stPi.json.standalone, true);
    assert.equal(stPi.json.resolved.model, null);

    // 7. scripts/install.mjs --help prints v4.2.0
    const instRes = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "install.mjs"), "--help"], { encoding: "utf8" });
    assert.equal(instRes.status, 0);
    assert.match(instRes.stdout, /v4\.2\.0/);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
    if (busDir) fs.rmSync(path.dirname(busDir), { recursive: true, force: true });
  }
});
