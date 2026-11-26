#!/usr/bin/env node
/**
 * zee 多宿主安装器 (v5.0.0)
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GITHUB_HTTPS = "https://github.com/zee820232/zee";
const PI_GIT_SOURCE = "git:github.com/zee820232/zee";
const SKILL_NAMES = ["zee", "zee-plan", "zee-verify", "zee-review", "zee-night", "zee-retro", "zee-setup"];

function isEphemeralSource(forceRemote) {
  if (forceRemote) return true;
  if (REPO_ROOT.includes(`${path.sep}_npx${path.sep}`)) return true;
  if (REPO_ROOT.includes(`${path.sep}node_modules${path.sep}`)) return true;
  return !fs.existsSync(path.join(REPO_ROOT, ".git"));
}

function hasBinary(bin) {
  const finder = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(finder, [bin], { encoding: "utf8" });
  return res.status === 0 && Boolean(res.stdout && res.stdout.trim());
}

function findDuplicateSkillDirs(rootDir) {
  const dups = [];
  for (const name of SKILL_NAMES) {
    const candidate = path.join(rootDir, name);
    if (fs.existsSync(candidate)) {
      try {
        if (fs.realpathSync(candidate) !== fs.realpathSync(path.join(REPO_ROOT, "skills", name))) dups.push(candidate);
      } catch { dups.push(candidate); }
    }
  }
  return dups;
}

function runCmd(cmd, args, dryRun) {
  const display = [cmd, ...args].join(" ");
  if (dryRun) { console.log(`[dry-run] 将执行: ${display}`); return; }
  console.log(`▶ 执行: ${display}`);
  execFileSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" && !path.isAbsolute(cmd) });
}

function cleanDups(roots, dryRun) {
  const dups = roots.flatMap((r) => findDuplicateSkillDirs(r));
  for (const d of dups) {
    if (dryRun) console.log(`[dry-run] 将删除旧副本: ${d}`);
    else fs.rmSync(d, { recursive: true, force: true });
  }
}

function installPi(dryRun, useRemote) {
  console.log("\n=== 安装目标：Pi 个人主厨扩展包（7 技能 + /zee-mode + 写保护锁 + zee_subagent） ===");
  if (!hasBinary("pi")) {
    console.error(`未检测到 pi 命令。请手动执行：pi install ${PI_GIT_SOURCE}`);
    process.exitCode = 1;
    return;
  }
  cleanDups([path.join(HOME, ".pi", "agent", "skills"), path.join(HOME, ".agents", "skills")], dryRun);
  runCmd("pi", ["install", useRemote ? PI_GIT_SOURCE : REPO_ROOT], dryRun);
  console.log("✅ Pi 安装完成！可用命令：/zee、/zee-plan、/zee-verify、/zee-review、/zee-night、/zee-retro、/zee-setup、/zee-mode");
}

function installAgy(dryRun, useRemote) {
  console.log("\n=== 安装目标：Google Antigravity (agy) 插件 ===");
  if (!hasBinary("agy")) {
    console.error(`未检测到 agy 命令。请手动执行：agy plugin install ${GITHUB_HTTPS}`);
    process.exitCode = 1;
    return;
  }
  cleanDups([path.join(HOME, ".gemini", "config", "skills"), path.join(HOME, ".agents", "skills")], dryRun);
  runCmd("agy", ["plugin", "validate", "--strict", REPO_ROOT], dryRun);
  runCmd("agy", ["plugin", "install", useRemote ? GITHUB_HTTPS : REPO_ROOT], dryRun);
  console.log("✅ Google Antigravity 安装完成！可用 agy --agent zee 或斜杠命令。");
}

function installUniversalSkills(dryRun) {
  console.log("\n=== 安装目标：通用 Agent Skills ===");
  runCmd("npx", ["skills", "add", "zee820232/zee"], dryRun);
}

function printHelp() {
  console.log(`zee v5.0.4 个人主厨工作流安装器

用法：
  npx github:zee820232/zee --target <pi|agy|skills|both> [--dry-run] [--remote] [--doctor]`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { printHelp(); return; }
  const runDoctorFlag = args.includes("--doctor");
  const dryRun = args.includes("--dry-run");
  const useRemote = isEphemeralSource(args.includes("--remote"));
  const targetIdx = args.indexOf("--target");
  let target = targetIdx >= 0 ? (args[targetIdx + 1] || "").toLowerCase() : "";

  if (runDoctorFlag && !target) {
    runCmd(process.execPath, [path.join(REPO_ROOT, "skills", "zee", "scripts", "zee-tool.mjs"), "doctor"], dryRun);
    return;
  }
  if (!target) {
    console.log("1) Pi  2) Antigravity (agy)  3) 通用 Skills  4) Pi + AGY  0) 取消\n");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const choice = (await rl.question("请选择 [1/2/3/4/0]: ")).trim();
    rl.close();
    target = ({ "1": "pi", "2": "agy", "3": "skills", "4": "both", "0": "cancel" })[choice] || "";
    if (target === "cancel") return;
  }
  if (target === "pi") installPi(dryRun, useRemote);
  else if (target === "agy") installAgy(dryRun, useRemote);
  else if (target === "skills") installUniversalSkills(dryRun);
  else if (target === "both") { installPi(dryRun, useRemote); installAgy(dryRun, useRemote); }
  else { console.error(`未知安装目标 "${target}"`); process.exit(1); }

  if (runDoctorFlag && !process.exitCode) {
    runCmd(process.execPath, [path.join(REPO_ROOT, "skills", "zee", "scripts", "zee-tool.mjs"), "doctor"], dryRun);
  }
}

main().catch((err) => { console.error("安装失败：", err.message || err); process.exit(1); });
