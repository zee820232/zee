#!/usr/bin/env node
/**
 * zee 交互式 / 命令行多宿主安装器
 *
 * 支持在安装时按需选择目标宿主（绝不越界改动未选择的宿主）：
 *   --target pi       安装为 Pi 完整扩展包（pi install <repo>，并检测/清理旧副本）
 *   --target agy      安装为 Google Antigravity 原生插件（agy plugin install <repo>）
 *   --target skills   通过标准 Agent Skills CLI（npx skills add）安装通用技能
 *   --target both     同时安装到 Pi 与 Google Antigravity
 *   --dry-run         仅打印将执行的步骤，不修改系统
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_NAMES = ["zee", "zee-setup", "zee-plan", "zee-init", "zee-review", "zee-night"];

function hasBinary(bin) {
  const res = spawnSync("which", [bin], { encoding: "utf8" });
  return res.status === 0 && Boolean(res.stdout.trim());
}

function findDuplicateSkillDirs(rootDir) {
  const dups = [];
  for (const name of SKILL_NAMES) {
    const candidate = path.join(rootDir, name);
    if (fs.existsSync(candidate)) {
      try {
        const realCand = fs.realpathSync(candidate);
        const realSrc = fs.realpathSync(path.join(REPO_ROOT, "skills", name));
        if (realCand !== realSrc) dups.push(candidate);
      } catch {
        dups.push(candidate);
      }
    }
  }
  return dups;
}

function runCmd(cmd, args, dryRun) {
  const display = [cmd, ...args].join(" ");
  if (dryRun) {
    console.log(`[dry-run] 将执行: ${display}`);
    return;
  }
  console.log(`▶ 执行: ${display}`);
  execFileSync(cmd, args, { stdio: "inherit" });
}

function installPi(dryRun) {
  console.log("\n=== 安装目标：Pi 完整扩展包（技能 + /zee-mode + 短命令 + 路径锁 + zee_subagent） ===");
  if (!hasBinary("pi")) {
    console.error("未检测到 pi 命令。请先安装 @earendil-works/pi-coding-agent，或手动执行：");
    console.error("  pi install git:github.com/zee820232/zee");
    process.exitCode = 1;
    return;
  }
  const dups = findDuplicateSkillDirs(path.join(HOME, ".pi", "agent", "skills"));
  if (dups.length > 0) {
    console.log(`检测到 ${dups.length} 个旧的手动技能副本（会触发 Pi 重名冲突），先清理：`);
    for (const d of dups) {
      if (dryRun) console.log(`[dry-run] 将删除旧副本: ${d}`);
      else fs.rmSync(d, { recursive: true, force: true });
    }
  }
  runCmd("pi", ["install", REPO_ROOT], dryRun);
  console.log("✅ Pi 安装完成！进入 Pi 后可直接使用 /zee-mode auto、/zee、/zee-plan、/zee-setup。");
}

function installAgy(dryRun) {
  console.log("\n=== 安装目标：Google Antigravity (agy) 原生插件（6 技能 + 7 代理 + 安全/规划 Hook） ===");
  if (!hasBinary("agy")) {
    console.error("未检测到 agy 命令。请先安装 Google Antigravity CLI，或手动执行：");
    console.error("  agy plugin install https://github.com/zee820232/zee");
    process.exitCode = 1;
    return;
  }
  const dups = findDuplicateSkillDirs(path.join(HOME, ".gemini", "config", "skills"));
  if (dups.length > 0) {
    console.log(`检测到 ${dups.length} 个旧的手动技能副本（会与插件技能重复），先清理：`);
    for (const d of dups) {
      if (dryRun) console.log(`[dry-run] 将删除旧副本: ${d}`);
      else fs.rmSync(d, { recursive: true, force: true });
    }
  }
  runCmd("agy", ["plugin", "validate", "--strict", REPO_ROOT], dryRun);
  runCmd("agy", ["plugin", "install", REPO_ROOT], dryRun);
  console.log("✅ Google Antigravity 安装完成！");
  console.log("   - 启动专属总控代理：agy --agent zee（或在 CLI 输入 /agents 选择 zee）");
  console.log("   - 直接调用斜杠命令：/zee、/zee-plan、/zee-init、/zee-review、/zee-night、/zee-setup");
}

function installUniversalSkills(dryRun) {
  console.log("\n=== 安装目标：通用 Agent Skills（T3 Code / Claude Code / Codex / Cursor / OpenCode） ===");
  runCmd("npx", ["skills", "add", "zee820232/zee"], dryRun);
}

function printHelp() {
  console.log(`zee 多宿主安装器 — 安装时自由选择目标宿主（装在哪就只管哪一个）

用法：
  node scripts/install.mjs                       交互式菜单选择宿主
  node scripts/install.mjs --target <目标>       直接安装到指定宿主
  node scripts/install.mjs --target <目标> --dry-run

可选目标 (--target)：
  pi       安装为 Pi 完整扩展包（pi install）
  agy      安装为 Google Antigravity 原生插件（agy plugin install）
  skills   使用 npx skills add 安装到其他通用 Harness
  both     同时安装 Pi + Google Antigravity
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const dryRun = args.includes("--dry-run");
  const targetIdx = args.indexOf("--target");
  let target = targetIdx >= 0 ? (args[targetIdx + 1] || "").toLowerCase() : "";

  if (!target) {
    const piDetected = hasBinary("pi") ? "已检测到" : "未检测到";
    const agyDetected = hasBinary("agy") ? "已检测到" : "未检测到";
    console.log(`zee 工作流安装向导（仓库路径：${REPO_ROOT}）\n`);
    console.log(`  1) Pi 完整扩展包（${piDetected} pi）— 含 /zee-mode、短命令、路径锁、并行 zee_subagent`);
    console.log(`  2) Google Antigravity 原生插件（${agyDetected} agy）— 含 agy --agent zee、6 专用子代理、安全/规划 Hook`);
    console.log(`  3) 通用 Agent Skills（npx skills add）— 适用于 T3 Code / Claude Code / Codex / Cursor / OpenCode`);
    console.log(`  4) 同时安装 Pi + Google Antigravity`);
    console.log(`  0) 取消\n`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const choice = (await rl.question("请选择要安装的宿主编号 [1/2/3/4/0]: ")).trim();
    rl.close();

    const map = { "1": "pi", "2": "agy", "3": "skills", "4": "both", "0": "cancel" };
    target = map[choice] || "";
    if (target === "cancel") {
      console.log("已取消安装。");
      return;
    }
  }

  switch (target) {
    case "pi":
      installPi(dryRun);
      break;
    case "agy":
      installAgy(dryRun);
      break;
    case "skills":
      installUniversalSkills(dryRun);
      break;
    case "both":
      installPi(dryRun);
      installAgy(dryRun);
      break;
    default:
      console.error(`未知安装目标 "${target}"。可用值：pi | agy | skills | both`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("安装失败：", err.message || err);
  process.exit(1);
});
