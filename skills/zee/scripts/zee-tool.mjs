#!/usr/bin/env node
/**
 * zee-tool.mjs v5.0.1 — 精简高杠杆确定性 CLI 原语（12 核心子命令）
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
 *   resolve-model [--harness pi|agy|t3] [--surface invoke_subagent|swarm] --role <role> [--config <path>] [--allow-standalone] [--ignore-cooldown]
 *   provider-health [--clear [modelKey]]
 *   doctor [--repo <path>]
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
]);

const MULTI_VALUE_FLAGS = new Set(["unit-upsert", "fallback"]);

const KNOWN_BOOLEAN_FLAGS = new Set([
  "all", "prune-safe", "working-tree", "allow-standalone", "clear", "ignore-cooldown", "help",
]);

function detectActiveHarness() {
  if (process.env.PI_CODING_AGENT === "true" || process.env.AI_AGENT === "pi") return "pi";
  if (process.env.ANTIGRAVITY_CLI || process.env.ANTIGRAVITY_AGENT || process.env.PLUGIN_ROOT?.includes(`${path.sep}.gemini${path.sep}`)) {
    return "antigravity";
  }
  const norm = path.resolve(SOURCE_SKILLS_DIR);
  if (norm.includes(`${path.sep}.pi${path.sep}`)) return "pi";
  if (norm.includes(`${path.sep}.claude${path.sep}`)) return "claude";
  if (norm.includes(`${path.sep}.gemini${path.sep}`)) return "antigravity";
  if (norm.includes(`${path.sep}.codex${path.sep}`)) return "codex";
  if (norm.includes(`${path.sep}.cursor${path.sep}`)) return "cursor";
  return "local";
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
  console.log(`zee-tool.mjs v5.0.1 — zee 核心确定性原语（宿主: ${detectActiveHarness()}）

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
  resolve-model [--harness pi|agy|t3] [--surface invoke_subagent|swarm] --role <role> [--config <path>] [--allow-standalone] [--ignore-cooldown]
  provider-health [--clear [modelKey]]
  doctor [--repo <path>]`);
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

function normalizeModelForAgy(modelHint, tier, effort, surface) {
  const low = String(modelHint || "").trim().toLowerCase();
  const eff = effort && effort !== "max" ? effort : "high";
  if (surface === "swarm") {
    if (low && /-(low|medium|high|xhigh)$/.test(low)) return low;
    if (low.includes("argon")) return `${low}-${eff === "xhigh" ? "high" : eff}`;
    if (low && low !== "inherit" && low !== "auto") return `${low}-${eff}`;
    return "inherit";
  }
  if (low === "inherit" || low === "auto" || low.includes("argon") || low.includes("orchestrator")) return "inherit";
  if (low.includes("flash-lite") || low.includes("flash_lite") || tier === "lite") return "flash_lite";
  if (low.includes("hydrogen") || low.includes("flash") || low.includes("haiku") || low.includes("swe-") || tier === "fast") return "flash";
  if (low.includes("neon") || low.includes("pro") || low.includes("opus") || tier === "pro") return "pro";
  return "inherit";
}

function getSlotFromConfig(cfg, rawRole) {
  const r = String(rawRole || "workhorse").trim().toLowerCase();
  // Schema v3: cfg.slots { fast, workhorse, adversary }
  if (cfg?.slots && typeof cfg.slots === "object") {
    const mapped = mapRoleToSlotName(r);
    if (cfg.slots[mapped]) return { slotName: mapped, slot: cfg.slots[mapped] };
  }
  // Legacy Schema v2: cfg.roles
  const roles = cfg?.roles || {};
  if (r === "scout" || r === "fast") return { slotName: "scout", slot: roles.scout };
  if (r === "architect" || r === "architect.primary") return { slotName: "architect.primary", slot: roles.architect?.primary };
  if (r === "judge") return { slotName: "judge", slot: roles.judge || (Array.isArray(roles.reviewers) ? roles.reviewers[0] : null) };
  if (r === "ui" || r === "ui.standard") return { slotName: "ui.standard", slot: roles.ui?.standard };
  if (r === "ui.heavy") return { slotName: "ui.heavy", slot: roles.ui?.heavy };
  if (r === "coder" || r === "coder.standard" || r === "workhorse") return { slotName: "coder.standard", slot: roles.coder?.standard };
  if (r === "coder.heavy") return { slotName: "coder.heavy", slot: roles.coder?.heavy };
  if (r === "verifier") return { slotName: "verifier", slot: roles.verifier };
  if (r === "reviewer" || r === "reviewer.0" || r === "adversary") return { slotName: "reviewer.0", slot: Array.isArray(roles.reviewers) ? roles.reviewers[0] : null };
  if (r.startsWith("reviewer.")) {
    const idx = Number(r.split(".")[1]);
    return { slotName: r, slot: Array.isArray(roles.reviewers) ? roles.reviewers[idx] || null : null };
  }
  return { slotName: r, slot: null };
}

function extractBindingPair(spec, harness) {
  if (!spec || typeof spec !== "object") return null;
  const h = harness === "antigravity" ? "agy" : harness;
  if (spec.bindings?.[harness]) return spec.bindings[harness];
  if (spec.bindings?.[h]) return spec.bindings[h];
  if (spec.providerInstanceId && spec.model) return { providerInstanceId: spec.providerInstanceId, model: spec.model };
  return null;
}

function cmdResolveModel(args) {
  const { flags } = parseFlags(args);
  const harness = String(flags.harness || detectActiveHarness()).toLowerCase();
  const surface = String(flags.surface || "invoke_subagent").toLowerCase();
  const role = String(flags.role || "workhorse").toLowerCase();
  const configPath = typeof flags.config === "string" ? flags.config : process.env.ZEE_CONFIG_PATH?.trim() || DEFAULT_CONFIG;
  const allowStandalone = Boolean(flags["allow-standalone"]);
  const ignoreCooldown = Boolean(flags["ignore-cooldown"]);

  if (!fs.existsSync(configPath)) {
    if (allowStandalone) {
      const isAgy = harness === "agy" || harness === "antigravity";
      console.log(JSON.stringify({ ok: true, standalone: true, configPath, resolved: { harness, surface, role, model: isAgy ? "inherit" : null, standalone: true } }, null, 2));
      return;
    }
    console.log(JSON.stringify({ ok: false, error: `未找到配置文件：${configPath}`, configPath }, null, 2));
    process.exit(1);
  }

  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, "utf8")); }
  catch (e) { console.log(JSON.stringify({ ok: false, error: `配置文件解析失败：${e.message}`, configPath }, null, 2)); process.exit(1); }

  const { slotName, slot } = getSlotFromConfig(cfg, role);
  if (!slot) {
    console.log(JSON.stringify({ ok: false, error: `配置中未定义角色槽位 "${role}"`, configPath, role }, null, 2));
    process.exit(1);
  }

  let activeSpec = slot?.prefer || slot;
  let activeBinding = extractBindingPair(activeSpec, harness) || extractBindingPair(slot, harness)?.prefer || extractBindingPair(slot, harness);
  let cooldownFallback = null;

  if (!ignoreCooldown) {
    const pId = activeBinding?.providerInstanceId;
    const mId = activeBinding?.model || activeSpec?.modelHint;
    const cd = mId ? getModelCooldown(pId, mId) : { active: false };
    if (cd.active && slot?.backup) {
      const bSpec = slot.backup;
      const bBind = extractBindingPair(bSpec, harness) || extractBindingPair(slot, harness)?.backup;
      const bCd = (bBind?.model || bSpec?.modelHint) ? getModelCooldown(bBind?.providerInstanceId, bBind?.model || bSpec?.modelHint) : { active: false };
      if (!bCd.active) {
        cooldownFallback = { skippedKey: cd.key, reason: cd.entry?.reason || "cooldown", remainingSec: cd.remainingSec };
        activeSpec = bSpec;
        if (bBind) activeBinding = bBind;
      }
    }
  }

  const effort = activeSpec?.effort || "medium";
  const resolved =
    harness === "agy" || harness === "antigravity"
      ? {
          harness: "antigravity",
          surface,
          role,
          slot: slotName,
          model: normalizeModelForAgy(activeBinding?.model || activeSpec?.modelHint, activeSpec?.tier, effort, surface),
          effectiveEffort: effort,
          binding: activeBinding,
          fallbackOn429: "inherit",
          ...(cooldownFallback ? { cooldownFallback } : {}),
        }
      : {
          harness,
          surface,
          role,
          slot: slotName,
          modelHint: activeSpec?.modelHint || activeBinding?.model || null,
          family: activeSpec?.family || extractModelFamily(activeBinding?.model || activeSpec?.modelHint || ""),
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

function cmdDoctor(args) {
  const { flags } = parseFlags(args);
  const configPath = typeof flags.config === "string" ? flags.config : process.env.ZEE_CONFIG_PATH?.trim() || DEFAULT_CONFIG;
  const targetRepo = typeof flags.repo === "string" && flags.repo.trim() ? path.resolve(flags.repo.trim()) : null;

  const errors = [];
  const warnings = [];
  let cfg = null;
  if (!fs.existsSync(configPath)) {
    warnings.push(`未配置 ${configPath}（单兵模式可用 --allow-standalone；完整多模型请配置 fast/workhorse/adversary 3 槽位）`);
  } else {
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (cfg.slots && typeof cfg.slots === "object") {
        for (const sName of ["fast", "workhorse", "adversary"]) {
          const s = cfg.slots[sName];
          if (!s?.prefer?.modelHint && !s?.prefer?.bindings?.pi?.model) errors.push(`slots.${sName}.prefer 缺失`);
        }
        const wf = cfg.slots.workhorse?.prefer?.family || extractModelFamily(cfg.slots.workhorse?.prefer?.modelHint || "");
        const af = cfg.slots.adversary?.prefer?.family || extractModelFamily(cfg.slots.adversary?.prefer?.modelHint || "");
        if (wf && af && wf === af) errors.push(`workhorse (${wf}) 与 adversary (${af}) 必须属于不同模型家族`);
      } else if (cfg.roles && typeof cfg.roles === "object") {
        warnings.push("当前为 legacy v2 roles 配置，建议升级为 3 槽位 schema v3 (slots.fast / workhorse / adversary)");
      } else {
        errors.push("zee-config.json 缺少 slots (v3) 或 roles (v2)");
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
    activeHarness: detectActiveHarness(),
    configPath,
    configExists: Boolean(cfg),
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
  case "resolve-model": cmdResolveModel(rest); break;
  case "provider-health": cmdProviderHealth(rest); break;
  case "doctor": cmdDoctor(rest); break;
  default:
    usage();
    process.exit(cmd ? 1 : 0);
}
