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

test("PreToolUse 安全命令返回空对象 {}，非 run_command 直接透传", () => {
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
  } finally {
    if (busDir) fs.rmSync(path.dirname(busDir), { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
