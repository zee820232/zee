#!/usr/bin/env node
/**
 * Google Antigravity Lifecycle Hook for zee v5.1.0 (Stop + standalone PreToolUse helper)
 *
 * 1. Antigravity PreToolUse 协议要求 decision ∈ {"allow","deny","ask","force_ask"}，无透传项；
 *    为避免空对象 {} 误拦普通 run_command（或 "allow" 越权绕过用户审批），hooks.json 在 AGY 下仅挂载 Stop。
 * 2. Stop 在存在活跃（24h 内）mode==="night" && status==="running" 的对应 conversationId 运行总线、
 *    且 fullyIdle && !continuationActive 时阻止静默断尾（安全透传严格返回 {}）。
 * 3. handlePreToolUse 仍保留供直调或单测校验。
 */

import fs from "node:fs";
import path from "node:path";
import {
  RUNS_ROOT,
  checkProjectDenyCommands,
  evaluateDestructiveCommand,
} from "../skills/zee/scripts/lib/guard-core.mjs";
import { repoKeyCandidates } from "../skills/zee/scripts/lib/repo-utils.mjs";

const DEFAULT_NIGHT_STALE_MS = 24 * 60 * 60 * 1000;

function getNightStaleMs() {
  const n = Number(process.env.ZEE_NIGHT_STALE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_NIGHT_STALE_MS;
}

function respond(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function findLatestNightState(cwd, conversationId = "") {
  if (!cwd || !fs.existsSync(RUNS_ROOT)) return null;
  const maxAgeMs = getNightStaleMs();
  const now = Date.now();

  let latest = null;
  for (const key of repoKeyCandidates(cwd)) {
    const repoRunDir = path.join(RUNS_ROOT, key);
    if (!fs.existsSync(repoRunDir)) continue;
    for (const slug of fs.readdirSync(repoRunDir)) {
      const sp = path.join(repoRunDir, slug, "state.json");
      if (!fs.existsSync(sp)) continue;
      try {
        const st = JSON.parse(fs.readFileSync(sp, "utf8"));
        if (st.mode !== "night") continue;
        if (st.conversationId && conversationId && st.conversationId !== conversationId) continue;
        const tsMs = Date.parse(st.updatedAt || st.createdAt || "") || fs.statSync(sp).mtimeMs;
        if (Number.isFinite(tsMs) && now - tsMs > maxAgeMs) continue;
        if (!latest || String(st.updatedAt || "").localeCompare(String(latest.updatedAt || "")) > 0) latest = st;
      } catch {}
    }
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
