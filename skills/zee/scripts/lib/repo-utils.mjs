/**
 * zee 共享仓库 / 路径 / Worktree / 进程与文本安全辅助模块（v5.1.0）
 *
 * 统一收敛 pi-extension/index.ts、skills/zee/scripts/zee-tool.mjs 与 scripts/agy-guard.mjs
 * 的公共逻辑，消除三处重复实现与跨平台漂移。
 */

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sanitizeSlug(s) {
  return (
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "task"
  );
}

export function normalizeRepoPathForKey(repoPath) {
  const absRepo = path.resolve(repoPath);
  if (process.platform === "win32") {
    return absRepo.toLowerCase();
  }
  return absRepo;
}

export function repoKeyFor(repoPath) {
  const absRepo = path.resolve(repoPath);
  const canonical = normalizeRepoPathForKey(absRepo);
  const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  return `${sanitizeSlug(path.basename(absRepo))}-${hash}`;
}

export function repoKeyCandidates(repoPath) {
  const absRepo = path.resolve(repoPath);
  const canonicalKey = repoKeyFor(absRepo);
  const keys = [canonicalKey];
  if (process.platform === "win32") {
    const legacyHash = crypto.createHash("sha256").update(absRepo).digest("hex").slice(0, 8);
    const legacyKey = `${sanitizeSlug(path.basename(absRepo))}-${legacyHash}`;
    if (!keys.includes(legacyKey)) keys.push(legacyKey);
    const upperDrive = absRepo.replace(/^[a-z]:/, (m) => m.toUpperCase());
    const upperHash = crypto.createHash("sha256").update(upperDrive).digest("hex").slice(0, 8);
    const upperKey = `${sanitizeSlug(path.basename(absRepo))}-${upperHash}`;
    if (!keys.includes(upperKey)) keys.push(upperKey);
  }
  return keys;
}

export function resolveRepoRunDir(runsRoot, repoPath) {
  const keys = repoKeyCandidates(repoPath);
  for (const k of keys) {
    const candidate = path.join(runsRoot, k);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(runsRoot, keys[0]);
}

export function resolveSafeWorktreeBranch(absRepo, rawBranch) {
  let candidate = String(rawBranch || "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^\/+|\/+$/g, "");
  let flattened = false;
  const refExists = (refName) => {
    try {
      execFileSync("git", ["-C", absRepo, "show-ref", "--verify", "--quiet", refName], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  const hasChildRefs = (prefix) => {
    try {
      return (
        execFileSync("git", ["-C", absRepo, "for-each-ref", "--format=%(refname)", `refs/heads/${prefix}/`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim().length > 0
      );
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
      flattened = true;
      continue;
    }
    if (candidate && hasChildRefs(candidate)) {
      candidate = `${candidate}-wt`;
      flattened = true;
      continue;
    }
    break;
  }
  return { branch: candidate, flattened };
}

export function ensureNodeModulesMount(absRepo, wtPath) {
  const src = path.join(absRepo, "node_modules");
  const dst = path.join(wtPath, "node_modules");
  if (!fs.existsSync(src) || fs.existsSync(dst)) return false;
  try {
    if (
      execFileSync("git", ["-C", absRepo, "ls-files", "node_modules"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
    ) {
      return false;
    }
    const exRel = execFileSync("git", ["-C", wtPath, "rev-parse", "--git-path", "info/exclude"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const exFile = path.resolve(wtPath, exRel);
    fs.mkdirSync(path.dirname(exFile), { recursive: true });
    const existing = fs.existsSync(exFile) ? fs.readFileSync(exFile, "utf8") : "";
    if (!existing.split(/\r?\n/).some((l) => l.trim() === "/node_modules" || l.trim() === "node_modules")) {
      fs.appendFileSync(exFile, `${existing && !existing.endsWith("\n") ? "\n" : ""}/node_modules\n`, "utf8");
    }
    fs.symlinkSync(src, dst, process.platform === "win32" ? "junction" : undefined);
    return true;
  } catch {
    return false;
  }
}

export function stripAnsiAndControl(input) {
  return String(input ?? "")
    // OSC sequences: ESC ] ... BEL or ESC \
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI / ANSI escape sequences: ESC [ ... final byte
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // Remaining two-char ESC sequences
    .replace(/\x1b[@-Z\\-_]/g, "")
    // C0/C1 control characters except \t (\x09), \n (\x0a), \r (\x0d)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

export function killProcessTree(proc, { force = false } = {}) {
  if (!proc) return;
  const pid = Number(proc.pid);
  if (process.platform === "win32" && Number.isInteger(pid) && pid > 0) {
    const res = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 3000,
    });
    if (!res.error && res.status === 0) return;
  }
  try {
    proc.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // Process already exited
  }
}
