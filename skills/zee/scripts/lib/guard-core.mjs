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
  "GLOSSARY-MAP.md",
  "DESIGN.md",
  "README.md",
]);

const PLAN_DOMAIN_ROOT_FILES = new Set([
  "GLOSSARY.md",
  "GLOSSARY-MAP.md",
]);

const READ_ONLY_SEARCH_PROGS = new Set(["grep", "rg", "egrep", "fgrep"]);
const INLINE_INTERPRETERS = new Set(["python", "python3", "node", "ruby", "perl"]);

export function isAllowedZeeTmpPath(targetPath, repoCwd = "") {
  if (!targetPath) return false;
  const resolved = path.resolve(targetPath);
  // 若目标就在当前被守卫仓库目录内（例如仓库本身建在 /tmp 或 os.tmpdir() 下），绝不借临时目录规则绕过写锁！
  if (repoCwd && isWithinDir(resolved, repoCwd)) return false;
  const tmpRoots = new Set(["/tmp", "/private/tmp", path.resolve(os.tmpdir())]);
  for (const root of tmpRoots) {
    const rel = path.relative(root, resolved);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const firstSeg = rel.split(path.sep)[0];
    if (firstSeg && /^zee-(?:probe|mut|rev|review|retro|doc|note|tmp|sandbox|verify|bench|proto)(?:[-_]|$)/.test(firstSeg)) {
      return true;
    }
  }
  return false;
}

/**
 * 判断只读/门禁子代理（verifier/reviewer/scout/architect）的写入目标是否落在允许的总线或隔离临时目录
 */
export function isReadOnlyRoleWriteAllowed(rawPath, cwd, extraAllowedDirs = []) {
  if (!rawPath) return false;
  const effectiveCwd = cwd || process.cwd();
  const target = normalizeToolPath(rawPath, effectiveCwd);
  if (isWithinDir(target, RUNS_ROOT)) return true;
  if (isAllowedZeeTmpPath(target, effectiveCwd)) return true;
  for (const dir of extraAllowedDirs) {
    if (dir && isWithinDir(target, dir)) return true;
  }
  return false;
}

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
  if (isAllowedZeeTmpPath(target, effectiveCwd)) return true;
  for (const dir of extraAllowedDirs) {
    if (dir && isWithinDir(target, dir)) return true;
  }

  const repoRoot = path.resolve(effectiveCwd);
  const docsDir = path.join(repoRoot, "docs");

  if (gateMode === "plan") {
    if (isWithinDir(target, path.join(repoRoot, ".scratch"))) return true;
    if (isWithinDir(target, path.join(docsDir, "plans"))) return true;
    if (isWithinDir(target, path.join(docsDir, "adr"))) return true;
    if ((path.dirname(target) === repoRoot || path.dirname(target) === docsDir) && PLAN_DOMAIN_ROOT_FILES.has(path.basename(target))) {
      return true;
    }
    return false;
  }

  if (gateMode === "init-design") {
    if (isWithinDir(target, path.join(repoRoot, ".scratch"))) return true;
    if (isWithinDir(target, path.join(docsDir, "plans"))) return true;
    if (isWithinDir(target, path.join(docsDir, "adr"))) return true;
    if (isWithinDir(target, path.join(repoRoot, ".agents"))) return true;
    // 允许在仓库根或 docs/ 目录写入 0→1 冻结设计文档
    if ((path.dirname(target) === repoRoot || path.dirname(target) === docsDir) && INIT_DESIGN_ROOT_FILES.has(path.basename(target))) {
      return true;
    }
    return false;
  }

  // review 模式仅放行 RUNS_ROOT、/tmp/zee-* 沙盒与显式 extraAllowedDirs（如 artifactDirectoryPath）
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
 * 递归剥离 sh/bash/zsh/dash/ksh（含前置选项如 -e / --norc / -o pipefail） -c 与 eval 嵌套子命令（最大深度 5）
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
        let j = i + 1;
        while (j < tokens.length) {
          const opt = tokens[j];
          if (opt === "--") break;
          if (opt === "-c" || (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(opt) && !opt.startsWith("--"))) {
            if (j + 1 < tokens.length) {
              results.push(...getAllNestedCommands(tokens[j + 1], maxDepth - 1));
            }
            break;
          }
          if ((opt === "-o" || opt === "+o") && j + 1 < tokens.length) {
            j += 2;
            continue;
          }
          if (opt.startsWith("-") || opt.startsWith("+")) {
            j += 1;
            continue;
          }
          break;
        }
      } else if (verb === "eval" && i + 1 < tokens.length) {
        const inner = tokens.slice(i + 1).join(" ");
        results.push(...getAllNestedCommands(inner, maxDepth - 1));
      }
    }
  }
  return results;
}

function isProtectedTarget(arg, cwd) {
  const clean = String(arg || "").trim();
  if (!clean) return false;
  if (PROTECTED_PATHS.has(clean)) return true;
  if (clean.endsWith("/*") && PROTECTED_PATHS.has(clean.slice(0, -2))) return true;
  const candidate = clean.endsWith("/*") ? clean.slice(0, -2) || "/" : clean;
  try {
    // 关键修复：相对路径按真实 cwd 解析，防止 rm -rf lib/bin/var/dev 被误判为删 /lib 等系统目录
    const resolved = normalizeToolPath(candidate, cwd || process.cwd());
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
  if (tokens[idx] === "export" || tokens[idx] === "local" || tokens[idx] === "readonly") {
    let j = idx + 1;
    while (j < tokens.length && (tokens[j].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[j]) || /^[A-Za-z_][A-Za-z0-9_]*$/.test(tokens[j]))) {
      j += 1;
    }
    if (j >= tokens.length) return [];
  }
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

function checkRootDeletion(allCmds, cwd) {
  const effectiveCwd = cwd || process.cwd();
  for (const cmd of allCmds) {
    let virtualCwd = effectiveCwd;
    for (const seg of splitShellSegments(cmd)) {
      const tokens = stripLeadingEnvAssignments(tokenizeShell(seg));
      if (tokens.length === 0) continue;
      const verb = path.basename(tokens[0]);
      if (verb === "cd") {
        const dirArg = tokens[1] && !tokens[1].startsWith("-") ? tokens[1] : os.homedir();
        if (dirArg !== "-") virtualCwd = normalizeToolPath(dirArg, virtualCwd);
        continue;
      }
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
      if (hasR && hasF && targets.some((t) => isProtectedTarget(t, virtualCwd))) {
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
 * 先剥离 Heredoc 正文防止文档/代码正文误报，再递归拆解嵌套子 shell
 * 返回 { level: "destructive", reason } 或 null
 */
export function evaluateDestructiveCommand(command, cwd) {
  const trimmed = String(command || "").trim();
  if (!trimmed) return null;
  const cleaned = stripHeredocBodies(trimmed);
  const allCmds = getAllNestedCommands(cleaned, 5);

  const rootDel = checkRootDeletion(allCmds, cwd);
  if (rootDel) return { level: "destructive", reason: rootDel };

  const forcePush = checkTrunkForcePush(allCmds, cwd);
  if (forcePush) return { level: "destructive", reason: forcePush };

  const dropDb = checkDropDatabase(allCmds);
  if (dropDb) return { level: "destructive", reason: dropDb };

  return null;
}

function getExecutableDenyCandidate(seg) {
  const tokens = stripLeadingEnvAssignments(tokenizeShell(seg));
  if (tokens.length === 0) return "";
  const verb = path.basename(tokens[0]);

  // 放行纯文本搜索命令（避免 rg "--live" src/ 误拦）
  if (READ_ONLY_SEARCH_PROGS.has(verb)) return "";
  // 放行 zee-tool.mjs 日志/状态更新（避免 log-decision --why "block --live" 误拦）
  if (isSafeZeeToolInvocation(tokens)) return "";

  if (verb === "git") {
    let subIdx = 1;
    while (subIdx < tokens.length && tokens[subIdx].startsWith("-")) {
      const opt = tokens[subIdx];
      if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(opt) && subIdx + 1 < tokens.length) {
        subIdx += 2;
      } else {
        subIdx += 1;
      }
    }
    const sub = tokens[subIdx] || "";
    if (["log", "show", "diff", "grep", "status", "rev-parse", "merge-base"].includes(sub)) {
      return "";
    }
    if (sub === "commit") {
      // 剥离 commit message 文本，仅检查其余参数
      const kept = [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if ((t === "-m" || t === "--message") && i + 1 < tokens.length) {
          i += 1;
          continue;
        }
        if (t.startsWith("--message=") || t.startsWith("-m")) continue;
        kept.push(t);
      }
      return kept.join(" ");
    }
  }

  return seg;
}

/**
 * 检查项目级 .agents/zee.project.json 中的 denyCommands（先剥 Heredoc、穿透嵌套子 shell、排除只读搜索与 commit 消息）
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

  const cleaned = stripHeredocBodies(String(command || ""));
  const allCmds = getAllNestedCommands(cleaned, 5);
  const checkableSegments = [];
  for (const c of allCmds) {
    for (const seg of splitShellSegments(c)) {
      const cand = getExecutableDenyCandidate(seg);
      if (cand) checkableSegments.push(cand);
    }
  }

  for (const entry of denies) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    if (checkableSegments.some((s) => s.includes(entry))) {
      return `命中项目安全红线（.agents/zee.project.json denyCommands: "${entry}"），已硬拦截该命令。`;
    }
  }
  return null;
}

/**
 * 剥离 Shell 命令中的 Heredoc 正文（保留命令行头，防止 Python/Markdown 正文触发误拦）
 */
export function stripHeredocBodies(command) {
  const lines = String(command || "").split(/\r?\n/);
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    out.push(line);

    // 仅在未加引号区域内查找 << 或 <<- 引导的 heredoc 分隔符
    let quote = null;
    let escaping = false;
    const delims = [];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (escaping) {
        escaping = false;
        continue;
      }
      if (quote === "'") {
        if (ch === "'") quote = null;
        continue;
      }
      if (quote === '"') {
        if (ch === "\\") escaping = true;
        else if (ch === '"') quote = null;
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
      if (ch === "<" && line[j + 1] === "<" && line[j + 2] !== "<") {
        let k = j + 2;
        const stripTabs = line[k] === "-";
        if (stripTabs) k += 1;
        while (k < line.length && (line[k] === " " || line[k] === "\t")) k += 1;
        const rest = line.slice(k);
        const m = rest.match(/^(?:'([^']+)'|"([^"]+)"|\\([A-Za-z0-9_.-]+)|([A-Za-z0-9_.-]+))/);
        if (m) {
          const delim = m[1] || m[2] || m[3] || m[4];
          delims.push({ delim, stripTabs });
          j = k + m[0].length - 1;
        }
      }
    }

    i += 1;
    for (const { delim, stripTabs } of delims) {
      while (i < lines.length) {
        const candidate = stripTabs ? lines[i].replace(/^\t+/, "") : lines[i];
        i += 1;
        if (candidate === delim) break;
      }
    }
  }

  return out.join("\n");
}

/**
 * 词法提取单段命令中的未加引号输出重定向目标（忽略引号内 > / 2>&1 / <<）
 */
function extractOutputRedirects(seg) {
  const targets = [];
  let quote = null;
  let escaping = false;

  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") escaping = true;
      else if (ch === '"') quote = null;
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
    if (ch === ">") {
      // 跳过 >&2 / &> 中的 &<fd>
      let k = i + 1;
      if (seg[k] === ">") k += 1;
      if (seg[k] === "&") {
        // 如 >&2 或 >&- 则非文件重定向；若 &后跟非数字（极少）忽略
        if (seg[k + 1] && /[0-9-]/.test(seg[k + 1])) {
          i = k + 1;
          continue;
        }
      }
      while (k < seg.length && /\s/.test(seg[k])) k += 1;
      if (k >= seg.length) break;

      // 读取紧随其后的单个路径 token（支持带引号）
      let target = "";
      let tq = null;
      let tEsc = false;
      while (k < seg.length) {
        const c = seg[k];
        if (tEsc) {
          target += c;
          tEsc = false;
          k += 1;
          continue;
        }
        if (tq === "'") {
          if (c === "'") tq = null;
          else target += c;
          k += 1;
          continue;
        }
        if (tq === '"') {
          if (c === "\\") tEsc = true;
          else if (c === '"') tq = null;
          else target += c;
          k += 1;
          continue;
        }
        if (c === "\\") {
          tEsc = true;
          k += 1;
          continue;
        }
        if (c === "'" || c === '"') {
          tq = c;
          k += 1;
          continue;
        }
        if (/[\s;|&<>]/.test(c)) break;
        target += c;
        k += 1;
      }
      if (target) targets.push(target);
      i = k - 1;
    }
  }
  return targets;
}

function expandStaticVars(str, staticVars) {
  if (!str || typeof str !== "string") return "";
  return str.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (full, braced, bare) => {
    const key = braced || bare;
    if (key === "HOME") return os.homedir();
    if (staticVars.has(key)) return staticVars.get(key);
    return full;
  });
}

function recordLeadingStaticVars(rawTokens, staticVars) {
  let idx = 0;
  if (rawTokens[0] === "export" || rawTokens[0] === "local" || rawTokens[0] === "readonly") {
    idx = 1;
    while (idx < rawTokens.length && rawTokens[idx].startsWith("-")) idx += 1;
  }
  while (idx < rawTokens.length) {
    const m = rawTokens[idx].match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) break;
    const [, name, val] = m;
    // 仅记录不含命令替换的纯字面量赋值
    if (!val.includes("$(") && !val.includes("`")) {
      const expanded = expandStaticVars(val, staticVars);
      if (!/\$[A-Za-z_{]/.test(expanded)) {
        staticVars.set(name, expanded);
      }
    }
    idx += 1;
  }
}

function isSafeZeeToolInvocation(tokens) {
  if (tokens.length < 3) return false;
  const prog = path.basename(tokens[0]);
  if (prog !== "node") return false;
  const scriptArg = tokens[1] || "";
  if (path.basename(scriptArg) !== "zee-tool.mjs") return false;
  const sub = tokens[2] || "";
  if (sub === "cleanup-worktrees") {
    // 锁态仅允许只读审计，禁止 --prune-safe 删除工作树
    return !tokens.includes("--prune-safe");
  }
  return new Set([
    "validate",
    "audit-rules",
    "init-run",
    "update-state",
    "list-runs",
    "log-decision",
    "check-plan",
    "resolve-model",
    "doctor",
  ]).has(sub);
}

function checkAllowlistedFileOp(verb, tokens, repoCwd, virtualCwd, gateMode, extraAllowedDirs) {
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

  const isAllowed = (rawTarget) => {
    if (isProtectedTarget(rawTarget, virtualCwd)) return false;
    const resolved = normalizeToolPath(rawTarget, virtualCwd);
    return isWriteAllowedUnderGate(resolved, repoCwd, gateMode, extraAllowedDirs);
  };

  if (verb === "mkdir" || verb === "touch" || verb === "tee" || verb === "rm") {
    return args.every(isAllowed);
  }
  if (verb === "cp") {
    if (args.length < 2) return false;
    const dst = args[args.length - 1];
    return isAllowed(dst);
  }
  if (verb === "mv") {
    if (args.length < 2) return false;
    return args.every(isAllowed);
  }
  return false;
}

const GATE_LABELS = {
  plan: "规划保护",
  review: "只读审查",
  "init-design": "0→1 设计冻结保护",
};

const BLOCKED_GIT_SUBCMDS = new Set([
  "add",
  "commit",
  "push",
  "merge",
  "rebase",
  "cherry-pick",
  "reset",
  "checkout",
  "switch",
  "restore",
  "clean",
  "am",
  "apply",
]);

const BLOCKED_JS_PKG_VERBS = new Set(["npm", "pnpm", "yarn", "bun"]);
const BLOCKED_JS_PKG_SUBCMDS = new Set([
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "uninstall",
  "update",
  "up",
  "ci",
  "publish",
]);

const BLOCKED_OTHER_PKG_VERBS = new Set(["pip", "pip3", "uv", "poetry", "cargo", "brew"]);
const BLOCKED_OTHER_PKG_SUBCMDS = new Set(["install", "add", "remove", "uninstall", "upgrade"]);

const MUTATING_FILE_VERBS = new Set(["chmod", "chown", "truncate", "dd", "mkfs", "patch"]);
const ALLOWLISTABLE_FILE_VERBS = new Set(["mkdir", "cp", "touch", "tee", "rm", "mv"]);

const INTERPRETER_WRITE_PATTERNS = {
  python: [
    /\bopen\s*\([^)]*['"][wax+]/i,
    /\.(write_text|write_bytes)\s*\(/,
    /\bshutil\.(copy|copy2|copytree|move|rmtree)\s*\(/,
    /\bos\.(remove|unlink|rename|replace|makedirs|mkdir)\s*\(/,
  ],
  node: [
    /\b(writeFileSync|writeFile|appendFileSync|appendFile|rmSync|unlinkSync|renameSync|mkdirSync|cpSync|createWriteStream)\b/,
  ],
  ruby: [/\bFile\.(write|delete|unlink|rename|open\s*\([^)]*['"][wa+])/],
  perl: [/\bopen\s*\([^)]*['"]>/, /\bunlink\b/],
};

function extractHeredocBodyText(command) {
  const lines = String(command || "").split(/\r?\n/);
  const bodies = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\([A-Za-z0-9_.-]+)|([A-Za-z0-9_.-]+))/);
    i += 1;
    if (!m) continue;
    const stripTabs = m[1] === "-";
    const delim = m[2] || m[3] || m[4] || m[5];
    while (i < lines.length) {
      const candidate = stripTabs ? lines[i].replace(/^\t+/, "") : lines[i];
      if (candidate === delim) {
        i += 1;
        break;
      }
      bodies.push(lines[i]);
      i += 1;
    }
  }
  return bodies.join("\n");
}

function checkInterpreterInlineWrite(verb, tokens, rawCommand) {
  if (!INLINE_INTERPRETERS.has(verb)) return null;
  const family = verb.startsWith("python") ? "python" : verb;
  const patterns = INTERPRETER_WRITE_PATTERNS[family] || [];
  if (patterns.length === 0) return null;

  const snippets = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t === "-c" || t === "-e" || t === "--eval") && i + 1 < tokens.length) {
      snippets.push(tokens[i + 1]);
      i += 1;
    }
  }
  if (/<<-?\s*/.test(rawCommand)) {
    const body = extractHeredocBodyText(rawCommand);
    if (body) snippets.push(body);
  }

  for (const code of snippets) {
    if (patterns.some((re) => re.test(code))) {
      return `解释器内联文件写入命令 (${verb})`;
    }
  }
  return null;
}

/**
 * 基于词法 token 精确识别变更类命令（彻底消除 git merge-base 与引号内参数误拦）
 */
function checkBlockedMutatingVerb(verb, tokens) {
  if (verb === "node" && tokens.length >= 3 && path.basename(tokens[1] || "") === "zee-tool.mjs") {
    const sub = tokens[2] || "";
    if (sub === "cleanup-worktrees" && tokens.includes("--prune-safe")) {
      return "删除 Git worktree 的 zee-tool 变更命令 (cleanup-worktrees --prune-safe)";
    }
    if (sub === "worktree-create" || (sub === "symlinks" && tokens.includes("--apply"))) {
      return `修改工作树或软链的 zee-tool 变更命令 (${sub})`;
    }
  }

  if (verb === "git") {
    let subIdx = 1;
    while (subIdx < tokens.length && tokens[subIdx].startsWith("-")) {
      const opt = tokens[subIdx];
      if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(opt) && subIdx + 1 < tokens.length) {
        subIdx += 2;
      } else {
        subIdx += 1;
      }
    }
    const sub = tokens[subIdx] || "";
    if (BLOCKED_GIT_SUBCMDS.has(sub)) {
      return "修改 Git 工作区或提交历史的命令";
    }
    if (sub === "stash") {
      const next = tokens[subIdx + 1] || "push";
      if (["push", "pop", "drop", "apply", "clear", "save"].includes(next)) {
        return "修改 Git 工作区或提交历史的命令";
      }
    }
    if (sub === "branch") {
      const rest = tokens.slice(subIdx + 1);
      if (
        rest.some(
          (a) =>
            a === "--delete" ||
            a === "--move" ||
            a === "--copy" ||
            a === "-f" ||
            a === "--force" ||
            (/^-[a-zA-Z]*[dDmMcCf]/.test(a) && !a.startsWith("--")),
        )
      ) {
        return "修改 Git 工作区或提交历史的命令";
      }
      // 检测创建新分支（无 --list/-l/--contains 等查询标志却带位置参数）
      const isListQuery = rest.some((a) => a === "-l" || a === "--list" || a === "--contains" || a === "--no-contains" || a === "--merged" || a === "--no-merged" || a === "--points-at" || a === "--show-current");
      if (!isListQuery) {
        const positionals = [];
        const branchValOpts = new Set(["--format", "--sort", "--color", "--column", "--abbrev"]);
        for (let i = 0; i < rest.length; i++) {
          const a = rest[i];
          if (a === "--") break;
          if (branchValOpts.has(a) && i + 1 < rest.length) {
            i += 1;
            continue;
          }
          if (!a.startsWith("-")) positionals.push(a);
        }
        if (positionals.length > 0) {
          return "创建 Git 分支的变更命令 (git branch)";
        }
      }
    }
    if (sub === "tag") {
      const rest = tokens.slice(subIdx + 1);
      const isListOrVerify = rest.length === 0 || rest.some((a) => a === "-l" || a === "--list" || a === "-v" || a === "--verify");
      const isMutating = rest.some((a) => a === "-d" || a === "--delete" || a === "-a" || a === "--annotate" || a === "-s" || a === "--sign" || a === "-f" || a === "--force");
      if (isMutating || !isListOrVerify) {
        return "修改 Git 标签的变更命令 (git tag)";
      }
    }
    return null;
  }

  if (verb === "sed" || verb === "perl") {
    for (let i = 1; i < tokens.length; i++) {
      const arg = tokens[i];
      if (arg === "--") break;
      if (arg === "--in-place" || arg.startsWith("--in-place=") || arg === "-i" || /^-[a-zA-Z]*i/.test(arg)) {
        return "原地修改文件命令 (sed -i / perl -i)";
      }
    }
    return null;
  }

  if (BLOCKED_JS_PKG_VERBS.has(verb)) {
    const valueOpts = new Set(["-F", "--filter", "--prefix", "-C", "--cwd", "--dir", "--workspace", "-w", "--config"]);
    let idx = 1;
    while (idx < tokens.length && tokens[idx].startsWith("-")) {
      const opt = tokens[idx];
      idx += valueOpts.has(opt) && idx + 1 < tokens.length ? 2 : 1;
    }
    const sub = tokens[idx] || "";
    if (BLOCKED_JS_PKG_SUBCMDS.has(sub)) {
      return "包管理变更命令";
    }
    return null;
  }

  if (BLOCKED_OTHER_PKG_VERBS.has(verb)) {
    const valueOpts = new Set(["-C", "--directory", "--project", "--manifest-path"]);
    let idx = 1;
    while (idx < tokens.length && tokens[idx].startsWith("-")) {
      const opt = tokens[idx];
      idx += valueOpts.has(opt) && idx + 1 < tokens.length ? 2 : 1;
    }
    const sub = tokens[idx] || "";
    if (BLOCKED_OTHER_PKG_SUBCMDS.has(sub)) {
      return "依赖安装或修改命令";
    }
    return null;
  }

  if (verb === "go") {
    const sub = tokens[1] || "";
    if (sub === "get" || (sub === "mod" && tokens[2] === "tidy")) {
      return "依赖安装或修改命令";
    }
  }

  return null;
}

/**
 * 在 plan / review / init-design 保护锁下校验 Shell 命令：
 * - 先剥离 Heredoc 正文，再递归拆解 sh/bash/zsh -c 与 eval
 * - 追踪同命令静态变量赋值（$B/$Z）与 cd 虚拟目录切换
 * - 词法级校验重定向、zee-tool.mjs、白名单 mkdir/cp/touch/tee 及变更类命令动词
 */
export function checkBashUnderGate(command, cwd, gateMode, extraAllowedDirs = []) {
  const trimmed = String(command || "").trim();
  if (!trimmed) return null;

  const effectiveCwd = cwd || process.cwd();
  const modeLabel = GATE_LABELS[gateMode] || gateMode;
  const cleanedCommand = stripHeredocBodies(trimmed);
  const allCmds = getAllNestedCommands(cleanedCommand, 5);

  for (const cmd of allCmds) {
    const staticVars = new Map();
    let virtualCwd = effectiveCwd;

    for (const seg of splitShellSegments(cmd)) {
      const rawTokens = tokenizeShell(seg);
      if (rawTokens.length === 0) continue;

      recordLeadingStaticVars(rawTokens, staticVars);

      // 词法提取未加引号的输出重定向（展开静态变量，相对 virtualCwd 解析并锚定 repo effectiveCwd 白名单）
      for (const rawTarget of extractOutputRedirects(seg)) {
        const expandedTarget = expandStaticVars(rawTarget, staticVars);
        if (expandedTarget === "/dev/null") continue;
        const resolvedTarget = normalizeToolPath(expandedTarget, virtualCwd);
        if (!isWriteAllowedUnderGate(resolvedTarget, effectiveCwd, gateMode, extraAllowedDirs)) {
          return `当前处于 zee ${modeLabel}模式，已拦截向 "${expandedTarget}" 的 Shell 重定向写入。`;
        }
      }

      const stripped = stripLeadingEnvAssignments(rawTokens).map((t) => expandStaticVars(t, staticVars));
      if (stripped.length === 0) continue;

      const verb = path.basename(stripped[0]);

      // 追踪同命令内的 cd <dir>（仅影响后续片段的虚拟工作目录）
      if (verb === "cd") {
        const dirArg = stripped[1] && !stripped[1].startsWith("-") ? stripped[1] : os.homedir();
        if (dirArg !== "-") {
          virtualCwd = normalizeToolPath(dirArg, virtualCwd);
        }
        continue;
      }

      if (isSafeZeeToolInvocation(stripped)) continue;

      if (ALLOWLISTABLE_FILE_VERBS.has(verb)) {
        if (!checkAllowlistedFileOp(verb, stripped, effectiveCwd, virtualCwd, gateMode, extraAllowedDirs)) {
          return `当前处于 zee ${modeLabel}模式，已拦截目标不在允许目录内的 ${verb} 命令。`;
        }
        continue;
      }

      if (MUTATING_FILE_VERBS.has(verb)) {
        return `当前处于 zee ${modeLabel}模式，已拦截文件增删改命令 (${verb})。`;
      }

      const interpBlocked = checkInterpreterInlineWrite(verb, stripped, trimmed);
      if (interpBlocked) {
        return `当前处于 zee ${modeLabel}模式，已拦截${interpBlocked}。`;
      }

      const blockedLabel = checkBlockedMutatingVerb(verb, stripped);
      if (blockedLabel) {
        return `当前处于 zee ${modeLabel}模式，已拦截${blockedLabel}。`;
      }
    }
  }

  return null;
}

const FAMILY_ALIASES = new Map([
  ["anthropic", "claude"],
  ["claude", "claude"],
  ["openai", "openai"],
  ["google", "gemini"],
  ["gemini", "gemini"],
  ["xai", "grok"],
  ["grok", "grok"],
  ["devin", "devin"],
  ["deepseek", "deepseek"],
  ["qwen", "qwen"],
  ["alibaba", "qwen"],
  ["meta", "meta"],
  ["meta-llama", "meta"],
  ["mistral", "mistral"],
  ["mistralai", "mistral"],
]);

/**
 * 统一提取模型底层家族（归一化 anthropic→claude / google→gemini / xai→grok，绝不将代理网关名当家族）
 */
export function extractModelFamily(modelId) {
  if (!modelId || typeof modelId !== "string") return "";
  const trimmed = modelId.trim().toLowerCase();
  if (FAMILY_ALIASES.has(trimmed)) return FAMILY_ALIASES.get(trimmed);
  const tail = trimmed.split("/").pop() || "";
  if (FAMILY_ALIASES.has(tail)) return FAMILY_ALIASES.get(tail);
  if (/(claude|fable|sonnet|opus|haiku)/.test(tail)) return "claude";
  if (/(^|[-_])(gpt|o1|o3|o4|codex)/.test(tail)) return "openai";
  if (/gemini/.test(tail)) return "gemini";
  if (/swe-/.test(tail)) return "devin";
  if (/deepseek/.test(tail)) return "deepseek";
  if (/grok/.test(tail)) return "grok";
  if (/qwen/.test(tail)) return "qwen";
  if (/llama/.test(tail)) return "meta";
  if (/mistral|mixtral|codestral/.test(tail)) return "mistral";
  const prefix = tail.split(/[-_.]/)[0] || "";
  return FAMILY_ALIASES.get(prefix) || prefix;
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
