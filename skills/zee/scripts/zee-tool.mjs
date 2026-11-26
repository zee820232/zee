#!/usr/bin/env node
/**
 * zee-tool.mjs v5.0.5 — 精简高杠杆确定性 CLI 原语（13 核心子命令）
 *
 * 子命令：
 *   init-run <repoRoot> <slug> [--mode night|standard] [--conversation-id <cid>]
 *   update-state <busDir> [--status ...] [--mode ...] [--resume-next ...] [--budget '<json>'] [--unit-upsert '<json>'] [--units '<json-array>'] [--decision '<json>'] [--inc-delegates [N]] [--delegate-id <id>] [--inc-aborted [N]]
 *   log-decision <busDir> --unit <id> --phase <p> --decision <d> [--why <w>] [--evidence <e>] [--result <r>]
 *   list-runs [repoRoot | --all]
 *   worktree-create <repoRoot> <slug> <lane> <baseRef> [--branch <name>]
 *   cleanup-worktrees [repoRoot] [--base <ref>] [--prune-safe]
 *   sandbox-export --repo <repoRoot> [--sha <sha> | --working-tree] [--prefix rev|mut]
 *   sandbox-clean <sandboxDir>
 *   gate-tamper-diff --repo <repoRoot> [--base <ref>] [--head <ref> | --working-tree]
 *   recommend-models [--harness pi|t3|agy|codex|claude] [--budget large|medium|small] [--prefer-provider <id>] [--models '<json>'] [--models-file <path>]
 *   resolve-model [--harness pi|t3|agy|codex|claude] [--surface delegate_task|invoke_subagent|swarm|zee_subagent] --role <role> [--config <path>] [--allow-standalone] [--ignore-cooldown]
 *   provider-health [--clear [modelKey]]
 *   doctor [--repo <path>] [--harness <h>]
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractModelFamily, isAllowedZeeTmpPath } from "./lib/guard-core.mjs";
import { atomicWriteJson, cleanStaleTempFiles, withFileLock } from "./lib/fs-atomic.mjs";
import {
  clearModelCooldown,
  getModelCooldown,
  listActiveCooldowns,
  mapRoleToSlotName,
  resolveProviderHealthPath,
} from "./lib/provider-health.mjs";

const HOME = os.homedir();
const DEFAULT_CONFIG = path.join(HOME, ".agents", "zee-config.json");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_SKILLS_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const REPO_ROOT = path.resolve(SOURCE_SKILLS_DIR, "..");
const RUNS_ROOT = path.join(HOME, ".local", "state", "zee", "runs");
const PROJECT_SKILLS_SUBDIRS = [
  path.join(".agents", "skills"),
  path.join(".pi", "skills"),
  path.join(".claude", "skills"),
  path.join(".cursor", "skills"),
];

const KNOWN_VALUE_FLAGS = new Set([
  "harness", "repo", "bus", "status", "mode", "level", "predicate", "resume-next",
  "conversation-id", "budget", "unit-upsert", "units", "decision", "fallback",
  "branch", "base", "head", "sha", "prefix", "delegate-id", "surface", "role",
  "config", "dir", "unit", "phase", "why", "evidence", "result",
  "models", "models-file", "prefer-provider",
]);

const MULTI_VALUE_FLAGS = new Set(["unit-upsert", "fallback"]);

const KNOWN_BOOLEAN_FLAGS = new Set([
  "all", "prune-safe", "working-tree", "allow-standalone", "clear", "ignore-cooldown", "help",
]);

function normalizeHarnessName(raw) {
  const low = String(raw || "").trim().toLowerCase();
  if (!low) return "local";
  if (low === "agy" || low === "antigravity") return "antigravity";
  if (low === "t3" || low === "t3code" || low === "t3-code") return "t3";
  if (low === "pi") return "pi";
  if (low === "codex") return "codex";
  if (low === "claude" || low === "claudecode" || low === "claude-code") return "claude";
  if (low === "cursor") return "cursor";
  return low;
}

function getHarnessKeys(harness) {
  const h = normalizeHarnessName(harness);
  return h === "antigravity" ? ["agy", "antigravity"] : [h];
}

function detectActiveHarness() {
  if (process.env.PI_CODING_AGENT === "true" || process.env.AI_AGENT === "pi") return "pi";
  if (process.env.T3CODE_THREAD_ID || process.env.T3_ACP_MCP_ENDPOINT || process.env.T3_ACP_MCP_NODE) return "t3";
  if (process.env.ANTIGRAVITY_CLI || process.env.ANTIGRAVITY_AGENT || process.env.PLUGIN_ROOT?.includes(`${path.sep}.gemini${path.sep}`)) {
    return "antigravity";
  }
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE) return "claude";
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_SANDBOX) return "codex";
  const norm = path.resolve(SOURCE_SKILLS_DIR);
  if (norm.includes(`${path.sep}.pi${path.sep}`)) return "pi";
  if (norm.includes(`${path.sep}.claude${path.sep}`)) return "claude";
  if (norm.includes(`${path.sep}.gemini${path.sep}`)) return "antigravity";
  if (norm.includes(`${path.sep}.codex${path.sep}`)) return "codex";
  if (norm.includes(`${path.sep}.cursor${path.sep}`)) return "cursor";
  return "local";
}

function detectRuntimeProvider() {
  if (process.env.ANTIGRAVITY_AGENT || process.env.ANTIGRAVITY_CLI) return "antigravity";
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE) return "claude";
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_SANDBOX) return "codex";
  return null;
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  let endOfFlags = false;
  const assignValueFlag = (key, val) => {
    if (MULTI_VALUE_FLAGS.has(key)) {
      if (!Array.isArray(flags[key])) flags[key] = flags[key] !== undefined ? [flags[key]] : [];
      flags[key].push(val);
    } else {
      flags[key] = val;
    }
  };
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (endOfFlags) { positional.push(token); continue; }
    if (token === "--") { endOfFlags = true; continue; }
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx > 2) {
        const key = token.slice(2, eqIdx);
        const val = token.slice(eqIdx + 1);
        if (key === "inc-delegates" || key === "inc-aborted") {
          flags[key] = (Number(flags[key]) || 0) + (Number(val) || 1);
        } else {
          assignValueFlag(key, val);
        }
      } else {
        const key = token.slice(2);
        const next = args[i + 1];
        if (KNOWN_BOOLEAN_FLAGS.has(key)) {
          flags[key] = true;
        } else if (KNOWN_VALUE_FLAGS.has(key)) {
          if (next !== undefined) { assignValueFlag(key, next); i += 1; }
          else assignValueFlag(key, true);
        } else if (key === "inc-delegates" || key === "inc-aborted") {
          if (next !== undefined && /^\d+$/.test(next)) {
            flags[key] = (Number(flags[key]) || 0) + Number(next);
            i += 1;
          } else {
            flags[key] = (Number(flags[key]) || 0) + 1;
          }
        } else if (next !== undefined && !next.startsWith("--")) {
          assignValueFlag(key, next);
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

function usage() {
  console.log(`zee-tool.mjs v5.0.5 — zee 核心确定性原语（宿主: ${detectActiveHarness()}）

可用命令：
  init-run <repoRoot> <slug> [--mode night|standard] [--conversation-id <cid>]
  update-state <busDir> [--status <s>] [--mode <m>] [--resume-next <r>] [--budget '<json>'] [--unit-upsert '<json>'] [--units '<json-array>'] [--decision '<json>'] [--inc-delegates [N]] [--delegate-id <id>] [--inc-aborted [N]]
  log-decision <busDir> --unit <id> --phase <p> --decision <d> [--why <w>] [--evidence <e>] [--result <r>]
  list-runs [repoRoot | --all]
  worktree-create <repoRoot> <slug> <lane> <baseRef> [--branch <name>]
  cleanup-worktrees [repoRoot] [--base <ref>] [--prune-safe]
  sandbox-export --repo <repoRoot> [--sha <sha> | --working-tree] [--prefix rev|mut]
  sandbox-clean <sandboxDir>
  gate-tamper-diff --repo <repoRoot> [--base <ref>] [--head <ref> | --working-tree]
  recommend-models [--harness pi|t3|agy|codex|claude] [--budget large|medium|small] [--prefer-provider <id>] [--models '<json>'] [--models-file <path>]
  resolve-model [--harness pi|t3|agy|codex|claude] [--surface delegate_task|invoke_subagent|swarm|zee_subagent] --role <role> [--config <path>] [--allow-standalone] [--ignore-cooldown]
  provider-health [--clear [modelKey]]
  doctor [--repo <path>] [--harness <h>]`);
}

function sanitizeSlug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "task";
}

function repoKeyFor(repoPath) {
  const absRepo = path.resolve(repoPath);
  const hash = crypto.createHash("sha256").update(absRepo).digest("hex").slice(0, 8);
  return `${sanitizeSlug(path.basename(absRepo))}-${hash}`;
}

const TSV_HEADER = "ts\tunit\tphase\tdecision\twhy\tevidence\tresult\n";

function cleanTsvField(val) {
  return String(val ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

function appendDecisionRow(busDir, entry) {
  const tsvPath = path.join(busDir, "decisions.tsv");
  return withFileLock(tsvPath, () => {
    fs.mkdirSync(busDir, { recursive: true });
    if (!fs.existsSync(tsvPath)) fs.writeFileSync(tsvPath, TSV_HEADER, "utf8");
    const rowObj = {
      ts: new Date().toISOString(),
      unit: cleanTsvField(entry.unit || "-"),
      phase: cleanTsvField(entry.phase || "-"),
      decision: cleanTsvField(entry.decision || ""),
      why: cleanTsvField(entry.why || "-"),
      evidence: cleanTsvField(entry.evidence || "-"),
      result: cleanTsvField(entry.result || "-"),
    };
    const row = `${rowObj.ts}\t${rowObj.unit}\t${rowObj.phase}\t${rowObj.decision}\t${rowObj.why}\t${rowObj.evidence}\t${rowObj.result}\n`;
    fs.appendFileSync(tsvPath, row, "utf8");
    return { tsvPath, row: rowObj };
  });
}

function cmdInitRun(args) {
  const { flags, positional } = parseFlags(args);
  const [repoPath, slug] = positional;
  if (!repoPath || !slug) {
    console.error("用法：init-run <仓库路径> <任务名> [--mode night|standard] [--conversation-id <cid>]");
    process.exit(1);
  }
  const absRepo = path.resolve(repoPath);
  const busDir = path.join(RUNS_ROOT, repoKeyFor(absRepo), sanitizeSlug(slug));
  fs.mkdirSync(path.join(busDir, "artifacts"), { recursive: true });
  fs.mkdirSync(path.join(busDir, "screenshots"), { recursive: true });

  const statePath = path.join(busDir, "state.json");
  cleanStaleTempFiles(busDir);
  withFileLock(statePath, () => {
    if (!fs.existsSync(statePath)) {
      atomicWriteJson(statePath, {
        version: 1,
        repoRoot: absRepo,
        slug: sanitizeSlug(slug),
        busDir,
        activeHarness: detectActiveHarness(),
        conversationId: typeof flags["conversation-id"] === "string" && flags["conversation-id"].trim() ? flags["conversation-id"].trim() : null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        mode: typeof flags.mode === "string" && flags.mode.trim() ? flags.mode.trim() : "standard",
        level: null,
        predicate: null,
        resumeNext: null,
        units: [],
        delegatesDispatched: 0,
        fallbacksUsed: [],
        status: "initialized",
      });
    }
  });
  const tsvPath = path.join(busDir, "decisions.tsv");
  withFileLock(tsvPath, () => {
    if (!fs.existsSync(tsvPath)) fs.writeFileSync(tsvPath, TSV_HEADER, "utf8");
  });
  console.log(JSON.stringify({ ok: true, activeHarness: detectActiveHarness(), busDir, statePath, tsvPath }, null, 2));
}

function cmdUpdateState(args) {
  const { flags, positional } = parseFlags(args);
  const busDir = flags.bus || positional[0];
  if (!busDir) {
    console.error("用法：update-state <总线目录> [--status <s>] [--mode <m>] [--resume-next <r>] ...");
    process.exit(1);
  }
  const statePath = path.join(busDir, "state.json");
  if (!fs.existsSync(statePath)) {
    console.error(`更新失败：未找到 ${statePath}，请先运行 init-run`);
    process.exit(1);
  }

  const st = withFileLock(statePath, () => {
    cleanStaleTempFiles(busDir);
    const next = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (typeof flags.status === "string") next.status = flags.status;
    if (typeof flags.mode === "string") next.mode = flags.mode;
    if (typeof flags.level === "string") next.level = flags.level;
    if (typeof flags.predicate === "string") next.predicate = flags.predicate;
    if (typeof flags["conversation-id"] === "string" && flags["conversation-id"].trim()) next.conversationId = flags["conversation-id"].trim();
    if (typeof flags["resume-next"] === "string") next.resumeNext = flags["resume-next"] === "null" ? null : flags["resume-next"];

    const delegateId = typeof flags["delegate-id"] === "string" && flags["delegate-id"].trim() ? flags["delegate-id"].trim() : "";
    if (flags["inc-delegates"] || delegateId) {
      if (!Array.isArray(next.countedDelegateIds)) next.countedDelegateIds = [];
      if (!(delegateId && next.countedDelegateIds.includes(delegateId))) {
        const inc = flags["inc-delegates"] ? Number(flags["inc-delegates"]) || 1 : 1;
        next.delegatesDispatched = (Number(next.delegatesDispatched) || 0) + inc;
        if (delegateId) {
          next.countedDelegateIds.push(delegateId);
          if (next.countedDelegateIds.length > 200) next.countedDelegateIds = next.countedDelegateIds.slice(-200);
        }
      }
    }
    if (flags["inc-aborted"]) next.abortedDelegates = (Number(next.abortedDelegates) || 0) + (Number(flags["inc-aborted"]) || 1);
    if (typeof flags.budget === "string") {
      const budgetObj = JSON.parse(flags.budget);
      if (!budgetObj || typeof budgetObj !== "object" || Array.isArray(budgetObj)) {
        console.error("--budget 必须是 JSON 对象");
        process.exit(1);
      }
      next.budget = { ...(next.budget && typeof next.budget === "object" ? next.budget : {}), ...budgetObj };
    }

    const fallbacks = Array.isArray(flags.fallback) ? flags.fallback : typeof flags.fallback === "string" ? [flags.fallback] : [];
    for (const fb of fallbacks) {
      if (typeof fb === "string" && fb.trim()) {
        if (!Array.isArray(next.fallbacksUsed)) next.fallbacksUsed = [];
        if (!next.fallbacksUsed.includes(fb)) next.fallbacksUsed.push(fb);
      }
    }

    const upsertUnit = (unitObj) => {
      if (!unitObj || typeof unitObj !== "object" || !unitObj.id) {
        console.error("--unit-upsert / --units 对象必须包含 id 字段");
        process.exit(1);
      }
      if (!Array.isArray(next.units)) next.units = [];
      const idx = next.units.findIndex((u) => u && u.id === unitObj.id);
      if (idx >= 0) next.units[idx] = { ...next.units[idx], ...unitObj, updatedAt: new Date().toISOString() };
      else next.units.push({ ...unitObj, updatedAt: new Date().toISOString() });
    };

    if (typeof flags.units === "string") {
      const arr = JSON.parse(flags.units);
      if (!Array.isArray(arr)) {
        console.error("--units 必须是 JSON 数组");
        process.exit(1);
      }
      for (const item of arr) upsertUnit(item);
    }

    const singleUpserts = Array.isArray(flags["unit-upsert"])
      ? flags["unit-upsert"]
      : typeof flags["unit-upsert"] === "string"
        ? [flags["unit-upsert"]]
        : [];
    for (const rawUnit of singleUpserts) {
      if (typeof rawUnit === "string") upsertUnit(JSON.parse(rawUnit));
    }

    next.updatedAt = new Date().toISOString();
    atomicWriteJson(statePath, next);
    return next;
  });

  if (typeof flags.decision === "string") {
    const decObj = JSON.parse(flags.decision);
    if (!decObj || typeof decObj !== "object" || Array.isArray(decObj) || !decObj.decision) {
      console.error("--decision 必须是包含 decision 字段的 JSON 对象");
      process.exit(1);
    }
    appendDecisionRow(busDir, decObj);
  }

  console.log(JSON.stringify({ ok: true, statePath, state: st }, null, 2));
}

function cmdLogDecision(args) {
  const { flags, positional } = parseFlags(args);
  const busDir = flags.bus || positional[0];
  const decision = typeof flags.decision === "string" ? flags.decision : positional[1];
  if (!busDir || !decision) {
    console.error("用法：log-decision <总线目录> --unit <id> --phase <p> --decision <d> [--why <w>] [--evidence <e>] [--result <r>]");
    process.exit(1);
  }
  const res = appendDecisionRow(busDir, {
    unit: flags.unit,
    phase: flags.phase,
    decision,
    why: flags.why,
    evidence: flags.evidence,
    result: flags.result,
  });
  console.log(JSON.stringify({ ok: true, ...res }, null, 2));
}

function cmdListRuns(repoPath) {
  if (!fs.existsSync(RUNS_ROOT)) {
    console.log(JSON.stringify({ ok: true, count: 0, runs: [] }, null, 2));
    return;
  }
  const repoDirs =
    repoPath && repoPath !== "--all"
      ? [path.join(RUNS_ROOT, repoKeyFor(repoPath))]
      : fs.readdirSync(RUNS_ROOT).map((d) => path.join(RUNS_ROOT, d));

  const runs = [];
  for (const rDir of repoDirs) {
    if (!fs.existsSync(rDir) || !fs.statSync(rDir).isDirectory()) continue;
    for (const slug of fs.readdirSync(rDir)) {
      const statePath = path.join(rDir, slug, "state.json");
      if (!fs.existsSync(statePath)) continue;
      try {
        const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
        runs.push({
          slug: st.slug || slug,
          status: st.status || "unknown",
          mode: st.mode || "standard",
          level: st.level ?? null,
          repoRoot: st.repoRoot || null,
          busDir: st.busDir || path.join(rDir, slug),
          updatedAt: st.updatedAt || st.createdAt || null,
          resumeNext: st.resumeNext ?? null,
          unitsCount: Array.isArray(st.units) ? st.units.length : 0,
        });
      } catch {}
    }
  }
  runs.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  console.log(JSON.stringify({ ok: true, count: runs.length, runs }, null, 2));
}

function resolveSafeBranchName(absRepo, rawBranch) {
  let candidate = String(rawBranch || "").trim().replace(/^refs\/heads\//, "").replace(/^\/+|\/+$/g, "");
  const refExists = (refName) => {
    try { execFileSync("git", ["-C", absRepo, "show-ref", "--verify", "--quiet", refName], { stdio: "ignore" }); return true; }
    catch { return false; }
  };
  for (let guard = 0; guard < 8; guard++) {
    const parts = candidate.split("/").filter(Boolean);
    let collidedIdx = -1;
    for (let i = 1; i < parts.length; i++) {
      if (refExists(`refs/heads/${parts.slice(0, i).join("/")}`)) { collidedIdx = i; break; }
    }
    if (collidedIdx > 0) {
      const merged = `${parts[collidedIdx - 1]}-${parts[collidedIdx]}`;
      candidate = [...parts.slice(0, collidedIdx - 1), merged, ...parts.slice(collidedIdx + 1)].join("/");
      continue;
    }
    break;
  }
  return candidate;
}

function ensureNodeModulesMount(absRepo, wtPath) {
  const src = path.join(absRepo, "node_modules");
  const dst = path.join(wtPath, "node_modules");
  if (!fs.existsSync(src) || fs.existsSync(dst)) return false;
  try {
    if (execFileSync("git", ["-C", absRepo, "ls-files", "node_modules"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) {
      return false;
    }
    const exRel = execFileSync("git", ["-C", wtPath, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const exFile = path.resolve(wtPath, exRel);
    fs.mkdirSync(path.dirname(exFile), { recursive: true });
    const existing = fs.existsSync(exFile) ? fs.readFileSync(exFile, "utf8") : "";
    if (!existing.split(/\r?\n/).some((l) => l.trim() === "/node_modules" || l.trim() === "node_modules")) {
      fs.appendFileSync(exFile, `${existing && !existing.endsWith("\n") ? "\n" : ""}/node_modules\n`, "utf8");
    }
    fs.symlinkSync(src, dst, process.platform === "win32" ? "junction" : undefined);
    return true;
  } catch {
    return false;
  }
}

function cmdWorktreeCreate(args) {
  const { flags, positional } = parseFlags(args);
  const [repoPath, slug, lane, baseRef] = positional;
  if (!repoPath || !slug || !lane || !baseRef) {
    console.error("用法：worktree-create <仓库路径> <slug> <lane> <baseRef> [--branch <分支名>]");
    process.exit(1);
  }
  const absRepo = path.resolve(repoPath);
  const wtRoot = path.join(RUNS_ROOT, repoKeyFor(absRepo), sanitizeSlug(slug), "worktrees");
  const wtPath = path.join(wtRoot, sanitizeSlug(lane));
  fs.mkdirSync(wtRoot, { recursive: true });

  if (fs.existsSync(wtPath)) {
    const st = execFileSync("git", ["-C", wtPath, "status", "--porcelain"], { encoding: "utf8" }).trim();
    if (st) {
      console.error(`拒绝覆盖：目标 worktree 存在未提交改动：${wtPath}`);
      process.exit(1);
    }
    execFileSync("git", ["-C", absRepo, "worktree", "remove", "--force", wtPath], { stdio: "ignore" });
  }

  const gitArgs = ["-C", absRepo, "worktree", "add"];
  const rawBranch = typeof flags.branch === "string" && flags.branch.trim() ? flags.branch.trim() : null;
  const branch = rawBranch ? resolveSafeBranchName(absRepo, rawBranch) : null;
  if (branch) {
    let exists = false;
    try { execFileSync("git", ["-C", absRepo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]); exists = true; } catch {}
    if (exists) gitArgs.push(wtPath, branch);
    else gitArgs.push("-b", branch, wtPath, baseRef);
  } else {
    gitArgs.push("--detach", wtPath, baseRef);
  }

  execFileSync("git", gitArgs, { encoding: "utf8" });
  const mountedNodeModules = ensureNodeModulesMount(absRepo, wtPath);
  const head = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  console.log(JSON.stringify({
    ok: true,
    repoRoot: absRepo,
    worktreePath: wtPath,
    branch: branch || "(detached)",
    flattened: Boolean(rawBranch && branch !== rawBranch),
    mountedNodeModules,
    head,
  }, null, 2));
}

function isSquashMergedByPatchId(absRepo, baseRef, branchRef) {
  try {
    const mergeBase = execFileSync("git", ["-C", absRepo, "merge-base", baseRef, branchRef], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!mergeBase) return false;
    const branchDiff = execFileSync("git", ["-C", absRepo, "diff", `${mergeBase}..${branchRef}`], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    if (!branchDiff.trim()) return true;
    const targetPatchId = (spawnSync("git", ["patch-id", "--stable"], { input: branchDiff, encoding: "utf8" }).stdout || "").trim().split(/\s+/)[0];
    if (!targetPatchId) return false;

    const logShas = execFileSync("git", ["-C", absRepo, "rev-list", "--max-count=50", `${mergeBase}..${baseRef}`], { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
    for (const sha of logShas) {
      const commitDiff = execFileSync("git", ["-C", absRepo, "show", "--format=", sha], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
      const pid = (spawnSync("git", ["patch-id", "--stable"], { input: commitDiff, encoding: "utf8" }).stdout || "").trim().split(/\s+/)[0];
      if (pid && pid === targetPatchId) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function detectDefaultBaseRef(absRepo) {
  for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master", "HEAD"]) {
    try {
      if (execFileSync("git", ["-C", absRepo, "rev-parse", "--verify", "--quiet", ref], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) return ref;
    } catch {}
  }
  return "HEAD";
}

function isWorktreeActiveLocked(wtPath) {
  const lockPath = `${wtPath}.zee-lock.json`;
  if (!fs.existsSync(lockPath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const pid = Number(data?.pid);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return true; }
      catch (e) { return Boolean(e && e.code === "EPERM"); }
    }
    const ageMs = Date.now() - Date.parse(data?.createdAt || "");
    return Number.isFinite(ageMs) && ageMs < 2 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function cmdCleanupWorktrees(args) {
  const { flags, positional } = parseFlags(args);
  const absRepo = path.resolve(positional[0] || process.cwd());
  const pruneSafe = Boolean(flags["prune-safe"]);
  const explicitBase = typeof flags.base === "string" && flags.base.trim() ? flags.base.trim() : null;
  const defaultBase = detectDefaultBaseRef(absRepo);
  const baseRefs = [];
  if (explicitBase) {
    baseRefs.push(explicitBase);
  } else {
    let headSha = "";
    let defaultSha = "";
    try { headSha = execFileSync("git", ["-C", absRepo, "rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
    try { defaultSha = execFileSync("git", ["-C", absRepo, "rev-parse", "--verify", "--quiet", defaultBase], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
    if (headSha && (!defaultSha || headSha !== defaultSha)) baseRefs.push("HEAD");
    if (!baseRefs.includes(defaultBase)) baseRefs.push(defaultBase);
  }

  let porcelain;
  try {
    porcelain = execFileSync("git", ["-C", absRepo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  } catch (e) {
    console.error(`检查失败：${absRepo} 不是合法的 Git 仓库（${e.message}）`);
    process.exit(1);
  }

  const worktrees = [];
  const pruned = [];
  porcelain.trim().split(/(?:\r?\n){2,}/).forEach((blk, idx) => {
    const lines = blk.split(/\r?\n/);
    const rawWtPath = lines.find((l) => l.startsWith("worktree "))?.slice(9).trim();
    const head = lines.find((l) => l.startsWith("HEAD "))?.slice(5).trim();
    const branchRef = lines.find((l) => l.startsWith("branch "))?.slice(7).trim();
    const isDetached = !branchRef;
    const branch = branchRef ? branchRef.replace(/^refs\/heads\//, "") : "(detached)";
    if (!rawWtPath) return;
    const wtPath = path.resolve(rawWtPath);

    let dirtyFiles = 0;
    try {
      const st = execFileSync("git", ["-C", wtPath, "status", "--porcelain"], { encoding: "utf8" }).trim();
      if (st) dirtyFiles = st.split(/\r?\n/).length;
    } catch {}

    let isMerged = false;
    let mergeMethod = null;
    let mergedInto = null;
    if (idx > 0 && head) {
      for (const ref of baseRefs) {
        try {
          execFileSync("git", ["-C", absRepo, "merge-base", "--is-ancestor", head, ref], { stdio: "ignore" });
          isMerged = true; mergeMethod = "ancestor"; mergedInto = ref; break;
        } catch {
          if (!isDetached && isSquashMergedByPatchId(absRepo, ref, branch)) {
            isMerged = true; mergeMethod = "squash-patch-id"; mergedInto = ref; break;
          }
        }
      }
    }

    const isPrimary = idx === 0;
    const isActiveLocked = !isPrimary && isWorktreeActiveLocked(wtPath);
    const isZeeRunDetached = isDetached && wtPath.includes(`${path.sep}zee${path.sep}runs${path.sep}`);
    let bucket = "primary";
    if (!isPrimary) {
      if (isActiveLocked) bucket = "active_hold";
      else if (dirtyFiles > 0) bucket = "keep_dirty";
      else if (isMerged || isZeeRunDetached) bucket = "safe_to_prune";
      else if (isDetached) bucket = "safe_to_prune_detached";
      else bucket = "review_unmerged";
    }

    let prunedNow = false;
    if (pruneSafe && (bucket === "safe_to_prune" || bucket === "safe_to_prune_detached")) {
      try {
        const nmLink = path.join(wtPath, "node_modules");
        if (fs.existsSync(nmLink) && fs.lstatSync(nmLink).isSymbolicLink()) {
          try { fs.unlinkSync(nmLink); } catch { fs.rmdirSync(nmLink); }
        }
      } catch {}
      try {
        execFileSync("git", ["-C", absRepo, "worktree", "remove", "--force", wtPath], { stdio: "ignore" });
        try { fs.rmSync(`${wtPath}.zee-lock.json`, { force: true }); } catch {}
        prunedNow = true;
        pruned.push(wtPath);
      } catch {}
    }

    worktrees.push({
      path: wtPath, branch, head: head?.slice(0, 10) || null, dirtyFiles,
      mergedIntoBase: isMerged, mergedInto, mergeMethod, activeLocked: isActiveLocked, bucket, pruned: prunedNow,
    });
  });

  if (pruneSafe) {
    try { execFileSync("git", ["-C", absRepo, "worktree", "prune"], { stdio: "ignore" }); } catch {}
  }
  console.log(JSON.stringify({ ok: true, readOnly: !pruneSafe, repoRoot: absRepo, baseRef: explicitBase || defaultBase, checkedBaseRefs: baseRefs, prunedCount: pruned.length, pruned, worktrees }, null, 2));
}

function cmdSandboxExport(args) {
  const { flags, positional } = parseFlags(args);
  const repoRoot = path.resolve(flags.repo || positional[0] || process.cwd());
  let gitDirRaw = "";
  try {
    gitDirRaw = execFileSync("git", ["-C", repoRoot, "rev-parse", "--git-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: `${repoRoot} 不是合法的 Git 仓库：${e.message}` }));
    process.exit(1);
  }
  const gitDir = path.resolve(repoRoot, gitDirRaw);
  const workingTree = Boolean(flags["working-tree"]);
  const ALLOWED_PREFIXES = new Set(["rev", "mut", "probe", "sim", "retro", "verify"]);
  const rawPrefix = typeof flags.prefix === "string" ? flags.prefix.trim().toLowerCase() : "mut";
  const prefix = ALLOWED_PREFIXES.has(rawPrefix) ? rawPrefix : "mut";
  const targetRef = workingTree ? "HEAD" : (typeof flags.sha === "string" && flags.sha.trim() ? flags.sha.trim() : "HEAD");

  let resolvedSha = null;
  let hasCommit = false;
  try {
    resolvedSha = execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", targetRef], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    hasCommit = Boolean(resolvedSha);
  } catch {
    if (!workingTree) {
      console.error(JSON.stringify({ ok: false, error: `无法解析提交引用：${targetRef}` }));
      process.exit(1);
    }
  }

  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), `zee-${prefix}-`));
  try {
    if (hasCommit) {
      let exported = false;
      const archRes = spawnSync("git", ["-c", "core.autocrlf=false", "-C", repoRoot, "archive", "--format=tar", targetRef], { maxBuffer: 200 * 1024 * 1024 });
      if (archRes.status === 0 && archRes.stdout) {
        if (spawnSync("tar", ["-xf", "-", "-C", sandboxDir], { input: archRes.stdout, maxBuffer: 50 * 1024 * 1024 }).status === 0) exported = true;
      }
      if (!exported) {
        const treeEntries = execFileSync("git", ["-C", repoRoot, "ls-tree", "--name-only", targetRef], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
        if (treeEntries) {
          const tmpIndex = path.join(os.tmpdir(), `zee-idx-${process.pid}-${Date.now()}`);
          try {
            execFileSync("git", ["-c", "core.autocrlf=false", `--git-dir=${gitDir}`, `--work-tree=${sandboxDir}`, "checkout", "-f", targetRef, "--", "."], { env: { ...process.env, GIT_INDEX_FILE: tmpIndex }, stdio: ["ignore", "pipe", "pipe"] });
          } finally { fs.rmSync(tmpIndex, { force: true }); }
        }
      }
    }

    if (workingTree) {
      if (hasCommit) {
        const diffRes = spawnSync("git", ["-C", repoRoot, "-c", "core.autocrlf=false", "diff", "--binary", "HEAD"], { maxBuffer: 50 * 1024 * 1024 });
        if (diffRes.status === 0 && diffRes.stdout?.length > 0) {
          const applyRes = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--allow-empty"], { cwd: sandboxDir, input: diffRes.stdout, encoding: "utf8" });
          if (applyRes.status !== 0) {
            const retryRes = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--allow-empty", "--ignore-space-change", "--recount"], { cwd: sandboxDir, input: diffRes.stdout, encoding: "utf8" });
            if (retryRes.status !== 0) {
              const parts = execFileSync("git", ["-C", repoRoot, "diff", "--name-status", "-z", "HEAD"], { encoding: "utf8" }).split("\0");
              for (let i = 0; i < parts.length; i += 1) {
                const stCode = parts[i];
                if (!stCode) continue;
                if (stCode.startsWith("R") || stCode.startsWith("C")) {
                  const oldRel = parts[i + 1]; const newRel = parts[i + 2]; i += 2;
                  if (stCode.startsWith("R") && oldRel) fs.rmSync(path.join(sandboxDir, oldRel), { recursive: true, force: true });
                  if (newRel && fs.existsSync(path.join(repoRoot, newRel)) && fs.statSync(path.join(repoRoot, newRel)).isFile()) {
                    const dst = path.join(sandboxDir, newRel);
                    fs.mkdirSync(path.dirname(dst), { recursive: true });
                    fs.copyFileSync(path.join(repoRoot, newRel), dst);
                  }
                } else {
                  const relFile = parts[i + 1]; i += 1;
                  if (!relFile) continue;
                  const dst = path.join(sandboxDir, relFile);
                  if (stCode === "D") fs.rmSync(dst, { recursive: true, force: true });
                  else if (fs.existsSync(path.join(repoRoot, relFile)) && fs.statSync(path.join(repoRoot, relFile)).isFile()) {
                    fs.mkdirSync(path.dirname(dst), { recursive: true });
                    fs.copyFileSync(path.join(repoRoot, relFile), dst);
                  }
                }
              }
            }
          }
        }
      }
      const untrackedRaw = execFileSync("git", ["-C", repoRoot, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" });
      for (const rel of untrackedRaw.split("\0").filter(Boolean)) {
        const src = path.join(repoRoot, rel);
        const dst = path.join(sandboxDir, rel);
        try {
          const st = fs.lstatSync(src);
          if (st.isFile()) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
          else if (st.isSymbolicLink()) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.symlinkSync(fs.readlinkSync(src), dst); }
        } catch {}
      }
    }
    console.log(JSON.stringify({ ok: true, sandboxDir, mode: workingTree ? "working-tree" : "sha", ref: workingTree ? "WORKING_TREE" : targetRef, sha: resolvedSha }, null, 2));
  } catch (e) {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
    console.error(JSON.stringify({ ok: false, error: `sandbox-export 失败：${e.message}` }));
    process.exit(1);
  }
}

function cmdSandboxClean(args) {
  const { flags, positional } = parseFlags(args);
  const rawDir = flags.dir || positional[0];
  if (!rawDir) {
    console.error(JSON.stringify({ ok: false, error: "用法：sandbox-clean <sandboxDir>" }));
    process.exit(1);
  }
  const sandboxDir = path.resolve(rawDir);
  const baseName = path.basename(sandboxDir);
  if (
    !isAllowedZeeTmpPath(sandboxDir, "") ||
    !/^zee-(?:mut|rev|probe|sim|retro|verify)-[a-z0-9][a-z0-9_.-]*$/i.test(baseName) ||
    fs.existsSync(path.join(sandboxDir, ".git")) ||
    fs.existsSync(path.join(sandboxDir, ".agents", "zee.project.json"))
  ) {
    console.error(JSON.stringify({ ok: false, error: `拒绝清理非法的沙盒目录 "${sandboxDir}"` }));
    process.exit(1);
  }
  const relCwd = path.relative(sandboxDir, process.cwd());
  if (relCwd === "" || (!relCwd.startsWith("..") && !path.isAbsolute(relCwd))) {
    try { process.chdir(os.tmpdir()); } catch {}
  }
  fs.rmSync(sandboxDir, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: true, removed: true, sandboxDir }, null, 2));
}

function isGateFilePath(rawRelPath) {
  const p = String(rawRelPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p) return false;
  if (/(?:^|\/)(?:tests?|__snapshots__|\.github\/workflows|verify-[^/]+)\//i.test(p)) return true;
  if (/(?:^|\/)\.agents\/(?:verify-ctl[^/]*|zee\.project\.json)$/i.test(p)) return true;
  const base = path.posix.basename(p);
  return /\.(?:test|spec)\.[^/]+$/i.test(base) || /^(?:\.eslintrc|eslint\.config\.|biome\.json$|tsconfig.*\.json$|ruff\.toml$|pyproject\.toml$|jest\.config\.|vitest\.config\.)/i.test(base);
}

const SUPPRESSION_PATTERNS = [
  { name: "@ts-ignore", re: /@ts-ignore\b/ },
  { name: "@ts-expect-error", re: /@ts-expect-error\b/ },
  { name: "as any", re: /\bas\s+any\b/ },
  { name: "eslint-disable", re: /\beslint-disable(?:-next-line|-line)?\b/ },
  { name: "# noqa", re: /#\s*noqa\b/i },
  { name: "#[allow(...)]", re: /#\[allow\(/ },
  { name: "//nolint", re: /\/\/\s*nolint\b/ },
];

const SECRET_PATTERNS = [
  { name: "private_key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "api_key_prefix", re: /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[po]_[A-Za-z0-9]{16,}|xox[bp]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/ },
  { name: "hardcoded_secret_assign", re: /(?:password|secret|api_?key|access_?token)\s*[:=]\s*["'](?!<REDACTED>|changeme|dummy|placeholder|test|example|\*{3,})[^\s"']{10,}["']/i },
];

function unquoteGitDiffPath(raw) {
  let s = String(raw || "").trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (s.startsWith("b/") || s.startsWith("a/")) s = s.slice(2);
  return s;
}

function cmdGateTamperDiff(args) {
  const { flags, positional } = parseFlags(args);
  const repoRoot = path.resolve(flags.repo || positional[0] || process.cwd());
  try {
    execFileSync("git", ["-C", repoRoot, "rev-parse", "--git-dir"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: `${repoRoot} 不是合法的 Git 仓库：${e.message}` }));
    process.exit(1);
  }

  const hasBase = typeof flags.base === "string" && flags.base.trim().length > 0;
  const hasHead = typeof flags.head === "string" && flags.head.trim().length > 0;
  const useWorkingTree = Boolean(flags["working-tree"]) || (!hasBase && !hasHead);

  const changedFiles = new Set();
  const suppressionsAdded = [];
  const secretsAdded = [];
  const encodingIssues = [];

  const scanAddedLine = (file, line) => {
    const cleanFile = file.replace(/\\/g, "/");
    for (const pat of SUPPRESSION_PATTERNS) {
      if (pat.re.test(line)) suppressionsAdded.push({ file: cleanFile, pattern: pat.name, line: line.trim().slice(0, 200) });
    }
    if (!/<REDACTED>/.test(line)) {
      for (const pat of SECRET_PATTERNS) {
        if (pat.re.test(line)) secretsAdded.push({ file: cleanFile, pattern: pat.name, line: "<REDACTED>" });
      }
    }
    if (line.includes("\uFFFD")) {
      encodingIssues.push({ file: cleanFile, pattern: "utf8_replacement_char", line: line.trim().slice(0, 200) });
    }
  };

  const scanDiffText = (diffText) => {
    let currentFile = null;
    let inHunk = false;
    for (const line of String(diffText || "").split(/\r?\n/)) {
      if (line.startsWith("diff --git ")) { inHunk = false; continue; }
      if (line.startsWith("+++ ")) {
        inHunk = false;
        const rawTarget = line.slice(4).trim();
        currentFile = rawTarget === "/dev/null" ? null : unquoteGitDiffPath(rawTarget);
        continue;
      }
      if (line.startsWith("--- ")) { inHunk = false; continue; }
      if (line.startsWith("@@ ")) { inHunk = true; continue; }
      if (inHunk && line.startsWith("+") && currentFile) scanAddedLine(currentFile, line.slice(1));
    }
  };

  if (useWorkingTree) {
    let hasHeadCommit = false;
    try { execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }); hasHeadCommit = true; } catch {}
    const nameArgs = hasHeadCommit ? ["diff", "--name-only", "-z", "HEAD"] : ["diff", "--name-only", "-z", "--cached"];
    const diffArgs = hasHeadCommit ? ["diff", "-U0", "HEAD"] : ["diff", "-U0", "--cached"];
    for (const f of execFileSync("git", ["-C", repoRoot, ...nameArgs], { encoding: "utf8" }).split("\0").filter(Boolean)) changedFiles.add(f);
    scanDiffText(execFileSync("git", ["-C", repoRoot, ...diffArgs], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }));

    for (const rel of execFileSync("git", ["-C", repoRoot, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean)) {
      changedFiles.add(rel);
      const absFile = path.join(repoRoot, rel);
      try {
        const st = fs.statSync(absFile);
        if (st.isFile() && st.size <= 512 * 1024) {
          const text = fs.readFileSync(absFile, "utf8");
          if (!text.includes("\0")) text.split(/\r?\n/).forEach((l) => scanAddedLine(rel, l));
        }
      } catch {}
    }
  } else {
    const range = hasBase && hasHead ? `${flags.base.trim()}..${flags.head.trim()}` : hasBase ? `${flags.base.trim()}..HEAD` : `${flags.head.trim()}~1..${flags.head.trim()}`;
    let useRootShow = false;
    if (!hasBase && hasHead) {
      try { execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", `${flags.head.trim()}~1`], { stdio: ["ignore", "pipe", "ignore"] }); }
      catch { useRootShow = true; }
    }
    const nameArgs = useRootShow ? ["show", "--format=", "--name-only", "-z", flags.head.trim()] : ["diff", "--name-only", "-z", range];
    const diffArgs = useRootShow ? ["show", "--format=", "-U0", flags.head.trim()] : ["diff", "-U0", range];
    for (const f of execFileSync("git", ["-C", repoRoot, ...nameArgs], { encoding: "utf8" }).split("\0").filter(Boolean)) changedFiles.add(f);
    scanDiffText(execFileSync("git", ["-C", repoRoot, ...diffArgs], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }));
  }

  const gateFilesTouched = [...changedFiles].map((f) => f.replace(/\\/g, "/")).filter((f) => isGateFilePath(f)).sort();
  console.log(JSON.stringify({
    ok: true,
    repoRoot,
    mode: useWorkingTree ? "working-tree" : "range",
    gateFilesTouched,
    suppressionsAdded,
    secretsAdded,
    encodingIssues,
    requiresCountersign: gateFilesTouched.length > 0 || suppressionsAdded.length > 0 || secretsAdded.length > 0 || encodingIssues.length > 0,
  }, null, 2));
}

function normalizeModelForAgy(modelHint, tier, effort, surface, explicitSpec) {
  const low = String(modelHint || "").trim().toLowerCase();
  const eff = effort && effort !== "max" ? effort : "high";
  if (surface === "swarm") {
    if (typeof explicitSpec?.swarmModel === "string" && explicitSpec.swarmModel.trim()) {
      return explicitSpec.swarmModel.trim();
    }
    if (low && /-(low|medium|high|xhigh)$/.test(low)) return low;
    if (low.includes("argon")) return `${low}-${eff === "xhigh" ? "high" : eff}`;
    if (low && low !== "inherit" && low !== "auto") return `${low}-${eff}`;
    return "inherit";
  }
  if (explicitSpec?.model === "inherit") return "inherit";
  if (
    low === "inherit" ||
    low === "auto" ||
    low.includes("gemini-4") ||
    low.includes("neon") ||
    low.includes("hydrogen") ||
    low.includes("carbon") ||
    low.includes("argon") ||
    low.includes("orchestrator")
  ) {
    return "inherit";
  }
  if (low === "flash_lite" || low === "flash-lite" || tier === "lite") return "flash_lite";
  if (low === "flash" || low.includes("gemini-3.8")) return "flash";
  if (low === "pro") return "pro";
  return "inherit";
}

function getHarnessSection(cfg, harness) {
  if (!cfg?.harnesses || typeof cfg.harnesses !== "object") return null;
  for (const k of getHarnessKeys(harness)) {
    if (cfg.harnesses[k] && typeof cfg.harnesses[k] === "object") {
      return { key: k, section: cfg.harnesses[k] };
    }
  }
  return null;
}

function specHasExplicitBindings(spec) {
  return Boolean(spec?.bindings && typeof spec.bindings === "object" && Object.keys(spec.bindings).length > 0);
}

function canonicalDisplayHarness(raw) {
  const norm = normalizeHarnessName(raw);
  return norm === "antigravity" ? "agy" : norm;
}

function listConfiguredHarnesses(cfg) {
  const out = new Set();
  if (cfg?.harnesses && typeof cfg.harnesses === "object") {
    for (const [k, v] of Object.entries(cfg.harnesses)) {
      if (v && typeof v === "object" && v.slots && typeof v.slots === "object" && Object.keys(v.slots).length > 0) {
        out.add(canonicalDisplayHarness(k));
      }
    }
  }
  if (cfg?.slots && typeof cfg.slots === "object") {
    for (const slot of Object.values(cfg.slots)) {
      const pref = slot?.prefer || slot;
      if (pref?.bindings && typeof pref.bindings === "object") {
        for (const k of Object.keys(pref.bindings)) out.add(canonicalDisplayHarness(k));
      }
    }
  }
  return [...out].sort();
}

function getSlotFromConfig(cfg, rawRole, harness) {
  const r = String(rawRole || "workhorse").trim().toLowerCase();
  const mapped = mapRoleToSlotName(r);
  const hs = harness ? getHarnessSection(cfg, harness) : null;
  if (hs?.section?.slots && typeof hs.section.slots === "object") {
    if (hs.section.slots[mapped]) {
      return { slotName: mapped, slot: hs.section.slots[mapped], source: "harnesses", harnessSectionKey: hs.key };
    }
  }
  // Legacy Schema v3: cfg.slots { fast, workhorse, adversary }
  if (cfg?.slots && typeof cfg.slots === "object") {
    if (cfg.slots[mapped]) {
      const pref = cfg.slots[mapped]?.prefer || cfg.slots[mapped];
      if (harness && specHasExplicitBindings(pref) && !getHarnessKeys(harness).some((k) => Boolean(pref.bindings[k]))) {
        return { slotName: mapped, slot: null, missingForHarness: true, source: "slots" };
      }
      return { slotName: mapped, slot: cfg.slots[mapped], source: "slots" };
    }
  }
  // Legacy Schema v2: cfg.roles
  const roles = cfg?.roles || {};
  if (r === "scout" || r === "fast") return { slotName: "scout", slot: roles.scout, source: "roles" };
  if (r === "architect" || r === "architect.primary") return { slotName: "architect.primary", slot: roles.architect?.primary, source: "roles" };
  if (r === "judge") return { slotName: "judge", slot: roles.judge || (Array.isArray(roles.reviewers) ? roles.reviewers[0] : null), source: "roles" };
  if (r === "ui" || r === "ui.standard") return { slotName: "ui.standard", slot: roles.ui?.standard, source: "roles" };
  if (r === "ui.heavy") return { slotName: "ui.heavy", slot: roles.ui?.heavy, source: "roles" };
  if (r === "coder" || r === "coder.standard" || r === "workhorse") return { slotName: "coder.standard", slot: roles.coder?.standard, source: "roles" };
  if (r === "coder.heavy") return { slotName: "coder.heavy", slot: roles.coder?.heavy, source: "roles" };
  if (r === "verifier") return { slotName: "verifier", slot: roles.verifier, source: "roles" };
  if (r === "reviewer" || r === "reviewer.0" || r === "adversary") return { slotName: "reviewer.0", slot: Array.isArray(roles.reviewers) ? roles.reviewers[0] : null, source: "roles" };
  if (r.startsWith("reviewer.")) {
    const idx = Number(r.split(".")[1]);
    return { slotName: r, slot: Array.isArray(roles.reviewers) ? roles.reviewers[idx] || null : null, source: "roles" };
  }
  if (!hs && !cfg?.slots && !cfg?.roles && cfg?.harnesses && Object.keys(cfg.harnesses).length > 0) {
    return { slotName: mapped, slot: null, missingForHarness: true, source: "harnesses" };
  }
  return { slotName: r, slot: null };
}

function extractBindingPair(spec, harness) {
  if (!spec || typeof spec !== "object") return null;
  for (const k of getHarnessKeys(harness)) {
    if (spec.bindings?.[k] && typeof spec.bindings[k] === "object") {
      return { ...spec.bindings[k] };
    }
  }
  if (specHasExplicitBindings(spec)) return null;
  if (spec.providerInstanceId || spec.model || spec.swarmModel) {
    return {
      ...(spec.providerInstanceId ? { providerInstanceId: spec.providerInstanceId } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.swarmModel ? { swarmModel: spec.swarmModel } : {}),
      ...(spec.options && typeof spec.options === "object" ? { options: spec.options } : {}),
      ...(spec.family ? { family: spec.family } : {}),
    };
  }
  return null;
}

const MODELS_CATALOG_PATH = path.join(SOURCE_SKILLS_DIR, "zee", "models.json");
const FALLBACK_PARENT_ALIASES = new Set(["inherit-parent", "auto", "inherit"]);

function loadModelsCatalog() {
  try {
    return JSON.parse(fs.readFileSync(MODELS_CATALOG_PATH, "utf8"));
  } catch (e) {
    throw new Error(`无法读取模型梯队目录 ${MODELS_CATALOG_PATH}：${e.message}`);
  }
}

function isParentAlias(val) {
  return FALLBACK_PARENT_ALIASES.has(String(val || "").trim().toLowerCase());
}

function extractSlotRawModel(pref) {
  if (!pref || typeof pref !== "object") return "";
  return pref.model || pref.modelHint || pref.swarmModel || "";
}

function cmdResolveModel(args) {
  const { flags } = parseFlags(args);
  const harness = normalizeHarnessName(flags.harness || detectActiveHarness());
  const defaultSurface =
    harness === "t3"
      ? "delegate_task"
      : harness === "antigravity"
        ? "invoke_subagent"
        : harness === "pi"
          ? "zee_subagent"
          : "native";
  const surface = String(flags.surface || defaultSurface).toLowerCase();
  const role = String(flags.role || "workhorse").toLowerCase();
  const configPath = typeof flags.config === "string" ? flags.config : process.env.ZEE_CONFIG_PATH?.trim() || DEFAULT_CONFIG;
  const allowStandalone = Boolean(flags["allow-standalone"]);
  const ignoreCooldown = Boolean(flags["ignore-cooldown"]);

  if (!fs.existsSync(configPath)) {
    if (allowStandalone) {
      const isAgy = harness === "antigravity";
      console.log(JSON.stringify({ ok: true, standalone: true, configPath, resolved: { harness, surface, role, model: isAgy ? "inherit" : null, standalone: true } }, null, 2));
      return;
    }
    console.log(JSON.stringify({ ok: false, error: `未找到配置文件：${configPath}`, configPath }, null, 2));
    process.exit(1);
  }

  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, "utf8")); }
  catch (e) { console.log(JSON.stringify({ ok: false, error: `配置文件解析失败：${e.message}`, configPath }, null, 2)); process.exit(1); }

  const { slotName, slot, missingForHarness, source } = getSlotFromConfig(cfg, role, harness);
  if (!slot) {
    if (missingForHarness && allowStandalone) {
      console.log(JSON.stringify({
        ok: true,
        standalone: true,
        configPath,
        reason: `配置中未定义当前宿主 (${harness}) 的模型绑定，已降级为单兵模式`,
        resolved: { harness, surface, role, model: harness === "antigravity" ? "inherit" : null, standalone: true },
      }, null, 2));
      return;
    }
    if (missingForHarness) {
      console.log(JSON.stringify({
        ok: false,
        error: `配置中未找到当前宿主 (${harness}) 的模型槽位（已有宿主：${listConfiguredHarnesses(cfg).join(", ") || "无"}），请运行 /zee-setup 或附加 --allow-standalone`,
        configPath,
        harness,
        role,
      }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: false, error: `配置中未定义角色槽位 "${role}"`, configPath, role }, null, 2));
    process.exit(1);
  }

  let activeSpec = slot?.prefer || slot;
  let activeBinding = extractBindingPair(activeSpec, harness) || extractBindingPair(slot, harness)?.prefer || extractBindingPair(slot, harness);
  let cooldownFallback = null;

  const initialModelRef = activeBinding?.model || activeSpec?.modelHint || activeSpec?.model || activeSpec?.swarmModel || "";
  if (!ignoreCooldown && !isParentAlias(initialModelRef)) {
    const pId = activeBinding?.providerInstanceId;
    const mId = activeBinding?.model || activeSpec?.modelHint || activeSpec?.swarmModel;
    const cd = mId ? getModelCooldown(pId, mId) : { active: false };
    if (cd.active && slot?.backup) {
      const bSpec = slot.backup;
      const bBind = extractBindingPair(bSpec, harness) || extractBindingPair(slot, harness)?.backup;
      const bModelId = bBind?.model || bSpec?.modelHint || bSpec?.swarmModel;
      const bCd = bModelId && !isParentAlias(bModelId) ? getModelCooldown(bBind?.providerInstanceId, bModelId) : { active: false };
      if (!bCd.active) {
        cooldownFallback = { skippedKey: cd.key, reason: cd.entry?.reason || "cooldown", remainingSec: cd.remainingSec };
        activeSpec = bSpec;
        if (bBind) activeBinding = bBind;
      }
    }
  }

  const effort = activeSpec?.effort || "medium";
  const effectiveRawModel = activeBinding?.model || activeSpec?.model || activeSpec?.modelHint || "";
  const hasExplicitSwarmModel = Boolean(harness === "antigravity" && (activeBinding?.swarmModel || activeSpec?.swarmModel));
  if (isParentAlias(effectiveRawModel) && !hasExplicitSwarmModel) {
    let resolvedAlias;
    if (harness === "antigravity") {
      resolvedAlias = {
        harness: "antigravity",
        surface,
        role,
        slot: slotName,
        inheritParent: true,
        model: "inherit",
        effectiveEffort: effort,
        binding: null,
        fallbackOn429: "inherit",
      };
    } else if (harness === "t3") {
      resolvedAlias = {
        harness: "t3",
        surface,
        role,
        slot: slotName,
        inheritParent: true,
        modelHint: effectiveRawModel,
        effort,
        binding: null,
        delegateTarget: null,
        backup: slot?.backup || null,
      };
    } else {
      resolvedAlias = {
        harness,
        surface,
        role,
        slot: slotName,
        inheritParent: true,
        modelHint: effectiveRawModel,
        effort,
        binding: null,
        subagentArgs: { thinkingLevel: effort },
        backup: slot?.backup || null,
      };
    }
    console.log(JSON.stringify({ ok: true, resolved: resolvedAlias }, null, 2));
    return;
  }

  const resolvedFamily =
    source === "harnesses"
      ? activeBinding?.family || activeSpec?.family || extractModelFamily(activeBinding?.model || activeSpec?.swarmModel || activeSpec?.modelHint || "")
      : activeBinding?.family || extractModelFamily(activeBinding?.model || "") || activeSpec?.family || extractModelFamily(activeSpec?.modelHint || "");

  let resolved;
  if (harness === "antigravity") {
    resolved = {
      harness: "antigravity",
      surface,
      role,
      slot: slotName,
      model: normalizeModelForAgy(activeBinding?.model || activeSpec?.modelHint || activeSpec?.model, activeSpec?.tier, effort, surface, { ...activeSpec, ...(activeBinding || {}) }),
      swarmModel: activeBinding?.swarmModel || activeSpec?.swarmModel || null,
      family: resolvedFamily,
      effectiveEffort: effort,
      binding: activeBinding,
      fallbackOn429: "inherit",
      ...(cooldownFallback ? { cooldownFallback } : {}),
    };
  } else if (harness === "t3") {
    const delegateTarget = {
      ...(activeBinding?.providerInstanceId ? { providerInstanceId: activeBinding.providerInstanceId } : {}),
      ...(activeBinding?.model ? { model: activeBinding.model } : {}),
      ...(activeBinding?.options && typeof activeBinding.options === "object" ? { options: activeBinding.options } : {}),
    };
    resolved = {
      harness: "t3",
      surface,
      role,
      slot: slotName,
      modelHint: activeSpec?.modelHint || activeBinding?.model || null,
      family: resolvedFamily,
      effort,
      binding: activeBinding,
      delegateTarget,
      backup: slot?.backup || null,
      ...(cooldownFallback ? { cooldownFallback } : {}),
    };
  } else {
    resolved = {
      harness,
      surface,
      role,
      slot: slotName,
      modelHint: activeSpec?.modelHint || activeBinding?.model || null,
      family: resolvedFamily,
      effort,
      binding: activeBinding,
      subagentArgs: {
        ...(activeBinding?.providerInstanceId ? { provider: activeBinding.providerInstanceId } : {}),
        ...(activeBinding?.model ? { model: activeBinding.model } : {}),
        thinkingLevel: effort,
      },
      backup: slot?.backup || null,
      ...(cooldownFallback ? { cooldownFallback } : {}),
    };
  }

  console.log(JSON.stringify({ ok: true, resolved }, null, 2));
}

function cmdProviderHealth(args) {
  const { flags, positional } = parseFlags(args);
  if (flags.clear !== undefined && flags.clear !== false) {
    const targetKey = typeof flags.clear === "string" ? flags.clear : positional[0];
    console.log(JSON.stringify({ ok: true, ...clearModelCooldown(targetKey) }, null, 2));
    return;
  }
  const cooldowns = listActiveCooldowns();
  console.log(JSON.stringify({ ok: true, healthPath: resolveProviderHealthPath(), activeCount: cooldowns.length, cooldowns }, null, 2));
}

function isParentAliasSlot(pref) {
  if (!pref || typeof pref !== "object") return false;
  if (pref.swarmModel || pref.providerInstanceId || pref.family) return false;
  return isParentAlias(extractSlotRawModel(pref));
}

function validateSlotTable(slotsObj, label, allowSingleFamily, errors, warnings) {
  for (const sName of ["fast", "workhorse", "adversary"]) {
    const s = slotsObj?.[sName];
    const pref = s?.prefer;
    const rawModel = extractSlotRawModel(pref);
    const hasAnyBindingModel = Boolean(
      pref?.bindings &&
        typeof pref.bindings === "object" &&
        Object.values(pref.bindings).some((b) => b && typeof b === "object" && (b.model || b.swarmModel)),
    );
    if (!rawModel && !hasAnyBindingModel) {
      errors.push(`${label}.${sName}.prefer 缺失`);
    }
  }
  const wRaw = extractSlotRawModel(slotsObj?.workhorse?.prefer);
  const aRaw = extractSlotRawModel(slotsObj?.adversary?.prefer);
  const wIsAlias = isParentAliasSlot(slotsObj?.workhorse?.prefer);
  const aIsAlias = isParentAliasSlot(slotsObj?.adversary?.prefer);
  if (aIsAlias) {
    warnings.push(`${label}.adversary 使用父模型别名 (${aRaw})，未启用独立跨家族对抗审查`);
  }
  if (!wIsAlias && !aIsAlias) {
    const wf = slotsObj?.workhorse?.prefer?.family || extractModelFamily(wRaw);
    const af = slotsObj?.adversary?.prefer?.family || extractModelFamily(aRaw);
    if (wf && af && wf === af) {
      const msg = `${label}: workhorse (${wf}) 与 adversary (${af}) 属于同一模型家族`;
      if (allowSingleFamily) warnings.push(`${msg}（已启用 singleFamily 单家族豁免）`);
      else errors.push(`${msg}（非 singleFamily 模式必须为不同模型家族）`);
    }
  }
}

async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function extractOptionFromT3Model(modelObj) {
  if (!Array.isArray(modelObj?.options)) return { optionKey: null, supportedEfforts: null };
  const preferredKeys = ["thought_level", "reasoningEffort", "effort", "thinking"];
  for (const k of preferredKeys) {
    const found = modelObj.options.find((o) => o && o.id === k && Array.isArray(o.values));
    if (found) return { optionKey: k, supportedEfforts: found.values };
  }
  return { optionKey: null, supportedEfforts: null };
}

function parseCandidateModelsInput(rawText, harness) {
  const trimmed = String(rawText || "").replace(/^\uFEFF/, "").trim();
  if (!trimmed) return { items: [], inferredPreferProvider: null };

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.providers)) {
      const activeProviders = parsed.providers.filter((p) => p && p.canRunChildTask === true && Array.isArray(p.models) && p.models.length > 0);
      const hasNativeNonPi = activeProviders.some((p) => p.providerInstanceId !== "pi" && p.driverKind !== "pi");
      const targetProviders =
        harness === "t3" && hasNativeNonPi
          ? activeProviders.filter((p) => p.providerInstanceId !== "pi" && p.driverKind !== "pi")
          : activeProviders;
      const items = [];
      for (const prov of targetProviders) {
        for (const m of prov.models) {
          if (!m?.id) continue;
          const { optionKey, supportedEfforts } = extractOptionFromT3Model(m);
          items.push({
            providerInstanceId: prov.providerInstanceId || prov.driverKind || "",
            model: String(m.id).trim(),
            optionKey,
            supportedEfforts,
          });
        }
      }
      return { items, inferredPreferProvider: parsed.inheritedProviderInstanceId || null };
    }
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : [];
    const items = arr
      .map((entry) => {
        if (typeof entry === "string") {
          const s = entry.trim();
          const slash = s.indexOf("/");
          if (slash > 0 && !s.startsWith("auto/") && !s.startsWith("magpie-")) {
            return { providerInstanceId: s.slice(0, slash), model: s.slice(slash + 1), optionKey: null, supportedEfforts: null };
          }
          return { providerInstanceId: "", model: s, optionKey: null, supportedEfforts: null };
        }
        if (entry && typeof entry === "object" && (entry.model || entry.id)) {
          return {
            providerInstanceId: String(entry.providerInstanceId || entry.provider || "").trim(),
            model: String(entry.model || entry.id).trim(),
            optionKey: entry.optionKey || null,
            supportedEfforts: Array.isArray(entry.supportedEfforts) ? entry.supportedEfforts : null,
          };
        }
        return null;
      })
      .filter((x) => x && x.model);
    return { items, inferredPreferProvider: null };
  }

  const items = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^[-=]+$/.test(line) || /^provider\s+model\b/i.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols.length >= 2) items.push({ providerInstanceId: cols[0].trim(), model: cols[1].trim(), optionKey: null, supportedEfforts: null });
    else if (cols.length === 1 && cols[0]) items.push({ providerInstanceId: "", model: cols[0].trim(), optionKey: null, supportedEfforts: null });
  }
  return { items, inferredPreferProvider: null };
}

function clampEffort(targetEffort, maxRuleEffort, supportedEfforts, ladder) {
  const idxOf = (eff) => ladder.indexOf(String(eff || "").toLowerCase());
  let maxIdx = ladder.length - 1;
  const ruleIdx = idxOf(maxRuleEffort);
  if (ruleIdx >= 0) maxIdx = Math.min(maxIdx, ruleIdx);
  let targetIdx = idxOf(targetEffort);
  if (targetIdx < 0) targetIdx = Math.min(idxOf("medium") >= 0 ? idxOf("medium") : 1, maxIdx);
  const clampedIdx = Math.min(targetIdx, maxIdx);

  if (Array.isArray(supportedEfforts) && supportedEfforts.length > 0) {
    const supSet = new Set(supportedEfforts.map((s) => String(s).toLowerCase()));
    for (let i = clampedIdx; i >= 0; i--) {
      if (supSet.has(ladder[i])) return ladder[i];
    }
    for (let i = clampedIdx + 1; i < ladder.length; i++) {
      if (supSet.has(ladder[i])) return ladder[i];
    }
  }
  return ladder[clampedIdx] || "medium";
}

function scoreModelByRules(baseModel, rules, defaultScore, defaultMaxEffort) {
  for (const rule of rules || []) {
    if (new RegExp(rule.pattern, "i").test(baseModel)) {
      return { matched: true, score: Number(rule.score) || defaultScore, maxEffort: rule.maxEffort || defaultMaxEffort };
    }
  }
  return { matched: false, score: defaultScore, maxEffort: defaultMaxEffort };
}

function formatRecommendedEntry(entry, roleSlot, harness, targetEffort, ladder) {
  if (!entry) return null;
  const maxEffort = roleSlot === "fast" ? entry.fastMaxEffort : entry.flagshipMaxEffort;
  const effort = clampEffort(targetEffort, maxEffort, entry.supportedEfforts, ladder);
  if (harness === "t3") {
    return {
      family: entry.family,
      modelHint: entry.baseModel,
      effort,
      providerInstanceId: entry.providerInstanceId,
      model: entry.model,
      ...(entry.optionKey ? { options: { [entry.optionKey]: effort } } : {}),
    };
  }
  if (harness === "antigravity") {
    return {
      family: entry.family,
      modelHint: entry.baseModel,
      effort,
      model: "inherit",
      swarmModel: `${entry.baseModel}-${effort}`,
    };
  }
  return {
    family: entry.family,
    modelHint: entry.baseModel,
    effort,
    ...(entry.providerInstanceId ? { providerInstanceId: entry.providerInstanceId } : {}),
    model: entry.model,
  };
}

async function cmdRecommendModels(args) {
  const { flags } = parseFlags(args);
  const harness = normalizeHarnessName(flags.harness || detectActiveHarness());
  const catalog = loadModelsCatalog();
  const budgetKey = String(flags.budget || "medium").trim().toLowerCase();
  const budgetSpec = catalog.budgets?.[budgetKey];
  if (!budgetSpec) {
    console.error(JSON.stringify({ ok: false, error: `未知 budget "${budgetKey}"，可选：${Object.keys(catalog.budgets || {}).join(", ")}` }));
    process.exit(1);
  }

  let rawText = typeof flags.models === "string" ? flags.models : "";
  if (!rawText) {
    const fileArg = typeof flags["models-file"] === "string" ? flags["models-file"] : null;
    if (fileArg === "-") rawText = await readStdinText();
    else if (fileArg) rawText = fs.readFileSync(path.resolve(fileArg), "utf8");
    else if (!process.stdin.isTTY) rawText = await readStdinText();
  }
  if (!rawText || !rawText.trim()) {
    console.error(JSON.stringify({ ok: false, error: "缺少输入模型清单：请通过 stdin、--models 或 --models-file 传入" }));
    process.exit(1);
  }

  let parsed;
  try {
    parsed = parseCandidateModelsInput(rawText, harness);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: `模型清单解析失败：${e.message}` }));
    process.exit(1);
  }

  const preferProvider = String(flags["prefer-provider"] || parsed.inferredPreferProvider || "").trim().toLowerCase();
  const ladder = Array.isArray(catalog.effortLadder) ? catalog.effortLadder : ["low", "medium", "high", "xhigh"];
  const excludeRes = (catalog.tierRules?.excludeFromSubagents || []).map((p) => new RegExp(p, "i"));
  const optInRes = (catalog.tierRules?.optInOnly || []).map((p) => new RegExp(p, "i"));

  const enriched = [];
  for (const item of parsed.items) {
    const lowModel = item.model.toLowerCase();
    const baseModel = (lowModel.split("/").pop() || lowModel).trim();
    if (!baseModel || isParentAlias(baseModel) || excludeRes.some((re) => re.test(baseModel) || re.test(lowModel))) continue;
    let routePriority = 1;
    if (harness === "t3") {
      if (!lowModel.includes("/")) routePriority = 4;
      else if (lowModel.startsWith("auto/")) routePriority = 2;
      else routePriority = 1;
    } else {
      if (lowModel.startsWith("auto/")) routePriority = 3;
      else if (!lowModel.includes("/")) routePriority = 2;
      else routePriority = 1;
    }
    const flagshipInfo = scoreModelByRules(baseModel, catalog.tierRules?.flagship, 70, "xhigh");
    const fastInfo = scoreModelByRules(baseModel, catalog.tierRules?.fastQuality, 65, "high");
    const providerBonus = preferProvider && item.providerInstanceId.toLowerCase() === preferProvider ? 2 : 0;
    const isOptIn = optInRes.some((re) => re.test(baseModel) || re.test(lowModel));
    const family = extractModelFamily(baseModel);
    enriched.push({
      key: `${item.providerInstanceId}\0${item.model}`.toLowerCase(),
      dedupKey: harness === "t3" ? baseModel : `${item.providerInstanceId.toLowerCase()}\0${baseModel}`,
      providerInstanceId: item.providerInstanceId,
      model: item.model,
      baseModel,
      family,
      optionKey: item.optionKey,
      supportedEfforts: item.supportedEfforts,
      routePriority,
      providerBonus,
      flagshipScore: flagshipInfo.score + providerBonus,
      flagshipMaxEffort: flagshipInfo.maxEffort,
      fastScore: fastInfo.score + providerBonus,
      fastMaxEffort: fastInfo.maxEffort,
      matchedFastRule: fastInfo.matched,
      isOptIn,
    });
  }

  const dedupMap = new Map();
  const skippedDuplicates = [];
  for (const cand of enriched) {
    const existing = dedupMap.get(cand.dedupKey);
    if (!existing) {
      dedupMap.set(cand.dedupKey, cand);
      continue;
    }
    const candBetter =
      cand.routePriority > existing.routePriority ||
      (cand.routePriority === existing.routePriority && cand.providerBonus > existing.providerBonus);
    if (candBetter) {
      skippedDuplicates.push({ dropped: existing.model, kept: cand.model, reason: "duplicate_base_model" });
      dedupMap.set(cand.dedupKey, cand);
    } else {
      skippedDuplicates.push({ dropped: cand.model, kept: existing.model, reason: "duplicate_base_model" });
    }
  }

  const deduped = [...dedupMap.values()];
  const optInCandidates = deduped.filter((m) => m.isOptIn);
  let eligible = deduped.filter((m) => !m.isOptIn);
  const warnings = [];
  let fallbackToOptIn = false;

  if (eligible.length === 0 && optInCandidates.length > 0) {
    eligible = optInCandidates;
    fallbackToOptIn = true;
    warnings.push("未检测到 Tier S/A 旗舰候选，已兜底使用 opt-in 轻量/第三方模型。");
  }
  if (eligible.length === 0) {
    console.error(JSON.stringify({ ok: false, error: "过滤后没有可用于子代理的候选模型", harness }));
    process.exit(1);
  }

  const flagshipRanked = [...eligible].sort((a, b) => b.flagshipScore - a.flagshipScore || b.fastScore - a.fastScore);
  const workhorsePrefer = flagshipRanked[0];
  const restWh = flagshipRanked.filter((m) => m.key !== workhorsePrefer.key);
  const bestWhAny = restWh[0] || null;
  const bestWhDiffFam = restWh.find((m) => m.family && workhorsePrefer.family && m.family !== workhorsePrefer.family) || null;
  const workhorseBackup = bestWhDiffFam && bestWhAny && bestWhAny.flagshipScore - bestWhDiffFam.flagshipScore <= 6 ? bestWhDiffFam : bestWhAny;

  const diffFromWh = flagshipRanked.filter((m) =>
    workhorsePrefer.family && m.family ? m.family !== workhorsePrefer.family : m.key !== workhorsePrefer.key,
  );
  let singleFamily = false;
  let adversaryPrefer;
  if (diffFromWh.length > 0) {
    adversaryPrefer = diffFromWh[0];
  } else {
    singleFamily = true;
    adversaryPrefer = restWh[0] || workhorsePrefer;
    warnings.push(`当前可用模型仅单一家族 (${workhorsePrefer.family || "unknown"})，已自动标记 singleFamily: true。`);
  }

  const restAdv = flagshipRanked.filter((m) => m.key !== adversaryPrefer.key);
  const adversaryBackup =
    restAdv.find((m) => m.family !== workhorsePrefer.family && m.family !== adversaryPrefer.family) ||
    restAdv.find((m) => m.family !== workhorsePrefer.family) ||
    restAdv[0] ||
    null;

  const fastRanked = [...eligible].sort((a, b) => {
    if (b.fastScore !== a.fastScore) return b.fastScore - a.fastScore;
    const aIsWh = a.key === workhorsePrefer.key ? 1 : 0;
    const bIsWh = b.key === workhorsePrefer.key ? 1 : 0;
    if (aIsWh !== bIsWh) return aIsWh - bIsWh;
    return b.flagshipScore - a.flagshipScore;
  });
  let fastPrefer = fastRanked[0];
  if (fastPrefer.key === workhorsePrefer.key) {
    const altFast = fastRanked.find((m) => m.key !== workhorsePrefer.key && m.matchedFastRule);
    if (altFast) fastPrefer = altFast;
  }
  const restFast = fastRanked.filter((m) => m.key !== fastPrefer.key);
  const fastBackup = restFast.find((m) => fastPrefer.family && m.family && m.family !== fastPrefer.family) || restFast[0] || null;

  const efforts = budgetSpec.efforts || { fast: "low", workhorse: "high", adversary: "high" };
  const slots = {
    fast: {
      prefer: formatRecommendedEntry(fastPrefer, "fast", harness, efforts.fast, ladder),
      ...(fastBackup ? { backup: formatRecommendedEntry(fastBackup, "fast", harness, efforts.fast, ladder) } : {}),
    },
    workhorse: {
      prefer: formatRecommendedEntry(workhorsePrefer, "workhorse", harness, efforts.workhorse, ladder),
      ...(workhorseBackup ? { backup: formatRecommendedEntry(workhorseBackup, "workhorse", harness, efforts.workhorse, ladder) } : {}),
    },
    adversary: {
      prefer: formatRecommendedEntry(adversaryPrefer, "adversary", harness, efforts.adversary, ladder),
      ...(adversaryBackup ? { backup: formatRecommendedEntry(adversaryBackup, "adversary", harness, efforts.adversary, ladder) } : {}),
    },
  };

  console.log(JSON.stringify({
    ok: true,
    harness,
    budget: budgetKey,
    budgetLabel: budgetSpec.label,
    singleFamily,
    fallbackToOptIn,
    warnings,
    harnessConfig: {
      budget: budgetKey,
      ...(singleFamily ? { singleFamily: true } : {}),
      slots,
    },
    optInModels: optInCandidates.map((m) => ({
      ...(m.providerInstanceId ? { providerInstanceId: m.providerInstanceId } : {}),
      model: m.model,
      family: m.family,
    })),
    skippedDuplicates,
  }, null, 2));
}

function cmdDoctor(args) {
  const { flags } = parseFlags(args);
  const activeHarness = normalizeHarnessName(flags.harness || detectActiveHarness());
  const runtimeProvider = detectRuntimeProvider();
  const configPath = typeof flags.config === "string" ? flags.config : process.env.ZEE_CONFIG_PATH?.trim() || DEFAULT_CONFIG;
  const targetRepo = typeof flags.repo === "string" && flags.repo.trim() ? path.resolve(flags.repo.trim()) : null;

  const errors = [];
  const warnings = [];
  let cfg = null;
  let configuredHarnesses = [];
  let activeHarnessConfigured = false;

  if (!fs.existsSync(configPath)) {
    warnings.push(`未配置 ${configPath}（单兵模式可用 --allow-standalone；完整多模型请运行 /zee-setup 为 ${activeHarness} 配置 fast/workhorse/adversary 3 槽位）`);
  } else {
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      configuredHarnesses = listConfiguredHarnesses(cfg);
      const hasHarnessesSlots = Boolean(
        cfg.harnesses &&
          typeof cfg.harnesses === "object" &&
          Object.values(cfg.harnesses).some((h) => h && typeof h === "object" && h.slots && typeof h.slots === "object"),
      );
      if (hasHarnessesSlots) {
        for (const [hKey, hCfg] of Object.entries(cfg.harnesses)) {
          if (!hCfg || typeof hCfg !== "object" || !hCfg.slots || typeof hCfg.slots !== "object") continue;
          const allowSingle = Boolean(hCfg.singleFamily) || hKey === "agy" || hKey === "antigravity";
          validateSlotTable(hCfg.slots, `harnesses.${hKey}.slots`, allowSingle, errors, warnings);
        }
      }
      if (cfg.slots && typeof cfg.slots === "object") {
        validateSlotTable(cfg.slots, "slots", Boolean(cfg.singleFamily), errors, warnings);
      }
      if (!hasHarnessesSlots && !(cfg.slots && typeof cfg.slots === "object")) {
        if (cfg.roles && typeof cfg.roles === "object") {
          warnings.push("当前为 legacy v2 roles 配置，建议升级为按宿主隔离的 3 槽位 schema v3 (harnesses.<h>.slots)");
        } else {
          errors.push("zee-config.json 缺少 harnesses / slots (v3) 或 roles (v2)");
        }
      }

      const hs = getHarnessSection(cfg, activeHarness);
      activeHarnessConfigured = Boolean(hs?.section?.slots && typeof hs.section.slots === "object" && Object.keys(hs.section.slots).length > 0);
      if (!activeHarnessConfigured && cfg.slots && typeof cfg.slots === "object") {
        const hKeys = getHarnessKeys(activeHarness);
        const slotEntries = ["fast", "workhorse", "adversary"].map((k) => cfg.slots[k]).filter(Boolean);
        if (slotEntries.length > 0) {
          activeHarnessConfigured = slotEntries.every((s) => {
            const pref = s?.prefer || s;
            if (specHasExplicitBindings(pref)) return hKeys.some((k) => Boolean(pref.bindings[k]));
            return Boolean(pref?.modelHint || pref?.model || pref?.providerInstanceId);
          });
        }
      }
      if (!activeHarnessConfigured && cfg.roles && typeof cfg.roles === "object") {
        activeHarnessConfigured = true;
      }
      if (!activeHarnessConfigured) {
        warnings.push(
          `当前宿主 (${activeHarness}) 尚未配置专属模型槽位（已有宿主：${configuredHarnesses.join(", ") || "无"}），请运行 /zee-setup 为当前宿主分配模型，或使用 --allow-standalone 单兵模式。`,
        );
      }
    } catch (e) {
      errors.push(`配置文件解析失败: ${e.message}`);
    }
  }

  let busWritable = false;
  try {
    fs.mkdirSync(RUNS_ROOT, { recursive: true });
    const p = path.join(RUNS_ROOT, `.probe-${process.pid}`);
    fs.writeFileSync(p, "ok\n", "utf8");
    fs.unlinkSync(p);
    busWritable = true;
  } catch { busWritable = false; }

  let repoStatus = null;
  if (targetRepo) {
    let verifySkill = null;
    for (const sub of PROJECT_SKILLS_SUBDIRS) {
      const dir = path.join(targetRepo, sub);
      if (!fs.existsSync(dir)) continue;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory() && /^verify-/i.test(ent.name) && fs.existsSync(path.join(dir, ent.name, "SKILL.md"))) {
          verifySkill = path.join(dir, ent.name, "SKILL.md");
          break;
        }
      }
      if (verifySkill) break;
    }
    let hasHeadCommit = false;
    let dirtyFilesCount = 0;
    try {
      execFileSync("git", ["-C", targetRepo, "rev-parse", "--verify", "--quiet", "HEAD"], { stdio: ["ignore", "pipe", "pipe"] });
      hasHeadCommit = true;
    } catch {}
    try {
      const st = execFileSync("git", ["-C", targetRepo, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      dirtyFilesCount = st ? st.split(/\r?\n/).length : 0;
    } catch {}
    if (!hasHeadCommit) {
      warnings.push("目标仓库尚无基线 commit（HEAD 不存在），启用 worktree 或 /zee-night 前请先建一次基础 git commit。");
    } else if (dirtyFilesCount > 0) {
      warnings.push(`目标仓库存在 ${dirtyFilesCount} 项未提交改动，新建 worktree 仅基于 HEAD，未提交改动不会同步到子代理工作树。`);
    }
    repoStatus = {
      repoRoot: targetRepo,
      projectJson: fs.existsSync(path.join(targetRepo, ".agents", "zee.project.json")),
      verifyCtl: fs.existsSync(path.join(targetRepo, ".agents", "verify-ctl.mjs")),
      verifySkill,
      hasHeadCommit,
      dirtyFilesCount,
    };
  }

  const cooldowns = listActiveCooldowns();
  const ok = errors.length === 0 && busWritable;
  console.log(JSON.stringify({
    ok,
    activeHarness,
    runtimeProvider,
    configPath,
    configExists: Boolean(cfg),
    configuredHarnesses,
    activeHarnessConfigured,
    busWritable,
    runsRoot: RUNS_ROOT,
    errors,
    warnings,
    repoStatus,
    providerHealth: { activeCount: cooldowns.length, cooldowns },
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case "init-run": cmdInitRun(rest); break;
  case "update-state": cmdUpdateState(rest); break;
  case "log-decision": cmdLogDecision(rest); break;
  case "list-runs": cmdListRuns(rest[0]); break;
  case "worktree-create": cmdWorktreeCreate(rest); break;
  case "cleanup-worktrees": cmdCleanupWorktrees(rest); break;
  case "sandbox-export": cmdSandboxExport(rest); break;
  case "sandbox-clean": cmdSandboxClean(rest); break;
  case "gate-tamper-diff": cmdGateTamperDiff(rest); break;
  case "recommend-models": await cmdRecommendModels(rest); break;
  case "resolve-model": cmdResolveModel(rest); break;
  case "provider-health": cmdProviderHealth(rest); break;
  case "doctor": cmdDoctor(rest); break;
  default:
    usage();
    process.exit(cmd ? 1 : 0);
}
