#!/usr/bin/env node
/**
 * zee-tool.mjs v4.1.1 — 零依赖纯 Node 多模型工作流辅助引擎
 *
 * 子命令：
 *   validate [configPath] [--check-live]
 *   audit-rules [--all | --harness <name>]
 *   symlinks [--apply]
 *   init-run <repoRoot> <slug> [--conversation-id <cid>]
 *   update-state <busDir> [--status ...] [--mode ...] [--level ...] [--predicate ...] [--resume-next ...] [--conversation-id <cid>] [--budget '<json>'] [--unit-upsert '<json>'] [--inc-delegates [N]] [--inc-aborted [N]] [--fallback '<str>']
 *   list-runs [repoRoot | --all]
 *   log-decision <busDir> <unit> <phase> <decision> <why> <evidence> <result>
 *   log-decision --bus <dir> --unit <u> --phase <p> --decision <d> --why <w> --evidence <e> --result <r>
 *   worktree-create <repoRoot> <slug> <lane> <baseRef> [--branch <name>]
 *   cleanup-worktrees [repoRoot] [--base <ref>] [--prune-safe]
 *   check-plan <planPath> [--strict-budget]
 *   resolve-model --harness agy|pi|t3 [--surface invoke_subagent|swarm] --role <role> [--config <path>]
 *   doctor [--harness <name>] [--repo <path>] [--all]
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const DEFAULT_CONFIG = path.join(HOME, ".agents", "zee-config.json");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_SKILLS_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const REPO_ROOT = path.resolve(SOURCE_SKILLS_DIR, "..");
const RUNS_ROOT = path.join(HOME, ".local", "state", "zee", "runs");
const SKILL_NAMES = ["zee", "zee-setup", "zee-plan", "zee-init", "zee-review", "zee-verify", "zee-night", "zee-arch", "zee-retro"];

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
  if (
    process.env.ANTIGRAVITY_CLI ||
    process.env.ANTIGRAVITY_AGENT ||
    (process.env.PLUGIN_ROOT && process.env.PLUGIN_ROOT.includes(`${path.sep}.gemini${path.sep}`))
  ) {
    return "antigravity";
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

const KNOWN_VALUE_FLAGS = new Set([
  "harness",
  "repo",
  "bus",
  "status",
  "mode",
  "level",
  "predicate",
  "resume-next",
  "conversation-id",
  "budget",
  "unit-upsert",
  "fallback",
  "unit",
  "phase",
  "decision",
  "why",
  "evidence",
  "result",
  "branch",
  "base",
  "surface",
  "role",
  "config",
]);

const KNOWN_BOOLEAN_FLAGS = new Set(["check-live", "all", "apply", "prune-safe", "strict-budget", "help"]);

function parseFlags(args) {
  const flags = {};
  const positional = [];
  let endOfFlags = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (endOfFlags) {
      positional.push(token);
      continue;
    }
    if (token === "--") {
      endOfFlags = true;
      continue;
    }
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx > 2) {
        const key = token.slice(2, eqIdx);
        const val = token.slice(eqIdx + 1);
        if (key === "inc-delegates" || key === "inc-aborted") {
          flags[key] = (Number(flags[key]) || 0) + (Number(val) || 1);
        } else {
          flags[key] = val;
        }
      } else {
        const key = token.slice(2);
        const next = args[i + 1];
        if (KNOWN_BOOLEAN_FLAGS.has(key)) {
          flags[key] = true;
        } else if (KNOWN_VALUE_FLAGS.has(key)) {
          if (next !== undefined) {
            flags[key] = next;
            i += 1;
          } else {
            flags[key] = true;
          }
        } else if (key === "inc-delegates" || key === "inc-aborted") {
          if (next !== undefined && /^\d+$/.test(next)) {
            flags[key] = (Number(flags[key]) || 0) + Number(next);
            i += 1;
          } else {
            flags[key] = (Number(flags[key]) || 0) + 1;
          }
        } else if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
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
  console.log(`zee-tool.mjs v4.1.1 — zee 多模型工作流辅助引擎（当前宿主: ${detectActiveHarness()}）

可用命令：
  validate [配置文件] [--check-live]
                                 校验 zee-config.json 结构、家族多样性，--check-live 联检 Pi enabledModels 漂移（含 backup 槽位）
  audit-rules [--all | --harness <名>]
                                 默认仅审计当前安装宿主的常驻规则冲突；加 --all 审计全机
  doctor [--harness <名>] [--repo <路径>] [--all]
                                 一站式健康体检：配置校验 + 冲突审计 + 目录可写 + AGY Hook 实发载荷探活
  symlinks [--apply]             （仅用户显式要求同步多端时使用）检查或创建跨宿主软链
  init-run <仓库路径> <任务名>    创建仓库外运行总线（~/.local/state/zee/runs/...）
  update-state <总线目录> [--status <s>] [--mode <m>] [--level <l>] [--predicate <p>]
                          [--resume-next <r>] [--budget '<json>'] [--unit-upsert '<json>']
                          [--inc-delegates [N]] [--inc-aborted [N]] [--fallback '<str>']
                                 以 tmp+rename 原子更新 state.json 并刷新 updatedAt
  list-runs [仓库路径 | --all]    列出当前仓库（或全部）的活跃/暂停任务总线，用于跨会话一键续跑
  log-decision <总线> <单元> <阶段> <决策> <原因> <证据> <结果>
  log-decision --bus <总线> --unit <单元> --phase <阶段> --decision <决策> --why <原因> --evidence <证据> --result <结果>
                                 安全追加一行决策记录到 decisions.tsv（兼容位置参数与具名参数）
  worktree-create <仓库> <slug> <lane> <baseRef> [--branch <分支名>]
                                 在 ~/.local/state/zee/runs/.../worktrees/<lane> 原子创建隔离 worktree（自动规避嵌套 ref 冲突）
  cleanup-worktrees [仓库路径] [--base <基准分支>] [--prune-safe]
                                 分级体检 worktree（含 squash-merge/patch-id 识别、wip vs scratch、干净 detached 识别），加 --prune-safe 执行安全回收
  check-plan <plan.md 路径> [--strict-budget]
                                 静态校验计划文档必备章节、切片环/悬空依赖与单切片预算（≤5 文件 / ≤400 LOC）
  resolve-model --harness agy|pi|t3 [--surface invoke_subagent|swarm] --role <角色> [--config <路径>]
                                 按目标执行面确定性翻译角色模型标识
`);
}

function sanitizeSlug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "task";
}

function repoKeyFor(repoPath) {
  const absRepo = path.resolve(repoPath);
  const hash = crypto.createHash("sha256").update(absRepo).digest("hex").slice(0, 8);
  return `${sanitizeSlug(path.basename(absRepo))}-${hash}`;
}

function atomicWriteJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
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

function collectModelHintsFromConfig(cfg) {
  const hints = [];
  const add = (spec, slot) => {
    if (spec?.modelHint) hints.push({ slot, modelHint: String(spec.modelHint) });
  };
  const addSlot = (slotObj, label) => {
    if (!slotObj || typeof slotObj !== "object") return;
    add(slotObj.prefer, `${label}.prefer`);
    add(slotObj.backup, `${label}.backup`);
  };
  const r = cfg?.roles || {};
  addSlot(r.scout, "scout");
  addSlot(r.architect?.primary, "architect.primary");
  if (Array.isArray(r.architect?.arenaPool)) {
    r.architect.arenaPool.forEach((e, i) => {
      add(e.prefer || e, `architect.arenaPool[${i}]`);
      add(e.backup, `architect.arenaPool[${i}].backup`);
    });
  }
  addSlot(r.ui?.standard, "ui.standard");
  addSlot(r.ui?.heavy, "ui.heavy");
  addSlot(r.coder?.standard, "coder.standard");
  addSlot(r.coder?.heavy, "coder.heavy");
  addSlot(r.verifier, "verifier");
  if (Array.isArray(r.reviewers)) {
    r.reviewers.forEach((rev, i) => {
      add(rev.prefer || rev, `reviewers[${i}].prefer`);
      add(rev.backup, `reviewers[${i}].backup`);
    });
  }
  if (r.judge) {
    if (Array.isArray(r.judge)) {
      r.judge.forEach((j, i) => addSlot(j, `judge[${i}]`));
    } else {
      addSlot(r.judge, "judge");
    }
  }
  return hints;
}

function checkPiLiveDrift(cfg) {
  const drift = [];
  const piModelsPath = path.join(HOME, ".pi", "agent", "models.json");
  const piSettingsPath = path.join(HOME, ".pi", "agent", "settings.json");

  const availableIds = new Set();
  if (fs.existsSync(piModelsPath)) {
    try {
      const mCfg = JSON.parse(fs.readFileSync(piModelsPath, "utf8"));
      const providers = mCfg?.providers && typeof mCfg.providers === "object" ? mCfg.providers : {};
      for (const [provName, provObj] of Object.entries(providers)) {
        const models = Array.isArray(provObj?.models) ? provObj.models : [];
        for (const m of models) {
          const id = typeof m === "string" ? m : m?.id;
          if (id) {
            availableIds.add(id.toLowerCase());
            availableIds.add(`${provName}/${id}`.toLowerCase());
          }
        }
      }
    } catch {}
  }

  let enabledList = null;
  if (fs.existsSync(piSettingsPath)) {
    try {
      const sCfg = JSON.parse(fs.readFileSync(piSettingsPath, "utf8"));
      if (Array.isArray(sCfg.enabledModels) && sCfg.enabledModels.length > 0) {
        enabledList = sCfg.enabledModels.map((s) => String(s).toLowerCase());
      }
    } catch {}
  }

  if (enabledList && availableIds.size > 0) {
    for (const { slot, modelHint } of collectModelHintsFromConfig(cfg)) {
      const low = modelHint.toLowerCase();
      const tail = low.split("/").pop();
      const inModels = [...availableIds].some((id) => id === low || id.endsWith(`/${tail}`) || id.includes(tail));
      const inEnabled = enabledList.some((e) => e === low || e.endsWith(`/${tail}`) || e.includes(tail));
      if (inModels && !inEnabled) {
        drift.push({
          code: "CONFIG_DRIFT",
          slot,
          modelHint,
          detail: `模型 "${modelHint}" 已在 ~/.pi/agent/models.json 中存在，但被 ~/.pi/agent/settings.json 的 enabledModels 白名单遮蔽！`,
        });
      }
    }
  }
  return {
    checkedPiFiles: {
      modelsJson: fs.existsSync(piModelsPath),
      settingsJson: fs.existsSync(piSettingsPath),
      enabledModelsCount: enabledList ? enabledList.length : null,
    },
    drift,
  };
}

function runValidate(configPath = DEFAULT_CONFIG, checkLive = false) {
  const errors = [];
  const warnings = [];
  if (!fs.existsSync(configPath)) {
    return {
      ok: false,
      activeHarness: detectActiveHarness(),
      configPath,
      errors: [`未找到配置文件 ${configPath}`],
      warnings,
      liveCheck: null,
    };
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    return {
      ok: false,
      activeHarness: detectActiveHarness(),
      configPath,
      errors: [`${configPath} 不是合法 JSON（${e.message}）`],
      warnings,
      liveCheck: null,
    };
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

  let liveCheck = null;
  if (checkLive) {
    liveCheck = checkPiLiveDrift(cfg);
    for (const item of liveCheck.drift) {
      warnings.push(`[${item.code}] ${item.detail}`);
    }
  }

  return {
    ok: errors.length === 0,
    activeHarness: detectActiveHarness(),
    configPath,
    errors,
    warnings,
    liveCheck,
  };
}

function cmdValidate(args) {
  const { flags, positional } = parseFlags(args);
  const configPath = positional[0] || DEFAULT_CONFIG;
  const checkLive = Boolean(flags["check-live"]);
  const res = runValidate(configPath, checkLive);
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
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

function runAuditRules(args) {
  const auditAll = args.includes("--all");
  const harnessIdx = args.indexOf("--harness");
  const activeHarness = harnessIdx >= 0 && args[harnessIdx + 1] ? args[harnessIdx + 1] : detectActiveHarness();
  const shouldCheck = (name) => auditAll || activeHarness === "agents" || activeHarness === "local" || activeHarness === name;
  const findings = [];

  if (shouldCheck("antigravity")) {
    const geminiCfgPath = path.join(HOME, ".gemini", "config", "config.json");
    let geminiCfg = {};
    try {
      if (fs.existsSync(geminiCfgPath)) geminiCfg = JSON.parse(fs.readFileSync(geminiCfgPath, "utf8"));
    } catch {}

    // 通用扫描：检测其他已启用插件是否携带全局常驻 rules/AGENTS.md（可能劫持 zee 工作流）
    const pluginsDir = path.join(HOME, ".gemini", "config", "plugins");
    if (fs.existsSync(pluginsDir)) {
      for (const entry of fs.readdirSync(pluginsDir)) {
        if (entry === "zee") continue;
        const rulePath = path.join(pluginsDir, entry, "rules", "AGENTS.md");
        if (!fs.existsSync(rulePath)) continue;
        const disabled = geminiCfg?.plugins?.[entry]?.enabled === false;
        let ruleBody = "";
        try {
          ruleBody = fs.readFileSync(rulePath, "utf8");
        } catch {}
        const looksCompetingController = /orchestrat|subagent|workflow|mode|always invoke|mandatory/i.test(ruleBody);
        findings.push({
          harness: "antigravity",
          file: rulePath,
          severity: disabled ? "info" : looksCompetingController ? "high" : "low",
          status: disabled ? "已禁用" : looksCompetingController ? "存在全局规则冲突" : "提示",
          detail: disabled
            ? `外部插件 ${entry} 已在 ~/.gemini/config/config.json 中禁用`
            : looksCompetingController
              ? `外部插件 ${entry} 携带全局常驻 rules/AGENTS.md，可能干扰 zee 编排与子代理派发；建议在 ~/.gemini/config/config.json 设 plugins.${entry}.enabled = false`
              : `外部插件 ${entry} 携带全局 rules/AGENTS.md，zee 的 worker.md 已在子代理中做隔离`,
        });
      }
    }

    const agyZeePlugin = path.join(HOME, ".gemini", "config", "plugins", "zee");
    if (fs.existsSync(agyZeePlugin)) {
      const pluginEnabled = geminiCfg?.plugins?.zee?.enabled !== false;
      const dupDirs = [];
      for (const checkRoot of [path.join(HOME, ".gemini", "config", "skills"), path.join(HOME, ".agents", "skills")]) {
        for (const skillName of SKILL_NAMES) {
          const candidate = path.join(checkRoot, skillName);
          if (!fs.existsSync(candidate)) continue;
          try {
            const realCand = fs.realpathSync(candidate);
            const realPlug = fs.realpathSync(path.join(agyZeePlugin, "skills", skillName));
            if (realCand !== realPlug) dupDirs.push(candidate);
          } catch {
            dupDirs.push(candidate);
          }
        }
      }
      findings.push({
        harness: "antigravity",
        file: agyZeePlugin,
        severity: dupDirs.length > 0 ? "high" : "info",
        status: !pluginEnabled ? "插件已禁用" : dupDirs.length > 0 ? "存在双安装重名冲突" : "Antigravity 插件单源正常",
        detail: !pluginEnabled
          ? "zee 插件已安装但在 ~/.gemini/config/config.json 中处于禁用状态，可用 agy plugin enable zee 启用"
          : dupDirs.length > 0
            ? `Antigravity 已以原生插件加载 zee，但同时发现重复技能副本（${dupDirs.join("、")}）；建议删除重复目录`
            : `Antigravity 以原生插件单源加载 zee（含 ${SKILL_NAMES.length} 技能 + 7 代理 + 生命周期安全 Hook）`,
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
          ? `家目录 CLAUDE.md 包含项目级硬编码规则（${hits.join("、")}），可能干扰非 JS 项目（zee v4 扩展已注入隔离指令，但仍建议清理）`
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
                if (realCandidate !== realSource) dupDirs.push(candidate);
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

  return {
    scope: auditAll ? "all" : activeHarness,
    sourceSkillsDir: SOURCE_SKILLS_DIR,
    findings,
  };
}

function cmdAuditRules(args) {
  console.log(JSON.stringify(runAuditRules(args), null, 2));
}

function cmdInitRun(args) {
  const { flags, positional } = parseFlags(args);
  const [repoPath, slug] = positional;
  if (!repoPath || !slug) {
    console.error("用法：init-run <仓库路径> <任务名> [--conversation-id <cid>]");
    process.exit(1);
  }
  const absRepo = path.resolve(repoPath);
  const repoKey = repoKeyFor(absRepo);
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
      conversationId: typeof flags["conversation-id"] === "string" && flags["conversation-id"].trim() ? flags["conversation-id"].trim() : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mode: "standard",
      level: null,
      predicate: null,
      resumeNext: null,
      units: [],
      delegatesDispatched: 0,
      fallbacksUsed: [],
      status: "initialized",
    };
    atomicWriteJson(statePath, initState);
  }

  const tsvPath = path.join(busDir, "decisions.tsv");
  if (!fs.existsSync(tsvPath)) {
    fs.writeFileSync(tsvPath, "ts\tunit\tphase\tdecision\twhy\tevidence\tresult\n", "utf8");
  }

  console.log(JSON.stringify({ ok: true, activeHarness: detectActiveHarness(), busDir, statePath, tsvPath }, null, 2));
}

function cmdUpdateState(args) {
  const { flags, positional } = parseFlags(args);
  const busDir = flags.bus || positional[0];
  if (!busDir) {
    console.error("用法：update-state <总线目录> [--status <s>] [--mode <m>] [--level <l>] [--predicate <p>] [--resume-next <r>] [--conversation-id <cid>] [--unit-upsert '<json>'] [--inc-delegates] [--fallback '<str>']");
    process.exit(1);
  }
  const statePath = path.join(busDir, "state.json");
  if (!fs.existsSync(statePath)) {
    console.error(`更新失败：未找到 ${statePath}，请先运行 init-run`);
    process.exit(1);
  }

  const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (typeof flags.status === "string") st.status = flags.status;
  if (typeof flags.mode === "string") st.mode = flags.mode;
  if (typeof flags.level === "string") st.level = flags.level;
  if (typeof flags.predicate === "string") st.predicate = flags.predicate;
  if (typeof flags["conversation-id"] === "string" && flags["conversation-id"].trim()) {
    st.conversationId = flags["conversation-id"].trim();
  }
  if (typeof flags["resume-next"] === "string") {
    st.resumeNext = flags["resume-next"] === "null" ? null : flags["resume-next"];
  }
  if (flags["inc-delegates"]) {
    const inc = Number(flags["inc-delegates"]) || 1;
    st.delegatesDispatched = (Number(st.delegatesDispatched) || 0) + inc;
  }
  if (flags["inc-aborted"]) {
    const inc = Number(flags["inc-aborted"]) || 1;
    st.abortedDelegates = (Number(st.abortedDelegates) || 0) + inc;
  }
  if (typeof flags.budget === "string") {
    let budgetObj;
    try {
      budgetObj = JSON.parse(flags.budget);
    } catch (e) {
      console.error(`--budget 不是合法 JSON：${e.message}`);
      process.exit(1);
    }
    if (!budgetObj || typeof budgetObj !== "object" || Array.isArray(budgetObj)) {
      console.error("--budget 必须是 JSON 对象（如 '{\"maxUnits\":4,\"maxDelegates\":12,\"cutoffRatio\":0.7}'）");
      process.exit(1);
    }
    st.budget = { ...(st.budget && typeof st.budget === "object" ? st.budget : {}), ...budgetObj };
  }
  if (typeof flags.fallback === "string" && flags.fallback.trim()) {
    if (!Array.isArray(st.fallbacksUsed)) st.fallbacksUsed = [];
    if (!st.fallbacksUsed.includes(flags.fallback)) st.fallbacksUsed.push(flags.fallback);
  }
  if (typeof flags["unit-upsert"] === "string") {
    let unitObj;
    try {
      unitObj = JSON.parse(flags["unit-upsert"]);
    } catch (e) {
      console.error(`--unit-upsert 不是合法 JSON：${e.message}`);
      process.exit(1);
    }
    if (!unitObj || typeof unitObj !== "object" || !unitObj.id) {
      console.error("--unit-upsert 对象必须包含 id 字段");
      process.exit(1);
    }
    if (!Array.isArray(st.units)) st.units = [];
    const idx = st.units.findIndex((u) => u && u.id === unitObj.id);
    if (idx >= 0) {
      st.units[idx] = { ...st.units[idx], ...unitObj, updatedAt: new Date().toISOString() };
    } else {
      st.units.push({ ...unitObj, updatedAt: new Date().toISOString() });
    }
  }

  st.updatedAt = new Date().toISOString();
  atomicWriteJson(statePath, st);
  console.log(JSON.stringify({ ok: true, statePath, state: st }, null, 2));
}

function cleanTsvCell(val) {
  const s = String(val ?? "").replace(/[\t\r\n]+/g, " ").trim();
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

function cmdLogDecision(args) {
  let busDir, unit, phase, decision, why, evidence, result;
  if (args.some((a) => a.startsWith("--"))) {
    const { flags } = parseFlags(args);
    busDir = flags.bus;
    unit = flags.unit;
    phase = flags.phase;
    decision = flags.decision;
    why = flags.why;
    evidence = flags.evidence;
    result = flags.result;
  } else {
    [busDir, unit, phase, decision, why, evidence, result] = args;
  }

  if (!busDir || !unit || !phase || !decision || why === undefined || evidence === undefined || result === undefined) {
    console.error("用法：log-decision <总线目录> <单元> <阶段> <决策> <原因> <证据> <结果>\n或：log-decision --bus <dir> --unit <u> --phase <p> --decision <d> --why <w> --evidence <e> --result <r>");
    process.exit(1);
  }

  const tsvPath = path.join(busDir, "decisions.tsv");
  fs.mkdirSync(busDir, { recursive: true });
  if (!fs.existsSync(tsvPath)) {
    fs.writeFileSync(tsvPath, "ts\tunit\tphase\tdecision\twhy\tevidence\tresult\n", "utf8");
  }
  const row =
    [
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
    try {
      execFileSync("git", ["-C", absRepo, "show-ref", "--verify", "--quiet", refName], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  for (let guard = 0; guard < 8; guard++) {
    const parts = candidate.split("/").filter(Boolean);
    let collidedIdx = -1;
    for (let i = 1; i < parts.length; i++) {
      if (refExists(`refs/heads/${parts.slice(0, i).join("/")}`)) {
        collidedIdx = i;
        break;
      }
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
    try {
      execFileSync("git", ["-C", absRepo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      exists = true;
    } catch {}
    if (exists) gitArgs.push(wtPath, branch);
    else gitArgs.push("-b", branch, wtPath, baseRef);
  } else {
    gitArgs.push("--detach", wtPath, baseRef);
  }

  execFileSync("git", gitArgs, { encoding: "utf8" });
  const head = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  console.log(
    JSON.stringify(
      { ok: true, repoRoot: absRepo, worktreePath: wtPath, branch: branch || "(detached)", flattened: Boolean(rawBranch && branch !== rawBranch), head },
      null,
      2,
    ),
  );
}

function isSquashMergedByPatchId(absRepo, baseRef, branchRef) {
  try {
    const mergeBase = execFileSync("git", ["-C", absRepo, "merge-base", baseRef, branchRef], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!mergeBase) return false;
    const branchDiff = execFileSync("git", ["-C", absRepo, "diff", `${mergeBase}..${branchRef}`], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    if (!branchDiff.trim()) return true;
    const patchRes = spawnSync("git", ["patch-id", "--stable"], { input: branchDiff, encoding: "utf8" });
    const targetPatchId = (patchRes.stdout || "").trim().split(/\s+/)[0];
    if (!targetPatchId) return false;

    // 检查 baseRef 上最近 50 个提交的 patch-id 是否命中（识别 squash-merge）
    const logShas = execFileSync("git", ["-C", absRepo, "rev-list", "--max-count=50", `${mergeBase}..${baseRef}`], {
      encoding: "utf8",
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    for (const sha of logShas) {
      const commitDiff = execFileSync("git", ["-C", absRepo, "show", "--format=", sha], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      const pr = spawnSync("git", ["patch-id", "--stable"], { input: commitDiff, encoding: "utf8" });
      const pid = (pr.stdout || "").trim().split(/\s+/)[0];
      if (pid && pid === targetPatchId) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function detectDefaultBaseRef(absRepo) {
  const candidates = ["origin/HEAD", "origin/main", "origin/master", "main", "master", "HEAD"];
  for (const ref of candidates) {
    try {
      const resolved = execFileSync("git", ["-C", absRepo, "rev-parse", "--verify", "--quiet", ref], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (resolved) return ref;
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
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        if (e && e.code === "EPERM") return true;
        return false;
      }
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
  const baseRef = typeof flags.base === "string" && flags.base.trim() ? flags.base.trim() : detectDefaultBaseRef(absRepo);

  let porcelain;
  try {
    porcelain = execFileSync("git", ["-C", absRepo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  } catch (e) {
    console.error(`检查失败：${absRepo} 不是合法的 Git 仓库（${e.message}）`);
    process.exit(1);
  }

  const blocks = porcelain.trim().split(/\n\n+/);
  const worktrees = [];
  const pruned = [];

  blocks.forEach((blk, idx) => {
    const lines = blk.split(/\r?\n/);
    const wtPath = lines.find((l) => l.startsWith("worktree "))?.slice(9).trim();
    const head = lines.find((l) => l.startsWith("HEAD "))?.slice(5).trim();
    const branchRef = lines.find((l) => l.startsWith("branch "))?.slice(7).trim();
    const isDetached = !branchRef;
    const branch = branchRef ? branchRef.replace(/^refs\/heads\//, "") : "(detached)";
    if (!wtPath) return;

    let wipFiles = 0;
    let scratchFiles = 0;
    try {
      const st = execFileSync("git", ["-C", wtPath, "status", "--porcelain"], { encoding: "utf8" }).trim();
      if (st) {
        for (const l of st.split(/\r?\n/)) {
          if (l.startsWith("??")) scratchFiles += 1;
          else wipFiles += 1;
        }
      }
    } catch {}
    const dirtyFiles = wipFiles + scratchFiles;

    let isMerged = false;
    let mergeMethod = null;
    if (idx > 0 && head) {
      try {
        execFileSync("git", ["-C", absRepo, "merge-base", "--is-ancestor", head, baseRef], { stdio: "ignore" });
        isMerged = true;
        mergeMethod = "ancestor";
      } catch {
        if (!isDetached && isSquashMergedByPatchId(absRepo, baseRef, branch)) {
          isMerged = true;
          mergeMethod = "squash-patch-id";
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
        execFileSync("git", ["-C", absRepo, "worktree", "remove", "--force", wtPath], { stdio: "ignore" });
        try {
          fs.rmSync(`${wtPath}.zee-lock.json`, { force: true });
        } catch {}
        prunedNow = true;
        pruned.push(wtPath);
      } catch {}
    }

    worktrees.push({
      path: wtPath,
      branch,
      head: head?.slice(0, 10) || null,
      dirtyFiles,
      wipFiles,
      scratchFiles,
      mergedIntoBase: isMerged,
      mergeMethod,
      activeLocked: isActiveLocked,
      bucket,
      pruned: prunedNow,
      pruneHint: !prunedNow && bucket.startsWith("safe_to_prune") ? `git -C "${absRepo}" worktree remove "${wtPath}"` : null,
    });
  });

  if (pruneSafe) {
    try {
      execFileSync("git", ["-C", absRepo, "worktree", "prune"], { stdio: "ignore" });
    } catch {}
  }

  console.log(JSON.stringify({ ok: true, readOnly: !pruneSafe, repoRoot: absRepo, baseRef, prunedCount: pruned.length, pruned, worktrees }, null, 2));
}

function cmdCheckPlan(args) {
  const { flags, positional } = parseFlags(args);
  const planPath = positional[0];
  const strictBudget = Boolean(flags["strict-budget"]);
  if (!planPath || !fs.existsSync(planPath)) {
    console.error(`用法：check-plan <plan.md 路径> [--strict-budget]（未找到文件：${planPath || ""}）`);
    process.exit(1);
  }
  const text = fs.readFileSync(planPath, "utf8");
  const checks = [
    { key: "goal_and_out_of_scope", label: "目标与 Out-of-Scope（明确不做）", re: /(out[- ]of[- ]scope|明确不做|不做清单|非目标)/i },
    { key: "data_shape_and_lanes", label: "数据形状 / 契约 / 文件归属", re: /(data\s+shape|数据形状|契约|interfaces?|文件归属|ownership|lanes?)/i },
    { key: "test_seam_and_predicate", label: "Test Seam 与可证伪 Done Predicate", re: /(test\s+seam|done\s+predicate|验收谓词|验收标准|完成判定)/i },
    { key: "throughput_checkpoint", label: "Throughput Checkpoint（并行检查点）", re: /(throughput\s+checkpoint|并行检查点|blocking\s+first\s+steps)/i },
    { key: "vertical_slices", label: "垂直切片清单与 blockedBy 依赖", re: /(vertical\s+slice|垂直切片|blockedBy|Slice\s*1|M1)/i },
  ];

  const missing = [];
  const passed = [];
  for (const c of checks) {
    if (c.re.test(text)) passed.push(c.key);
    else missing.push(c.label);
  }

  // 仅在切片清单区块（或显式 Slice/M/U 切片条目行）检查单切片硬预算，避免误报项目背景总文件数
  const warnings = [];
  const lines = text.split(/\r?\n/);
  let inSliceSection = false;
  const declaredSlices = new Set();
  const sliceDeps = new Map();
  for (const line of lines) {
    if (/^#{1,4}\s+/.test(line)) {
      inSliceSection = /(vertical\s+slice|垂直切片|roadmap|里程碑|切片清单|slices?)/i.test(line);
      const headingSlice = line.match(/\b((?:Slice|M|U|S)\s*\d+)\b/i);
      if (headingSlice) declaredSlices.add(headingSlice[1].replace(/\s+/g, "").toUpperCase());
      continue;
    }
    const isSliceBullet = /^\s*[-*|]\s*(?:\*\*)?(?:Slice|M|U|S)\s*\d+/i.test(line) || /\bblockedBy\b/i.test(line);
    if (!inSliceSection && !isSliceBullet) continue;

    const fm = line.match(/(\d+)\s*(?:个?文件|files)/i);
    if (fm) {
      const num = Number(fm[1]);
      if (num > 5 && num < 50) {
        warnings.push(`切片条目检测到 "${fm[0]}"，请核实单个垂直切片是否超出硬预算（建议 ≤5 文件 / ≤400 LOC）`);
      }
    }
    const lm = line.match(/(\d+)\s*(?:行|LOC|lines)/i);
    if (lm) {
      const num = Number(lm[1]);
      if (num > 400 && num < 50000) {
        warnings.push(`切片条目检测到 "${lm[0]}"，请核实单个垂直切片是否超出硬预算（建议 ≤400 LOC）`);
      }
    }

    // 提取切片 ID 与 blockedBy 依赖，用于环检测与悬空依赖检测
    const idMatch = line.match(/\b((?:Slice|M|U|S)\s*\d+)\b/i);
    if (idMatch) {
      const nodeId = idMatch[1].replace(/\s+/g, "").toUpperCase();
      declaredSlices.add(nodeId);
      const depMatch = line.match(/blockedBy\s*[:=]\s*([^)\n;|]+)/i);
      if (depMatch) {
        const rawDeps = depMatch[1];
        if (!/^\s*(none|无|-)\s*$/i.test(rawDeps)) {
          const deps = (rawDeps.match(/(?:Slice|M|U|S)\s*\d+/gi) || []).map((d) => d.replace(/\s+/g, "").toUpperCase());
          sliceDeps.set(nodeId, deps);
        } else {
          sliceDeps.set(nodeId, []);
        }
      }
    }
  }

  // 悬空依赖检测：blockedBy 引用了切片清单中未声明的 ID
  const dangling = [];
  for (const [node, deps] of sliceDeps.entries()) {
    for (const dep of deps) {
      if (!declaredSlices.has(dep)) {
        dangling.push(`${node} -> ${dep}`);
      }
    }
  }
  if (dangling.length > 0) {
    missing.push(`切片 blockedBy 引用了未定义切片（悬空依赖）: ${dangling.join(", ")}`);
  }

  // DFS 检测 blockedBy 依赖环
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];
  const dfs = (node, trail) => {
    if (visiting.has(node)) {
      cycles.push([...trail, node].join(" -> "));
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dep of sliceDeps.get(node) || []) {
      if (sliceDeps.has(dep)) dfs(dep, [...trail, node]);
    }
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of sliceDeps.keys()) dfs(node, []);
  if (cycles.length > 0) {
    missing.push(`切片 blockedBy 存在循环依赖: ${cycles.join("; ")}`);
  }

  const dedupWarnings = [...new Set(warnings)];
  if (strictBudget && dedupWarnings.length > 0) {
    missing.push(`开启 --strict-budget 时存在超预算切片告警（${dedupWarnings.length} 条）`);
  }

  const ok = missing.length === 0;
  console.log(JSON.stringify({ ok, planPath, strictBudget, passed, missing, warnings: dedupWarnings }, null, 2));
  process.exit(ok ? 0 : 1);
}

const EFFORT_LADDER = ["off", "low", "medium", "high", "xhigh"];

function adjustEffortByBudget(effort, budget) {
  const base = EFFORT_LADDER.includes(effort) ? effort : effort === "max" ? "xhigh" : "medium";
  let idx = EFFORT_LADDER.indexOf(base);
  if (budget === "eco") idx = Math.max(1, idx - 1);
  else if (budget === "max") idx = Math.min(EFFORT_LADDER.length - 1, idx + 1);
  return EFFORT_LADDER[idx];
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
  // invoke_subagent 仅接受 4 枚举：inherit | pro | flash | flash_lite
  if (low === "inherit" || low === "auto" || low.includes("argon") || low.includes("orchestrator")) return "inherit";
  if (low.includes("flash-lite") || low.includes("flash_lite") || tier === "lite") return "flash_lite";
  if (low.includes("hydrogen") || low.includes("flash") || low.includes("haiku") || low.includes("swe-") || tier === "fast") return "flash";
  if (low.includes("neon") || low.includes("pro") || low.includes("opus") || tier === "pro") return "pro";
  return "inherit";
}

function cmdResolveModel(args) {
  const { flags } = parseFlags(args);
  const harness = String(flags.harness || detectActiveHarness()).toLowerCase();
  const surface = String(flags.surface || "invoke_subagent").toLowerCase();
  const role = String(flags.role || "coder.standard").toLowerCase();
  const configPath = typeof flags.config === "string" ? flags.config : DEFAULT_CONFIG;

  if (!fs.existsSync(configPath)) {
    console.log(
      JSON.stringify(
        { ok: false, error: `未找到配置文件：${configPath}，请先执行 /zee-setup 生成配置。`, configPath },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `配置文件 JSON 解析失败：${e.message}`, configPath }, null, 2));
    process.exit(1);
  }

  const getSlot = (r) => {
    const roles = cfg?.roles || {};
    if (r === "scout") return roles.scout;
    if (r === "architect" || r === "architect.primary") return roles.architect?.primary;
    if (r.startsWith("architect.arena.")) {
      const idx = Number(r.split(".")[2]);
      return Array.isArray(roles.architect?.arenaPool) ? roles.architect.arenaPool[idx] || null : null;
    }
    if (r === "judge") return roles.judge || (Array.isArray(roles.reviewers) ? roles.reviewers[0] : null);
    if (r === "ui" || r === "ui.standard") return roles.ui?.standard;
    if (r === "ui.heavy") return roles.ui?.heavy;
    if (r === "coder" || r === "coder.standard") return roles.coder?.standard;
    if (r === "coder.heavy") return roles.coder?.heavy;
    if (r === "verifier") return roles.verifier;
    if (r === "reviewer" || r === "reviewer.0") return Array.isArray(roles.reviewers) ? roles.reviewers[0] : null;
    if (r.startsWith("reviewer.")) {
      const idx = Number(r.split(".")[1]);
      return Array.isArray(roles.reviewers) ? roles.reviewers[idx] || null : null;
    }
    return null;
  };

  const slot = getSlot(role);
  if (!slot) {
    console.log(JSON.stringify({ ok: false, error: `配置中未定义角色槽位 "${role}"`, configPath, role }, null, 2));
    process.exit(1);
  }

  const spec = slot?.prefer || slot;
  const effectiveEffort = adjustEffortByBudget(spec.effort, cfg?.budget || "balanced");

  let resolved;
  if (harness === "agy" || harness === "antigravity") {
    const agyBinding = slot?.bindings?.agy || slot?.bindings?.antigravity || null;
    const hint = agyBinding?.model || spec.modelHint;
    resolved = {
      harness: "antigravity",
      surface,
      role,
      model: normalizeModelForAgy(hint, spec.tier, effectiveEffort, surface),
      effectiveEffort,
      budget: cfg?.budget || "balanced",
      binding: agyBinding,
      fallbackOn429: "inherit",
      sourceSpec: spec,
    };
  } else {
    resolved = {
      harness,
      surface,
      role,
      modelHint: spec.modelHint,
      family: spec.family,
      effort: effectiveEffort,
      budget: cfg?.budget || "balanced",
      binding: slot?.bindings?.[harness] || null,
      backup: slot?.backup || null,
    };
  }

  console.log(JSON.stringify({ ok: true, resolved }, null, 2));
}

function probeAgyHook() {
  const hookScript = path.join(REPO_ROOT, "scripts", "agy-guard.mjs");
  if (!fs.existsSync(hookScript)) {
    return { skipped: true, reason: `未找到 ${hookScript}` };
  }
  const runCase = (payload, extraEnv = {}) => {
    const res = spawnSync(process.execPath, [hookScript], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
      timeout: 5000,
    });
    let parsed = null;
    try {
      parsed = JSON.parse((res.stdout || "").trim());
    } catch {}
    return { status: res.status, parsed };
  };

  const safeRes = runCase({
    hookEventName: "PreToolUse",
    conversationId: "doctor-probe-safe",
    cwd: REPO_ROOT,
    lastUserInput: "hello",
    toolCall: { name: "run_command", args: { CommandLine: "ls -la" } },
  });
  const dangerRes = runCase(
    {
      hookEventName: "PreToolUse",
      conversationId: "doctor-probe-danger",
      cwd: REPO_ROOT,
      lastUserInput: "cleanup",
      toolCall: { name: "run_command", args: { CommandLine: "bash -c 'rm -rf /'" } },
    },
    { NON_INTERACTIVE: "1" },
  );
  const planLockRes = runCase({
    hookEventName: "PreToolUse",
    conversationId: "doctor-probe-plan",
    cwd: REPO_ROOT,
    lastUserInput: "/zee-plan design feature",
    toolCall: { name: "write_file", args: { Path: path.join(REPO_ROOT, "src", "app.ts") } },
  });

  const safePass = safeRes.status === 0 && safeRes.parsed && Object.keys(safeRes.parsed).length === 0;
  const dangerPass = dangerRes.status === 0 && dangerRes.parsed?.decision === "deny";
  const planLockPass = planLockRes.status === 0 && planLockRes.parsed?.decision === "deny";

  return {
    ok: Boolean(safePass && dangerPass && planLockPass),
    safePassthroughIsEmptyObject: safePass,
    nestedSubshellDestructiveDenied: dangerPass,
    planWriteLockDenied: planLockPass,
  };
}

function cmdDoctor(args) {
  const { flags } = parseFlags(args);
  const harness = typeof flags.harness === "string" ? flags.harness : detectActiveHarness();
  const auditAll = Boolean(flags.all);

  const configReport = runValidate(DEFAULT_CONFIG, harness === "pi" || harness === "local" || auditAll);
  const rulesReport = runAuditRules(auditAll ? ["--all"] : ["--harness", harness]);

  // 检测总线目录可写性
  let busWritable = false;
  try {
    fs.mkdirSync(RUNS_ROOT, { recursive: true });
    const probeFile = path.join(RUNS_ROOT, `.doctor-probe-${process.pid}`);
    fs.writeFileSync(probeFile, "ok\n", "utf8");
    fs.unlinkSync(probeFile);
    busWritable = true;
  } catch {
    busWritable = false;
  }

  const hookProbe = harness === "antigravity" || harness === "local" || auditAll ? probeAgyHook() : { skipped: true };

  const highFindings = rulesReport.findings.filter((f) => f.severity === "high");
  const ok =
    configReport.ok &&
    busWritable &&
    highFindings.length === 0 &&
    (hookProbe.skipped || hookProbe.ok);

  console.log(
    JSON.stringify(
      {
        ok,
        activeHarness: harness,
        busWritable,
        runsRoot: RUNS_ROOT,
        config: configReport,
        rules: rulesReport,
        agyHookProbe: hookProbe,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
}

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case "validate":
    cmdValidate(rest);
    break;
  case "symlinks":
    cmdSymlinks(rest.includes("--apply"));
    break;
  case "audit-rules":
    cmdAuditRules(rest);
    break;
  case "init-run":
    cmdInitRun(rest);
    break;
  case "update-state":
    cmdUpdateState(rest);
    break;
  case "list-runs":
    cmdListRuns(rest[0]);
    break;
  case "worktree-create":
    cmdWorktreeCreate(rest);
    break;
  case "cleanup-worktrees":
    cmdCleanupWorktrees(rest);
    break;
  case "log-decision":
    cmdLogDecision(rest);
    break;
  case "check-plan":
    cmdCheckPlan(rest);
    break;
  case "resolve-model":
    cmdResolveModel(rest);
    break;
  case "doctor":
    cmdDoctor(rest);
    break;
  default:
    usage();
    process.exit(cmd ? 1 : 0);
}
