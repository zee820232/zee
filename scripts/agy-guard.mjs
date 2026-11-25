#!/usr/bin/env node
/**
 * Google Antigravity Lifecycle Hook for zee (PreInvocation + PreToolUse + Stop)
 *
 * 1. 所有安全透传路径严格返回空对象 {}（跨新旧全部 AGY 版本零副作用，绝不静默 auto_approve）。
 * 2. PreInvocation 按 conversationId 将 plan / review / init-design / night 状态持久化到 $PLUGIN_DATA/sessions/，
 *    彻底解决 /zee-plan 多轮访谈第 2 轮掉锁问题；非 zee 普通对话零文件创建、零 token 注入。
 * 3. PreToolUse 共用 skills/zee/scripts/lib/guard-core.mjs 执行：
 *    - 项目 denyCommands 穿透子 shell 硬拦截（deny）
 *    - 通用破坏性命令（rm -rf /、主干强推、DROP DATABASE）交互态 force_ask / 无头或过夜态 deny
 *    - plan / review / init-design 路径写锁（含白名单目录 mkdir/cp/touch/tee 与 zee-tool.mjs 精准放行）
 * 4. Stop 仅在 mode==="night" && fullyIdle && !continuationActive 且 state.json 未完成/未暂停时介入，防过夜静默断尾。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  RUNS_ROOT,
  checkBashUnderGate,
  checkProjectDenyCommands,
  evaluateDestructiveCommand,
  isWriteAllowedUnderGate,
} from "../skills/zee/scripts/lib/guard-core.mjs";

const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
]);

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function respond(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function getSessionDir() {
  if (process.env.PLUGIN_DATA && process.env.PLUGIN_DATA.trim()) {
    return path.join(process.env.PLUGIN_DATA.trim(), "sessions");
  }
  return path.join(os.homedir(), ".local", "state", "zee", "agy-locks");
}

function sanitizeId(raw) {
  return String(raw || "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

function sessionFilePath(conversationId) {
  const safe = sanitizeId(conversationId);
  if (!safe) return "";
  return path.join(getSessionDir(), `${safe}.json`);
}

function pruneStaleSessions(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const full = path.join(dir, file);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > SESSION_TTL_MS) {
          fs.unlinkSync(full);
        }
      } catch {}
    }
  } catch {}
}

function loadSessionState(conversationId) {
  const fp = sessionFilePath(conversationId);
  if (!fp || !fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function saveSessionState(conversationId, state) {
  const fp = sessionFilePath(conversationId);
  if (!fp) return;
  try {
    const dir = path.dirname(fp);
    fs.mkdirSync(dir, { recursive: true });
    pruneStaleSessions(dir);
    const tmp = `${fp}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, fp);
  } catch {}
}

function clearSessionState(conversationId) {
  const fp = sessionFilePath(conversationId);
  if (!fp) return;
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}
}

function isWorkerPrompt(text) {
  const s = String(text || "");
  return (
    s.includes("[zee-worker]") ||
    s.includes("# zee Worker Standing Contract") ||
    s.includes("You are already running as a delegate")
  );
}

function isHeadless(sessionState) {
  if (sessionState?.mode === "night") return true;
  return Boolean(
    process.env.CI === "true" ||
      process.env.CI === "1" ||
      process.env.NON_INTERACTIVE === "1" ||
      process.env.HEADLESS === "1",
  );
}

function parseUserIntent(lastUserInput) {
  const trimmed = String(lastUserInput || "").trim();
  if (!trimmed || isWorkerPrompt(trimmed)) return { kind: "ignore" };

  if (/^\/zee-plan\b/i.test(trimmed) || /^\/zee\s+plan\b/i.test(trimmed)) {
    return { kind: "set", gate: "plan", mode: "standard" };
  }
  if (/^\/zee-review\b/i.test(trimmed) || /^\/zee\s+review\b/i.test(trimmed)) {
    return { kind: "set", gate: "review", mode: "standard" };
  }
  if (/^\/zee-init\b/i.test(trimmed) || /^\/zee\s+init\b/i.test(trimmed)) {
    return { kind: "set", gate: "init-design", mode: "standard" };
  }
  if (/^\/zee-night\b/i.test(trimmed) || /^\/zee\s+night\b/i.test(trimmed)) {
    return { kind: "set", gate: "none", mode: "night" };
  }
  if (/^\/zee(?:-setup)?\b/i.test(trimmed)) {
    return { kind: "clear" };
  }
  if (/^(解锁|解除锁定|开始写代码|开始实现|执行计划)\b/.test(trimmed)) {
    return { kind: "clear" };
  }
  return { kind: "followup" };
}

function extractTargetPath(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["Path", "path", "TargetFile", "targetFile", "AbsolutePath", "absolutePath", "filePath"]) {
    if (typeof args[key] === "string" && args[key].trim()) return args[key];
  }
  return "";
}

function extractCommand(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["CommandLine", "commandLine", "command", "Command"]) {
    if (typeof args[key] === "string" && args[key].trim()) return args[key];
  }
  return "";
}

function isInitBootstrapDone(cwd) {
  if (!cwd) return false;
  return fs.existsSync(path.join(cwd, ".agents", "zee.project.json"));
}

function handlePreInvocation(payload, cwd) {
  const cid = payload?.conversationId || "";
  const intent = parseUserIntent(payload?.lastUserInput);

  if (intent.kind === "set") {
    if (cid) {
      saveSessionState(cid, { gate: intent.gate, mode: intent.mode, cwd });
    }
    respond({});
    return;
  }

  if (intent.kind === "clear") {
    if (cid) clearSessionState(cid);
    respond({});
    return;
  }

  // 非 zee 对话或无状态会话：零副作用透传
  const existing = cid ? loadSessionState(cid) : null;
  if (!existing) {
    respond({});
    return;
  }

  // init-design 在 M0 写出 .agents/zee.project.json 后自动解锁
  if (existing.gate === "init-design" && isInitBootstrapDone(cwd)) {
    saveSessionState(cid, { ...existing, gate: "none" });
    respond({});
    return;
  }

  // 审查锁仅限单轮，用户进入下一轮非 /zee-review 对话时释放
  if (existing.gate === "review" && intent.kind === "followup") {
    clearSessionState(cid);
    respond({});
    return;
  }

  respond({});
}

function handlePreToolUse(payload, cwd) {
  const cid = payload?.conversationId || "";
  const toolName = String(payload?.toolCall?.name || "");
  const args = payload?.toolCall?.args || {};
  const artifactDir = payload?.artifactDirectoryPath || "";
  const extraDirs = artifactDir ? [artifactDir] : [];

  const sessionState = cid ? loadSessionState(cid) : null;
  let gateMode = sessionState?.gate || "none";
  // 兼容单测或未触发 PreInvocation 时的直接 PreToolUse 调用
  if (gateMode === "none") {
    const intent = parseUserIntent(payload?.lastUserInput);
    if (intent.kind === "set") gateMode = intent.gate;
  }
  // init-design 在 M0 落盘后自动解锁
  if (gateMode === "init-design" && isInitBootstrapDone(cwd)) {
    gateMode = "none";
    if (cid && sessionState) saveSessionState(cid, { ...sessionState, gate: "none" });
  }

  const workerCall = isWorkerPrompt(payload?.lastUserInput);

  // 1. run_command：无条件执行项目 denyCommands 与破坏性命令护栏；锁态下再执行路径/写命令拦截
  if (toolName === "run_command") {
    const cmd = extractCommand(args);

    const denyReason = checkProjectDenyCommands(cmd, cwd);
    if (denyReason) {
      respond({ decision: "deny", reason: denyReason });
      return;
    }

    const destructive = evaluateDestructiveCommand(cmd, cwd);
    if (destructive) {
      const decision = isHeadless(sessionState) ? "deny" : "force_ask";
      respond({
        decision,
        reason: `[zee 安全护栏] ${destructive.reason}。请人工确认后方可继续。`,
      });
      return;
    }

    if (gateMode !== "none" && (!workerCall || gateMode === "review")) {
      const gateViolation = checkBashUnderGate(cmd, cwd, gateMode, extraDirs);
      if (gateViolation) {
        respond({ decision: "deny", reason: gateViolation });
        return;
      }
    }

    // 安全透传：一律返回空对象 {}
    respond({});
    return;
  }

  // 2. 文件写工具：锁态下执行路径白名单拦截
  if (gateMode !== "none" && WRITE_TOOLS.has(toolName) && (!workerCall || gateMode === "review")) {
    const rawPath = extractTargetPath(args);
    if (rawPath) {
      const allowed = isWriteAllowedUnderGate(rawPath, cwd, gateMode, extraDirs);
      if (!allowed) {
        const hintMap = {
          plan: "~/.local/state/zee/runs/、.scratch/、docs/plans/ 或 Antigravity Artifact 目录",
          "init-design": "~/.local/state/zee/runs/、.scratch/、.agents/、SPEC/ARCHITECTURE/DESIGN.md 或 Artifact 目录",
          review: "~/.local/state/zee/runs/ 或 Antigravity Artifact 目录",
        };
        respond({
          decision: "deny",
          reason: `当前处于 zee-${gateMode} 保护锁，禁止修改 "${rawPath}"（仅允许写入 ${hintMap[gateMode] || "~/.local/state/zee/runs/"}）。如需开始写代码，请调用 /zee 执行计划。`,
        });
        return;
      }
    }
  }

  // 安全透传：一律返回空对象 {}
  respond({});
}

function findLatestNightStateForRepo(cwd) {
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
      if (!latest || String(st.updatedAt || "").localeCompare(String(latest.updatedAt || "")) > 0) {
        latest = st;
      }
    } catch {}
  }
  return latest;
}

function handleStop(payload, cwd) {
  const cid = payload?.conversationId || "";
  const sessionState = cid ? loadSessionState(cid) : null;
  if (!sessionState || sessionState.mode !== "night") {
    respond({});
    return;
  }

  // 防止死循环：仅在完全空闲、正常无工具结束、且尚未由 Stop 续跑过时介入一次
  if (
    payload?.fullyIdle !== true ||
    payload?.continuationActive === true ||
    (payload?.terminationReason && payload.terminationReason !== "NO_TOOL_CALL")
  ) {
    respond({});
    return;
  }

  const nightState = findLatestNightStateForRepo(cwd || sessionState.cwd);
  const terminalStatuses = new Set(["completed", "paused", "planned"]);
  if (nightState && !terminalStatuses.has(String(nightState.status || ""))) {
    respond({
      decision: "continue",
      reason: `[zee-night] 检测到当前过夜任务 (${nightState.slug}) 仍处于 status="${nightState.status}" 且尚未交付最终中文晨报或安全暂停。请先用 zee-tool.mjs update-state 更新 state.json 并输出中文晨报后再结束回合。`,
    });
    return;
  }

  respond({});
}

function main() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    respond({});
    return;
  }
  if (!raw.trim()) {
    respond({});
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    respond({});
    return;
  }

  const cwd =
    payload?.cwd ||
    (Array.isArray(payload?.workspacePaths) ? payload.workspacePaths[0] : "") ||
    process.cwd();
  const eventName = String(payload?.hookEventName || "PreToolUse");

  if (eventName === "PreInvocation") {
    handlePreInvocation(payload, cwd);
    return;
  }
  if (eventName === "Stop") {
    handleStop(payload, cwd);
    return;
  }
  handlePreToolUse(payload, cwd);
}

main();
