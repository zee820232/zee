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
