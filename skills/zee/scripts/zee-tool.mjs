#!/usr/bin/env node
/**
 * zee-tool.mjs v5.2.0 — 精简高杠杆确定性 CLI 原语（14 核心子命令）
 *
 * 子命令：
 *   init-run <repoRoot> <slug> [--mode night|standard] [--conversation-id <cid>] [--ensure-git]
 *   update-state <busDir> [--status ...] [--mode ...] [--predicate ...] [--resume-next ...] [--conversation-id <cid>] [--budget '<json>'] [--unit-upsert '<json>'] [--units '<json-array>'] [--units-file <path|->] [--decision '<json>'] [--inc-delegates [N]] [--delegate-id <id>] [--inc-aborted [N]]
 *   log-decision <busDir> --unit <id> --phase <p> --decision <d> [--why <w>] [--evidence <e>] [--result <r>]
 *   list-runs [repoRoot | --repo <path> | --all] [--decisions] [--limit <N>]
 *   finding <add|list|resolve> --repo <path> [--pattern <slug>] [--summary <text>] [--file <path>] [--severity P2|P1] [--note <text>] [--include-resolved]
 *   worktree-create <repoRoot> <slug> <lane> <baseRef> [--branch <name>]
 *   cleanup-worktrees [repoRoot] [--base <ref>] [--prune-safe]
 *   sandbox-export --repo <repoRoot> [--sha <sha> | --working-tree] [--prefix rev|mut|probe|sim|retro|verify]
 *   sandbox-clean <sandboxDir>
 *   gate-tamper-diff --repo <repoRoot> [--base <ref>] [--head <ref> | --working-tree]
 *   recommend-models [--harness pi|t3|agy|codex|claude] [--budget large|medium|small] [--prefer-provider <id>] [--models '<json>'] [--models-file <path>]
 *   resolve-model [--harness pi|t3|agy|codex|claude] [--surface delegate_task|invoke_subagent|swarm|zee_subagent] --role <role> [--author-family <fam>] [--config <path>] [--allow-standalone] [--ignore-cooldown]
 *   provider-health [--clear [modelKey] | --record <modelKey> [--provider <p>] [--kind rate_limit|transient_5xx] [--reason <r>] [--ttl-ms <ms>]]
 *   doctor [--repo <path>] [--harness <h>]
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractModelFamily, isAllowedZeeTmpPath } from "./lib/guard-core.mjs";
import { atomicWriteJson, cleanStaleTempFiles, withFileLock } from "./lib/fs-atomic.mjs";
import {
  clearModelCooldown,
  getModelCooldown,
  listActiveCooldowns,
  mapRoleToSlotName,
  recordModelCooldown,
  resolveProviderHealthPath,
} from "./lib/provider-health.mjs";
import {
  ensureNodeModulesMount,
  repoKeyCandidates,
  resolveGitRoot,
  resolveRepoRunDir,
  resolveSafeWorktreeBranch,
  sanitizeSlug,
  stripAnsiAndControl,
  unmountNodeModulesLink,
} from "./lib/repo-utils.mjs";

const HOME = os.homedir();
const DEFAULT_CONFIG = path.join(HOME, ".agents", "zee-config.json");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_SKILLS_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const RUNS_ROOT = path.join(HOME, ".local", "state", "zee", "runs");
const SANDBOX_MARKER_FILE = ".zee-sandbox-marker";
const PROJECT_SKILLS_SUBDIRS = [
  path.join(".agents", "skills"),
  path.join(".pi", "skills"),
  path.join(".claude", "skills"),
  path.join(".cursor", "skills"),
];

const KNOWN_VALUE_FLAGS = new Set([
  "harness", "repo", "bus", "status", "mode", "level", "predicate", "resume-next",
  "conversation-id", "budget", "unit-upsert", "units", "units-file", "decision", "fallback",
  "branch", "base", "head", "sha", "prefix", "delegate-id", "surface", "role", "author-family",
  "config", "dir", "unit", "phase", "why", "evidence", "result",
  "models", "models-file", "prefer-provider",
  "record", "provider", "kind", "reason", "ttl-ms",
  "limit", "pattern", "summary", "file", "severity", "note",
]);

const MULTI_VALUE_FLAGS = new Set(["unit-upsert", "fallback"]);

const KNOWN_BOOLEAN_FLAGS = new Set([
  "all", "prune-safe", "working-tree", "allow-standalone", "clear", "ignore-cooldown",
  "help", "ensure-git", "decisions", "include-resolved",
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
    if (token === "-h") { flags.help = true; continue; }
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
        const nextIsFlag = typeof next === "string" && next.startsWith("--") && next.length > 2;
        if (KNOWN_BOOLEAN_FLAGS.has(key)) {
          flags[key] = true;
        } else if (KNOWN_VALUE_FLAGS.has(key)) {
          if (next !== undefined && !nextIsFlag) { assignValueFlag(key, next); i += 1; }
          else assignValueFlag(key, true);
        } else if (key === "inc-delegates" || key === "inc-aborted") {
          if (next !== undefined && /^\d+$/.test(next)) {
            flags[key] = (Number(flags[key]) || 0) + Number(next);
            i += 1;
          } else {
            flags[key] = (Number(flags[key]) || 0) + 1;
          }
        } else if (next !== undefined && !nextIsFlag) {
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
  console.log(`zee-tool.mjs v5.2.0 — zee 核心确定性原语（宿主: ${detectActiveHarness()}）

可用命令：
  init-run <repoRoot> <slug> [--mode night|standard] [--conversation-id <cid>] [--ensure-git]
  update-state <busDir> [--status <s>] [--mode <m>] [--predicate <p>] [--resume-next <r>] [--conversation-id <cid>] [--budget '<json>'] [--unit-upsert '<json>'] [--units '<json-array>'] [--units-file <path|->] [--decision '<json>'] [--inc-delegates [N]] [--delegate-id <id>] [--inc-aborted [N]]
  log-decision <busDir> --unit <id> --phase <p> --decision <d> [--why <w>] [--evidence <e>] [--result <r>]
  list-runs [repoRoot | --repo <path> | --all] [--decisions] [--limit <N>]
  finding <add|list|resolve> --repo <path> [--pattern <slug>] [--summary <text>] [--file <path>] [--severity P2|P1] [--note <text>] [--include-resolved]
  worktree-create <repoRoot> <slug> <lane> <baseRef> [--branch <name>]
  cleanup-worktrees [repoRoot] [--base <ref>] [--prune-safe]
  sandbox-export --repo <repoRoot> [--sha <sha> | --working-tree] [--prefix rev|mut|probe|sim|retro|verify]
  sandbox-clean <sandboxDir>
  gate-tamper-diff --repo <repoRoot> [--base <ref>] [--head <ref> | --working-tree]
  recommend-models [--harness pi|t3|agy|codex|claude] [--budget large|medium|small] [--prefer-provider <id>] [--models '<json>'] [--models-file <path>]
  resolve-model [--harness pi|t3|agy|codex|claude] [--surface delegate_task|invoke_subagent|swarm|zee_subagent] --role <role> [--author-family <fam>] [--config <path>] [--allow-standalone] [--ignore-cooldown]
  provider-health [--clear [modelKey] | --record <modelKey> [--provider <p>] [--kind rate_limit|transient_5xx] [--reason <r>] [--ttl-ms <ms>]]
  doctor [--repo <path>] [--harness <h>]`);
}

const TSV_HEADER = "ts\tunit\tphase\tdecision\twhy\tevidence\tresult\n";

function cleanTsvField(val) {
  const cleaned = stripAnsiAndControl(val ?? "").replace(/[\t\r\n]+/g, " ").trim();
  if (cleaned && cleaned !== "-" && /^[=+\-@]/.test(cleaned)) return `'${cleaned}`;
  return cleaned;
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

function ensureGitBaseline(absRepo) {
  fs.mkdirSync(absRepo, { recursive: true });
  let initializedGit = false;
  let createdBaselineCommit = false;
  let isGit = false;
  try {
    execFileSync("git", ["-C", absRepo, "rev-parse", "--git-dir"], { stdio: ["ignore", "pipe", "pipe"] });
    isGit = true;
  } catch {}
  if (!isGit) {
    execFileSync("git", ["-C", absRepo, "init", "-q"], { stdio: ["ignore", "pipe", "pipe"] });
    initializedGit = true;
  }
  let hasHead = false;
  try {
    execFileSync("git", ["-C", absRepo, "rev-parse", "--verify", "--quiet", "HEAD"], { stdio: ["ignore", "pipe", "pipe"] });
    hasHead = true;
  } catch {}
  if (!hasHead) {
    execFileSync(
      "git",
      ["-C", absRepo, "-c", "user.name=zee", "-c", "user.email=zee@local", "commit", "--allow-empty", "-qm", "chore: bootstrap zee baseline"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    createdBaselineCommit = true;
  }
  return { initializedGit, createdBaselineCommit };
}

function cmdInitRun(args) {
  const { flags, positional } = parseFlags(args);
  if (flags.help) { usage(); return; }
  const [repoPath, slug] = positional;
  if (!repoPath || !slug) {
    console.error("用法：init-run <仓库路径> <任务名> [--mode night|standard] [--conversation-id <cid>] [--ensure-git]");
    process.exit(1);
  }
  const absRepo = path.resolve(repoPath);
  let gitBootstrap = null;
  if (flags["ensure-git"]) {
    gitBootstrap = ensureGitBaseline(absRepo);
  }
  const busDir = path.join(resolveRepoRunDir(RUNS_ROOT, absRepo), sanitizeSlug(slug));
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
  console.log(JSON.stringify({
    ok: true,
    activeHarness: detectActiveHarness(),
    busDir,
    statePath,
    tsvPath,
    ...(gitBootstrap ? { gitBootstrap } : {}),
  }, null, 2));
}

async function cmdUpdateState(args) {
  const { flags, positional } = parseFlags(args);
  if (flags.help) { usage(); return; }
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

  // 所有 JSON 解析与 Schema 校验前置到 withFileLock 之外，杜绝异常退出泄漏 .lock 或部分写
  let unitsFromFile = null;
  if (typeof flags["units-file"] === "string" && flags["units-file"].trim()) {
    const fileArg = flags["units-file"].trim();
    const rawUnitsText = fileArg === "-" ? await readStdinText() : fs.readFileSync(path.resolve(fileArg), "utf8");
    const parsedUnits = JSON.parse(String(rawUnitsText || "").replace(/^\uFEFF/, ""));
    if (!Array.isArray(parsedUnits)) {
      console.error("--units-file 内容必须是 JSON 数组");
      process.exit(1);
    }
    unitsFromFile = parsedUnits;
  }

  let budgetObj = null;
  if (typeof flags.budget === "string") {
    budgetObj = JSON.parse(flags.budget);
    if (!budgetObj || typeof budgetObj !== "object" || Array.isArray(budgetObj)) {
      console.error("--budget 必须是 JSON 对象");
      process.exit(1);
    }
  }

  const parsedUnitsToUpsert = [];
  const validateUnit = (u) => {
    if (!u || typeof u !== "object" || Array.isArray(u) || !u.id) {
      console.error("--unit-upsert / --units 对象必须包含 id 字段");
      process.exit(1);
    }
    parsedUnitsToUpsert.push(u);
  };

  if (Array.isArray(unitsFromFile)) unitsFromFile.forEach(validateUnit);
  if (typeof flags.units === "string") {
    const arr = JSON.parse(flags.units);
    if (!Array.isArray(arr)) {
      console.error("--units 必须是 JSON 数组");
      process.exit(1);
    }
    arr.forEach(validateUnit);
  }
  const singleUpserts = Array.isArray(flags["unit-upsert"])
    ? flags["unit-upsert"]
    : typeof flags["unit-upsert"] === "string"
      ? [flags["unit-upsert"]]
      : [];
  for (const rawUnit of singleUpserts) {
    if (typeof rawUnit === "string") validateUnit(JSON.parse(rawUnit));
  }

  let parsedDecision = null;
  if (typeof flags.decision === "string") {
    parsedDecision = JSON.parse(flags.decision);
    if (!parsedDecision || typeof parsedDecision !== "object" || Array.isArray(parsedDecision) || !parsedDecision.decision) {
      console.error("--decision 必须是包含 decision 字段的 JSON 对象");
      process.exit(1);
    }
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
    if (budgetObj) {
      next.budget = { ...(next.budget && typeof next.budget === "object" ? next.budget : {}), ...budgetObj };
    }

    const fallbacks = Array.isArray(flags.fallback) ? flags.fallback : typeof flags.fallback === "string" ? [flags.fallback] : [];
    for (const fb of fallbacks) {
      if (typeof fb === "string" && fb.trim()) {
        if (!Array.isArray(next.fallbacksUsed)) next.fallbacksUsed = [];
        if (!next.fallbacksUsed.includes(fb)) next.fallbacksUsed.push(fb);
      }
    }

    for (const unitObj of parsedUnitsToUpsert) {
      if (!Array.isArray(next.units)) next.units = [];
      const idx = next.units.findIndex((u) => u && u.id === unitObj.id);
      if (idx >= 0) next.units[idx] = { ...next.units[idx], ...unitObj, updatedAt: new Date().toISOString() };
      else next.units.push({ ...unitObj, updatedAt: new Date().toISOString() });
    }

    next.updatedAt = new Date().toISOString();
    atomicWriteJson(statePath, next);
    return next;
  });

  if (parsedDecision) appendDecisionRow(busDir, parsedDecision);

  console.log(JSON.stringify({ ok: true, statePath, state: st }, null, 2));
}

function cmdLogDecision(args) {
  const { flags, positional } = parseFlags(args);
  if (flags.help) { usage(); return; }
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

function readDecisionsFromRun(runDir, slug) {
  const tsvPath = path.join(runDir, "decisions.tsv");
  if (!fs.existsSync(tsvPath)) return [];
  try {
    const lines = fs.readFileSync(tsvPath, "utf8").split(/\r?\n/).filter((l) => l.trim());
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split("\t");
      if (cols.length < 4) continue;
      rows.push({
        slug,
        ts: cols[0] || "",
        unit: cols[1] || "-",
        phase: cols[2] || "-",
        decision: cols[3] || "",
        why: cols[4] || "-",
        evidence: cols[5] || "-",
        result: cols[6] || "-",
      });
    }
    return rows;
  } catch {
    return [];
  }
}

function cmdListRuns(args) {
  const { flags, positional } = parseFlags(args);
  if (flags.help) { usage(); return; }
  const includeAll = Boolean(flags.all);
  const rawRepo = typeof flags.repo === "string" && flags.repo.trim() ? flags.repo.trim() : positional[0];
  const includeDecisions = Boolean(flags.decisions);
  const limit = Math.max(1, Math.min(200, Number(flags.limit) || 40));

  if (!fs.existsSync(RUNS_ROOT)) {
    console.log(JSON.stringify({ ok: true, count: 0, runs: [], ...(includeDecisions ? { decisions: [] } : {}) }, null, 2));
    return;
  }

  let repoDirs;
  if (!includeAll && rawRepo) {
    const resolved = path.resolve(rawRepo);
    const gitTop = resolveGitRoot(resolved);
    const keySet = new Set(repoKeyCandidates(resolved));
    if (gitTop) repoKeyCandidates(gitTop).forEach((k) => keySet.add(k));
    repoDirs = [...keySet].map((k) => path.join(RUNS_ROOT, k));
  } else {
    repoDirs = fs.readdirSync(RUNS_ROOT).map((d) => path.join(RUNS_ROOT, d));
  }

  const runs = [];
  const allDecisions = [];
  const seenBusDirs = new Set();

  for (const rDir of repoDirs) {
    if (!fs.existsSync(rDir) || !fs.statSync(rDir).isDirectory()) continue;
    for (const slug of fs.readdirSync(rDir)) {
      const runDir = path.join(rDir, slug);
      if (seenBusDirs.has(runDir)) continue;
      const statePath = path.join(runDir, "state.json");
      if (!fs.existsSync(statePath)) continue;
      seenBusDirs.add(runDir);
      try {
        const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
        runs.push({
          slug: st.slug || slug,
          status: st.status || "unknown",
          mode: st.mode || "standard",
          level: st.level ?? null,
          predicate: st.predicate ?? null,
          repoRoot: st.repoRoot || null,
          busDir: st.busDir || runDir,
          updatedAt: st.updatedAt || st.createdAt || null,
          resumeNext: st.resumeNext ?? null,
          unitsCount: Array.isArray(st.units) ? st.units.length : 0,
        });
        if (includeDecisions) {
          allDecisions.push(...readDecisionsFromRun(runDir, st.slug || slug));
        }
      } catch {}
    }
  }
  runs.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  const out = { ok: true, count: runs.length, runs };
  if (includeDecisions) {
    allDecisions.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
    out.decisions = allDecisions.slice(0, limit);
  }
  console.log(JSON.stringify(out, null, 2));
}

function cmdFinding(args) {
  const { flags, positional } = parseFlags(args);
  if (flags.help) { usage(); return; }
  const action = String(positional[0] || "list").trim().toLowerCase();
  const repoRoot = path.resolve(typeof flags.repo === "string" && flags.repo.trim() ? flags.repo.trim() : process.cwd());
  if (!fs.existsSync(repoRoot)) {
    console.error(JSON.stringify({ ok: false, error: `仓库路径不存在：${repoRoot}` }));
    process.exit(1);
  }
  const queuePath = path.join(repoRoot, ".agents", "gardening-queue.jsonl");

  const readEntries = () => {
    if (!fs.existsSync(queuePath)) return [];
    const lines = fs.readFileSync(queuePath, "utf8").split(/\r?\n/).filter((l) => l.trim());
    const items = [];
    for (const line of lines) {
      try { items.push(JSON.parse(line)); } catch {}
    }
    return items;
  };

  if (action === "add") {
    const pattern = sanitizeSlug(flags.pattern || "");
    const summary = stripAnsiAndControl(typeof flags.summary === "string" ? flags.summary : "").trim();
    if (!flags.pattern || !summary) {
      console.error("用法：finding add --repo <path> --pattern <slug> --summary <text> [--file <path>] [--severity P2|P1]");
      process.exit(1);
    }
    const entry = {
      type: "finding",
      ts: new Date().toISOString(),
      pattern,
      summary: summary.slice(0, 400),
      file: typeof flags.file === "string" && flags.file.trim() ? stripAnsiAndControl(flags.file.trim()) : null,
      severity: String(flags.severity || "P2").toUpperCase() === "P1" ? "P1" : "P2",
    };
    withFileLock(queuePath, () => {
      fs.mkdirSync(path.dirname(queuePath), { recursive: true });
      fs.appendFileSync(queuePath, JSON.stringify(entry) + "\n", "utf8");
    });
    console.log(JSON.stringify({ ok: true, queuePath, added: entry }, null, 2));
    return;
  }

  if (action === "resolve") {
    const pattern = sanitizeSlug(flags.pattern || "");
    if (!flags.pattern) {
      console.error("用法：finding resolve --repo <path> --pattern <slug> [--note <text>]");
      process.exit(1);
    }
    const entry = {
      type: "resolved",
      ts: new Date().toISOString(),
      pattern,
      note: typeof flags.note === "string" ? stripAnsiAndControl(flags.note).trim().slice(0, 300) : "resolved",
    };
    withFileLock(queuePath, () => {
      fs.mkdirSync(path.dirname(queuePath), { recursive: true });
      fs.appendFileSync(queuePath, JSON.stringify(entry) + "\n", "utf8");
    });
    console.log(JSON.stringify({ ok: true, queuePath, resolved: entry }, null, 2));
    return;
  }

  if (action === "list") {
    const includeResolved = Boolean(flags["include-resolved"]);
    const entries = readEntries();
    const groups = new Map();
    for (const item of entries) {
      const pat = item?.pattern;
      if (!pat) continue;
      if (!groups.has(pat)) {
        groups.set(pat, { pattern: pat, openCount: 0, totalCount: 0, resolvedAt: null, lastNote: null, samples: [] });
      }
      const g = groups.get(pat);
      if (item.type === "resolved") {
        g.openCount = 0;
        g.resolvedAt = item.ts || null;
        g.lastNote = item.note || null;
      } else {
        g.openCount += 1;
        g.totalCount += 1;
        g.resolvedAt = null;
        g.samples.push({ ts: item.ts, summary: item.summary, file: item.file || null, severity: item.severity || "P2" });
        if (g.samples.length > 5) g.samples.shift();
      }
    }
    const clusters = [...groups.values()]
      .filter((g) => includeResolved || g.openCount > 0)
      .map((g) => ({ ...g, systemic: g.openCount >= 3 }))
      .sort((a, b) => Number(b.systemic) - Number(a.systemic) || b.openCount - a.openCount || a.pattern.localeCompare(b.pattern));

    console.log(JSON.stringify({
      ok: true,
      queuePath,
      openClusters: clusters.filter((c) => c.openCount > 0).length,
      systemicCount: clusters.filter((c) => c.systemic).length,
      clusters,
    }, null, 2));
    return;
  }

  console.error(`未知 finding 操作 "${action}"，支持：add | list | resolve`);
  process.exit(1);
}

const DEFAULT_WORKTREE_LOCK_TTL_MS = 12 * 60 * 60 * 1000;

function getWorktreeLockMaxTtlMs() {
  const n = Number(process.env.ZEE_WORKTREE_LOCK_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WORKTREE_LOCK_TTL_MS;
}

function isWorktreeActiveLocked(wtPath) {
  const lockPath = `${wtPath}.zee-lock.json`;
  if (!fs.existsSync(lockPath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const createdMs = Date.parse(data?.createdAt || "");
    const ageMs = Number.isFinite(createdMs) ? Date.now() - createdMs : NaN;
    const maxTtlMs = getWorktreeLockMaxTtlMs();
    if (Number.isFinite(ageMs) && ageMs > maxTtlMs) return false;
    const pid = Number(data?.pid);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return true; }
      catch (e) { return Boolean(e && e.code === "EPERM"); }
    }
    return Number.isFinite(ageMs) && ageMs < Math.min(2 * 60 * 60 * 1000, maxTtlMs);
  } catch {
    return false;
  }
}

function cmdWorktreeCreate(args) {
  const { flags, positional } = parseFlags(args);
  if (flags.help) { usage(); return; }
  const [repoPath, slug, lane, baseRef] = positional;
  if (!repoPath || !slug || !lane || !baseRef) {
    console.error("用法：worktree-create <仓库路径> <slug> <lane> <baseRef> [--branch <分支名>]");
    process.exit(1);
  }
  const absRepo = path.resolve(repoPath);
  try {
    execFileSync("git", ["-C", absRepo, "rev-parse", "--verify", "--quiet", baseRef], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    console.error(`创建 worktree 失败：基准引用 "${baseRef}" 不存在（0→1 空仓请先执行 init-run --ensure-git 或创建首次 git commit）`);
    process.exit(1);
  }

  const wtRoot = path.join(resolveRepoRunDir(RUNS_ROOT, absRepo), sanitizeSlug(slug), "worktrees");
  const wtPath = path.join(wtRoot, sanitizeSlug(lane));
  fs.mkdirSync(wtRoot, { recursive: true });

  if (fs.existsSync(wtPath)) {
    if (isWorktreeActiveLocked(wtPath)) {
      console.error(`拒绝覆盖：目标 worktree 正被活跃子代理锁定：${wtPath}`);
      process.exit(1);
    }
    let st = "";
    try { st = execFileSync("git", ["-C", wtPath, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
    if (st) {
      console.error(`拒绝覆盖：目标 worktree 存在未提交改动：${wtPath}`);
      process.exit(1);
    }
    unmountNodeModulesLink(wtPath);
    try {
      execFileSync("git", ["-C", absRepo, "worktree", "remove", "--force", wtPath], { stdio: "ignore" });
    } catch {}
    if (fs.existsSync(wtPath)) {
      fs.rmSync(wtPath, { recursive: true, force: true });
      try { execFileSync("git", ["-C", absRepo, "worktree", "prune"], { stdio: "ignore" }); } catch {}
    }
  }

  const gitArgs = ["-C", absRepo, "worktree", "add"];
  const rawBranch = typeof flags.branch === "string" && flags.branch.trim() ? flags.branch.trim() : null;
  const resolvedBranch = rawBranch ? resolveSafeWorktreeBranch(absRepo, rawBranch) : null;
  const branch = resolvedBranch ? resolvedBranch.branch : null;
  let reusedExistingBranch = false;
  if (branch) {
    let exists = false;
    try { execFileSync("git", ["-C", absRepo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]); exists = true; } catch {}
    if (exists) {
      reusedExistingBranch = true;
      gitArgs.push(wtPath, branch);
    } else {
      gitArgs.push("-b", branch, wtPath, baseRef);
    }
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
    reusedExistingBranch,
    flattened: Boolean(resolvedBranch?.flattened),
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

function cmdCleanupWorktrees(args) {
  const { flags, positional } = parseFlags(args);
  if (flags.help) { usage(); return; }
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
          if (isSquashMergedByPatchId(absRepo, ref, isDetached ? head : branch)) {
            isMerged = true; mergeMethod = "squash-patch-id"; mergedInto = ref; break;
          }
        }
      }
    }

    const isPrimary = idx === 0;
    const isActiveLocked = !isPrimary && isWorktreeActiveLocked(wtPath);
    let bucket = "primary";
    if (!isPrimary) {
      if (isActiveLocked) bucket = "active_hold";
      else if (dirtyFiles > 0) bucket = "keep_dirty";
      else if (isMerged) bucket = "safe_to_prune";
      else if (isDetached) bucket = "review_unmerged_detached";
      else bucket = "review_unmerged";
    }

    let prunedNow = false;
    if (pruneSafe && bucket === "safe_to_prune") {
      unmountNodeModulesLink(wtPath);
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

function copyDirectoryTreeSkippingHeavy(srcDir, dstDir) {
  const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".nuxt", "dist", "build", ".venv", "__pycache__", "target"]);
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const src = path.join(srcDir, ent.name);
    const dst = path.join(dstDir, ent.name);
    try {
      if (ent.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(src);
        let isDirLink = false;
        try { isDirLink = fs.statSync(src).isDirectory(); } catch {}
        fs.symlinkSync(linkTarget, dst, process.platform === "win32" && isDirLink ? "junction" : undefined);
      } else if (ent.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        copyDirectoryTreeSkippingHeavy(src, dst);
      } else if (ent.isFile()) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    } catch {}
  }
}

function repoHasExportIgnore(repoRoot) {
  const attrPath = path.join(repoRoot, ".gitattributes");
  if (!fs.existsSync(attrPath)) return false;
  try {
    return /\bexport-ignore\b/i.test(fs.readFileSync(attrPath, "utf8"));
  } catch {
    return false;
  }
}

function copyRelFileOrLink(repoRoot, sandboxDir, rel) {
  const src = path.join(repoRoot, rel);
  const dst = path.join(sandboxDir, rel);
  try {
    const st = fs.lstatSync(src);
    if (st.isFile()) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } else if (st.isSymbolicLink()) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      let isDirLink = false;
      try { isDirLink = fs.statSync(src).isDirectory(); } catch {}
      fs.symlinkSync(fs.readlinkSync(src), dst, process.platform === "win32" && isDirLink ? "junction" : undefined);
    }
  } catch {}
}

function writeSandboxMarker(sandboxDir, repoRoot) {
  fs.writeFileSync(
    path.join(sandboxDir, SANDBOX_MARKER_FILE),
    JSON.stringify({ createdBy: "zee-sandbox-export", repoRoot, createdAt: new Date().toISOString() }) + "\n",
    "utf8",
  );
}

function cmdSandboxExport(args) {
  const { flags, positional } = parseFlags(args);
  if (flags.help) { usage(); return; }
  const repoRoot = path.resolve(flags.repo || positional[0] || process.cwd());
  if (!fs.existsSync(repoRoot)) {
    console.error(JSON.stringify({ ok: false, error: `目标目录不存在：${repoRoot}` }));
    process.exit(1);
  }
  const workingTree = Boolean(flags["working-tree"]);
  const ALLOWED_PREFIXES = new Set(["rev", "mut", "probe", "sim", "retro", "verify"]);
  const rawPrefix = typeof flags.prefix === "string" ? flags.prefix.trim().toLowerCase() : "mut";
  const prefix = ALLOWED_PREFIXES.has(rawPrefix) ? rawPrefix : "mut";

  let gitDirRaw = "";
  let isGitRepo = false;
  try {
    gitDirRaw = execFileSync("git", ["-C", repoRoot, "rev-parse", "--git-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    isGitRepo = Boolean(gitDirRaw);
  } catch {}

  if (!isGitRepo) {
    if (!workingTree) {
      console.error(JSON.stringify({ ok: false, error: `${repoRoot} 不是合法的 Git 仓库（非 Git 目录请附加 --working-tree）` }));
      process.exit(1);
    }
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), `zee-${prefix}-`));
    try {
      copyDirectoryTreeSkippingHeavy(repoRoot, sandboxDir);
      writeSandboxMarker(sandboxDir, repoRoot);
      console.log(JSON.stringify({ ok: true, sandboxDir, mode: "working-tree", nonGit: true, ref: "WORKING_TREE", sha: null }, null, 2));
      return;
    } catch (e) {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
      console.error(JSON.stringify({ ok: false, error: `sandbox-export 失败：${e.message}` }));
      process.exit(1);
    }
  }

  const gitDir = path.resolve(repoRoot, gitDirRaw);
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
      if (!repoHasExportIgnore(repoRoot)) {
        const archRes = spawnSync("git", ["-c", "core.autocrlf=false", "-C", repoRoot, "archive", "--format=tar", targetRef], { maxBuffer: 200 * 1024 * 1024 });
        if (archRes.status === 0 && archRes.stdout) {
          if (spawnSync("tar", ["-xf", "-", "-C", sandboxDir], { input: archRes.stdout, maxBuffer: 50 * 1024 * 1024 }).status === 0) exported = true;
        }
      }
      if (!exported) {
        const treeEntries = execFileSync("git", ["-C", repoRoot, "ls-tree", "--name-only", targetRef], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
        if (treeEntries) {
          const tmpIndex = path.join(os.tmpdir(), `zee-idx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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
                  if (newRel) copyRelFileOrLink(repoRoot, sandboxDir, newRel);
                } else {
                  const relFile = parts[i + 1]; i += 1;
                  if (!relFile) continue;
                  const dst = path.join(sandboxDir, relFile);
                  if (stCode === "D") fs.rmSync(dst, { recursive: true, force: true });
                  else copyRelFileOrLink(repoRoot, sandboxDir, relFile);
                }
              }
            }
          }
        }
      } else {
        // 无 HEAD 的 0→1 仓库：同时导出已暂存文件（staged）与未跟踪文件
        const stagedRaw = execFileSync("git", ["-C", repoRoot, "ls-files", "-z"], { encoding: "utf8" });
        for (const rel of stagedRaw.split("\0").filter(Boolean)) {
          copyRelFileOrLink(repoRoot, sandboxDir, rel);
        }
      }
      const untrackedRaw = execFileSync("git", ["-C", repoRoot, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" });
      for (const rel of untrackedRaw.split("\0").filter(Boolean)) {
        copyRelFileOrLink(repoRoot, sandboxDir, rel);
      }
    }
    writeSandboxMarker(sandboxDir, repoRoot);
    console.log(JSON.stringify({ ok: true, sandboxDir, mode: workingTree ? "working-tree" : "sha", ref: workingTree ? "WORKING_TREE" : targetRef, sha: resolvedSha }, null, 2));
  } catch (e) {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
    console.error(JSON.stringify({ ok: false, error: `sandbox-export 失败：${e.message}` }));
    process.exit(1);
  }
}

function cmdSandboxClean(args) {
  const { flags, positional } = parseFlags(args);
  if (flags.help) { usage(); return; }
  const rawDir = flags.dir || positional[0];
  if (!rawDir) {
    console.error(JSON.stringify({ ok: false, error: "用法：sandbox-clean <sandboxDir>" }));
    process.exit(1);
  }
  const sandboxDir = path.resolve(rawDir);
  const baseName = path.basename(sandboxDir);
  const hasMarker = fs.existsSync(path.join(sandboxDir, SANDBOX_MARKER_FILE));
  const looksLikeRealRepo = fs.existsSync(path.join(sandboxDir, ".git")) || (!hasMarker && fs.existsSync(path.join(sandboxDir, ".agents", "zee.project.json")));
  if (
    !isAllowedZeeTmpPath(sandboxDir, "") ||
    !/^zee-(?:mut|rev|probe|sim|retro|verify)-[a-z0-9][a-z0-9_.-]*$/i.test(baseName) ||
    looksLikeRealRepo
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

function isPureTestFilePath(rawRelPath) {
  const p = String(rawRelPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p) return false;
  if (/(?:^|\/)(?:tests?|__tests__)\//i.test(p)) return true;
  const base = path.posix.basename(p);
  return (
    /\.(?:test|spec)\.[^/]+$/i.test(base) ||
    /_test\.(?:go|py|rs|rb|ts|tsx|js|jsx|mjs|cjs)$/i.test(base) ||
    /^test_[^/]+\.py$/i.test(base)
  );
}

function isHardGateConfigPath(rawRelPath) {
  const p = String(rawRelPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p) return false;
  if (/(?:^|\/)(?:__snapshots__|\.github\/workflows|verify-[^/]+)\//i.test(p)) return true;
  if (/(?:^|\/)\.agents\/(?:verify-ctl[^/]*|zee\.project\.json)$/i.test(p)) return true;
  const base = path.posix.basename(p);
  return /^(?:\.eslintrc|eslint\.config\.|biome\.json$|tsconfig.*\.json$|ruff\.toml$|pyproject\.toml$|jest\.config\.|vitest\.config\.)/i.test(base);
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

function parseNameStatusZ(raw) {
  const entries = [];
  const parts = String(raw || "").split("\0");
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = parts[i + 1] || "";
      const newPath = parts[i + 2] || "";
      i += 2;
      if (oldPath) entries.push({ status: code[0], file: oldPath.replace(/\\/g, "/") });
      if (newPath) entries.push({ status: code[0], file: newPath.replace(/\\/g, "/") });
    } else {
      const file = parts[i + 1] || "";
      i += 1;
      if (file) entries.push({ status: code[0], file: file.replace(/\\/g, "/") });
    }
  }
  return entries;
}

function walkNonGitFiles(rootDir, curDir = rootDir, out = []) {
  const SKIP = new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "__pycache__", "target"]);
  for (const ent of fs.readdirSync(curDir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const full = path.join(curDir, ent.name);
    if (ent.isDirectory()) walkNonGitFiles(rootDir, full, out);
    else if (ent.isFile()) out.push(path.relative(rootDir, full).replace(/\\/g, "/"));
  }
  return out;
}

function cmdGateTamperDiff(args) {
  const { flags, positional } = parseFlags(args);
  if (flags.help) { usage(); return; }
  const repoRoot = path.resolve(flags.repo || positional[0] || process.cwd());
  if (!fs.existsSync(repoRoot)) {
    console.error(JSON.stringify({ ok: false, error: `目录不存在：${repoRoot}` }));
    process.exit(1);
  }

  const suppressionsAdded = [];
  const secretsAdded = [];
  const encodingIssues = [];
  const seenIssues = new Set();

  const scanAddedLine = (file, line) => {
    const cleanFile = file.replace(/\\/g, "/");
    if (!/\.md$/i.test(cleanFile)) {
      for (const pat of SUPPRESSION_PATTERNS) {
        if (pat.re.test(line)) {
          const k = `sup:${cleanFile}:${pat.name}:${line.trim().slice(0, 80)}`;
          if (!seenIssues.has(k)) {
            seenIssues.add(k);
            suppressionsAdded.push({ file: cleanFile, pattern: pat.name, line: line.trim().slice(0, 200) });
          }
        }
      }
    }
    if (!/<REDACTED>/.test(line)) {
      for (const pat of SECRET_PATTERNS) {
        if (pat.re.test(line)) {
          const k = `sec:${cleanFile}:${pat.name}:${secretsAdded.length}`;
          seenIssues.add(k);
          secretsAdded.push({ file: cleanFile, pattern: pat.name, line: "<REDACTED>" });
        }
      }
    }
    if (line.includes("\uFFFD")) {
      const k = `enc:${cleanFile}:${line.trim().slice(0, 80)}`;
      if (!seenIssues.has(k)) {
        seenIssues.add(k);
        encodingIssues.push({ file: cleanFile, pattern: "utf8_replacement_char", line: line.trim().slice(0, 200) });
      }
    }
  };

  const scanTextFile = (rel) => {
    const absFile = path.join(repoRoot, rel);
    try {
      const st = fs.statSync(absFile);
      if (st.isFile() && st.size <= 512 * 1024) {
        const text = fs.readFileSync(absFile, "utf8");
        if (!text.includes("\0")) text.split(/\r?\n/).forEach((l) => scanAddedLine(rel, l));
      }
    } catch {}
  };

  let isGitRepo = false;
  try {
    execFileSync("git", ["-C", repoRoot, "rev-parse", "--git-dir"], { stdio: ["ignore", "pipe", "pipe"] });
    isGitRepo = true;
  } catch {}

  if (!isGitRepo) {
    const gateFilesTouched = [];
    const testFilesAdded = [];
    for (const rel of walkNonGitFiles(repoRoot)) {
      if (isHardGateConfigPath(rel)) gateFilesTouched.push(rel);
      else if (isPureTestFilePath(rel)) testFilesAdded.push(rel);
      scanTextFile(rel);
    }
    gateFilesTouched.sort();
    testFilesAdded.sort();
    console.log(JSON.stringify({
      ok: true,
      nonGit: true,
      repoRoot,
      mode: "working-tree",
      gateFilesTouched,
      testFilesAdded,
      suppressionsAdded,
      secretsAdded,
      encodingIssues,
      requiresCountersign: gateFilesTouched.length > 0 || suppressionsAdded.length > 0 || secretsAdded.length > 0 || encodingIssues.length > 0,
    }, null, 2));
    return;
  }

  const hasBase = typeof flags.base === "string" && flags.base.trim().length > 0;
  const hasHead = typeof flags.head === "string" && flags.head.trim().length > 0;
  const useWorkingTree = Boolean(flags["working-tree"]) || (!hasBase && !hasHead);

  const gateFilesSet = new Set();
  const testAddedSet = new Set();

  const classifyFileStatus = (file, status) => {
    const norm = file.replace(/\\/g, "/");
    if (isHardGateConfigPath(norm)) {
      gateFilesSet.add(norm);
    } else if (isPureTestFilePath(norm)) {
      if (status === "A" || status === "?") {
        if (!gateFilesSet.has(norm)) testAddedSet.add(norm);
      } else {
        testAddedSet.delete(norm);
        gateFilesSet.add(norm);
      }
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

    if (hasHeadCommit) {
      const statusOut = execFileSync("git", ["-C", repoRoot, "-c", "core.quotepath=false", "diff", "--name-status", "-z", "HEAD"], { encoding: "utf8" });
      for (const entry of parseNameStatusZ(statusOut)) classifyFileStatus(entry.file, entry.status);
      scanDiffText(execFileSync("git", ["-C", repoRoot, "-c", "core.quotepath=false", "diff", "-U0", "HEAD"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }));
    } else {
      const cachedStatus = execFileSync("git", ["-C", repoRoot, "-c", "core.quotepath=false", "diff", "--name-status", "-z", "--cached"], { encoding: "utf8" });
      for (const entry of parseNameStatusZ(cachedStatus)) classifyFileStatus(entry.file, entry.status);
      scanDiffText(execFileSync("git", ["-C", repoRoot, "-c", "core.quotepath=false", "diff", "-U0", "--cached"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }));

      // 无 HEAD 时还要扫描已暂存文件在工作区继续修改但未再 stage 的内容
      const unstagedStatus = execFileSync("git", ["-C", repoRoot, "-c", "core.quotepath=false", "diff", "--name-status", "-z"], { encoding: "utf8" });
      for (const entry of parseNameStatusZ(unstagedStatus)) classifyFileStatus(entry.file, entry.status === "A" ? "A" : "M");
      scanDiffText(execFileSync("git", ["-C", repoRoot, "-c", "core.quotepath=false", "diff", "-U0"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }));
    }

    for (const rel of execFileSync("git", ["-C", repoRoot, "-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean)) {
      classifyFileStatus(rel, "?");
      scanTextFile(rel);
    }
  } else {
    const range = hasBase && hasHead ? `${flags.base.trim()}..${flags.head.trim()}` : hasBase ? `${flags.base.trim()}..HEAD` : `${flags.head.trim()}~1..${flags.head.trim()}`;
    let useRootShow = false;
    if (!hasBase && hasHead) {
      try { execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", `${flags.head.trim()}~1`], { stdio: ["ignore", "pipe", "ignore"] }); }
      catch { useRootShow = true; }
    }
    const statusArgs = useRootShow
      ? ["-c", "core.quotepath=false", "show", "--format=", "--name-status", "-z", flags.head.trim()]
      : ["-c", "core.quotepath=false", "diff", "--name-status", "-z", range];
    const diffArgs = useRootShow
      ? ["-c", "core.quotepath=false", "show", "--format=", "-U0", flags.head.trim()]
      : ["-c", "core.quotepath=false", "diff", "-U0", range];
    for (const entry of parseNameStatusZ(execFileSync("git", ["-C", repoRoot, ...statusArgs], { encoding: "utf8" }))) {
      classifyFileStatus(entry.file, entry.status);
    }
    scanDiffText(execFileSync("git", ["-C", repoRoot, ...diffArgs], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }));
  }

  const gateFilesTouched = [...gateFilesSet].sort();
  const testFilesAdded = [...testAddedSet].sort();
  console.log(JSON.stringify({
    ok: true,
    repoRoot,
    mode: useWorkingTree ? "working-tree" : "range",
    gateFilesTouched,
    testFilesAdded,
    suppressionsAdded,
    secretsAdded,
    encodingIssues,
    requiresCountersign: gateFilesTouched.length > 0 || suppressionsAdded.length > 0 || secretsAdded.length > 0 || encodingIssues.length > 0,
  }, null, 2));
}

function normalizeModelForAgy(modelHint, _tier, effort, surface, explicitSpec) {
  const low = String(modelHint || "").trim().toLowerCase();
  const eff = effort && effort !== "max" ? effort : "high";
  if (surface === "swarm") {
    if (typeof explicitSpec?.swarmModel === "string" && explicitSpec.swarmModel.trim()) {
      return explicitSpec.swarmModel.trim();
    }
    if (low && /-(low|medium|high|xhigh)$/.test(low)) return low;
    if (low.includes("argon") || low.includes("carbon")) {
      return `${low}-${eff === "xhigh" ? "high" : eff}`;
    }
    if (low && low !== "inherit" && low !== "auto") return `${low}-${eff}`;
    return "inherit";
  }
  // 严守 Gemini 4 代际锁：AGY invoke_subagent 永远返回 "inherit"，绝不映射到 3.8 系列的 pro/flash/flash_lite
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
  if (cfg?.slots && typeof cfg.slots === "object") {
    if (cfg.slots[mapped]) {
      const pref = cfg.slots[mapped]?.prefer || cfg.slots[mapped];
      if (harness && specHasExplicitBindings(pref) && !getHarnessKeys(harness).some((k) => Boolean(pref.bindings[k]))) {
        return { slotName: mapped, slot: null, missingForHarness: true, source: "slots" };
      }
      return { slotName: mapped, slot: cfg.slots[mapped], source: "slots" };
    }
  }
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

function buildStandaloneResolved(harness, surface, role) {
  return {
    harness,
    surface,
    role,
    effort: "medium",
    model: harness === "antigravity" ? "inherit" : null,
    standalone: true,
    ...(harness === "pi" ? { subagentArgs: {} } : {}),
    ...(harness === "t3" ? { delegateTarget: null } : {}),
  };
}

function enforceOptionsEffortFloor(rawOptions) {
  if (!rawOptions || typeof rawOptions !== "object") return undefined;
  const out = { ...rawOptions };
  for (const k of ["thought_level", "reasoningEffort", "effort", "thinking"]) {
    if (typeof out[k] === "string" && out[k].trim()) {
      out[k] = enforceEffortFloor(out[k]);
    }
  }
  return out;
}

function cmdResolveModel(args) {
  const { flags } = parseFlags(args);
  if (flags.help) { usage(); return; }
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
  const authorFamilyRaw = typeof flags["author-family"] === "string" ? flags["author-family"].trim() : "";
  const authorFam = authorFamilyRaw ? extractModelFamily(authorFamilyRaw) : "";
  const targetSlotName = mapRoleToSlotName(role);
  const needsCrossFamily = Boolean(authorFam && targetSlotName === "adversary");

  if (!fs.existsSync(configPath)) {
    if (allowStandalone) {
      console.log(JSON.stringify({ ok: true, standalone: true, configPath, resolved: buildStandaloneResolved(harness, surface, role) }, null, 2));
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
        resolved: buildStandaloneResolved(harness, surface, role),
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
  let crossFamilyFallback = null;
  let cooldownWarning = null;

  const hsForSingle = getHarnessSection(cfg, harness);
  const allowSingleFamily = Boolean(hsForSingle?.section?.singleFamily || cfg?.singleFamily || harness === "antigravity");

  const getCandidateFamily = (spec, bind) =>
    source === "harnesses"
      ? bind?.family || spec?.family || extractModelFamily(bind?.model || spec?.swarmModel || spec?.modelHint || "")
      : bind?.family || extractModelFamily(bind?.model || "") || spec?.family || extractModelFamily(spec?.modelHint || "");

  const initialModelRef = activeBinding?.model || activeSpec?.modelHint || activeSpec?.model || activeSpec?.swarmModel || "";
  const initialFam = getCandidateFamily(activeSpec, activeBinding);
  const initialSameFamilyConflict = Boolean(needsCrossFamily && !allowSingleFamily && initialFam && initialFam === authorFam);

  const initialCd =
    !ignoreCooldown && !isParentAlias(initialModelRef)
      ? (() => {
          const mId = activeBinding?.model || activeSpec?.modelHint || activeSpec?.swarmModel;
          return mId ? getModelCooldown(activeBinding?.providerInstanceId, mId) : { active: false };
        })()
      : { active: false };

  if (initialCd.active || initialSameFamilyConflict) {
    const candidateSpecs = [];
    if (slot?.backup) candidateSpecs.push({ spec: slot.backup, bind: extractBindingPair(slot.backup, harness) || extractBindingPair(slot, harness)?.backup });
    const slotMap = hsForSingle?.section?.slots || cfg?.slots;
    if (slotMap && typeof slotMap === "object") {
      const borrowOrder =
        targetSlotName === "adversary"
          ? ["workhorse", "fast"]
          : targetSlotName === "workhorse"
            ? ["adversary"]
            : targetSlotName === "fast"
              ? ["workhorse"]
              : [];
      for (const extraName of borrowOrder) {
        const extraSlot = slotMap[extraName];
        if (!extraSlot) continue;
        if (extraSlot.prefer) candidateSpecs.push({ spec: extraSlot.prefer, bind: extractBindingPair(extraSlot.prefer, harness) });
        if (extraSlot.backup) candidateSpecs.push({ spec: extraSlot.backup, bind: extractBindingPair(extraSlot.backup, harness) });
      }
    }
    let switched = false;
    for (const cand of candidateSpecs) {
      const bSpec = cand.spec;
      const bBind = cand.bind;
      const bModelId = bBind?.model || bSpec?.modelHint || bSpec?.swarmModel;
      if (!bModelId) continue;
      const bFam = getCandidateFamily(bSpec, bBind);
      if (needsCrossFamily && !allowSingleFamily && bFam && bFam === authorFam) continue;
      const bCd = !ignoreCooldown && !isParentAlias(bModelId) ? getModelCooldown(bBind?.providerInstanceId, bModelId) : { active: false };
      if (bCd.active) continue;
      if (initialCd.active) {
        cooldownFallback = { skippedKey: initialCd.key, reason: initialCd.entry?.reason || "cooldown", remainingSec: initialCd.remainingSec };
      } else if (initialSameFamilyConflict) {
        crossFamilyFallback = { skippedFamily: initialFam, authorFamily: authorFam };
      }
      activeSpec = bSpec;
      activeBinding = bBind;
      switched = true;
      break;
    }
    if (!switched && initialCd.active) {
      cooldownWarning = {
        allCooledDown: true,
        key: initialCd.key,
        remainingSec: initialCd.remainingSec,
        reason: initialCd.entry?.reason || "cooldown",
      };
    }
  }

  const finalFamCheck = getCandidateFamily(activeSpec, activeBinding);
  if (needsCrossFamily && !allowSingleFamily && finalFamCheck && finalFamCheck === authorFam) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: `[resolve-model:${role}] 跨家族拦截：解析结果家族 "${finalFamCheck}" 与作者家族 "${authorFam}" 相同且无健康异构备胎`,
          role,
          authorFamily: authorFam,
          resolvedFamily: finalFamCheck,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const effort = enforceEffortFloor(activeSpec?.effort || "medium");
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
        ...(harness === "pi" ? { subagentArgs: { thinkingLevel: effort } } : {}),
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
      ...(crossFamilyFallback ? { crossFamilyFallback } : {}),
      ...(cooldownWarning ? { cooldownWarning } : {}),
    };
  } else if (harness === "t3") {
    const safeOptions = enforceOptionsEffortFloor(activeBinding?.options);
    const delegateTarget = {
      ...(activeBinding?.providerInstanceId ? { providerInstanceId: activeBinding.providerInstanceId } : {}),
      ...(activeBinding?.model ? { model: activeBinding.model } : {}),
      ...(safeOptions ? { options: safeOptions } : {}),
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
      ...(crossFamilyFallback ? { crossFamilyFallback } : {}),
      ...(cooldownWarning ? { cooldownWarning } : {}),
    };
  } else {
    resolved = {
      harness,
      surface,
      role,
      slot: slotName,
      model: activeBinding?.model || activeSpec?.modelHint || null,
      modelHint: activeSpec?.modelHint || activeBinding?.model || null,
      family: resolvedFamily,
      effort,
      binding: activeBinding,
      ...(harness === "pi" || harness === "local"
        ? {
            subagentArgs: {
              ...(activeBinding?.providerInstanceId ? { provider: activeBinding.providerInstanceId } : {}),
              ...(activeBinding?.model ? { model: activeBinding.model } : {}),
              thinkingLevel: effort,
            },
          }
        : {}),
      backup: slot?.backup || null,
      ...(cooldownFallback ? { cooldownFallback } : {}),
      ...(crossFamilyFallback ? { crossFamilyFallback } : {}),
      ...(cooldownWarning ? { cooldownWarning } : {}),
    };
  }

  console.log(JSON.stringify({ ok: true, resolved }, null, 2));
}

function cmdProviderHealth(args) {
  const { flags, positional } = parseFlags(args);
  if (flags.help) { usage(); return; }
  if (flags.record !== undefined && flags.record !== false) {
    const rawTarget = typeof flags.record === "string" && flags.record.trim() ? flags.record.trim() : String(positional[0] || "").trim();
    if (!rawTarget) {
      console.error("用法：provider-health --record <provider/model> [--provider <p>] [--kind rate_limit|transient_5xx] [--reason <r>] [--ttl-ms <ms>]");
      process.exit(1);
    }
    let provider = typeof flags.provider === "string" && flags.provider.trim() ? flags.provider.trim() : undefined;
    let model = rawTarget;
    if (!provider && rawTarget.includes("/") && !rawTarget.startsWith("auto/")) {
      const idx = rawTarget.indexOf("/");
      provider = rawTarget.slice(0, idx);
      model = rawTarget.slice(idx + 1);
    } else if (provider && model.toLowerCase().startsWith(`${provider.toLowerCase()}/`)) {
      model = model.slice(provider.length + 1);
    }
    const rawKind = String(flags.kind || "rate_limit").trim().toLowerCase();
    const kind = rawKind === "transient_5xx" || rawKind === "5xx" ? "transient_5xx" : "rate_limit";
    const ttlMs = Number(flags["ttl-ms"]);
    const rec = recordModelCooldown(provider, model, {
      kind,
      ...(typeof flags.reason === "string" && flags.reason.trim() ? { reason: flags.reason.trim() } : {}),
      ...(Number.isFinite(ttlMs) && ttlMs > 0 ? { ttlMs } : {}),
    });
    console.log(JSON.stringify({ ok: Boolean(rec), recorded: rec }, null, 2));
    return;
  }
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

function validateSlotTable(slotsObj, label, allowSingleFamily, errors, warnings, isActiveTarget = true) {
  const pushErr = (msg) => (isActiveTarget ? errors.push(msg) : warnings.push(`[非当前宿主] ${msg}`));
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
      pushErr(`${label}.${sName}.prefer 缺失`);
    }
    const prefEffort = String(pref?.effort || "").trim().toLowerCase();
    if (prefEffort && ["low", "minimal", "off", "none"].includes(prefEffort)) {
      warnings.push(`${label}.${sName}.prefer.effort 为 "${prefEffort}"，已过低；最低思考档位为 "medium"（运行期已自动提升至 "medium"）`);
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
      else pushErr(`${msg}（非 singleFamily 模式必须为不同模型家族）`);
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

const NOISE_LINE_RE = /^(?:warning|warn|error|err|note|info|hint|total|deprecated|usage)\b\s*[:\-]/i;

function parseCandidateModelsInput(rawText, harness) {
  const trimmed = stripAnsiAndControl(String(rawText || "")).replace(/^\uFEFF/, "").trim();
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
    if (!line || /^[-=─━]+$/.test(line) || /^provider\s+model\b/i.test(line) || NOISE_LINE_RE.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols.length >= 2) {
      if (/:$/.test(cols[0])) continue;
      items.push({ providerInstanceId: cols[0].trim(), model: cols[1].trim(), optionKey: null, supportedEfforts: null });
    } else if (cols.length === 1 && cols[0] && !/:$/.test(cols[0])) {
      items.push({ providerInstanceId: "", model: cols[0].trim(), optionKey: null, supportedEfforts: null });
    }
  }
  return { items, inferredPreferProvider: null };
}

function enforceEffortFloor(rawEffort) {
  const low = String(rawEffort || "medium").trim().toLowerCase();
  if (!low || low === "low" || low === "minimal" || low === "off" || low === "none") return "medium";
  return low;
}

function clampEffort(targetEffort, maxRuleEffort, supportedEfforts, ladder) {
  const safeLadder = Array.isArray(ladder) && ladder.length > 0 ? ladder.filter((e) => !["low", "minimal", "off", "none"].includes(String(e).toLowerCase())) : ["medium", "high", "xhigh"];
  const effectiveLadder = safeLadder.length > 0 ? safeLadder : ["medium", "high", "xhigh"];
  const idxOf = (eff) => effectiveLadder.indexOf(String(eff || "").toLowerCase());
  let maxIdx = effectiveLadder.length - 1;
  const ruleIdx = idxOf(enforceEffortFloor(maxRuleEffort));
  if (ruleIdx >= 0) maxIdx = Math.min(maxIdx, ruleIdx);
  let targetIdx = idxOf(enforceEffortFloor(targetEffort));
  if (targetIdx < 0) targetIdx = 0;
  const clampedIdx = Math.min(targetIdx, maxIdx);

  if (Array.isArray(supportedEfforts) && supportedEfforts.length > 0) {
    const supSet = new Set(supportedEfforts.map((s) => String(s).toLowerCase()));
    for (let i = clampedIdx; i >= 0; i--) {
      if (supSet.has(effectiveLadder[i])) return enforceEffortFloor(effectiveLadder[i]);
    }
    for (let i = clampedIdx + 1; i < effectiveLadder.length; i++) {
      if (supSet.has(effectiveLadder[i])) return enforceEffortFloor(effectiveLadder[i]);
    }
  }
  return enforceEffortFloor(effectiveLadder[clampedIdx] || "medium");
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
    const cleanBase = entry.baseModel.replace(/-(?:low|medium|high|xhigh)$/i, "");
    return {
      family: entry.family,
      modelHint: cleanBase,
      effort,
      model: "inherit",
      swarmModel: `${cleanBase}-${effort}`,
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
  if (flags.help) { usage(); return; }
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
  const rawLadder = Array.isArray(catalog.effortLadder) ? catalog.effortLadder : ["medium", "high", "xhigh"];
  const ladder = rawLadder.filter((e) => !["low", "minimal", "off", "none"].includes(String(e).toLowerCase()));
  const excludeRes = (catalog.tierRules?.excludeFromSubagents || []).map((p) => new RegExp(p, "i"));
  const optInRes = (catalog.tierRules?.optInOnly || []).map((p) => new RegExp(p, "i"));

  const enriched = [];
  for (const item of parsed.items) {
    const lowModel = item.model.toLowerCase();
    let baseModel = (lowModel.split("/").pop() || lowModel).trim();
    if (harness === "antigravity") {
      baseModel = baseModel.replace(/-(?:low|medium|high|xhigh)$/i, "");
    }
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
      dedupKey: harness === "t3" || harness === "antigravity" ? baseModel : `${item.providerInstanceId.toLowerCase()}\0${baseModel}`,
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

  const efforts = budgetSpec.efforts || { fast: "medium", workhorse: "high", adversary: "high" };
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

function detectProjectProfile(targetRepo, verifyCtlPath, verifySkillPath, projectJsonExists) {
  let isGitRepo = false;
  let hasHeadCommit = false;
  let dirtyFilesCount = 0;
  try {
    execFileSync("git", ["-C", targetRepo, "rev-parse", "--git-dir"], { stdio: ["ignore", "pipe", "pipe"] });
    isGitRepo = true;
  } catch {}
  if (isGitRepo) {
    try {
      execFileSync("git", ["-C", targetRepo, "rev-parse", "--verify", "--quiet", "HEAD"], { stdio: ["ignore", "pipe", "pipe"] });
      hasHeadCommit = true;
    } catch {}
    try {
      const st = execFileSync("git", ["-C", targetRepo, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      dirtyFilesCount = st ? st.split(/\r?\n/).length : 0;
    } catch {}
  }

  let packageManager = null;
  const detectedCmds = { test: null, lint: null, typecheck: null, build: null, dev: null };
  let appShape = "empty";

  const pkgPath = path.join(targetRepo, "package.json");
  if (fs.existsSync(pkgPath)) {
    if (fs.existsSync(path.join(targetRepo, "pnpm-lock.yaml"))) packageManager = "pnpm";
    else if (fs.existsSync(path.join(targetRepo, "yarn.lock"))) packageManager = "yarn";
    else if (fs.existsSync(path.join(targetRepo, "bun.lockb")) || fs.existsSync(path.join(targetRepo, "bun.lock"))) packageManager = "bun";
    else packageManager = "npm";
    const runPrefix = packageManager === "npm" ? "npm run" : packageManager;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
      if (scripts.test) detectedCmds.test = packageManager === "npm" ? "npm test" : `${packageManager} test`;
      if (scripts.lint) detectedCmds.lint = `${runPrefix} lint`;
      if (scripts.typecheck) detectedCmds.typecheck = `${runPrefix} typecheck`;
      else if (scripts["type-check"]) detectedCmds.typecheck = `${runPrefix} type-check`;
      else if (fs.existsSync(path.join(targetRepo, "tsconfig.json"))) detectedCmds.typecheck = "npx tsc --noEmit";
      if (scripts.build) detectedCmds.build = `${runPrefix} build`;
      if (scripts.dev) detectedCmds.dev = `${runPrefix} dev`;
      else if (scripts.start) detectedCmds.dev = `${runPrefix} start`;

      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const depKeys = Object.keys(allDeps);
      if (depKeys.some((d) => /^(react|next|vue|nuxt|svelte|vite|astro|solid-js|@angular\/core|tailwindcss|electron)$/i.test(d))) {
        appShape = "web";
      } else if (depKeys.some((d) => /^(express|fastify|koa|hono|@nestjs\/core|elysia)$/i.test(d))) {
        appShape = "api";
      } else if (pkg.bin) {
        appShape = "cli";
      } else {
        appShape = "lib";
      }
    } catch {
      appShape = "lib";
    }
  } else if (fs.existsSync(path.join(targetRepo, "pyproject.toml")) || fs.existsSync(path.join(targetRepo, "requirements.txt"))) {
    packageManager = fs.existsSync(path.join(targetRepo, "uv.lock")) ? "uv" : fs.existsSync(path.join(targetRepo, "poetry.lock")) ? "poetry" : "pip";
    detectedCmds.test = packageManager === "uv" ? "uv run pytest" : "pytest";
    appShape = "lib";
  } else if (fs.existsSync(path.join(targetRepo, "Cargo.toml"))) {
    packageManager = "cargo";
    detectedCmds.test = "cargo test";
    detectedCmds.build = "cargo build";
    detectedCmds.lint = "cargo clippy";
    appShape = "cli";
  } else if (fs.existsSync(path.join(targetRepo, "go.mod"))) {
    packageManager = "go";
    detectedCmds.test = "go test ./...";
    detectedCmds.build = "go build ./...";
    appShape = "api";
  } else {
    try {
      const entries = fs.readdirSync(targetRepo).filter((n) => n !== ".git");
      appShape = entries.length === 0 ? "empty" : "unknown";
    } catch {
      appShape = "empty";
    }
  }

  let hasDenyCommands = false;
  if (projectJsonExists) {
    try {
      const pcfg = JSON.parse(fs.readFileSync(path.join(targetRepo, ".agents", "zee.project.json"), "utf8"));
      hasDenyCommands = Array.isArray(pcfg.denyCommands) && pcfg.denyCommands.length > 0;
    } catch {}
  }

  const hasVerify = Boolean(verifyCtlPath || verifySkillPath);
  const hasTest = Boolean(detectedCmds.test);
  const hasStaticCheck = Boolean(detectedCmds.lint || detectedCmds.typecheck);

  let verifiability = "minimal";
  let recommendedTrust = "T1";
  if (hasVerify && hasTest && (hasStaticCheck || hasDenyCommands)) {
    verifiability = "ready";
    recommendedTrust = "T2";
  } else if (hasVerify || hasTest) {
    verifiability = "partial";
    recommendedTrust = "T1";
  }

  return {
    isGitRepo,
    hasHeadCommit,
    dirtyFilesCount,
    packageManager,
    appShape,
    detectedCmds,
    verifyCtlPath,
    verifiability,
    recommendedTrust,
  };
}

function cmdDoctor(args) {
  const { flags } = parseFlags(args);
  if (flags.help) { usage(); return; }
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
    warnings.push(`未配置 ${configPath}（零配置单兵开箱可用；多模型异构请按需运行 /zee-setup 为 ${activeHarness} 配置 3 槽位）`);
  } else {
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      configuredHarnesses = listConfiguredHarnesses(cfg);
      const activeKeys = new Set(getHarnessKeys(activeHarness));
      const hasHarnessesSlots = Boolean(
        cfg.harnesses &&
          typeof cfg.harnesses === "object" &&
          Object.values(cfg.harnesses).some((h) => h && typeof h === "object" && h.slots && typeof h.slots === "object"),
      );
      if (hasHarnessesSlots) {
        for (const [hKey, hCfg] of Object.entries(cfg.harnesses)) {
          if (!hCfg || typeof hCfg !== "object" || !hCfg.slots || typeof hCfg.slots !== "object") continue;
          const allowSingle = Boolean(hCfg.singleFamily) || hKey === "agy" || hKey === "antigravity";
          const isActiveTarget = activeKeys.has(hKey) || activeHarness === "local";
          validateSlotTable(hCfg.slots, `harnesses.${hKey}.slots`, allowSingle, errors, warnings, isActiveTarget);
        }
      }
      if (cfg.slots && typeof cfg.slots === "object") {
        validateSlotTable(cfg.slots, "slots", Boolean(cfg.singleFamily), errors, warnings, !hasHarnessesSlots || activeHarness === "local");
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
          `当前宿主 (${activeHarness}) 尚未配置专属模型槽位（已有宿主：${configuredHarnesses.join(", ") || "无"}），可直接单兵开箱运行或按需跑 /zee-setup。`,
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
  let projectProfile = null;
  if (targetRepo) {
    if (!fs.existsSync(targetRepo)) {
      errors.push(`目标仓库路径不存在：${targetRepo}`);
    } else {
      let verifySkill = null;
      let verifyCtlPath = fs.existsSync(path.join(targetRepo, ".agents", "verify-ctl.mjs"))
        ? path.join(targetRepo, ".agents", "verify-ctl.mjs")
        : null;
      for (const sub of PROJECT_SKILLS_SUBDIRS) {
        const dir = path.join(targetRepo, sub);
        if (!fs.existsSync(dir)) continue;
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (ent.isDirectory() && /^verify-/i.test(ent.name)) {
            const skillDir = path.join(dir, ent.name);
            if (!verifySkill && fs.existsSync(path.join(skillDir, "SKILL.md"))) {
              verifySkill = path.join(skillDir, "SKILL.md");
            }
            if (!verifyCtlPath) {
              const scriptsDir = path.join(skillDir, "scripts");
              if (fs.existsSync(scriptsDir)) {
                const ctl = fs.readdirSync(scriptsDir).find((f) => /^verify-ctl\.(?:mjs|js|py|sh)$/i.test(f));
                if (ctl) verifyCtlPath = path.join(scriptsDir, ctl);
              }
            }
          }
        }
      }
      const projectJson = fs.existsSync(path.join(targetRepo, ".agents", "zee.project.json"));
      projectProfile = detectProjectProfile(targetRepo, verifyCtlPath, verifySkill, projectJson);
      if (!projectProfile.isGitRepo) {
        warnings.push("目标目录尚非 Git 仓库，0→1 自动驾驶请使用 init-run --ensure-git 自动初始化基线。");
      } else if (!projectProfile.hasHeadCommit) {
        warnings.push("目标仓库尚无基线 commit（HEAD 不存在），启用 worktree 或 /zee-night 前请用 init-run --ensure-git 建基线提交。");
      } else if (projectProfile.dirtyFilesCount > 0) {
        warnings.push(`目标仓库存在 ${projectProfile.dirtyFilesCount} 项未提交改动，新建 worktree 仅基于 HEAD，未提交改动不会同步到子代理工作树。`);
      }
      repoStatus = {
        repoRoot: targetRepo,
        isGitRepo: projectProfile.isGitRepo,
        projectJson,
        verifyCtl: Boolean(verifyCtlPath),
        verifyCtlPath,
        verifySkill,
        hasHeadCommit: projectProfile.hasHeadCommit,
        dirtyFilesCount: projectProfile.dirtyFilesCount,
      };
    }
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
    projectProfile,
    providerHealth: { activeCount: cooldowns.length, cooldowns },
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

try {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "init-run": cmdInitRun(rest); break;
    case "update-state": await cmdUpdateState(rest); break;
    case "log-decision": cmdLogDecision(rest); break;
    case "list-runs": cmdListRuns(rest); break;
    case "finding": cmdFinding(rest); break;
    case "worktree-create": cmdWorktreeCreate(rest); break;
    case "cleanup-worktrees": cmdCleanupWorktrees(rest); break;
    case "sandbox-export": cmdSandboxExport(rest); break;
    case "sandbox-clean": cmdSandboxClean(rest); break;
    case "gate-tamper-diff": cmdGateTamperDiff(rest); break;
    case "recommend-models": await cmdRecommendModels(rest); break;
    case "resolve-model": cmdResolveModel(rest); break;
    case "provider-health": cmdProviderHealth(rest); break;
    case "doctor": cmdDoctor(rest); break;
    case "--help":
    case "-h":
    case "help":
    case undefined:
      usage();
      process.exit(0);
    default:
      usage();
      process.exit(1);
  }
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
}
