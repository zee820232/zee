#!/usr/bin/env node
/**
 * Google Antigravity Lifecycle Hook for zee v5.0.0 (PreToolUse + Stop)
 *
 * 1. 所有安全透传路径严格返回空对象 {}（绝不返回 allow）。
 * 2. PreToolUse 仅拦截项目 denyCommands 与不可逆破坏性命令（交互态 force_ask / 无头或过夜 deny）。
 * 3. Stop 仅在存在活跃 mode==="night" && status==="running" 的对应 conversationId 运行总线、
 *    且 fullyIdle && !continuationActive 时阻止静默断尾。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  RUNS_ROOT,
  checkProjectDenyCommands,
  evaluateDestructiveCommand,
} from "../skills/zee/scripts/lib/guard-core.mjs";

function respond(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function findLatestNightState(cwd, conversationId = "") {
  if (!cwd || !fs.existsSync(RUNS_ROOT)) return null;
  const absRepo = path.resolve(cwd);
  const base = path.basename(absRepo).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "task";
  const hash = crypto.createHash("sha256").update(absRepo).digest("hex").slice(0, 8);
  const repoRunDir = path.join(RUNS_ROOT, `${base}-${hash}`);
  if (!fs.existsSync(repoRunDir)) return null;

  let latest = null;
  for (const slug of fs.readdirSync(repoRunDir)) {
    const sp = path.join(repoRunDir, slug, "state.json");
    if (!fs.existsSync(sp)) continue;
    try {
      const st = JSON.parse(fs.readFileSync(sp, "utf8"));
      if (st.mode !== "night") continue;
      if (st.conversationId && conversationId && st.conversationId !== conversationId) continue;
      if (!latest || String(st.updatedAt || "").localeCompare(String(latest.updatedAt || "")) > 0) latest = st;
    } catch {}
  }
  return latest;
}

function isHeadless(cwd, cid) {
  if (process.env.CI === "true" || process.env.CI === "1" || process.env.NON_INTERACTIVE === "1" || process.env.HEADLESS === "1") {
    return true;
  }
  const st = findLatestNightState(cwd, cid);
  return Boolean(st && st.status === "running");
}

function handlePreToolUse(payload, cwd) {
  if (String(payload?.toolCall?.name || "") !== "run_command") {
    respond({});
    return;
  }
  const args = payload?.toolCall?.args || {};
  const cmd = args.CommandLine || args.commandLine || args.command || args.Command || "";
  if (!cmd) {
    respond({});
    return;
  }
  const denyReason = checkProjectDenyCommands(cmd, cwd);
  if (denyReason) {
    respond({ decision: "deny", reason: denyReason });
    return;
  }
  const destructive = evaluateDestructiveCommand(cmd, cwd);
  if (destructive) {
    const decision = isHeadless(cwd, payload?.conversationId || "") ? "deny" : "force_ask";
    respond({ decision, reason: `[zee 安全护栏] ${destructive.reason}。请人工确认后方可继续。` });
    return;
  }
  respond({});
}

function handleStop(payload, cwd) {
  if (
    payload?.fullyIdle !== true ||
    payload?.continuationActive === true ||
    (payload?.terminationReason && payload.terminationReason !== "NO_TOOL_CALL")
  ) {
    respond({});
    return;
  }
  const nightState = findLatestNightState(cwd, payload?.conversationId || "");
  if (nightState && String(nightState.status || "") === "running") {
    respond({
      decision: "continue",
      reason: `[zee-night] 过夜任务 (${nightState.slug}) 仍处于 running 且尚未输出中文晨报，请更新 state.json 并输出晨报后再结束。`,
    });
    return;
  }
  respond({});
}

function main() {
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch { respond({}); return; }
  if (!raw.trim()) { respond({}); return; }
  let payload;
  try { payload = JSON.parse(raw); } catch { respond({}); return; }

  const cwd = payload?.cwd || (Array.isArray(payload?.workspacePaths) ? payload.workspacePaths[0] : "") || process.cwd();
  if (String(payload?.hookEventName || "PreToolUse") === "Stop") handleStop(payload, cwd);
  else handlePreToolUse(payload, cwd);
}

main();
