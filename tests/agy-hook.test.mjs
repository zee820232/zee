import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGY_GUARD = path.join(REPO_ROOT, "scripts", "agy-guard.mjs");
const ZEE_TOOL = path.join(REPO_ROOT, "skills", "zee", "scripts", "zee-tool.mjs");

function runHook(payload, { env = {} } = {}) {
  const res = spawnSync(process.execPath, [AGY_GUARD], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(res.status, 0, `agy-guard 非法退出: ${res.stderr}`);
  return JSON.parse(res.stdout.trim() || "{}");
}

test("PreToolUse 安全命令返回空对象 {}，非 run_command 与未知事件直接透传", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-agy-safe-"));
  try {
    assert.deepEqual(
      runHook({ hookEventName: "PreToolUse", cwd: repo, toolCall: { name: "read_file", args: { Path: "a.txt" } } }),
      {},
    );
    assert.deepEqual(
      runHook({ hookEventName: "PreToolUse", cwd: repo, toolCall: { name: "run_command", args: { CommandLine: "git status" } } }),
      {},
    );
    // 未知事件（如 PostToolUse）绝不误路由进 PreToolUse 拦截
    assert.deepEqual(
      runHook({ hookEventName: "PostToolUse", cwd: repo, toolCall: { name: "run_command", args: { CommandLine: "rm -rf /" } } }),
      {},
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("PreToolUse 拦截破坏性命令（交互态 force_ask，无头/过夜态 deny）与 denyCommands", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-agy-guard-"));
  try {
    fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".agents", "zee.project.json"), JSON.stringify({ denyCommands: ["npm publish"] }), "utf8");

    const denyRes = runHook({
      hookEventName: "PreToolUse",
      cwd: repo,
      toolCall: { name: "run_command", args: { CommandLine: "npm publish" } },
    });
    assert.equal(denyRes.decision, "deny");

    const askRes = runHook(
      {
        hookEventName: "PreToolUse",
        cwd: repo,
        toolCall: { name: "run_command", args: { CommandLine: "git push --force origin main" } },
      },
      { env: { CI: "", NON_INTERACTIVE: "", HEADLESS: "" } },
    );
    assert.equal(askRes.decision, "force_ask");

    const headlessRes = runHook(
      {
        hookEventName: "PreToolUse",
        cwd: repo,
        toolCall: { name: "run_command", args: { CommandLine: "git push --force origin main" } },
      },
      { env: { CI: "1" } },
    );
    assert.equal(headlessRes.decision, "deny");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Stop Hook 在 night running 且完全空闲时阻止静默断尾，非同会话或完成后放行", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-agy-stop-"));
  const cid = `cid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let busDir = "";
  try {
    const init = JSON.parse(
      execFileSync(process.execPath, [ZEE_TOOL, "init-run", repo, "night-eval", "--mode", "night", "--conversation-id", cid], {
        encoding: "utf8",
      }),
    );
    busDir = init.busDir;
    execFileSync(process.execPath, [ZEE_TOOL, "update-state", busDir, "--status", "running", "--mode", "night"], {
      encoding: "utf8",
    });

    const blocked = runHook({
      hookEventName: "Stop",
      cwd: repo,
      conversationId: cid,
      fullyIdle: true,
      continuationActive: false,
      terminationReason: "NO_TOOL_CALL",
    });
    assert.equal(blocked.decision, "continue");
    assert.match(blocked.reason, /night-eval/);

    assert.deepEqual(
      runHook({
        hookEventName: "Stop",
        cwd: repo,
        conversationId: "other-conversation",
        fullyIdle: true,
        continuationActive: false,
      }),
      {},
    );

    execFileSync(process.execPath, [ZEE_TOOL, "update-state", busDir, "--status", "completed"], { encoding: "utf8" });
    assert.deepEqual(
      runHook({
        hookEventName: "Stop",
        cwd: repo,
        conversationId: cid,
        fullyIdle: true,
        continuationActive: false,
      }),
      {},
    );

    // 超过 24h 的陈旧 running night 总线应放行，不再永久卡死 Stop
    const sp = path.join(busDir, "state.json");
    const st = JSON.parse(fs.readFileSync(sp, "utf8"));
    st.status = "running";
    st.updatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(sp, JSON.stringify(st, null, 2), "utf8");
    assert.deepEqual(
      runHook({
        hookEventName: "Stop",
        cwd: repo,
        conversationId: cid,
        fullyIdle: true,
        continuationActive: false,
      }),
      {},
    );
  } finally {
    if (busDir) fs.rmSync(path.dirname(busDir), { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("v5.2.0 Stop Hook 四大边界：严防 null 跨会话劫持、多轮续命与无进展止损、子目录溯源与不被 completed 遮蔽", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-agy-stop-v52-"));
  const subDir = path.join(repo, "packages", "web");
  fs.mkdirSync(subDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const cid = `cid-v52-${Date.now()}`;
  let repoRunsParent = "";
  try {
    // 1. conversationId=null 的夜跑记录，绝不能跨会话劫持带 conversationId 的无关窗口
    const noCid = JSON.parse(
      execFileSync(process.execPath, [ZEE_TOOL, "init-run", repo, "night-no-cid", "--mode", "night"], { encoding: "utf8" }),
    );
    repoRunsParent = path.dirname(noCid.busDir);
    execFileSync(process.execPath, [ZEE_TOOL, "update-state", noCid.busDir, "--status", "running", "--mode", "night"], { encoding: "utf8" });

    assert.deepEqual(
      runHook({
        hookEventName: "Stop",
        cwd: repo,
        conversationId: "unrelated-window-id",
        fullyIdle: true,
        continuationActive: false,
        terminationReason: "NO_TOOL_CALL",
      }),
      {},
      "conversationId=null 的夜跑总线不得跨会话劫持带 ID 的普通会话",
    );

    // 2. 子目录 cwd 溯源仓根 + 存在更新的 completed 总线不遮蔽活跃 running 总线
    const activeRun = JSON.parse(
      execFileSync(process.execPath, [ZEE_TOOL, "init-run", repo, "night-active", "--mode", "night", "--conversation-id", cid], {
        encoding: "utf8",
      }),
    );
    execFileSync(
      process.execPath,
      [ZEE_TOOL, "update-state", activeRun.busDir, "--status", "running", "--mode", "night", "--unit-upsert", JSON.stringify({ id: "U1", status: "pending" })],
      { encoding: "utf8" },
    );
    const doneRun = JSON.parse(
      execFileSync(process.execPath, [ZEE_TOOL, "init-run", repo, "night-newer-done", "--mode", "night", "--conversation-id", cid], {
        encoding: "utf8",
      }),
    );
    execFileSync(process.execPath, [ZEE_TOOL, "update-state", doneRun.busDir, "--status", "completed", "--mode", "night"], {
      encoding: "utf8",
    });

    // continuationActive=true 且位于子目录 packages/web，依然正确续命并提示待完成单元 U1
    const cont1 = runHook({
      hookEventName: "Stop",
      cwd: subDir,
      conversationId: cid,
      executionNum: 1,
      fullyIdle: true,
      continuationActive: true,
      terminationReason: "NO_TOOL_CALL",
    });
    assert.equal(cont1.decision, "continue");
    assert.match(cont1.reason, /night-active/);
    assert.match(cont1.reason, /U1/);

    // 3. 连续无进展熔断：如果 state.updatedAt 连续 2 次唤醒毫无变化，自动放行防死循环
    const cont2 = runHook({
      hookEventName: "Stop",
      cwd: subDir,
      conversationId: cid,
      executionNum: 2,
      fullyIdle: true,
      continuationActive: true,
      terminationReason: "NO_TOOL_CALL",
    });
    assert.equal(cont2.decision, "continue");
    const stagnantStop = runHook({
      hookEventName: "Stop",
      cwd: subDir,
      conversationId: cid,
      executionNum: 3,
      fullyIdle: true,
      continuationActive: true,
      terminationReason: "NO_TOOL_CALL",
    });
    assert.deepEqual(stagnantStop, {}, "连续 2 次唤醒无状态推进必须放行止损");

    // 超过最大续命次数直接放行
    execFileSync(process.execPath, [ZEE_TOOL, "update-state", activeRun.busDir, "--status", "running"], { encoding: "utf8" });
    assert.deepEqual(
      runHook(
        {
          hookEventName: "Stop",
          cwd: repo,
          conversationId: cid,
          executionNum: 8,
          fullyIdle: true,
          continuationActive: true,
          terminationReason: "NO_TOOL_CALL",
        },
        { env: { ZEE_MAX_NIGHT_CONTINUATIONS: "8" } },
      ),
      {},
    );
  } finally {
    if (repoRunsParent) fs.rmSync(repoRunsParent, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
