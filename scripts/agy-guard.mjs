#!/usr/bin/env node
/**
 * Google Antigravity Lifecycle Hook for zee v5.2.0 (Stop + standalone PreToolUse helper)
 *
 * 1. Antigravity PreToolUse 协议要求 decision ∈ {"allow","deny","ask","force_ask"}，无透传项；
 *    为避免空对象 {} 误拦普通 run_command（或 "allow" 越权绕过用户审批），hooks.json 在 AGY 下仅挂载 Stop。
 * 2. Stop 在存在活跃（24h 内）mode==="night" && status==="running" 且严格匹配当前 conversationId 的运行总线、
 *    fullyIdle === true 且未超出续命上限/连续无进展熔断时阻止静默断尾（安全透传严格返回 {}）。
 * 3. handlePreToolUse 仅当 hookEventName === "PreToolUse" 时执行，其余未知事件一律透传 {}。
 */

import fs from "node:fs";
import path from "node:path";
import {
  RUNS_ROOT,
  checkProjectDenyCommands,
  evaluateDestructiveCommand,
} from "../skills/zee/scripts/lib/guard-core.mjs";
import { atomicWriteJson } from "../skills/zee/scripts/lib/fs-atomic.mjs";
import { repoKeyCandidates, resolveGitRoot } from "../skills/zee/scripts/lib/repo-utils.mjs";

const DEFAULT_NIGHT_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_NIGHT_CONTINUATIONS = 8;
const MAX_STAGNANT_WAKEUPS = 2;

function getNightStaleMs() {
  const n = Number(process.env.ZEE_NIGHT_STALE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_NIGHT_STALE_MS;
}

function getMaxNightContinuations() {
  const n = Number(process.env.ZEE_MAX_NIGHT_CONTINUATIONS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_NIGHT_CONTINUATIONS;
}

function respond(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function collectCandidateRepoKeys(cwd, workspacePaths = []) {
  const rawDirs = [];
  if (cwd) rawDirs.push(cwd);
  if (Array.isArray(workspacePaths)) {
    for (const p of workspacePaths) {
      if (typeof p === "string" && p.trim()) rawDirs.push(p.trim());
    }
  }
  const keySet = new Set();
  for (const dir of rawDirs) {
    repoKeyCandidates(dir).forEach((k) => keySet.add(k));
    const gitTop = resolveGitRoot(dir);
    if (gitTop) repoKeyCandidates(gitTop).forEach((k) => keySet.add(k));
  }
  return [...keySet];
}

function findActiveNightRun(cwd, workspacePaths = [], conversationId = "") {
  if (!fs.existsSync(RUNS_ROOT)) return null;
  const candidateKeys = collectCandidateRepoKeys(cwd, workspacePaths);
  if (candidateKeys.length === 0) return null;

  const maxAgeMs = getNightStaleMs();
  const now = Date.now();
  const cid = String(conversationId || "").trim();

  let latest = null;
  let latestTsMs = -1;

  for (const key of candidateKeys) {
    const repoRunDir = path.join(RUNS_ROOT, key);
    if (!fs.existsSync(repoRunDir)) continue;
    for (const slug of fs.readdirSync(repoRunDir)) {
      const runDir = path.join(repoRunDir, slug);
      const sp = path.join(runDir, "state.json");
      if (!fs.existsSync(sp)) continue;
      try {
        const st = JSON.parse(fs.readFileSync(sp, "utf8"));
        if (st.mode !== "night" || String(st.status || "") !== "running") continue;

        // 严格会话隔离：payload 带 conversationId 时仅匹配相同 conversationId，杜绝 null 跨会话劫持普通窗口
        const stateCid = String(st.conversationId || "").trim();
        if (cid) {
          if (!stateCid || stateCid !== cid) continue;
        }

        const tsMs = Date.parse(st.updatedAt || st.createdAt || "") || fs.statSync(sp).mtimeMs;
        if (Number.isFinite(tsMs) && now - tsMs > maxAgeMs) continue;
        if (tsMs > latestTsMs) {
          latestTsMs = tsMs;
          latest = { state: st, busDir: runDir };
        }
      } catch {}
    }
  }
  return latest;
}

function isHeadless(cwd, workspacePaths, cid) {
  if (process.env.CI === "true" || process.env.CI === "1" || process.env.NON_INTERACTIVE === "1" || process.env.HEADLESS === "1") {
    return true;
  }
  return Boolean(findActiveNightRun(cwd, workspacePaths, cid));
}

function checkAndRecordStopProgress(busDir, stateUpdatedAt) {
  const guardPath = path.join(busDir, ".stop-guard.json");
  let stagnantCount = 0;
  try {
    if (fs.existsSync(guardPath)) {
      const prev = JSON.parse(fs.readFileSync(guardPath, "utf8"));
      if (prev && prev.lastStateUpdatedAt === stateUpdatedAt) {
        stagnantCount = (Number(prev.stagnantCount) || 0) + 1;
      }
    }
  } catch {}
  try {
    atomicWriteJson(guardPath, {
      lastStateUpdatedAt: stateUpdatedAt || "",
      stagnantCount,
      updatedAt: new Date().toISOString(),
    });
  } catch {}
  return stagnantCount;
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
    const decision = isHeadless(cwd, payload?.workspacePaths, payload?.conversationId || "") ? "deny" : "force_ask";
    respond({ decision, reason: `[zee 安全护栏] ${destructive.reason}。请人工确认后方可继续。` });
    return;
  }
  respond({});
}

function handleStop(payload, cwd) {
  if (
    payload?.fullyIdle !== true ||
    (payload?.terminationReason && payload.terminationReason !== "NO_TOOL_CALL")
  ) {
    respond({});
    return;
  }
  const maxContinuations = getMaxNightContinuations();
  const executionNum = Number(payload?.executionNum) || 0;
  if (executionNum >= maxContinuations) {
    respond({});
    return;
  }

  const active = findActiveNightRun(cwd, payload?.workspacePaths, payload?.conversationId || "");
  if (!active) {
    respond({});
    return;
  }

  const { state, busDir } = active;
  const stagnantCount = checkAndRecordStopProgress(busDir, String(state.updatedAt || ""));
  if (stagnantCount >= MAX_STAGNANT_WAKEUPS) {
    respond({});
    return;
  }

  const pendingUnits = Array.isArray(state.units)
    ? state.units.filter((u) => u && (u.status === "pending" || u.status === "in_progress")).map((u) => u.id)
    : [];
  const nextHint = pendingUnits.length > 0
    ? `尚有未完成单元 (${pendingUnits.slice(0, 5).join(", ")})，请继续自动推进并及时 update-state；`
    : "请完成终审并输出中文晨报 morning-report.md，";

  respond({
    decision: "continue",
    reason: `[zee-night] 过夜任务 (${state.slug}) 仍处于 running，${nextHint}若全部完成或触发两败熔断，请将 state.json 更新为 completed 或 handoff 后再结束。`,
  });
}

function main() {
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch { respond({}); return; }
  if (!raw.trim()) { respond({}); return; }
  let payload;
  try { payload = JSON.parse(raw); } catch { respond({}); return; }

  const cwd = payload?.cwd || (Array.isArray(payload?.workspacePaths) ? payload.workspacePaths[0] : "") || process.cwd();
  const eventName = String(payload?.hookEventName || "");
  if (eventName === "Stop") handleStop(payload, cwd);
  else if (eventName === "PreToolUse") handlePreToolUse(payload, cwd);
  else respond({});
}

main();
