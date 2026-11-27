#!/usr/bin/env node
/**
 * zee 多宿主零摩擦安装器 (v5.3.0)
 *
 * 支持：--target auto（自动探测本机全部宿主一键装齐）| pi | agy | skills | both | all
 * 修复：Windows 空格/括号/& 路径安全执行（无 DEP0190）、跨宿主 ~/.agents/skills 不互删、strict 参数校验
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HOME = os.homedir();
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GITHUB_HTTPS = "https://github.com/zee820232/zee";
const PI_GIT_SOURCE = "git:github.com/zee820232/zee";
export const SKILL_NAMES = ["zee", "zee-plan", "zee-verify", "zee-review", "zee-night", "zee-retro", "zee-setup"];

export function isEphemeralSource(forceRemote, repoRoot = REPO_ROOT) {
  if (forceRemote) return true;
  if (repoRoot.includes(`${path.sep}_npx${path.sep}`)) return true;
  if (repoRoot.includes(`${path.sep}node_modules${path.sep}`)) return true;
  if (fs.existsSync(path.join(repoRoot, "skills", "zee", "SKILL.md"))) return false;
  return !fs.existsSync(path.join(repoRoot, ".git"));
}

export function resolveWindowsBinary(bin) {
  if (path.isAbsolute(bin) && fs.existsSync(bin)) return bin;
  const res = spawnSync("where.exe", [bin], { encoding: "utf8", windowsHide: true });
  if (res.status !== 0 || !res.stdout) return null;
  const candidates = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const exe = candidates.find((c) => /\.(?:exe|com)$/i.test(c));
  if (exe) return exe;
  const cmd = candidates.find((c) => /\.(?:cmd|bat)$/i.test(c));
  return cmd || candidates[0] || null;
}

export function buildWinCmdInvocation(resolvedBin, args) {
  // 通过子进程环境变量 + 延迟扩展 (!VAR!) 传参给 cmd.exe /d /v:on /c，
  // 彻底杜绝 cmd.exe 对空格/括号/&/|/%VAR% 进行参数撕裂或环境变量展开
  const extraEnv = { ZEE_CMD_BIN: String(resolvedBin) };
  const argTokens = [];
  for (let i = 0; i < args.length; i++) {
    const key = `ZEE_CMD_ARG_${i}`;
    extraEnv[key] = String(args[i] ?? "");
    argTokens.push(`"!${key}!"`);
  }
  const cmdLine = [`"!ZEE_CMD_BIN!"`, ...argTokens].join(" ");
  return {
    comspec: process.env.ComSpec || "cmd.exe",
    cmdArgs: ["/d", "/v:on", "/s", "/c", `"${cmdLine}"`],
    extraEnv,
  };
}

export function quoteWinCmdArg(arg) {
  const s = String(arg ?? "");
  if (!s) return '""';
  const safe = s
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/, "$1$1");
  return `"${safe}"`;
}

function hasBinary(bin) {
  if (process.platform === "win32") return Boolean(resolveWindowsBinary(bin));
  const res = spawnSync("which", [bin], { encoding: "utf8" });
  return res.status === 0 && Boolean(res.stdout && res.stdout.trim());
}

export function findDuplicateSkillDirs(rootDir, repoRoot = REPO_ROOT) {
  const dups = [];
  for (const name of SKILL_NAMES) {
    const candidate = path.join(rootDir, name);
    if (fs.existsSync(candidate)) {
      try {
        if (fs.realpathSync(candidate) !== fs.realpathSync(path.join(repoRoot, "skills", name))) dups.push(candidate);
      } catch { dups.push(candidate); }
    }
  }
  return dups;
}

export function runCrossPlatformCmd(cmd, args, dryRun = false) {
  const display = [cmd, ...args].map((a) => (/\s/.test(String(a)) ? `"${a}"` : String(a))).join(" ");
  if (dryRun) { console.log(`[dry-run] 将执行: ${display}`); return; }
  console.log(`▶ 执行: ${display}`);

  if (process.platform !== "win32" || path.isAbsolute(cmd)) {
    execFileSync(cmd, args, { stdio: "inherit", shell: false });
    return;
  }

  const resolved = resolveWindowsBinary(cmd);
  if (!resolved) {
    throw new Error(`未找到可执行命令：${cmd}`);
  }
  if (/\.(?:exe|com)$/i.test(resolved)) {
    execFileSync(resolved, args, { stdio: "inherit", shell: false });
    return;
  }

  // .cmd / .bat 通过环境变量 + 延迟扩展安全传参，零 DEP0190、零 %VAR% 展开、零空格/括号撕裂
  const { comspec, cmdArgs, extraEnv } = buildWinCmdInvocation(resolved, args);
  const res = spawnSync(comspec, cmdArgs, {
    stdio: "inherit",
    windowsVerbatimArguments: true,
    env: { ...process.env, ...extraEnv },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`命令退出码 ${res.status}：${display}`);
  }
}

export function cleanDups(roots, dryRun, repoRoot = REPO_ROOT) {
  const dups = roots.flatMap((r) => findDuplicateSkillDirs(r, repoRoot));
  for (const d of dups) {
    if (dryRun) console.log(`[dry-run] 将删除旧副本: ${d}`);
    else fs.rmSync(d, { recursive: true, force: true });
  }
  return dups;
}

function warnSharedSkillsIfPresent(dryRun, cleanShared) {
  const sharedRoot = path.join(HOME, ".agents", "skills");
  const sharedDups = findDuplicateSkillDirs(sharedRoot);
  if (sharedDups.length === 0) return;
  if (cleanShared) {
    cleanDups([sharedRoot], dryRun);
  } else {
    console.log(`ℹ 保留跨宿主共享目录 ${sharedRoot} 中的 ${sharedDups.length} 项技能（供 Codex/Claude Code/T3 共存；如需清理请附加 --clean-shared-skills）。`);
  }
}

function installPi(dryRun, useRemote, cleanShared) {
  console.log("\n=== 安装目标：Pi 个人主厨自动驾驶扩展包（7 技能 + /zee-mode 默认 auto + 写保护锁 + zee_subagent） ===");
  if (!hasBinary("pi")) {
    console.error(`未检测到 pi 命令。请手动执行：pi install ${PI_GIT_SOURCE}`);
    process.exitCode = 1;
    return false;
  }
  cleanDups([path.join(HOME, ".pi", "agent", "skills")], dryRun);
  warnSharedSkillsIfPresent(dryRun, cleanShared);
  runCrossPlatformCmd("pi", ["install", useRemote ? PI_GIT_SOURCE : REPO_ROOT], dryRun);
  console.log("✅ Pi 安装完成！装完即默认开启 auto 自动驾驶（随时可 /zee-mode off）。可用命令：/zee、/zee-plan、/zee-verify、/zee-review、/zee-night、/zee-retro、/zee-setup、/zee-mode");
  return true;
}

function installAgy(dryRun, useRemote, cleanShared) {
  console.log("\n=== 安装目标：Google Antigravity (agy) 插件（含 rules/AGENTS.md 自动唤醒 + Stop 守夜） ===");
  if (!hasBinary("agy")) {
    console.error(`未检测到 agy 命令。请手动执行：agy plugin install ${GITHUB_HTTPS}`);
    process.exitCode = 1;
    return false;
  }
  cleanDups([path.join(HOME, ".gemini", "config", "skills")], dryRun);
  warnSharedSkillsIfPresent(dryRun, cleanShared);
  if (!useRemote) {
    runCrossPlatformCmd("agy", ["plugin", "validate", "--strict", REPO_ROOT], dryRun);
  }
  runCrossPlatformCmd("agy", ["plugin", "install", useRemote ? GITHUB_HTTPS : REPO_ROOT], dryRun);
  console.log("✅ Google Antigravity 安装完成！直接用自然语言提工程需求即可自动驾驶，或显式调用 /zee*。");
  return true;
}

function installUniversalSkills(dryRun, useRemote) {
  console.log("\n=== 安装目标：通用 Agent Skills（Claude Code / Codex / T3 Code / Cursor） ===");
  if (!hasBinary("npx")) {
    console.error(`未检测到 npx 命令。请安装 Node.js 后执行：npx --yes skills add ${GITHUB_HTTPS} -g -s * -y`);
    process.exitCode = 1;
    return false;
  }
  const source = useRemote ? GITHUB_HTTPS : REPO_ROOT;
  runCrossPlatformCmd("npx", ["--yes", "skills", "add", source, "-g", "-s", "*", "-y"], dryRun);
  console.log("✅ 通用 Agent Skills 全局安装完成！零配置单兵开箱可用。");
  return true;
}

function installAuto(dryRun, useRemote, cleanShared) {
  const detected = [];
  if (hasBinary("pi")) detected.push("pi");
  if (hasBinary("agy")) detected.push("agy");
  if (hasBinary("npx")) detected.push("skills");

  if (detected.length === 0) {
    console.error("未检测到 pi、agy 或 npx。请至少安装其中一个工具，或手工将 skills/ 拷贝至目标宿主的 skills 目录。");
    process.exitCode = 1;
    return;
  }
  console.log(`🔍 自动探测到可用目标：${detected.join(", ")}`);
  if (detected.includes("pi")) installPi(dryRun, useRemote, cleanShared);
  if (detected.includes("agy")) installAgy(dryRun, useRemote, cleanShared);
  if (detected.includes("skills")) installUniversalSkills(dryRun, useRemote);
}

function printHelp() {
  console.log(`zee v5.3.0 个人主厨自动驾驶工作流安装器

用法：
  node scripts/install.mjs --target <auto|pi|agy|skills|both|all> [--dry-run] [--remote] [--doctor] [--clean-shared-skills]

目标说明：
  auto    自动探测本机已安装的 pi / agy / npx 并一键全自动安装（推荐）
  pi      安装 Pi CLI 扩展包（默认开启 auto 自动驾驶）
  agy     安装 Google Antigravity 原生插件（含 rules/AGENTS.md 自动唤醒）
  skills  全局安装通用 Agent Skills（Claude Code / Codex / T3 / Cursor）
  both    同时安装 Pi + Antigravity
  all     同时安装 Pi + Antigravity + 通用 Skills`);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      allowPositionals: false,
      options: {
        target: { type: "string", short: "t" },
        "dry-run": { type: "boolean", default: false },
        remote: { type: "boolean", default: false },
        doctor: { type: "boolean", default: false },
        "clean-shared-skills": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    console.error(`参数错误：${err.message}`);
    printHelp();
    process.exit(1);
  }

  const values = parsed.values;
  if (values.help) { printHelp(); return; }
  const runDoctorFlag = Boolean(values.doctor);
  const dryRun = Boolean(values["dry-run"]);
  const cleanShared = Boolean(values["clean-shared-skills"]);
  const useRemote = isEphemeralSource(Boolean(values.remote));
  let target = String(values.target || "").trim().toLowerCase();

  if (runDoctorFlag && !target) {
    runCrossPlatformCmd(process.execPath, [path.join(REPO_ROOT, "skills", "zee", "scripts", "zee-tool.mjs"), "doctor"], dryRun);
    return;
  }
  if (!target) {
    if (!process.stdin.isTTY) {
      console.error("非交互环境下必须指定 --target <auto|pi|agy|skills|both|all>（推荐使用 --target auto）");
      process.exit(1);
    }
    console.log("1) 自动全装 (auto，推荐)  2) Pi  3) Antigravity (agy)  4) 通用 Skills  5) Pi + AGY  6) 全部 (all)  0) 取消\n");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const choice = (await rl.question("请选择 [1/2/3/4/5/6/0]: ")).trim();
    rl.close();
    target = ({ "1": "auto", "2": "pi", "3": "agy", "4": "skills", "5": "both", "6": "all", "0": "cancel" })[choice] || "";
    if (target === "cancel") return;
  }

  if (target === "auto") installAuto(dryRun, useRemote, cleanShared);
  else if (target === "pi") installPi(dryRun, useRemote, cleanShared);
  else if (target === "agy") installAgy(dryRun, useRemote, cleanShared);
  else if (target === "skills") installUniversalSkills(dryRun, useRemote);
  else if (target === "both") { installPi(dryRun, useRemote, cleanShared); installAgy(dryRun, useRemote, cleanShared); }
  else if (target === "all") { installPi(dryRun, useRemote, cleanShared); installAgy(dryRun, useRemote, cleanShared); installUniversalSkills(dryRun, useRemote); }
  else { console.error(`未知安装目标 "${target}"，可选：auto | pi | agy | skills | both | all`); process.exit(1); }

  if (runDoctorFlag && !process.exitCode) {
    runCrossPlatformCmd(process.execPath, [path.join(REPO_ROOT, "skills", "zee", "scripts", "zee-tool.mjs"), "doctor"], dryRun);
  }
}

function canonicalizeEntryPath(p) {
  try {
    const real = (fs.realpathSync.native || fs.realpathSync)(p);
    return process.platform === "win32" ? real.toLowerCase() : real;
  } catch {
    const abs = path.resolve(p);
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  }
}

const isEntryPoint =
  Boolean(process.argv[1]) &&
  canonicalizeEntryPath(process.argv[1]) === canonicalizeEntryPath(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  main().catch((err) => { console.error("安装失败：", err.message || err); process.exit(1); });
}
