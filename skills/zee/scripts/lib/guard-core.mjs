/**
 * zee 共享零依赖安全与守卫核心（v5.2.0）
 *
 * 职责：
 * 1. 跨平台递归子 shell（sh/bash/zsh/dash/ksh -c、eval、cmd /c、powershell/pwsh -Command、$(...)、反引号）与命令链拆分
 * 2. 破坏性命令识别（POSIX/Windows 系统保护路径与盘符根删除、主干 git push --force、DB 客户端 DROP DATABASE）
 * 3. 项目级 .agents/zee.project.json denyCommands 词法穿透拦截（防绝对路径与中间 flag 绕过）
 * 4. plan / review 写工具（write/edit）路径白名单与只读角色路径限制
 * 5. 模型底层家族提取与按角色硬最小权限工具裁剪
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveGitRoot } from "./repo-utils.mjs";

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
  "%SystemRoot%",
  "%WINDIR%",
  "%USERPROFILE%",
  "%ProgramFiles%",
  "$env:SystemRoot",
  "$env:USERPROFILE",
]);

const WIN_PROTECTED_SUBDIRS = new Set([
  "windows",
  "program files",
  "program files (x86)",
  "users",
  "programdata",
  "system volume information",
]);

const DB_CLIENTS = new Set(["psql", "mysql", "sqlite3", "mariadb", "mongosh", "sqlcmd"]);
const CONTAINER_RUNNERS = new Set(["docker", "podman", "kubectl"]);
const DROP_DB_RE = /\bdrop\s+database\b(?:\s+if\s+exists)?\s+[`"'\[]?\w+[`"'\]]?/i;
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const READ_ONLY_INSPECT_PROGS = new Set([
  "grep", "rg", "egrep", "fgrep", "cat", "bat", "head", "tail", "less", "more", "echo", "printf", "findstr",
]);
const PARENT_MODEL_ALIASES = new Set(["inherit-parent", "inherit", "auto"]);

const PLAN_ALLOWED_ROOT_FILES = new Set([
  "GLOSSARY.md",
  "GLOSSARY-MAP.md",
  "plan.md",
  "SPEC.md",
  "ARCHITECTURE.md",
  "DESIGN.md",
]);

const SHELL_ESCAPE_CHARS = new Set([
  "\\", '"', "'", "$", "`", " ", "\t", "\r", "\n", ";", "|", "&", ">", "<", "(", ")",
]);

function isShellEscapeTarget(nextCh) {
  return nextCh !== undefined && SHELL_ESCAPE_CHARS.has(nextCh);
}

function looksLikeWindowsPathPrefix(str) {
  return /^[a-zA-Z]:[\\/]/.test(str) || /^[a-zA-Z]:$/.test(str) || /^\\\\[^\\]/.test(str);
}

function normalizeForPathCompare(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathsEqual(a, b) {
  return Boolean(a && b && normalizeForPathCompare(a) === normalizeForPathCompare(b));
}

function exeBasename(token) {
  const raw = String(token || "");
  const norm = raw.replace(/\\/g, "/");
  const base = path.posix.basename(norm).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "");
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
  const rel = path.relative(normalizeForPathCompare(parentDir), normalizeForPathCompare(targetPath));
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel))
  );
}

export function isAllowedZeeTmpPath(targetPath, repoCwd = "") {
  if (!targetPath) return false;
  const resolved = path.resolve(targetPath);
  if (repoCwd && isWithinDir(resolved, repoCwd)) return false;

  const tmpRoots = new Set([
    "/tmp",
    "/private/tmp",
    path.resolve("/tmp"),
    path.resolve("/private/tmp"),
    path.resolve(os.tmpdir()),
  ]);
  if (process.platform === "win32") {
    const driveRoot = path.parse(resolved).root;
    if (driveRoot) {
      tmpRoots.add(path.join(driveRoot, "tmp"));
      tmpRoots.add(path.join(driveRoot, "private", "tmp"));
    }
  }
  const normResolved = normalizeForPathCompare(resolved);
  for (const root of tmpRoots) {
    const normRoot = normalizeForPathCompare(root);
    const rel = path.relative(normRoot, normResolved);
    if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../") || path.isAbsolute(rel)) {
      continue;
    }
    const firstSeg = rel.split(/[\\/]/)[0];
    if (firstSeg && /^zee-[a-z0-9][a-z0-9_.-]*$/i.test(firstSeg)) {
      return true;
    }
  }
  return false;
}

export function isReadOnlyRoleWriteAllowed(rawPath, cwd, extraAllowedDirs = []) {
  if (!rawPath) return false;
  const effectiveCwd = cwd || process.cwd();
  const target = normalizeToolPath(rawPath, effectiveCwd);
  if (isWithinDir(target, RUNS_ROOT)) return true;
  if (isAllowedZeeTmpPath(target, effectiveCwd)) return true;
  return extraAllowedDirs.some((dir) => Boolean(dir && isWithinDir(target, dir)));
}

export function isWriteAllowedUnderGate(rawPath, cwd, gateMode, extraAllowedDirs = []) {
  if (!rawPath) return false;
  const effectiveCwd = cwd || process.cwd();
  const target = normalizeToolPath(rawPath, effectiveCwd);

  if (isWithinDir(target, RUNS_ROOT)) return true;
  if (isAllowedZeeTmpPath(target, effectiveCwd)) return true;
  if (extraAllowedDirs.some((dir) => Boolean(dir && isWithinDir(target, dir)))) return true;

  const repoRoot = resolveGitRoot(effectiveCwd) || path.resolve(effectiveCwd);
  const docsDir = path.join(repoRoot, "docs");

  if ((gateMode === "plan" || gateMode === "review") && pathsEqual(target, path.join(repoRoot, ".agents", "gardening-queue.jsonl"))) {
    return true;
  }

  if (gateMode === "plan") {
    if (isWithinDir(target, path.join(repoRoot, ".scratch"))) return true;
    if (isWithinDir(target, path.join(docsDir, "plans"))) return true;
    if (isWithinDir(target, path.join(docsDir, "adr"))) return true;
    if (pathsEqual(target, path.join(repoRoot, ".agents", "zee.project.json"))) return true;
    return (
      (pathsEqual(path.dirname(target), repoRoot) || pathsEqual(path.dirname(target), docsDir)) &&
      PLAN_ALLOWED_ROOT_FILES.has(path.basename(target))
    );
  }

  return false;
}

export function tokenizeShell(segment) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;
  let substParenDepth = 0;

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
        const nextCh = segment[i + 1];
        if (looksLikeWindowsPathPrefix(current) && nextCh === '"') {
          current += ch;
          continue;
        }
        if (looksLikeWindowsPathPrefix(current) && nextCh !== undefined && nextCh !== "\\") {
          current += ch;
          continue;
        }
        if (isShellEscapeTarget(nextCh)) {
          escaping = true;
          continue;
        }
      }
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === "\\") {
      const nextCh = segment[i + 1];
      if (looksLikeWindowsPathPrefix(current)) {
        current += ch;
        continue;
      }
      if (isShellEscapeTarget(nextCh)) {
        escaping = true;
        continue;
      }
    }
    if (ch === "$" && segment[i + 1] === "(") {
      substParenDepth += 1;
      current += "$(";
      i += 1;
      continue;
    }
    if (substParenDepth > 0) {
      if (ch === "(") substParenDepth += 1;
      else if (ch === ")") substParenDepth -= 1;
      current += ch;
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

export function splitShellSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  let escaping = false;
  let substParenDepth = 0;
  let substBraceDepth = 0;
  let quoteStartIdx = -1;

  const flush = () => {
    if (current.trim()) segments.push(current.trim());
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (quote === "'") {
      current += ch;
      if (ch === "'") { quote = null; quoteStartIdx = -1; }
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        const insideQuote = quoteStartIdx >= 0 ? command.slice(quoteStartIdx + 1, i) : "";
        const nextCh = command[i + 1];
        if (looksLikeWindowsPathPrefix(insideQuote) && nextCh === '"') {
          current += ch;
          continue;
        }
        if (isShellEscapeTarget(nextCh)) {
          current += ch;
          escaping = true;
          continue;
        }
      }
      current += ch;
      if (ch === '"') { quote = null; quoteStartIdx = -1; }
      continue;
    }
    if (ch === "\\") {
      const lastWord = current.split(/\s+/).pop() || "";
      if (!looksLikeWindowsPathPrefix(lastWord) && isShellEscapeTarget(command[i + 1])) {
        current += ch;
        escaping = true;
        continue;
      }
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      quoteStartIdx = i;
      current += ch;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      substParenDepth += 1;
      current += "$(";
      i += 1;
      continue;
    }
    if (substParenDepth > 0) {
      if (ch === "(") substParenDepth += 1;
      else if (ch === ")") substParenDepth -= 1;
      current += ch;
      continue;
    }
    if (ch === "$" && command[i + 1] === "{") {
      substBraceDepth += 1;
      current += "${";
      i += 1;
      continue;
    }
    if (substBraceDepth > 0) {
      if (ch === "{") substBraceDepth += 1;
      else if (ch === "}") substBraceDepth -= 1;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === ")") {
      flush();
      continue;
    }
    if (ch === "{" || ch === "}") {
      const prev = command[i - 1];
      const next = command[i + 1];
      const prevBoundary = prev === undefined || /[\s;|&(\n{]/.test(prev);
      const nextBoundary = next === undefined || /[\s;|&)\n};]/.test(next);
      if (prevBoundary && nextBoundary) {
        flush();
        continue;
      }
    }
    if (ch === ";" || ch === "\n") {
      flush();
      continue;
    }
    if (ch === "|" || ch === "&") {
      const next = command[i + 1];
      if (ch === "&" && command[i - 1] === ">") {
        current += ch;
        continue;
      }
      flush();
      if (next === ch) i += 1;
      continue;
    }
    current += ch;
  }
  flush();
  return segments;
}

function extractCommandSubstitutions(command) {
  const subs = [];
  let quote = null;
  let escaping = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\" && isShellEscapeTarget(command[i + 1])) {
      escaping = true;
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      let innerEsc = false;
      while (j < command.length) {
        const c = command[j];
        if (innerEsc) innerEsc = false;
        else if (c === "\\") innerEsc = true;
        else if (c === "`") break;
        j += 1;
      }
      if (j < command.length && command[j] === "`") {
        const inner = command.slice(i + 1, j).trim();
        if (inner) subs.push(inner);
        i = j;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(" && command[i + 2] !== "(") {
      let depth = 1;
      let j = i + 2;
      let innerQuote = null;
      let innerEsc = false;
      while (j < command.length && depth > 0) {
        const c = command[j];
        if (innerEsc) innerEsc = false;
        else if (innerQuote === "'") { if (c === "'") innerQuote = null; }
        else if (innerQuote === '"') {
          if (c === "\\" && isShellEscapeTarget(command[j + 1])) innerEsc = true;
          else if (c === '"') innerQuote = null;
        } else if (c === "\\" && isShellEscapeTarget(command[j + 1])) innerEsc = true;
        else if (c === "'" || c === '"') innerQuote = c;
        else if (c === "(") depth += 1;
        else if (c === ")") depth -= 1;
        j += 1;
      }
      if (depth === 0) {
        const inner = command.slice(i + 2, j - 1).trim();
        if (inner) subs.push(inner);
        i = j - 1;
      }
    }
  }
  return subs;
}

const SUDO_VALUE_OPTS = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"]);
const ENV_VALUE_OPTS = new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]);

function stripLeadingEnvAssignments(tokens) {
  let idx = 0;
  if (tokens[idx] === "export" || tokens[idx] === "local" || tokens[idx] === "readonly") {
    let j = idx + 1;
    while (j < tokens.length && (tokens[j].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[j]) || /^[A-Za-z_][A-Za-z0-9_]*$/.test(tokens[j]))) {
      j += 1;
    }
    if (j >= tokens.length) return [];
  }
  while (idx < tokens.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) {
      idx += 1;
      continue;
    }
    if (tokens[idx] === "env") {
      idx += 1;
      while (idx < tokens.length) {
        const t = tokens[idx];
        if (ENV_VALUE_OPTS.has(t) && idx + 1 < tokens.length) { idx += 2; continue; }
        if (t.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { idx += 1; continue; }
        break;
      }
      continue;
    }
    if (tokens[idx] === "sudo") {
      idx += 1;
      while (idx < tokens.length) {
        const t = tokens[idx];
        if (SUDO_VALUE_OPTS.has(t) && idx + 1 < tokens.length) { idx += 2; continue; }
        if (t.startsWith("-")) { idx += 1; continue; }
        break;
      }
      continue;
    }
    break;
  }
  return tokens.slice(idx);
}

export function getAllNestedCommands(command, maxDepth = 5) {
  const results = [String(command || "")];
  if (maxDepth <= 0 || !command) return results;

  for (const sub of extractCommandSubstitutions(command)) {
    results.push(...getAllNestedCommands(sub, maxDepth - 1));
  }

  for (const seg of splitShellSegments(command)) {
    const tokens = stripLeadingEnvAssignments(tokenizeShell(seg));
    if (tokens.length < 2) continue;
    const verb = exeBasename(tokens[0]);

    if (["sh", "bash", "zsh", "dash", "ksh"].includes(verb)) {
      let j = 1;
      while (j < tokens.length) {
        const opt = tokens[j];
        if (opt === "--") break;
        if (opt === "-c" || (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(opt) && !opt.startsWith("--"))) {
          if (j + 1 < tokens.length) results.push(...getAllNestedCommands(tokens[j + 1], maxDepth - 1));
          break;
        }
        if ((opt === "-o" || opt === "+o") && j + 1 < tokens.length) { j += 2; continue; }
        if (opt.startsWith("-") || opt.startsWith("+")) { j += 1; continue; }
        break;
      }
    } else if (verb === "eval") {
      results.push(...getAllNestedCommands(tokens.slice(1).join(" "), maxDepth - 1));
    } else if (verb === "cmd") {
      let j = 1;
      while (j < tokens.length) {
        const optLow = tokens[j].toLowerCase();
        if (optLow === "/c" || optLow === "/k") {
          const payload = tokens.slice(j + 1).join(" ").trim();
          if (payload) results.push(...getAllNestedCommands(payload, maxDepth - 1));
          break;
        }
        if (optLow.startsWith("/")) { j += 1; continue; }
        break;
      }
    } else if (verb === "powershell" || verb === "pwsh") {
      let j = 1;
      while (j < tokens.length) {
        const optLow = tokens[j].toLowerCase();
        if (optLow === "-c" || optLow === "-command" || optLow === "/c" || optLow === "/command") {
          const payload = tokens.slice(j + 1).join(" ").trim();
          if (payload) results.push(...getAllNestedCommands(payload, maxDepth - 1));
          break;
        }
        if (["-executionpolicy", "-ep", "-windowstyle", "-w", "-workingdirectory", "-wd"].includes(optLow)) {
          j += 2;
          continue;
        }
        if (optLow.startsWith("-") || optLow.startsWith("/")) { j += 1; continue; }
        break;
      }
    }
  }
  return results;
}

export function stripHeredocBodies(command) {
  const lines = String(command || "").split(/\r?\n/);
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    out.push(line);

    let quote = null;
    let escaping = false;
    const delims = [];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (escaping) { escaping = false; continue; }
      if (quote === "'") { if (ch === "'") quote = null; continue; }
      if (quote === '"') {
        if (ch === "\\" && isShellEscapeTarget(line[j + 1])) escaping = true;
        else if (ch === '"') quote = null;
        continue;
      }
      if (ch === "\\" && isShellEscapeTarget(line[j + 1])) { escaping = true; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === "<" && line[j + 1] === "<" && line[j + 2] !== "<") {
        let k = j + 2;
        const stripTabs = line[k] === "-";
        if (stripTabs) k += 1;
        while (k < line.length && (line[k] === " " || line[k] === "\t")) k += 1;
        const m = line.slice(k).match(/^(?:'([^']+)'|"([^"]+)"|\\([A-Za-z0-9_.-]+)|([A-Za-z0-9_.-]+))/);
        if (m) {
          delims.push({ delim: m[1] || m[2] || m[3] || m[4], stripTabs });
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

function isWindowsProtectedLiteral(clean) {
  const unquoted = clean.replace(/^["']|["']$/g, "").trim();
  if (!unquoted) return false;
  if (/^[a-zA-Z]:[\\/]*\*?$/.test(unquoted)) return true;
  if (/^%(?:systemroot|windir|userprofile|programfiles|programfiles\(x86\)|programdata)%(?:[\\/]\*?)?$/i.test(unquoted)) {
    return true;
  }
  if (/^\$env:(?:systemroot|windir|userprofile|programfiles|programdata)(?:[\\/]\*?)?$/i.test(unquoted)) {
    return true;
  }
  const winDriveMatch = unquoted.match(/^[a-zA-Z]:[\\/](.+?)[\\/]*\*?$/);
  if (winDriveMatch) {
    const first = winDriveMatch[1].replace(/[\\/]+$/, "").toLowerCase();
    if (WIN_PROTECTED_SUBDIRS.has(first)) return true;
  }
  return false;
}

function isProtectedTarget(arg, cwd) {
  const clean = String(arg || "").trim();
  if (!clean) return false;
  if (PROTECTED_PATHS.has(clean)) return true;
  if (isWindowsProtectedLiteral(clean)) return true;
  if ((clean.endsWith("/*") || clean.endsWith("\\*")) && PROTECTED_PATHS.has(clean.slice(0, -2))) return true;
  const candidate = clean.endsWith("/*") || clean.endsWith("\\*") ? clean.slice(0, -2) || "/" : clean;
  try {
    const resolved = normalizeToolPath(candidate, cwd || process.cwd());
    if (resolved === "/" || pathsEqual(resolved, path.resolve(os.homedir()))) return true;
    const parsed = path.parse(resolved);
    if (parsed.root && pathsEqual(resolved, parsed.root)) return true;
    if (process.platform === "win32" && isWindowsProtectedLiteral(resolved)) return true;
    const PROTECTED_ABS = ["/etc", "/usr", "/bin", "/sbin", "/var", "/lib", "/boot", "/dev", "/home", "/root", "/System", "/Applications"];
    return PROTECTED_ABS.some((p) => resolved === p || pathsEqual(resolved, path.resolve(p)));
  } catch {
    return false;
  }
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
      const verb = exeBasename(tokens[0]);
      if (verb === "cd" || verb === "set-location" || verb === "sl") {
        const dirArg = tokens[1] && !tokens[1].startsWith("-") ? tokens[1] : os.homedir();
        if (dirArg !== "-") virtualCwd = normalizeToolPath(dirArg, virtualCwd);
        continue;
      }

      if (verb === "rm" || verb === "remove-item" || verb === "ri") {
        let hasR = false;
        let hasF = false;
        let hasNoPreserve = false;
        const targets = [];
        let endOfOpts = false;

        for (let i = 1; i < tokens.length; i++) {
          const arg = tokens[i];
          const low = arg.toLowerCase();
          if (arg === "--") { endOfOpts = true; continue; }
          if (!endOfOpts && arg.startsWith("-")) {
            if (low === "--no-preserve-root") hasNoPreserve = true;
            else if (low === "--recursive" || low === "-recurse" || low === "-rec") hasR = true;
            else if (low === "--force" || low === "-force" || low === "-fo") hasF = true;
            else if (low === "-path" || low === "-literalpath") {
              if (i + 1 < tokens.length) { targets.push(tokens[i + 1]); i += 1; }
            } else if (!arg.startsWith("--") && /^-[a-zA-Z]+$/.test(arg)) {
              if (/[rR]/.test(arg)) hasR = true;
              if (/[fF]/.test(arg)) hasF = true;
            }
          } else {
            targets.push(arg);
          }
        }
        if (hasNoPreserve) return "检测到 rm --no-preserve-root 极端破坏性删除命令";
        if (hasR && hasF && targets.some((t) => isProtectedTarget(t, virtualCwd))) {
          return `检测到针对系统保护目录、盘符根或家目录的递归强制删除命令 (${verb})`;
        }
        continue;
      }

      if (verb === "rd" || verb === "rmdir") {
        let hasS = false;
        const targets = [];
        for (let i = 1; i < tokens.length; i++) {
          const arg = tokens[i];
          const low = arg.toLowerCase();
          if (low === "/s" || low === "-r" || low === "--recursive" || low === "-recurse" || low === "-rec") hasS = true;
          else if (low === "-path" || low === "-literalpath") {
            if (i + 1 < tokens.length) { targets.push(tokens[i + 1]); i += 1; }
          } else if (low.startsWith("/") && low.length <= 3) continue;
          else if (low.startsWith("-")) {
            if (!arg.startsWith("--") && /^-[a-zA-Z]+$/.test(arg) && /[rR]/.test(arg)) hasS = true;
            continue;
          } else targets.push(arg);
        }
        if (hasS && targets.some((t) => isProtectedTarget(t, virtualCwd))) {
          return `检测到针对系统保护目录或盘符根的递归删除命令 (${verb})`;
        }
        continue;
      }

      if (verb === "del" || verb === "erase") {
        let hasS = false;
        let hasF = false;
        const targets = [];
        for (let i = 1; i < tokens.length; i++) {
          const arg = tokens[i];
          const low = arg.toLowerCase();
          if (low === "/s" || low === "--recursive" || low === "-recurse" || low === "-rec") hasS = true;
          else if (low === "/f" || low === "/q" || low === "--force" || low === "-force" || low === "-fo") hasF = true;
          else if (low === "-path" || low === "-literalpath") {
            if (i + 1 < tokens.length) { targets.push(tokens[i + 1]); i += 1; }
          } else if (low.startsWith("/") && low.length <= 3) continue;
          else if (low.startsWith("-")) {
            if (!arg.startsWith("--") && /^-[a-zA-Z]+$/.test(arg)) {
              if (/[rR]/.test(arg)) hasS = true;
              if (/[fF]/.test(arg)) hasF = true;
            }
          } else targets.push(arg);
        }
        if (hasS && hasF && targets.some((t) => isProtectedTarget(t, virtualCwd))) {
          return `检测到针对系统保护目录、盘符根或家目录的强制递归删除命令 (${verb})`;
        }
      }
    }
  }
  return null;
}

const GIT_PUSH_VALUE_OPTS = new Set([
  "-o", "--push-option", "--receive-pack", "--exec", "--repo", "--signed", "--recurse-submodules",
]);

function checkTrunkForcePush(allCmds, cwd) {
  for (const cmd of allCmds) {
    for (const seg of splitShellSegments(cmd)) {
      const tokens = stripLeadingEnvAssignments(tokenizeShell(seg));
      if (tokens.length < 2 || exeBasename(tokens[0]) !== "git") continue;
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

      let isForce = false;
      let isAllOrMirror = false;
      const positionals = [];
      const pushArgs = tokens.slice(subIdx + 1);
      for (let i = 0; i < pushArgs.length; i++) {
        const a = pushArgs[i];
        if (
          a === "-f" || a === "--force" || a === "--force-with-lease" ||
          a.startsWith("--force-with-lease=") || (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) && !a.startsWith("--"))
        ) {
          isForce = true;
        } else if (a === "--all" || a === "--mirror") {
          isAllOrMirror = true;
        } else if (GIT_PUSH_VALUE_OPTS.has(a)) {
          i += 1;
        } else if (!a.startsWith("-")) {
          positionals.push(a);
        }
      }
      const refspecs = positionals.slice(1);
      if (refspecs.some((s) => s.startsWith("+"))) isForce = true;
      if (!isForce) continue;

      if (isAllOrMirror) {
        return "检测到强制全量推送 (git push --force --all/--mirror)，可能覆盖受保护主干分支";
      }

      const currentBranch = getCurrentGitBranch(gitCwd);
      for (const spec of refspecs) {
        const cleaned = spec.replace(/^\+/, "");
        const dst = cleaned.includes(":") ? cleaned.split(":").pop() : cleaned;
        let branchName = String(dst || "").replace(/^refs\/heads\//, "");
        if (branchName === "HEAD" && currentBranch) branchName = currentBranch;
        if (PROTECTED_BRANCHES.has(branchName)) {
          return `检测到向受保护主干分支 "${branchName}" 执行强制推送 (git push --force)`;
        }
      }
      if (refspecs.length === 0 && PROTECTED_BRANCHES.has(currentBranch)) {
        return "当前处于受保护主干分支，检测到无目标强推 (git push --force)";
      }
    }
  }
  return null;
}

function segmentInvokesDbClient(tokens) {
  if (tokens.length === 0) return false;
  const verb = exeBasename(tokens[0]);
  if (DB_CLIENTS.has(verb)) return true;
  if (CONTAINER_RUNNERS.has(verb)) {
    for (let i = 1; i < tokens.length; i++) {
      if (DB_CLIENTS.has(exeBasename(tokens[i]))) return true;
    }
  }
  return false;
}

function checkDropDatabase(allCmds) {
  for (const cmd of allCmds) {
    for (const seg of splitShellSegments(cmd)) {
      if (!DROP_DB_RE.test(seg)) continue;
      const tokens = stripLeadingEnvAssignments(tokenizeShell(seg));
      if (segmentInvokesDbClient(tokens)) {
        return "检测到通过数据库客户端执行 DROP DATABASE 破坏性删库命令";
      }
    }
  }
  return null;
}

export function evaluateDestructiveCommand(command, cwd) {
  const trimmed = String(command || "").trim();
  if (!trimmed) return null;
  const allCmds = getAllNestedCommands(stripHeredocBodies(trimmed), 5);
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
  const verb = exeBasename(tokens[0]);
  if (READ_ONLY_INSPECT_PROGS.has(verb)) return "";
  if ((verb === "node" || verb === "bun") && path.basename(tokens[1] || "") === "zee-tool.mjs") return "";

  if (verb === "git") {
    let subIdx = 1;
    while (subIdx < tokens.length && tokens[subIdx].startsWith("-")) {
      const opt = tokens[subIdx];
      if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(opt) && subIdx + 1 < tokens.length) subIdx += 2;
      else subIdx += 1;
    }
    const sub = tokens[subIdx] || "";
    if (["log", "show", "diff", "grep", "status", "rev-parse", "merge-base"].includes(sub)) return "";
    if (sub === "commit") {
      const kept = [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if ((t === "-m" || t === "--message") && i + 1 < tokens.length) { i += 1; continue; }
        if (t.startsWith("--message=") || t.startsWith("-m")) continue;
        kept.push(t);
      }
      return kept.join(" ");
    }
  }
  return seg;
}

function matchesDenyEntry(segment, rawEntry) {
  const entry = String(rawEntry || "").trim();
  if (!entry) return false;
  const entryTokens = tokenizeShell(entry);
  const segTokens = stripLeadingEnvAssignments(tokenizeShell(segment));
  if (entryTokens.length === 0 || segTokens.length === 0) return false;

  const tokenMatches = (segTok, entryTok, isVerbPos = false) => {
    if (segTok === entryTok) return true;
    if (isVerbPos && !entryTok.includes("/") && !entryTok.includes("\\") && exeBasename(segTok) === exeBasename(entryTok)) {
      return true;
    }
    if (entryTok.startsWith("-") && segTok.startsWith(`${entryTok}=`)) return true;
    if ((entryTok === "/" || entryTok === "~") && segTok === `${entryTok}*`) return true;
    return entryTok === "~" && (segTok === "~/" || segTok === "~/*");
  };

  // 1. 精确连续 token 匹配（动词位兼容绝对路径如 /usr/bin/npm）
  for (let i = 0; i <= segTokens.length - entryTokens.length; i++) {
    let matched = true;
    for (let j = 0; j < entryTokens.length; j++) {
      if (!tokenMatches(segTokens[i + j], entryTokens[j], i + j === 0 && j === 0)) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }

  // 2. 多词命令防插旗绕过（如 npm --tag next publish 匹配 "npm publish"）
  if (entryTokens.length >= 2 && !entryTokens[0].startsWith("-") && tokenMatches(segTokens[0], entryTokens[0], true)) {
    let k = 1;
    let eIdx = 1;
    while (k < segTokens.length && eIdx < entryTokens.length) {
      if (tokenMatches(segTokens[k], entryTokens[eIdx], false)) {
        eIdx += 1;
        k += 1;
      } else if (segTokens[k].startsWith("-")) {
        const hasEq = segTokens[k].includes("=");
        k += 1;
        if (!hasEq && k < segTokens.length && !segTokens[k].startsWith("-") && !tokenMatches(segTokens[k], entryTokens[eIdx], false)) {
          k += 1;
        }
      } else {
        break;
      }
    }
    if (eIdx === entryTokens.length) return true;
  }

  if (entryTokens.length === 1 && !entry.endsWith("/") && !entry.endsWith("~")) {
    const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|[\\s"'=;|&])${escaped}(?:$|[\\s"'=;|&*])`);
    if (re.test(segment)) return true;
  }
  return false;
}

export function checkProjectDenyCommands(command, cwd) {
  if (!command || !cwd) return null;
  const repoRoot = resolveGitRoot(cwd) || path.resolve(cwd);
  const projFile = fs.existsSync(path.join(cwd, ".agents", "zee.project.json"))
    ? path.join(cwd, ".agents", "zee.project.json")
    : path.join(repoRoot, ".agents", "zee.project.json");
  if (!fs.existsSync(projFile)) return null;
  let denies = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(projFile, "utf8"));
    denies = Array.isArray(cfg.denyCommands) ? cfg.denyCommands : [];
  } catch {
    return null;
  }
  if (denies.length === 0) return null;

  const allCmds = getAllNestedCommands(stripHeredocBodies(String(command || "")), 5);
  const segments = [];
  for (const c of allCmds) {
    for (const seg of splitShellSegments(c)) {
      const cand = getExecutableDenyCandidate(seg);
      if (cand) segments.push(cand);
    }
  }
  for (const entry of denies) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    if (segments.some((s) => matchesDenyEntry(s, entry))) {
      return `命中项目安全红线（.agents/zee.project.json denyCommands: "${entry}"），已硬拦截该命令。`;
    }
  }
  return null;
}

const FAMILY_ALIASES = new Map([
  ["anthropic", "claude"],
  ["openai", "openai"],
  ["google", "gemini"],
  ["vertex", "gemini"],
  ["xai", "grok"],
  ["zhipu", "glm"],
  ["moonshot", "kimi"],
  ["alibaba", "qwen"],
  ["meta-llama", "meta"],
  ["mistralai", "mistral"],
]);

export function extractModelFamily(modelId) {
  if (!modelId || typeof modelId !== "string") return "";
  const trimmed = modelId.trim().toLowerCase();
  if (!trimmed || PARENT_MODEL_ALIASES.has(trimmed)) return "";
  if (FAMILY_ALIASES.has(trimmed)) return FAMILY_ALIASES.get(trimmed);

  const parts = trimmed.split("/").filter(Boolean);
  const tail = parts[parts.length - 1] || "";
  if (PARENT_MODEL_ALIASES.has(tail)) return "";
  if (FAMILY_ALIASES.has(tail)) return FAMILY_ALIASES.get(tail);
  if (/(claude|fable|sonnet|opus|haiku)/.test(tail)) return "claude";
  if (/(^|[-_])(gpt|o1|o3|o4|codex)/.test(tail)) return "openai";
  if (/(gemini|(^|[-_])(neon|hydrogen|carbon|argon)($|[-_0-9]))/.test(tail)) return "gemini";
  if (/swe-/.test(tail)) return "devin";
  if (/deepseek/.test(tail)) return "deepseek";
  if (/grok/.test(tail)) return "grok";
  if (/qwen/.test(tail)) return "qwen";
  if (/llama/.test(tail)) return "meta";
  if (/mistral|mixtral|codestral/.test(tail)) return "mistral";

  for (const seg of parts.slice(0, -1)) {
    if (FAMILY_ALIASES.has(seg)) return FAMILY_ALIASES.get(seg);
  }
  const prefix = tail.split(/[-_.]/)[0] || "";
  if (PARENT_MODEL_ALIASES.has(prefix)) return "";
  return FAMILY_ALIASES.get(prefix) || prefix;
}

export function enforcePiRoleTools(role, requestedTools) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const base = Array.isArray(requestedTools) && requestedTools.length > 0 ? [...requestedTools] : null;

  if (normalizedRole === "judge") {
    const fallback = ["read", "grep", "find", "ls"];
    const allowed = new Set(fallback);
    if (!base) return fallback;
    const filtered = base.filter((t) => allowed.has(t));
    return filtered.length > 0 ? filtered : fallback;
  }
  if (normalizedRole === "scout") {
    const fallback = ["read", "grep", "find", "ls", "bash"];
    const forbidden = new Set(["edit", "write"]);
    if (!base) return fallback;
    const filtered = base.filter((t) => !forbidden.has(t));
    return filtered.length > 0 ? filtered : fallback;
  }
  if (normalizedRole === "architect") {
    const fallback = ["read", "grep", "find", "ls"];
    const forbidden = new Set(["edit", "bash", "powershell"]);
    if (!base) return fallback;
    const filtered = base.filter((t) => !forbidden.has(t));
    return filtered.length > 0 ? filtered : fallback;
  }
  if (normalizedRole === "verifier" || normalizedRole === "reviewer") {
    const fallback = ["read", "grep", "find", "ls", "bash", "write"];
    const forbidden = new Set(["edit"]);
    if (!base) return fallback;
    const filtered = base.filter((t) => !forbidden.has(t));
    return filtered.length > 0 ? filtered : fallback;
  }
  return base;
}
