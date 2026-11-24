#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const DEFAULT_CONFIG = path.join(HOME, ".agents", "zee-config.json");
const SOURCE_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNS_ROOT = path.join(HOME, ".local", "state", "zee", "runs");
const SKILL_NAMES = ["zee", "zee-setup"];

const HARNESS_TARGETS = [
  { name: "agents", dir: path.join(HOME, ".agents", "skills"), parentMustExist: path.join(HOME, ".agents") },
  { name: "antigravity", dir: path.join(HOME, ".gemini", "config", "skills"), parentMustExist: path.join(HOME, ".gemini", "config") },
  { name: "claude", dir: path.join(HOME, ".claude", "skills"), parentMustExist: path.join(HOME, ".claude") },
  { name: "codex", dir: path.join(HOME, ".codex", "skills"), parentMustExist: path.join(HOME, ".codex") },
  { name: "pi", dir: path.join(HOME, ".pi", "agent", "skills"), parentMustExist: path.join(HOME, ".pi", "agent") },
  { name: "cursor", dir: path.join(HOME, ".cursor", "skills"), parentMustExist: path.join(HOME, ".cursor") },
];

const VALID_BUDGETS = new Set(["eco", "balanced", "max"]);
const VALID_TIERS = new Set(["lite", "fast", "standard", "pro"]);
const VALID_EFFORTS = new Set(["off", "low", "medium", "high", "xhigh", "max"]);

function usage() {
  console.log(`zee-tool.mjs — deterministic helper for the universal zee workflow

Commands:
  validate [configPath]       Validate zee-config.json schema, families, and fallbacks
  symlinks [--apply]          Check or create harness symlinks from ~/.agents/skills/
  audit-rules                 Inspect ambient always-on rules that may conflict with zee
  init-run <repoPath> <slug>  Create Out-of-Tree Run Bus under ~/.local/state/zee/runs/
  log-decision <busDir> <unit> <phase> <decision> <why> <evidence> <result>
                              Append an escaped row to decisions.tsv
`);
}

function validateSpec(spec, label, errors, warnings) {
  if (!spec || typeof spec !== "object") {
    errors.push(`${label}: missing object`);
    return;
  }
  for (const key of ["family", "modelHint", "tier", "effort"]) {
    if (typeof spec[key] !== "string" || !spec[key].trim()) {
      errors.push(`${label}.${key}: required non-empty string`);
    }
  }
  if (spec.tier && !VALID_TIERS.has(spec.tier)) {
    errors.push(`${label}.tier: invalid "${spec.tier}" (expected lite|fast|standard|pro)`);
  }
  if (spec.effort && !VALID_EFFORTS.has(spec.effort)) {
    errors.push(`${label}.effort: invalid "${spec.effort}"`);
  }
  if (spec.effort === "max") {
    warnings.push(`${label}.effort is "max"; zee recommends capping routine defaults at "xhigh"`);
  }
}

function validateSlot(slot, label, errors, warnings) {
  if (!slot || typeof slot !== "object") {
    errors.push(`${label}: missing slot object`);
    return;
  }
  validateSpec(slot.prefer, `${label}.prefer`, errors, warnings);
  if (slot.backup) {
    validateSpec(slot.backup, `${label}.backup`, errors, warnings);
  } else {
    warnings.push(`${label}: no backup model configured`);
  }
}

function cmdValidate(configPath = DEFAULT_CONFIG) {
  const errors = [];
  const warnings = [];
  if (!fs.existsSync(configPath)) {
    console.error(`FAIL: config not found at ${configPath}`);
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    console.error(`FAIL: invalid JSON in ${configPath}: ${e.message}`);
    process.exit(1);
  }

  if (cfg.version !== 2) errors.push(`version must be 2 (got ${cfg.version})`);
  if (!VALID_BUDGETS.has(cfg.budget)) errors.push(`budget must be eco|balanced|max (got ${cfg.budget})`);
  if (!cfg.roles || typeof cfg.roles !== "object") {
    errors.push("roles object is required");
  } else {
    const r = cfg.roles;
    validateSlot(r.scout, "roles.scout", errors, warnings);
    if (!r.architect || typeof r.architect !== "object") {
      errors.push("roles.architect is required");
    } else {
      validateSlot(r.architect.primary, "roles.architect.primary", errors, warnings);
      if (!Array.isArray(r.architect.arenaPool) || r.architect.arenaPool.length < 2) {
        warnings.push("roles.architect.arenaPool has fewer than 2 entries (L3 Arena diversity reduced)");
      } else {
        r.architect.arenaPool.forEach((entry, i) => validateSpec(entry.prefer || entry, `roles.architect.arenaPool[${i}]`, errors, warnings));
      }
    }
    if (!r.ui || typeof r.ui !== "object") {
      errors.push("roles.ui is required");
    } else {
      validateSlot(r.ui.standard, "roles.ui.standard", errors, warnings);
      validateSlot(r.ui.heavy, "roles.ui.heavy", errors, warnings);
      if (r.ui.visionVerified !== true) {
        warnings.push("roles.ui.visionVerified is not true; confirm UI model supports image input");
      }
    }
    if (!r.coder || typeof r.coder !== "object") {
      errors.push("roles.coder is required");
    } else {
      validateSlot(r.coder.standard, "roles.coder.standard", errors, warnings);
      validateSlot(r.coder.heavy, "roles.coder.heavy", errors, warnings);
    }
    validateSlot(r.verifier, "roles.verifier", errors, warnings);
    if (!Array.isArray(r.reviewers) || r.reviewers.length < 2) {
      errors.push("roles.reviewers must be an array with at least 2 entries for cross-family review");
    } else {
      const families = new Set();
      r.reviewers.forEach((rev, i) => {
        const spec = rev.prefer || rev;
        validateSpec(spec, `roles.reviewers[${i}]`, errors, warnings);
        if (spec?.family) families.add(spec.family);
      });
      if (families.size < 2) {
        errors.push(`roles.reviewers has only ${families.size} distinct family (${[...families].join(", ")}); need >= 2`);
      }
      const coderFam = r.coder?.standard?.prefer?.family;
      if (coderFam && families.size === 1 && families.has(coderFam)) {
        errors.push(`all reviewers share coder.standard family "${coderFam}"`);
      }
    }
    if (r.judge) {
      if (Array.isArray(r.judge)) {
        r.judge.forEach((j, i) => validateSpec(j.prefer || j, `roles.judge[${i}]`, errors, warnings));
      } else {
        validateSlot(r.judge, "roles.judge", errors, warnings);
      }
    }
  }

  console.log(JSON.stringify({ ok: errors.length === 0, configPath, errors, warnings }, null, 2));
  process.exit(errors.length === 0 ? 0 : 1);
}

function cmdSymlinks(apply) {
  const report = [];
  for (const target of HARNESS_TARGETS) {
    const parentExists = fs.existsSync(target.parentMustExist);
    if (!parentExists) {
      report.push({ harness: target.name, status: "skipped_not_installed", dir: target.dir });
      continue;
    }
    if (apply && !fs.existsSync(target.dir)) {
      fs.mkdirSync(target.dir, { recursive: true });
    }
    for (const skill of SKILL_NAMES) {
      const src = path.join(SOURCE_SKILLS_DIR, skill);
      const dest = path.join(target.dir, skill);
      if (path.resolve(dest) === path.resolve(src)) {
        report.push({ harness: target.name, skill, status: "source_dir", dest });
        continue;
      }
      if (!fs.existsSync(src)) {
        report.push({ harness: target.name, skill, status: "error_missing_source", src });
        continue;
      }
      let status = "missing";
      try {
        const stat = fs.lstatSync(dest);
        if (stat.isSymbolicLink()) {
          const resolved = path.resolve(path.dirname(dest), fs.readlinkSync(dest));
          status = resolved === src ? "linked_ok" : `symlink_other(${resolved})`;
        } else {
          status = "exists_non_symlink";
        }
      } catch {
        status = "missing";
      }

      if (apply && status === "missing") {
        fs.symlinkSync(src, dest);
        status = "created";
      }
      report.push({ harness: target.name, skill, status, dest });
    }
  }
  console.log(JSON.stringify({ source: SOURCE_SKILLS_DIR, applied: apply, report }, null, 2));
}

function cmdAuditRules() {
  const findings = [];

  const geminiCfgPath = path.join(HOME, ".gemini", "config", "config.json");
  const agystackRule = path.join(HOME, ".gemini", "config", "plugins", "agystack", "rules", "AGENTS.md");
  if (fs.existsSync(agystackRule)) {
    let disabled = false;
    try {
      const cfg = JSON.parse(fs.readFileSync(geminiCfgPath, "utf8"));
      disabled = cfg?.plugins?.agystack?.enabled === false;
    } catch {}
    findings.push({
      harness: "antigravity",
      file: agystackRule,
      severity: disabled ? "info" : "high",
      status: disabled ? "disabled_in_config" : "active_conflict",
      detail: disabled
        ? "agystack plugin is disabled in ~/.gemini/config/config.json"
        : "Always-on rule forces poteto-mode and native invoke_subagent; disable via ~/.gemini/config/config.json -> plugins.agystack.enabled = false",
    });
  }

  const useBendRule = path.join(HOME, ".gemini", "config", "plugins", "use-bend", "rules", "AGENTS.md");
  if (fs.existsSync(useBendRule)) {
    findings.push({
      harness: "antigravity",
      file: useBendRule,
      severity: "low",
      status: "advisory",
      detail: "May bias new scripts toward Bend 2; worker.md header explicitly enforces repository language",
    });
  }

  const homeClaude = path.join(HOME, "CLAUDE.md");
  if (fs.existsSync(homeClaude)) {
    const body = fs.readFileSync(homeClaude, "utf8");
    const hits = [];
    if (/pnpm test/i.test(body)) hits.push("hardcoded pnpm test");
    if (/超过\s*3\s*个文件|more than 3 files/i.test(body)) hits.push("<=3 files refactor cap");
    if (/CHANGELOG/i.test(body)) hits.push("mandatory CHANGELOG update");
    findings.push({
      harness: "pi/claude",
      file: homeClaude,
      severity: hits.length ? "medium" : "info",
      status: hits.length ? "potential_conflict" : "ok",
      detail: hits.length ? `Home CLAUDE.md contains project-specific rules (${hits.join(", ")})` : "Present, no obvious hardcoded conflicts",
    });
  }

  const dotClaude = path.join(HOME, ".claude", "CLAUDE.md");
  if (fs.existsSync(dotClaude)) {
    const body = fs.readFileSync(dotClaude, "utf8");
    if (/oh-my-claudecode|OMC/i.test(body)) {
      findings.push({
        harness: "claude-code",
        file: dotClaude,
        severity: "medium",
        status: "active_in_claude_code",
        detail: "OMC orchestration rules active when Claude Code provider is used; worker.md forbids nested delegation",
      });
    }
  }

  for (const extra of [
    { harness: "codex", file: path.join(HOME, ".codex", "AGENTS.md") },
    { harness: "cursor", file: path.join(HOME, ".cursor", "rules") },
  ]) {
    if (fs.existsSync(extra.file)) {
      findings.push({ harness: extra.harness, file: extra.file, severity: "info", status: "present", detail: "Inspect manually if unexpected behavior occurs" });
    }
  }

  console.log(JSON.stringify({ findings }, null, 2));
}

function sanitizeSlug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "task";
}

function cmdInitRun(repoPath, slug) {
  if (!repoPath || !slug) {
    console.error("Usage: init-run <repoPath> <slug>");
    process.exit(1);
  }
  const absRepo = path.resolve(repoPath);
  const hash = crypto.createHash("sha256").update(absRepo).digest("hex").slice(0, 8);
  const repoKey = `${sanitizeSlug(path.basename(absRepo))}-${hash}`;
  const cleanSlug = sanitizeSlug(slug);
  const busDir = path.join(RUNS_ROOT, repoKey, cleanSlug);

  fs.mkdirSync(path.join(busDir, "artifacts"), { recursive: true });
  fs.mkdirSync(path.join(busDir, "screenshots"), { recursive: true });

  const statePath = path.join(busDir, "state.json");
  if (!fs.existsSync(statePath)) {
    const initState = {
      version: 1,
      repoRoot: absRepo,
      slug: cleanSlug,
      busDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mode: "standard",
      level: null,
      predicate: null,
      units: [],
      delegatesDispatched: 0,
      fallbacksUsed: [],
      status: "initialized",
    };
    const tmp = `${statePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(initState, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, statePath);
  }

  const tsvPath = path.join(busDir, "decisions.tsv");
  if (!fs.existsSync(tsvPath)) {
    fs.writeFileSync(tsvPath, "ts\tunit\tphase\tdecision\twhy\tevidence\tresult\n", "utf8");
  }

  console.log(JSON.stringify({ ok: true, busDir, statePath, tsvPath }, null, 2));
}

function cleanTsvCell(val) {
  const s = String(val ?? "").replace(/[\t\r\n]+/g, " ").trim();
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

function cmdLogDecision(args) {
  if (args.length < 7) {
    console.error("Usage: log-decision <busDir> <unit> <phase> <decision> <why> <evidence> <result>");
    process.exit(1);
  }
  const [busDir, unit, phase, decision, why, evidence, result] = args;
  const tsvPath = path.join(busDir, "decisions.tsv");
  fs.mkdirSync(busDir, { recursive: true });
  if (!fs.existsSync(tsvPath)) {
    fs.writeFileSync(tsvPath, "ts\tunit\tphase\tdecision\twhy\tevidence\tresult\n", "utf8");
  }
  const row = [
    new Date().toISOString(),
    cleanTsvCell(unit),
    cleanTsvCell(phase),
    cleanTsvCell(decision),
    cleanTsvCell(why),
    cleanTsvCell(evidence),
    cleanTsvCell(result),
  ].join("\t") + "\n";
  fs.appendFileSync(tsvPath, row, "utf8");
  console.log(JSON.stringify({ ok: true, tsvPath, appended: row.trim() }));
}

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case "validate":
    cmdValidate(rest[0]);
    break;
  case "symlinks":
    cmdSymlinks(rest.includes("--apply"));
    break;
  case "audit-rules":
    cmdAuditRules();
    break;
  case "init-run":
    cmdInitRun(rest[0], rest[1]);
    break;
  case "log-decision":
    cmdLogDecision(rest);
    break;
  default:
    usage();
    process.exit(cmd ? 1 : 0);
}
