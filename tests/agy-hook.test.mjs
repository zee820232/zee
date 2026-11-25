import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RUNS_ROOT } from "../skills/zee/scripts/lib/guard-core.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_SCRIPT = path.join(REPO_ROOT, "scripts", "agy-guard.mjs");

function runHook(payload, extraEnv = {}) {
  const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  assert.equal(res.status, 0, `Hook exited ${res.status}: ${res.stderr}`);
  return JSON.parse((res.stdout || "").trim());
}

test("agy-guard 安全透传返回空对象 {}（绝不返回 decision: allow）", () => {
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "zee-pdata-"));
  try {
    const out = runHook(
      {
        hookEventName: "PreToolUse",
        conversationId: "conv-safe-1",
        cwd: REPO_ROOT,
        lastUserInput: "解释一下这个函数",
        toolCall: { name: "run_command", args: { CommandLine: "git status" } },
      },
      { PLUGIN_DATA: pluginData },
    );
    assert.deepEqual(out, {});
    // 非 zee 普通会话零状态文件创建
    assert.equal(fs.existsSync(path.join(pluginData, "sessions")), false);
  } finally {
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});

test("agy-guard 跨回合持久保持 /zee-plan 锁（修复第 2 轮访谈掉锁 Bug）并放行白名单 cp", () => {
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "zee-pdata-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-repo-"));
  try {
    const cid = "conv-plan-multiturn";
    // 第 1 轮：用户输入 /zee-plan
    assert.deepEqual(
      runHook(
        { hookEventName: "PreInvocation", conversationId: cid, cwd: repoDir, lastUserInput: "/zee-plan 设计马里奥物理引擎" },
        { PLUGIN_DATA: pluginData },
      ),
      {},
    );

    // 第 2 轮：用户回答 Grill 访谈（不再有 /zee-plan 前缀！）
    assert.deepEqual(
      runHook(
        { hookEventName: "PreInvocation", conversationId: cid, cwd: repoDir, lastUserInput: "1选A，其余按推荐" },
        { PLUGIN_DATA: pluginData },
      ),
      {},
    );

    // 第 2 轮尝试写业务代码 -> 必须继续被锁拦截！
    const blocked = runHook(
      {
        hookEventName: "PreToolUse",
        conversationId: cid,
        cwd: repoDir,
        lastUserInput: "1选A，其余按推荐",
        toolCall: { name: "write_file", args: { Path: path.join(repoDir, "src", "physics.ts") } },
      },
      { PLUGIN_DATA: pluginData },
    );
    assert.equal(blocked.decision, "deny");

    // 第 2 轮写 .scratch/plan.md 与 cp 到 .scratch/ -> 必须放行返回 {}
    const allowedWrite = runHook(
      {
        hookEventName: "PreToolUse",
        conversationId: cid,
        cwd: repoDir,
        lastUserInput: "1选A，其余按推荐",
        toolCall: { name: "write_file", args: { Path: path.join(repoDir, ".scratch", "mario", "plan.md") } },
      },
      { PLUGIN_DATA: pluginData },
    );
    assert.deepEqual(allowedWrite, {});

    const allowedCp = runHook(
      {
        hookEventName: "PreToolUse",
        conversationId: cid,
        cwd: repoDir,
        lastUserInput: "1选A，其余按推荐",
        toolCall: {
          name: "run_command",
          args: { CommandLine: `mkdir -p .scratch/mario && cp "${RUNS_ROOT}/x/plan.md" .scratch/mario/plan.md` },
        },
      },
      { PLUGIN_DATA: pluginData },
    );
    assert.deepEqual(allowedCp, {});

    // 第 3 轮：用户触发 /zee 执行计划 -> 自动解锁
    runHook(
      { hookEventName: "PreInvocation", conversationId: cid, cwd: repoDir, lastUserInput: "/zee 执行 .scratch/mario/plan.md" },
      { PLUGIN_DATA: pluginData },
    );
    const unlockedWrite = runHook(
      {
        hookEventName: "PreToolUse",
        conversationId: cid,
        cwd: repoDir,
        lastUserInput: "/zee 执行 .scratch/mario/plan.md",
        toolCall: { name: "write_file", args: { Path: path.join(repoDir, "src", "physics.ts") } },
      },
      { PLUGIN_DATA: pluginData },
    );
    assert.deepEqual(unlockedWrite, {});
  } finally {
    fs.rmSync(pluginData, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("agy-guard 破坏性命令区分交互 force_ask 与无头 deny", () => {
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "zee-pdata-"));
  try {
    const interactive = runHook(
      {
        hookEventName: "PreToolUse",
        conversationId: "conv-danger-int",
        cwd: REPO_ROOT,
        lastUserInput: "clean up",
        toolCall: { name: "run_command", args: { CommandLine: `bash -c "rm -rf /"` } },
      },
      { PLUGIN_DATA: pluginData, CI: "", NON_INTERACTIVE: "", HEADLESS: "" },
    );
    assert.equal(interactive.decision, "force_ask");

    const headless = runHook(
      {
        hookEventName: "PreToolUse",
        conversationId: "conv-danger-ci",
        cwd: REPO_ROOT,
        lastUserInput: "clean up",
        toolCall: { name: "run_command", args: { CommandLine: `bash -c "rm -rf /"` } },
      },
      { PLUGIN_DATA: pluginData, NON_INTERACTIVE: "1" },
    );
    assert.equal(headless.decision, "deny");
  } finally {
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});

test("agy-guard Stop Hook 仅在 night 模式未结项且未续跑过时返回 continue", () => {
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "zee-pdata-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-night-repo-"));
  const absRepo = path.resolve(repoDir);
  const hash = crypto.createHash("sha256").update(absRepo).digest("hex").slice(0, 8);
  const base = path.basename(absRepo).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const busDir = path.join(RUNS_ROOT, `${base}-${hash}`, "night-run");

  try {
    fs.mkdirSync(busDir, { recursive: true });
    fs.writeFileSync(
      path.join(busDir, "state.json"),
      JSON.stringify({ slug: "night-run", mode: "night", status: "running", updatedAt: new Date().toISOString() }),
    );

    const cid = "conv-night-stop";
    runHook(
      { hookEventName: "PreInvocation", conversationId: cid, cwd: absRepo, lastUserInput: "/zee-night 跑完所有切片" },
      { PLUGIN_DATA: pluginData },
    );

    // 首次未结项停止 -> 必须拦截 continue
    const firstStop = runHook(
      {
        hookEventName: "Stop",
        conversationId: cid,
        cwd: absRepo,
        fullyIdle: true,
        continuationActive: false,
        terminationReason: "NO_TOOL_CALL",
      },
      { PLUGIN_DATA: pluginData },
    );
    assert.equal(firstStop.decision, "continue");

    // continuationActive=true 时必须放行防止死循环
    const secondStop = runHook(
      {
        hookEventName: "Stop",
        conversationId: cid,
        cwd: absRepo,
        fullyIdle: true,
        continuationActive: true,
        terminationReason: "NO_TOOL_CALL",
      },
      { PLUGIN_DATA: pluginData },
    );
    assert.deepEqual(secondStop, {});
  } finally {
    fs.rmSync(pluginData, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(busDir), { recursive: true, force: true });
  }
});

test("v4.1 回归 [C4/H4]：Stop Hook 豁免 initialized/awaiting-approval 且按 conversationId 绑定、次日自动退出 night 态、独立子代理受写白名单保护", () => {
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v41-pdata-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v41-night-"));
  const absRepo = path.resolve(repoDir);
  const hash = crypto.createHash("sha256").update(absRepo).digest("hex").slice(0, 8);
  const base = path.basename(absRepo).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const busDir = path.join(RUNS_ROOT, `${base}-${hash}`, "night-c4");

  try {
    fs.mkdirSync(busDir, { recursive: true });
    const cid = "conv-night-c4";

    // 1. status="initialized"（等待 Trust Gate 人类确认）-> Stop 必须放行 {} 绝不抢跑！
    fs.writeFileSync(
      path.join(busDir, "state.json"),
      JSON.stringify({ slug: "night-c4", mode: "night", status: "initialized", conversationId: cid, updatedAt: new Date().toISOString() }),
    );
    runHook(
      { hookEventName: "PreInvocation", conversationId: cid, cwd: absRepo, lastUserInput: "/zee-night 跑完" },
      { PLUGIN_DATA: pluginData },
    );
    const waitingStop = runHook(
      { hookEventName: "Stop", conversationId: cid, cwd: absRepo, fullyIdle: true, continuationActive: false, terminationReason: "NO_TOOL_CALL" },
      { PLUGIN_DATA: pluginData },
    );
    assert.deepEqual(waitingStop, {});

    // 2. 其他会话的 running night 状态不误伤本会话
    fs.writeFileSync(
      path.join(busDir, "state.json"),
      JSON.stringify({ slug: "night-c4", mode: "night", status: "running", conversationId: "other-conv", updatedAt: new Date().toISOString() }),
    );
    const otherConvStop = runHook(
      { hookEventName: "Stop", conversationId: cid, cwd: absRepo, fullyIdle: true, continuationActive: false, terminationReason: "NO_TOOL_CALL" },
      { PLUGIN_DATA: pluginData },
    );
    assert.deepEqual(otherConvStop, {});

    // 3. 过夜完成后次日 followup 自动退出 night 模式（破坏性命令恢复为交互 force_ask 而非 headless deny）
    fs.writeFileSync(
      path.join(busDir, "state.json"),
      JSON.stringify({ slug: "night-c4", mode: "night", status: "completed", conversationId: cid, updatedAt: new Date().toISOString() }),
    );
    runHook(
      { hookEventName: "PreInvocation", conversationId: cid, cwd: absRepo, lastUserInput: "早上好，帮我看下日志" },
      { PLUGIN_DATA: pluginData },
    );
    const nextDayDanger = runHook(
      {
        hookEventName: "PreToolUse",
        conversationId: cid,
        cwd: absRepo,
        lastUserInput: "早上好，帮我看下日志",
        toolCall: { name: "run_command", args: { CommandLine: 'bash -e -c "rm -rf /"' } },
      },
      { PLUGIN_DATA: pluginData, CI: "", NON_INTERACTIVE: "", HEADLESS: "" },
    );
    assert.equal(nextDayDanger.decision, "force_ask");

    // 4. [H4] 独立 conversationId 的只读/门禁子代理（reviewer）尝试写业务源码 -> 必须拦截；写总线/tmp 放行
    const workerPrompt = "[zee-worker] Read /x/worker.md\nRole: /x/roles/reviewer.md | Bus: " + busDir;
    const workerBlock = runHook(
      {
        hookEventName: "PreToolUse",
        conversationId: "subagent-independent-cid",
        cwd: absRepo,
        lastUserInput: workerPrompt,
        toolCall: { name: "write_file", args: { Path: path.join(absRepo, "src", "hack.ts") } },
      },
      { PLUGIN_DATA: pluginData },
    );
    assert.equal(workerBlock.decision, "deny");

    const workerAllowBus = runHook(
      {
        hookEventName: "PreToolUse",
        conversationId: "subagent-independent-cid",
        cwd: absRepo,
        lastUserInput: workerPrompt,
        toolCall: { name: "write_file", args: { Path: path.join(busDir, "artifacts", "review-r1.md") } },
      },
      { PLUGIN_DATA: pluginData },
    );
    assert.deepEqual(workerAllowBus, {});

    // 5. v4.1.1: /zee-verify run 启用只读 review 锁，且 Scout /tmp/zee-probe-* 沙盒装包放行、(rm -rf /) 必拦截
    runHook(
      { hookEventName: "PreInvocation", conversationId: "conv-verify-run", cwd: absRepo, lastUserInput: "/zee-verify run" },
      { PLUGIN_DATA: pluginData },
    );
    const verifyRunBlock = runHook(
      {
        hookEventName: "PreToolUse",
        conversationId: "conv-verify-run",
        cwd: absRepo,
        lastUserInput: "/zee-verify run",
        toolCall: { name: "write_file", args: { Path: path.join(absRepo, "src", "edit.ts") } },
      },
      { PLUGIN_DATA: pluginData },
    );
    assert.equal(verifyRunBlock.decision, "deny");

    const parenBlock = runHook(
      {
        hookEventName: "PreToolUse",
        conversationId: "conv-paren",
        cwd: absRepo,
        lastUserInput: "clean",
        toolCall: { name: "run_command", args: { CommandLine: "(rm -rf /)" } },
      },
      { PLUGIN_DATA: pluginData, NON_INTERACTIVE: "1" },
    );
    assert.equal(parenBlock.decision, "deny");

    // 6. v4.2.0: Windows 反斜杠 Role 路径识别 + review 锁放行 .agents/gardening-queue.jsonl 与新 zee-tool.mjs 子命令
    const winWorkerPrompt = "[zee-worker] Read C:\\zee\\worker.md\nRole: C:\\zee\\skills\\zee\\roles\\reviewer.md | Bus: " + busDir;
    const winWorkerDeny = runHook(
      {
        hookEventName: "PreToolUse",
        conversationId: "subagent-win-role-cid",
        cwd: absRepo,
        lastUserInput: winWorkerPrompt,
        toolCall: { name: "write_file", args: { Path: path.join(absRepo, "src", "hack.ts") } },
      },
      { PLUGIN_DATA: pluginData },
    );
    assert.equal(winWorkerDeny.decision, "deny");

    const allowQueueInReview = runHook(
      {
        hookEventName: "PreToolUse",
        conversationId: "conv-verify-run",
        cwd: absRepo,
        lastUserInput: "/zee-verify run",
        toolCall: { name: "write_file", args: { Path: path.join(absRepo, ".agents", "gardening-queue.jsonl") } },
      },
      { PLUGIN_DATA: pluginData },
    );
    assert.deepEqual(allowQueueInReview, {});

    const toolScriptWin = path.join(REPO_ROOT, "skills", "zee", "scripts", "zee-tool.mjs");
    const allowSandboxExportInReview = runHook(
      {
        hookEventName: "PreToolUse",
        conversationId: "conv-verify-run",
        cwd: absRepo,
        lastUserInput: "/zee-verify run",
        toolCall: { name: "run_command", args: { CommandLine: `node "${toolScriptWin}" sandbox-export --repo "${absRepo}" --prefix mut` } },
      },
      { PLUGIN_DATA: pluginData },
    );
    assert.deepEqual(allowSandboxExportInReview, {});
  } finally {
    fs.rmSync(pluginData, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(busDir), { recursive: true, force: true });
  }
});
