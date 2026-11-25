/**
 * zee 共享零依赖安全与守卫核心（AGY Hook 与 Pi Extension 唯一真源）
 *
 * 职责：
 * 1. 递归子 shell（sh/bash/zsh/dash/ksh -c、eval）与命令链拆分
 * 2. 破坏性命令识别（系统保护路径 rm -rf、主干 git push --force、DB 客户端 DROP DATABASE）
 * 3. 项目级 .agents/zee.project.json denyCommands 递归穿透拦截
 * 4. plan / review / init-design 路径写保护锁与允许目录上的 cp/mkdir/touch/tee/zee-tool.mjs 精准放行
 * 5. 模型底层家族提取与按角色硬最小权限工具裁剪
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const RUNS_ROOT = path.join(os.homedir(), ".local", "state", "zee", "runs");

export const PROTECTED_PATHS = new Set([
  "/",
  "/*",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/var",
  "/lib",
  "/boot",
  "/dev",
  "/home",
  "/root",
  "/System",
  "/Applications",
  "~",
  "$HOME",
  "${HOME}",
]);

const DB_CLIENTS = new Set(["psql", "mysql", "sqlite3", "mariadb", "mongosh", "sqlcmd"]);
const READ_ONLY_PROGS = new Set(["grep", "rg", "egrep", "fgrep", "find", "cat", "bat", "head", "tail", "less", "more", "pytest", "git"]);
const DROP_DB_RE = /\bdrop\s+database\b(?:\s+if\s+exists)?\s+[`"'\[]?\w+[`"'\]]?/i;
const PROTECTED_BRANCHES = new Set(["main", "master"]);

const INIT_DESIGN_ROOT_FILES = new Set([
  "SPEC.md",
  "ARCHITECTURE.md",
  "GLOSSARY.md",
  "DESIGN.md",
  "README.md",
]);

export function normalizeToolPath(rawPath, cwd) {
  let cleaned = String(rawPath || "").trim();
  if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
  if (cleaned === "~") {
    cleaned = os.homedir();
  } else if (cleaned.startsWith("~/") || cleaned.startsWith("~\\")) {
    cleaned = path.join(os.homedir(), cleaned.slice(2));
  } else if (cleaned.startsWith("$HOME/")) {
    cleaned = path.join(os.homedir(), cleaned.slice(6));
  } else if (cleaned.startsWith("${HOME}/")) {
    cleaned = path.join(os.homedir(), cleaned.slice(8));
  }
  return path.resolve(cwd || process.cwd(), cleaned);
}

export function isWithinDir(targetPath, parentDir) {
  if (!parentDir || !targetPath) return false;
  const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 判断写入路径在当前 gateMode 下是否允许。
 * gateMode: "plan" | "review" | "init-design"
 */
export function isWriteAllowedUnderGate(rawPath, cwd, gateMode, extraAllowedDirs = []) {
  if (!rawPath) return false;
  const effectiveCwd = cwd || process.cwd();
  const target = normalizeToolPath(rawPath, effectiveCwd);

  if (isWithinDir(target, RUNS_ROOT)) return true;
  for (const dir of extraAllowedDirs) {
    if (dir && isWithinDir(target, dir)) return true;
  }

  if (gateMode === "plan") {
    if (isWithinDir(target, path.join(effectiveCwd, ".scratch"))) return true;
    if (isWithinDir(target, path.join(effectiveCwd, "docs", "plans"))) return true;
    return false;
  }

  if (gateMode === "init-design") {
    if (isWithinDir(target, path.join(effectiveCwd, ".scratch"))) return true;
    if (isWithinDir(target, path.join(effectiveCwd, "docs", "plans"))) return true;
    if (isWithinDir(target, path.join(effectiveCwd, ".agents"))) return true;
    // 允许在仓库根写入 0→1 冻结设计文档
    if (path.dirname(target) === path.resolve(effectiveCwd) && INIT_DESIGN_ROOT_FILES.has(path.basename(target))) {
      return true;
    }
    return false;
  }

  // review 模式仅放行 RUNS_ROOT 与显式 extraAllowedDirs（如 artifactDirectoryPath）
  return false;
}

/**
 * 轻量 POSIX Shell 分词器（保留引号内完整字面量，不丢转义）
 */
export function tokenizeShell(segment) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        escaping = true;
      } else if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * 按未加引号的 shell 控制操作符（&&, ||, ;, |, &, \n）拆分单层命令片段
 */
export function splitShellSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      current += ch;
      if (ch === "\\") escaping = true;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaping = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    if (ch === "|" || ch === "&") {
      const next = command[i + 1];
      // 保留重定向如 2>&1 或 >&2
      const prev = command[i - 1];
      if (ch === "&" && prev === ">") {
        current += ch;
        continue;
      }
      if (current.trim()) segments.push(current.trim());
      current = "";
      if (next === ch) i += 1;
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/**
 * 递归剥离 sh/bash/zsh/dash/ksh -c 与 eval 嵌套子命令（最大深度 5）
 */
export function getAllNestedCommands(command, maxDepth = 5) {
  const results = [String(command || "")];
  if (maxDepth <= 0 || !command) return results;

  const segments = splitShellSegments(command);
  for (const seg of segments) {
    const tokens = tokenizeShell(seg);
    if (tokens.length === 0) continue;

    for (let i = 0; i < tokens.length; i++) {
      const verb = path.basename(tokens[i]);
      if (["sh", "bash", "zsh", "dash", "ksh"].includes(verb) && i + 2 < tokens.length) {
        const flag = tokens[i + 1];
        if (flag === "-c" || (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(flag) && !flag.startsWith("--"))) {
          results.push(...getAllNestedCommands(tokens[i + 2], maxDepth - 1));
        }
      } else if (verb === "eval" && i + 1 < tokens.length) {
        const inner = tokens.slice(i + 1).join(" ");
        results.push(...getAllNestedCommands(inner, maxDepth - 1));
      }
    }
  }
  return results;
}

function isProtectedTarget(arg) {
  const clean = String(arg || "").trim();
  if (!clean) return false;
  if (PROTECTED_PATHS.has(clean)) return true;
  if (clean.endsWith("/*") && PROTECTED_PATHS.has(clean.slice(0, -2))) return true;
  try {
    const resolved = normalizeToolPath(clean, "/");
    if (resolved === "/") return true;
    const homeResolved = path.resolve(os.homedir());
    if (resolved === homeResolved) return true;
    for (const p of ["/etc", "/usr", "/bin", "/sbin", "/var", "/lib", "/boot", "/dev", "/home", "/root", "/System", "/Applications"]) {
      if (resolved === p) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function stripLeadingEnvAssignments(tokens) {
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) {
    idx += 1;
  }
  if (tokens[idx] === "env") {
    idx += 1;
    while (idx < tokens.length && (tokens[idx].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]))) {
      idx += 1;
    }
  }
  if (tokens[idx] === "sudo") {
    idx += 1;
    while (idx < tokens.length && tokens[idx].startsWith("-")) idx += 1;
  }
  return tokens.slice(idx);
}

function getCurrentGitBranch(cwd) {
  try {
    return execFileSync("git", ["-C", cwd || process.cwd(), "symbolic-ref", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function checkRootDeletion(allCmds) {
  for (const cmd of allCmds) {
    for (const seg of splitShellSegments(cmd)) {
      const tokens = stripLeadingEnvAssignments(tokenizeShell(seg));
      if (tokens.length === 0) continue;
      const verb = path.basename(tokens[0]);
      if (verb !== "rm") continue;

      let hasR = false;
      let hasF = false;
      let hasNoPreserve = false;
      const targets = [];
      let endOfOpts = false;

      for (let i = 1; i < tokens.length; i++) {
        const arg = tokens[i];
        if (arg === "--") {
          endOfOpts = true;
          continue;
        }
        if (!endOfOpts && arg.startsWith("-")) {
          if (arg === "--no-preserve-root") hasNoPreserve = true;
          else if (arg === "--recursive") hasR = true;
          else if (arg === "--force") hasF = true;
          else if (!arg.startsWith("--")) {
            if (/[rR]/.test(arg)) hasR = true;
            if (/f/.test(arg)) hasF = true;
          }
        } else {
          targets.push(arg);
        }
      }

      if (hasNoPreserve) {
        return "检测到 rm --no-preserve-root 极端破坏性删除命令";
      }
      if (hasR && hasF && targets.some((t) => isProtectedTarget(t))) {
        return "检测到针对系统保护目录或家目录的递归强制删除命令 (rm -rf)";
      }
    }
  }
  return null;
}

function checkTrunkForcePush(allCmds, cwd) {
  for (const cmd of allCmds) {
    for (const seg of splitShellSegments(cmd)) {
      const tokens = stripLeadingEnvAssignments(tokenizeShell(seg));
      if (tokens.length < 2 || path.basename(tokens[0]) !== "git") continue;

      // 穿透 git 全局参数 (-C, -c, --git-dir, --work-tree)
      let subIdx = 1;
      let gitCwd = cwd || process.cwd();
      while (subIdx < tokens.length && tokens[subIdx].startsWith("-")) {
        const opt = tokens[subIdx];
        if (opt === "-C" && subIdx + 1 < tokens.length) {
          gitCwd = path.resolve(gitCwd, tokens[subIdx + 1]);
          subIdx += 2;
        } else if (["-c", "--git-dir", "--work-tree", "--namespace"].includes(opt) && subIdx + 1 < tokens.length) {
          subIdx += 2;
        } else {
          subIdx += 1;
        }
      }
      if (tokens[subIdx] !== "push") continue;

      const pushArgs = tokens.slice(subIdx + 1);
      let isForce = false;
      const positionals = [];
      for (const a of pushArgs) {
        if (
          a === "-f" ||
          a === "--force" ||
          a === "--force-with-lease" ||
          a.startsWith("--force-with-lease=") ||
          (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) && !a.startsWith("--"))
        ) {
          isForce = true;
        } else if (!a.startsWith("-")) {
          positionals.push(a);
        }
      }

      // 检查 +refspec 语法（即便没写 -f 也属于强推）
      const refspecs = positionals.slice(1);
      for (const spec of refspecs) {
        if (spec.startsWith("+")) isForce = true;
      }
      if (!isForce) continue;

      // 明确推送到 main/master
      for (const spec of refspecs) {
        const cleaned = spec.replace(/^\+/, "");
        const dst = cleaned.includes(":") ? cleaned.split(":").pop() : cleaned;
        const branchName = String(dst || "").replace(/^refs\/heads\//, "");
        if (PROTECTED_BRANCHES.has(branchName)) {
          return `检测到向受保护主干分支 "${branchName}" 执行强制推送 (git push --force)`;
        }
      }

      // 无 refspec 强推：检查当前分支是否为主干
      if (refspecs.length === 0) {
        const curBranch = getCurrentGitBranch(gitCwd);
        if (PROTECTED_BRANCHES.has(curBranch)) {
          return `当前处于受保护主干分支 "${curBranch}"，检测到无目标强推 (git push --force)`;
        }
      }
    }
  }
  return null;
}

function checkDropDatabase(allCmds) {
  for (const cmd of allCmds) {
    if (!DROP_DB_RE.test(cmd)) continue;
    const segments = splitShellSegments(cmd);
    let hasDbClient = false;
    let onlyReadOnly = true;

    for (const seg of segments) {
      const tokens = stripLeadingEnvAssignments(tokenizeShell(seg));
      if (tokens.length === 0) continue;
      const verb = path.basename(tokens[0]);
      if (DB_CLIENTS.has(verb)) {
        hasDbClient = true;
        onlyReadOnly = false;
      } else if (!READ_ONLY_PROGS.has(verb)) {
        onlyReadOnly = false;
      }
    }
    if (hasDbClient && !onlyReadOnly) {
      return "检测到通过数据库客户端执行 DROP DATABASE 破坏性删库命令";
    }
  }
  return null;
}

/**
 * 评估通用破坏性命令（无论是否处于 plan/review 锁均检测）
 * 返回 { level: "destructive", reason } 或 null
 */
export function evaluateDestructiveCommand(command, cwd) {
  const trimmed = String(command || "").trim();
  if (!trimmed) return null;
  const allCmds = getAllNestedCommands(trimmed, 5);

  const rootDel = checkRootDeletion(allCmds);
  if (rootDel) return { level: "destructive", reason: rootDel };

  const forcePush = checkTrunkForcePush(allCmds, cwd);
  if (forcePush) return { level: "destructive", reason: forcePush };

  const dropDb = checkDropDatabase(allCmds);
  if (dropDb) return { level: "destructive", reason: dropDb };

  return null;
}

/**
 * 检查项目级 .agents/zee.project.json 中的 denyCommands（穿透嵌套子 shell）
 */
export function checkProjectDenyCommands(command, cwd) {
  if (!command || !cwd) return null;
  const projFile = path.join(cwd, ".agents", "zee.project.json");
  if (!fs.existsSync(projFile)) return null;
  let denies = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(projFile, "utf8"));
    denies = Array.isArray(cfg.denyCommands) ? cfg.denyCommands : [];
  } catch {
    return null;
  }
  if (denies.length === 0) return null;

  const allCmds = getAllNestedCommands(command, 5);
  for (const entry of denies) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    if (allCmds.some((c) => c.includes(entry))) {
      return `命中项目安全红线（.agents/zee.project.json denyCommands: "${entry}"），已硬拦截该命令。`;
    }
  }
  return null;
}

function isSafeZeeToolInvocation(tokens) {
  if (tokens.length < 2) return false;
  const prog = path.basename(tokens[0]);
  if (prog !== "node") return false;
  const scriptArg = tokens[1] || "";
  if (path.basename(scriptArg) !== "zee-tool.mjs") return false;
  const sub = tokens[2] || "";
  return new Set([
    "validate",
    "audit-rules",
    "init-run",
    "update-state",
    "list-runs",
    "log-decision",
    "cleanup-worktrees",
    "check-plan",
    "resolve-model",
    "doctor",
  ]).has(sub);
}

function checkAllowlistedFileOp(verb, tokens, cwd, gateMode, extraAllowedDirs) {
  // 去掉选项参数提取位置参数
  const args = [];
  let endOfOpts = false;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--") {
      endOfOpts = true;
      continue;
    }
    if (!endOfOpts && tok.startsWith("-")) continue;
    args.push(tok);
  }
  if (args.length === 0) return false;

  if (verb === "mkdir" || verb === "touch" || verb === "tee") {
    return args.every((t) => isWriteAllowedUnderGate(t, cwd, gateMode, extraAllowedDirs));
  }
  if (verb === "cp") {
    if (args.length < 2) return false;
    const dst = args[args.length - 1];
    return isWriteAllowedUnderGate(dst, cwd, gateMode, extraAllowedDirs);
  }
  return false;
}

const GATE_LABELS = {
  plan: "规划保护",
  review: "只读审查",
  "init-design": "0→1 设计冻结保护",
};

const ALWAYS_BLOCKED_IN_GATE = [
  {
    pattern:
      /\bgit\s+(?:-[Cc]\s+\S+\s+)*(add|commit|push|merge|rebase|cherry-pick|reset|checkout|switch|restore|clean|am|apply|stash\s+(push|pop|drop|apply)|branch\s+-[dDmM])\b/,
    label: "修改 Git 工作区或提交历史的命令",
  },
  {
    pattern: /\bsed\s+-[^\s]*i|\bperl\s+-[^\s]*i/,
    label: "原地修改文件命令 (sed -i / perl -i)",
  },
  {
    pattern: /\b(npm|pnpm|yarn|bun)\s+(install|i|add|remove|rm|uninstall|update|up|ci|publish)\b/,
    label: "包管理变更命令",
  },
  {
    pattern: /\b(pip|pip3|uv|poetry|cargo|brew)\s+(install|add|remove|uninstall|upgrade)\b|\bgo\s+(get|mod\s+tidy)\b/,
    label: "依赖安装或修改命令",
  },
];

const MUTATING_FILE_VERBS = new Set(["rm", "mv", "chmod", "chown", "truncate", "dd", "mkfs", "patch"]);
const ALLOWLISTABLE_FILE_VERBS = new Set(["mkdir", "cp", "touch", "tee"]);

/**
 * 在 plan / review / init-design 保护锁下校验 Shell 命令：
 * - 递归拆解 sh/bash/zsh -c 与 eval
 * - 精准放行 zee-tool.mjs 与目标位于允许目录的 mkdir/cp/touch/tee
 * - 拦截其他任何修改业务代码、Git 状态、依赖或非白名单重定向的命令
 */
export function checkBashUnderGate(command, cwd, gateMode, extraAllowedDirs = []) {
  const trimmed = String(command || "").trim();
  if (!trimmed) return null;

  const effectiveCwd = cwd || process.cwd();
  const modeLabel = GATE_LABELS[gateMode] || gateMode;
  const allCmds = getAllNestedCommands(trimmed, 5);

  for (const cmd of allCmds) {
    for (const seg of splitShellSegments(cmd)) {
      const tokens = stripLeadingEnvAssignments(tokenizeShell(seg));
      if (tokens.length === 0) continue;

      // 放行合法 zee-tool.mjs 总线/校验命令（仅限不含非法重定向）
      const verb = path.basename(tokens[0]);

      // 检测输出重定向（放行 /dev/null、>&2、以及写入允许目录）
      const redirectRegex = /(?:^|[^0-9&>])>>?\s*(?!&\d)(\S+)/g;
      for (const match of seg.matchAll(redirectRegex)) {
        const rawTarget = match[1].replace(/^['"]|['"]$/g, "");
        if (rawTarget === "/dev/null") continue;
        if (!isWriteAllowedUnderGate(rawTarget, effectiveCwd, gateMode, extraAllowedDirs)) {
          return `当前处于 zee ${modeLabel}模式，已拦截向 "${rawTarget}" 的 Shell 重定向写入。`;
        }
      }

      if (isSafeZeeToolInvocation(tokens)) continue;

      if (ALLOWLISTABLE_FILE_VERBS.has(verb)) {
        if (!checkAllowlistedFileOp(verb, tokens, effectiveCwd, gateMode, extraAllowedDirs)) {
          return `当前处于 zee ${modeLabel}模式，已拦截目标不在允许目录内的 ${verb} 命令。`;
        }
        continue;
      }

      if (MUTATING_FILE_VERBS.has(verb)) {
        return `当前处于 zee ${modeLabel}模式，已拦截文件增删改命令 (${verb})。`;
      }

      for (const { pattern, label } of ALWAYS_BLOCKED_IN_GATE) {
        if (pattern.test(seg)) {
          return `当前处于 zee ${modeLabel}模式，已拦截${label}。`;
        }
      }
    }
  }

  return null;
}

/**
 * 统一提取模型底层家族（绝不将代理网关名如 pi/vm/devin 当家族）
 */
export function extractModelFamily(modelId) {
  if (!modelId || typeof modelId !== "string") return "";
  const tail = modelId.trim().toLowerCase().split("/").pop() || "";
  if (/(claude|fable|sonnet|opus|haiku)/.test(tail)) return "claude";
  if (/(^|[-_])(gpt|o1|o3|o4|codex)/.test(tail)) return "openai";
  if (/gemini/.test(tail)) return "gemini";
  if (/swe-/.test(tail)) return "devin";
  if (/deepseek/.test(tail)) return "deepseek";
  if (/grok/.test(tail)) return "grok";
  if (/qwen/.test(tail)) return "qwen";
  if (/llama/.test(tail)) return "meta";
  return tail.split(/[-_.]/)[0] || "";
}

/**
 * Pi 子代理按角色硬收敛最小权限工具集（无论主控 LLM 传入什么 tools，均在代码层兜底裁剪）
 */
export function enforcePiRoleTools(role, requestedTools) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const base = Array.isArray(requestedTools) && requestedTools.length > 0 ? [...requestedTools] : null;

  if (normalizedRole === "judge") {
    const allowed = new Set(["read", "grep", "find", "ls"]);
    return base ? base.filter((t) => allowed.has(t)) : ["read", "grep", "find", "ls"];
  }
  if (normalizedRole === "scout") {
    // 侦察兵硬剥离 edit/write；保留只读 bash（便于 git log、检查工具链版本）
    const forbidden = new Set(["edit", "write"]);
    return base ? base.filter((t) => !forbidden.has(t)) : ["read", "grep", "find", "ls", "bash"];
  }
  if (normalizedRole === "architect") {
    // 架构师硬剥离 edit 与 bash；默认纯只读输出 plan.md 由主控落盘（若显式给 write 仍保留但事后有脏区审计）
    const forbidden = new Set(["edit", "bash"]);
    return base ? base.filter((t) => !forbidden.has(t)) : ["read", "grep", "find", "ls"];
  }
  if (normalizedRole === "verifier" || normalizedRole === "reviewer") {
    // 门禁官与审查员硬剥离 edit，绝不允许原地编辑业务代码
    const forbidden = new Set(["edit"]);
    return base ? base.filter((t) => !forbidden.has(t)) : ["read", "grep", "find", "ls", "bash", "write"];
  }
  return base;
}
