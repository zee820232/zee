#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const DEFAULT_CONFIG = path.join(HOME, ".agents", "zee-config.json");
const SOURCE_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNS_ROOT = path.join(HOME, ".local", "state", "zee", "runs");
const SKILL_NAMES = ["zee", "zee-setup", "zee-plan", "zee-init", "zee-review", "zee-night"];

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

function detectActiveHarness() {
  if (process.env.PI_CODING_AGENT === "true" || process.env.AI_AGENT === "pi") {
    return "pi";
  }
  const norm = path.resolve(SOURCE_SKILLS_DIR);
  for (const t of HARNESS_TARGETS) {
    if (path.resolve(t.dir) === norm) return t.name;
  }
  if (norm.includes(`${path.sep}.pi${path.sep}`)) return "pi";
  if (norm.includes(`${path.sep}.claude${path.sep}`)) return "claude";
  if (norm.includes(`${path.sep}.gemini${path.sep}`)) return "antigravity";
  if (norm.includes(`${path.sep}.codex${path.sep}`)) return "codex";
  if (norm.includes(`${path.sep}.cursor${path.sep}`)) return "cursor";
  return "local";
}

function usage() {
  console.log(`zee-tool.mjs — zee 多模型工作流辅助工具（当前宿主: ${detectActiveHarness()}）

可用命令：
  validate [配置文件路径]         校验 zee-config.json 结构、模型家族多样性与备胎配置
  audit-rules [--all | --harness <名>]
                                 默认仅审计当前安装宿主的常驻规则冲突；加 --all 审计全机
  symlinks [--apply]             （仅用户显式要求同步多端时使用）检查或创建跨宿主软链
  init-run <仓库路径> <任务名>    创建仓库外运行总线（~/.local/state/zee/runs/...）
  list-runs [仓库路径]            列出当前仓库（或全部）的活跃/暂停任务总线，用于跨会话一键续跑
  cleanup-worktrees [仓库路径]    只读体检 Git worktree 状态（安全可清理 / 未合并 / 有未提交改动）
  log-decision <总线目录> <单元> <阶段> <决策> <原因> <证据> <结果>
                                 安全追加一行决策记录到 decisions.tsv
`);
}

function validateSpec(spec, label, errors, warnings) {
  if (!spec || typeof spec !== "object") {
    errors.push(`${label}: 缺少模型配置对象`);
    return;
  }
  for (const key of ["family", "modelHint", "tier", "effort"]) {
    if (typeof spec[key] !== "string" || !spec[key].trim()) {
      errors.push(`${label}.${key}: 必填且不能为空字符串`);
    }
  }
  if (spec.tier && !VALID_TIERS.has(spec.tier)) {
    errors.push(`${label}.tier: 非法值 "${spec.tier}"（仅允许 lite|fast|standard|pro）`);
  }
  if (spec.effort && !VALID_EFFORTS.has(spec.effort)) {
    errors.push(`${label}.effort: 非法思考强度 "${spec.effort}"`);
  }
  if (spec.effort === "max") {
    warnings.push(`${label}.effort 为 "max"；zee 建议日常默认思考强度封顶 "xhigh"`);
  }
}

function validateSlot(slot, label, errors, warnings) {
  if (!slot || typeof slot !== "object") {
    errors.push(`${label}: 缺少角色槽位配置`);
    return;
  }
  validateSpec(slot.prefer, `${label}.prefer`, errors, warnings);
  if (slot.backup) {
    validateSpec(slot.backup, `${label}.backup`, errors, warnings);
  } else {
    warnings.push(`${label}: 未配置备胎模型（backup）`);
  }
}

function cmdValidate(configPath = DEFAULT_CONFIG) {
  const errors = [];
  const warnings = [];
  if (!fs.existsSync(configPath)) {
    console.error(`校验失败：未找到配置文件 ${configPath}`);
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    console.error(`校验失败：${configPath} 不是合法 JSON（${e.message}）`);
    process.exit(1);
  }

  if (cfg.version !== 2) errors.push(`version 必须为 2（当前为 ${cfg.version}）`);
  if (!VALID_BUDGETS.has(cfg.budget)) errors.push(`budget 必须为 eco|balanced|max（当前为 ${cfg.budget}）`);
  if (!cfg.roles || typeof cfg.roles !== "object") {
    errors.push("缺少 roles 配置对象");
  } else {
    const r = cfg.roles;
    validateSlot(r.scout, "roles.scout", errors, warnings);
    if (!r.architect || typeof r.architect !== "object") {
      errors.push("缺少 roles.architect 配置");
    } else {
      validateSlot(r.architect.primary, "roles.architect.primary", errors, warnings);
      if (!Array.isArray(r.architect.arenaPool) || r.architect.arenaPool.length < 2) {
        warnings.push("roles.architect.arenaPool 少于 2 个模型（L3 辩论多样性不足）");
      } else {
        r.architect.arenaPool.forEach((entry, i) => validateSpec(entry.prefer || entry, `roles.architect.arenaPool[${i}]`, errors, warnings));
      }
    }
    if (!r.ui || typeof r.ui !== "object") {
      errors.push("缺少 roles.ui 配置");
    } else {
      validateSlot(r.ui.standard, "roles.ui.standard", errors, warnings);
      validateSlot(r.ui.heavy, "roles.ui.heavy", errors, warnings);
      if (r.ui.visionVerified !== true) {
        warnings.push("roles.ui.visionVerified 未标记为 true，请确认所选 UI 模型支持图像输入");
      }
    }
    if (!r.coder || typeof r.coder !== "object") {
      errors.push("缺少 roles.coder 配置");
    } else {
      validateSlot(r.coder.standard, "roles.coder.standard", errors, warnings);
      validateSlot(r.coder.heavy, "roles.coder.heavy", errors, warnings);
    }
    validateSlot(r.verifier, "roles.verifier", errors, warnings);
    if (!Array.isArray(r.reviewers) || r.reviewers.length < 2) {
      errors.push("roles.reviewers 必须包含至少 2 个模型才能执行跨家族异构审查");
    } else {
      const families = new Set();
      r.reviewers.forEach((rev, i) => {
        const spec = rev.prefer || rev;
        validateSpec(spec, `roles.reviewers[${i}]`, errors, warnings);
        if (spec?.family) families.add(spec.family);
      });
      if (families.size < 2) {
        errors.push(`roles.reviewers 仅有 ${families.size} 个底层家族（${[...families].join(", ")}），至少需要 2 个不同家族`);
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

  console.log(JSON.stringify({
    ok: errors.length === 0,
    activeHarness: detectActiveHarness(),
    configPath,
    errors,
    warnings,
  }, null, 2));
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
  console.log(JSON.stringify({ activeHarness: detectActiveHarness(), source: SOURCE_SKILLS_DIR, applied: apply, report }, null, 2));
}

function cmdAuditRules(args) {
  const auditAll = args.includes("--all");
  const harnessIdx = args.indexOf("--harness");
  const activeHarness = harnessIdx >= 0 && args[harnessIdx + 1] ? args[harnessIdx + 1] : detectActiveHarness();
  const shouldCheck = (name) => auditAll || activeHarness === "agents" || activeHarness === "local" || activeHarness === name;
  const findings = [];

  if (shouldCheck("antigravity")) {
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
        status: disabled ? "已禁用" : "存在冲突",
        detail: disabled
          ? "agystack 插件已在 ~/.gemini/config/config.json 中禁用"
          : "常驻规则会强制拦截进入 poteto-mode 与原生 invoke_subagent；建议在 ~/.gemini/config/config.json 写入 plugins.agystack.enabled = false",
      });
    }
    const useBendRule = path.join(HOME, ".gemini", "config", "plugins", "use-bend", "rules", "AGENTS.md");
    if (fs.existsSync(useBendRule)) {
      findings.push({
        harness: "antigravity",
        file: useBendRule,
        severity: "low",
        status: "提示",
        detail: "可能偏向使用 Bend 2 写脚本；zee 的 worker.md 已明确要求沿用仓库现有语言",
      });
    }
  }

  if (shouldCheck("pi") || shouldCheck("claude")) {
    const homeClaude = path.join(HOME, "CLAUDE.md");
    if (fs.existsSync(homeClaude)) {
      const body = fs.readFileSync(homeClaude, "utf8");
      const hits = [];
      if (/pnpm test/i.test(body)) hits.push("写死了 pnpm test");
      if (/超过\s*3\s*个文件|more than 3 files/i.test(body)) hits.push("限制一次重构不超过 3 个文件");
      if (/CHANGELOG/i.test(body)) hits.push("强制更新 CHANGELOG");
      findings.push({
        harness: activeHarness === "pi" ? "pi" : "pi/claude",
        file: homeClaude,
        severity: hits.length ? "medium" : "info",
        status: hits.length ? "潜在冲突" : "正常",
        detail: hits.length
          ? `家目录 CLAUDE.md 包含项目级硬编码规则（${hits.join("、")}），可能干扰非 JS 项目`
          : "存在且未发现明显硬编码冲突",
      });
    }
  }

  if (shouldCheck("pi")) {
    const piSettings = path.join(HOME, ".pi", "agent", "settings.json");
    if (fs.existsSync(piSettings)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(piSettings, "utf8"));
        const skillsArr = Array.isArray(cfg.skills) ? cfg.skills : [];
        const packagesArr = Array.isArray(cfg.packages) ? cfg.packages : [];
        const hasPstackExclude = skillsArr.some((s) => typeof s === "string" && s.includes("poteto-mode"));
        const pstackExists = fs.existsSync(path.join(HOME, ".agents", "skills", "poteto-mode"));
        if (pstackExists) {
          findings.push({
            harness: "pi",
            file: piSettings,
            severity: hasPstackExclude ? "info" : "medium",
            status: hasPstackExclude ? "已隔离" : "建议禁用 pstack",
            detail: hasPstackExclude
              ? "Pi 已通过 settings.json 排除 ~/.agents/skills 下的 pstack 工作流"
              : "Pi 会自动扫描 ~/.agents/skills/ 中的 pstack，可在 ~/.pi/agent/settings.json 的 skills 中用 ! 规则排除",
          });
        }

        // 双安装冲突检测：Pi Package 已注册 zee 时，检查 ~/.pi/agent/skills 与 ~/.agents/skills 是否有重复副本
        const hasZeePkg = packagesArr.some((p) => {
          const src = typeof p === "string" ? p : p?.source;
          return typeof src === "string" && /(^|[/:\\])zee([\\/.]|$)|zee-workflow/.test(src);
        });
        if (hasZeePkg) {
          const dupDirs = [];
          for (const checkRoot of [path.join(HOME, ".pi", "agent", "skills"), path.join(HOME, ".agents", "skills")]) {
            for (const skillName of SKILL_NAMES) {
              const candidate = path.join(checkRoot, skillName);
              if (!fs.existsSync(candidate)) continue;
              try {
                const realCandidate = fs.realpathSync(candidate);
                const realSource = fs.realpathSync(path.join(SOURCE_SKILLS_DIR, skillName));
                if (realCandidate !== realSource) {
                  dupDirs.push(candidate);
                }
              } catch {
                dupDirs.push(candidate);
              }
            }
          }
          findings.push({
            harness: "pi",
            file: piSettings,
            severity: dupDirs.length > 0 ? "high" : "info",
            status: dupDirs.length > 0 ? "存在双安装重名冲突" : "Pi Package 单源正常",
            detail:
              dupDirs.length > 0
                ? `Pi 已以 Package 形态加载 zee，但同时发现重复技能副本（${dupDirs.join("、")}），会触发重名警告；请删除这些重复目录`
                : "Pi 以 Package 形态单源加载 zee，未发现技能重名冲突",
          });
        }
      } catch {}
    }
  }

  if (shouldCheck("claude")) {
    const dotClaude = path.join(HOME, ".claude", "CLAUDE.md");
    if (fs.existsSync(dotClaude)) {
      const body = fs.readFileSync(dotClaude, "utf8");
      if (/oh-my-claudecode|OMC/i.test(body)) {
        findings.push({
          harness: "claude",
          file: dotClaude,
          severity: "medium",
          status: "存在冲突",
          detail: "检测到 oh-my-claudecode (OMC) 编排规则；使用 Claude Code 跑 zee 时请留意避免嵌套派发",
        });
      }
    }
  }

  if (shouldCheck("codex")) {
    const codexAgents = path.join(HOME, ".codex", "AGENTS.md");
    if (fs.existsSync(codexAgents)) {
      findings.push({ harness: "codex", file: codexAgents, severity: "info", status: "存在", detail: "如出现指令冲突请检查该常驻规则文件" });
    }
  }

  if (shouldCheck("cursor")) {
    const cursorRules = path.join(HOME, ".cursor", "rules");
    if (fs.existsSync(cursorRules)) {
      findings.push({ harness: "cursor", file: cursorRules, severity: "info", status: "存在", detail: "如出现指令冲突请检查 Cursor 全局 rules" });
    }
  }

  console.log(JSON.stringify({
    scope: auditAll ? "all" : activeHarness,
    sourceSkillsDir: SOURCE_SKILLS_DIR,
    findings,
  }, null, 2));
}

function sanitizeSlug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "task";
}

function cmdInitRun(repoPath, slug) {
  if (!repoPath || !slug) {
    console.error("用法：init-run <仓库路径> <任务名>");
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
      activeHarness: detectActiveHarness(),
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

  console.log(JSON.stringify({ ok: true, activeHarness: detectActiveHarness(), busDir, statePath, tsvPath }, null, 2));
}

function cleanTsvCell(val) {
  const s = String(val ?? "").replace(/[\t\r\n]+/g, " ").trim();
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

function cmdLogDecision(args) {
  if (args.length < 7) {
    console.error("用法：log-decision <总线目录> <单元> <阶段> <决策> <原因> <证据> <结果>");
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

function repoKeyFor(repoPath) {
  const absRepo = path.resolve(repoPath);
  const hash = crypto.createHash("sha256").update(absRepo).digest("hex").slice(0, 8);
  return `${sanitizeSlug(path.basename(absRepo))}-${hash}`;
}

function cmdListRuns(repoPath) {
  if (!fs.existsSync(RUNS_ROOT)) {
    console.log(JSON.stringify({ ok: true, count: 0, runs: [] }, null, 2));
    return;
  }
  const repoDirs = repoPath && repoPath !== "--all"
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

function cmdCleanupWorktrees(repoPath = process.cwd()) {
  const absRepo = path.resolve(repoPath);
  let porcelain;
  try {
    porcelain = execFileSync("git", ["-C", absRepo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  } catch (e) {
    console.error(`检查失败：${absRepo} 不是合法的 Git 仓库（${e.message}）`);
    process.exit(1);
  }

  let mergedSet = new Set();
  try {
    const mergedOut = execFileSync("git", ["-C", absRepo, "branch", "--merged"], { encoding: "utf8" });
    mergedSet = new Set(mergedOut.split(/\r?\n/).map((l) => l.replace(/^[*+\s]+/, "").trim()).filter(Boolean));
  } catch {}

  const blocks = porcelain.trim().split(/\n\n+/);
  const worktrees = [];
  blocks.forEach((blk, idx) => {
    const lines = blk.split(/\r?\n/);
    const wtPath = lines.find((l) => l.startsWith("worktree "))?.slice(9).trim();
    const head = lines.find((l) => l.startsWith("HEAD "))?.slice(5).trim();
    const branchRef = lines.find((l) => l.startsWith("branch "))?.slice(7).trim();
    const branch = branchRef ? branchRef.replace(/^refs\/heads\//, "") : "(detached)";
    if (!wtPath) return;

    let dirtyCount = 0;
    try {
      const st = execFileSync("git", ["-C", wtPath, "status", "--porcelain"], { encoding: "utf8" }).trim();
      dirtyCount = st ? st.split(/\r?\n/).length : 0;
    } catch {}

    const isPrimary = idx === 0;
    const isMerged = branch !== "(detached)" && mergedSet.has(branch);
    let bucket = "primary";
    if (!isPrimary) {
      if (dirtyCount > 0) bucket = "keep_dirty";
      else if (isMerged) bucket = "safe_to_prune";
      else bucket = "review_unmerged";
    }
    worktrees.push({
      path: wtPath,
      branch,
      head: head?.slice(0, 10) || null,
      dirtyFiles: dirtyCount,
      mergedIntoCurrent: isMerged,
      bucket,
      pruneHint: bucket === "safe_to_prune" ? `git -C "${absRepo}" worktree remove "${wtPath}"` : null,
    });
  });

  console.log(JSON.stringify({ ok: true, readOnly: true, repoRoot: absRepo, worktrees }, null, 2));
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
    cmdAuditRules(rest);
    break;
  case "init-run":
    cmdInitRun(rest[0], rest[1]);
    break;
  case "list-runs":
    cmdListRuns(rest[0]);
    break;
  case "cleanup-worktrees":
    cmdCleanupWorktrees(rest[0]);
    break;
  case "log-decision":
    cmdLogDecision(rest);
    break;
  default:
    usage();
    process.exit(cmd ? 1 : 0);
}
