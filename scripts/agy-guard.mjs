#!/usr/bin/env node
/**
 * Antigravity PreToolUse Hook for zee
 *
 * 1. 非 zee 规划/审查且未命中项目 denyCommands 时，直接返回 {"decision":"allow"} 透传给 Antigravity 默认权限策略（绝不静默 auto_approve）。
 * 2. 当本轮用户指令为 /zee-plan 或 /zee-review 时，强制执行与 Pi 扩展等价的路径级防写保护锁：
 *    - 兼容 Antigravity CLI (write_file/edit_file/run_command) 与 IDE (write_to_file/replace_file_content/multi_replace_file_content) 工具名。
 *    - 放行 ~/.local/state/zee/runs/、Antigravity artifactDirectoryPath，以及 plan 模式下的 .scratch/ 与 docs/plans/。
 * 3. 当仓库存在 <cwd>/.agents/zee.project.json 且声明 denyCommands 时，拦截命中的高危命令。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUNS_ROOT = path.join(os.homedir(), ".local", "state", "zee", "runs");
const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
]);

const BLOCKED_CMD_PATTERNS = [
  {
    pattern:
      /\bgit\s+(add|commit|push|merge|rebase|cherry-pick|reset|checkout|switch|restore|clean|am|apply|stash\s+(push|pop|drop|apply)|branch\s+-[dDmM])\b/,
    label: "修改 Git 工作区或提交历史的命令",
  },
  {
    pattern: /(^|[;&|]\s*)(rm|mv|cp|chmod|chown|truncate|dd|mkfs|tee|patch)\b/,
    label: "文件增删改或落盘命令",
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

function respond(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function normalizePath(rawPath, cwd) {
  let cleaned = String(rawPath || "").trim();
  if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
  if (cleaned === "~") cleaned = os.homedir();
  else if (cleaned.startsWith("~/") || cleaned.startsWith("~\\")) {
    cleaned = path.join(os.homedir(), cleaned.slice(2));
  }
  return path.resolve(cwd || process.cwd(), cleaned);
}

function isWithinDir(targetPath, parentDir) {
  if (!parentDir) return false;
  const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function detectGateMode(lastUserInput) {
  const trimmed = String(lastUserInput || "").trim();
  if (!trimmed) return "none";
  // 子代理消息不误判为顶层 /zee-plan
  if (trimmed.includes("[zee-worker]") || trimmed.includes("You are already running as a delegate")) {
    return "none";
  }
  if (/^\/zee-plan\b/i.test(trimmed) || /^\/zee\s+plan\b/i.test(trimmed)) return "plan";
  if (/^\/zee-review\b/i.test(trimmed) || /^\/zee\s+review\b/i.test(trimmed)) return "review";
  return "none";
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

function checkProjectDenyCommands(command, cwd) {
  if (!command || !cwd) return null;
  const projFile = path.join(cwd, ".agents", "zee.project.json");
  if (!fs.existsSync(projFile)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(projFile, "utf8"));
    const denies = Array.isArray(cfg.denyCommands) ? cfg.denyCommands : [];
    for (const entry of denies) {
      if (typeof entry !== "string" || !entry.trim()) continue;
      if (command.includes(entry)) {
        return `命中项目安全红线（.agents/zee.project.json denyCommands: "${entry}"），已硬拦截该命令。`;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function checkCommandUnderGate(command, gateMode) {
  const trimmed = command.trim();
  if (!trimmed) return null;
  for (const { pattern, label } of BLOCKED_CMD_PATTERNS) {
    if (pattern.test(trimmed)) {
      return `当前处于 zee-${gateMode} ${gateMode === "plan" ? "规划保护" : "只读审查"}模式，已拦截${label}。`;
    }
  }
  const redirectRegex = /(?:^|[^0-9&>])>>?\s*(?!&\d)(\S+)/g;
  for (const match of trimmed.matchAll(redirectRegex)) {
    const target = match[1].replace(/^['"]|['"]$/g, "");
    if (target === "/dev/null") continue;
    const allowed =
      target.includes(".local/state/zee/runs") ||
      (gateMode === "plan" && (target.startsWith(".scratch/") || target.startsWith("docs/plans/")));
    if (!allowed) {
      return `当前处于 zee-${gateMode} ${gateMode === "plan" ? "规划保护" : "只读审查"}模式，已拦截向 "${target}" 的重定向写入。`;
    }
  }
  return null;
}

function main() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    respond({ decision: "allow" });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    respond({ decision: "allow" });
    return;
  }

  const toolName = String(payload?.toolCall?.name || "");
  const args = payload?.toolCall?.args || {};
  const cwd = payload?.cwd || (Array.isArray(payload?.workspacePaths) ? payload.workspacePaths[0] : "") || process.cwd();
  const artifactDir = payload?.artifactDirectoryPath || "";
  const gateMode = detectGateMode(payload?.lastUserInput);

  // 1. 项目级 denyCommands 硬红线（无论是否处于 plan/review）
  if (toolName === "run_command") {
    const cmd = extractCommand(args);
    const denyReason = checkProjectDenyCommands(cmd, cwd);
    if (denyReason) {
      respond({ decision: "deny", reason: denyReason });
      return;
    }
    if (gateMode !== "none") {
      const gateViolation = checkCommandUnderGate(cmd, gateMode);
      if (gateViolation) {
        respond({ decision: "deny", reason: gateViolation });
        return;
      }
    }
    respond({ decision: "allow" });
    return;
  }

  // 2. Plan / Review 路径级写保护锁
  if (gateMode !== "none" && WRITE_TOOLS.has(toolName)) {
    const rawPath = extractTargetPath(args);
    if (rawPath) {
      const target = normalizePath(rawPath, cwd);
      const allowed =
        isWithinDir(target, RUNS_ROOT) ||
        isWithinDir(target, artifactDir) ||
        (gateMode === "plan" &&
          (isWithinDir(target, path.join(cwd, ".scratch")) ||
            isWithinDir(target, path.join(cwd, "docs", "plans"))));

      if (!allowed) {
        const hint =
          gateMode === "plan"
            ? "~/.local/state/zee/runs/、.scratch/、docs/plans/ 或 Antigravity Artifact 目录"
            : "~/.local/state/zee/runs/ 或 Antigravity Artifact 目录";
        respond({
          decision: "deny",
          reason: `当前处于 zee-${gateMode} 保护锁，禁止修改 "${rawPath}"（仅允许写入 ${hint}）。如需开始写代码，请调用 /zee 执行计划。`,
        });
        return;
      }
    }
  }

  // 默认透传，交给 Antigravity 原生权限策略处理
  respond({ decision: "allow" });
}

main();
