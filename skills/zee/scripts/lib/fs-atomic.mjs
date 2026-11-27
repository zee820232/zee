/**
 * Windows-safe 共享文件锁与原子 JSON 写入工具（zee v5.2.0）
 *
 * 1. withFileLock：基于 O_EXCL 独占锁 + UUID owner token 校验 + renameSync 原子回收陈旧锁
 *    + Windows EPERM/EACCES/EBUSY 退避重试，杜绝并发 RMW 丢更新与跨进程误删活锁
 * 2. atomicWriteJson：独立临时文件 + EPERM/EBUSY/EACCES 退避重命名 + finally 强制清理孤儿临时文件
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const RETRYABLE_LOCK_CODES = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);

function sleepSync(ms) {
  const safeMs = Math.max(1, Math.min(2000, Math.round(ms)));
  Atomics.wait(SLEEP_ARRAY, 0, 0, safeMs);
}

function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === "EPERM");
  }
}

function tryAtomicReclaim(lockPath) {
  const reclaimPath = `${lockPath}.reclaim.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.renameSync(lockPath, reclaimPath);
    try {
      fs.rmSync(reclaimPath, { force: true });
    } catch {}
    return true;
  } catch (e) {
    return Boolean(e && e.code === "ENOENT");
  }
}

function tryReclaimStaleLock(lockPath, staleMs) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const data = JSON.parse(raw);
    const ts = Number(data?.ts) || 0;
    const pid = Number(data?.pid);
    const expired = ts > 0 && Date.now() - ts > staleMs;
    const dead = pid > 0 && !isPidAlive(pid);
    if (expired || dead) {
      return tryAtomicReclaim(lockPath);
    }
  } catch (e) {
    if (e && e.code === "ENOENT") return true;
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs > staleMs) {
        return tryAtomicReclaim(lockPath);
      }
    } catch (statErr) {
      return Boolean(statErr && statErr.code === "ENOENT");
    }
  }
  return false;
}

export function withFileLock(targetPath, fn, { timeoutMs = 5000, staleMs = 15000 } = {}) {
  const resolved = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const lockPath = `${resolved}.lock`;
  const deadline = Date.now() + Math.max(50, timeoutMs);
  const token = crypto.randomUUID();

  let acquired = false;
  let attempt = 0;
  while (!acquired) {
    let lockFd = -1;
    let createdFile = false;
    try {
      lockFd = fs.openSync(lockPath, "wx");
      createdFile = true;
      fs.writeSync(lockFd, JSON.stringify({ pid: process.pid, ts: Date.now(), token }) + "\n");
      fs.closeSync(lockFd);
      lockFd = -1;
      acquired = true;
    } catch (e) {
      if (lockFd >= 0) {
        try { fs.closeSync(lockFd); } catch {}
        lockFd = -1;
      }
      if (createdFile) {
        try { fs.rmSync(lockPath, { force: true }); } catch {}
      }
      if (!e || !RETRYABLE_LOCK_CODES.has(e.code)) throw e;
      if (e.code === "EEXIST" && tryReclaimStaleLock(lockPath, staleMs)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`获取文件锁超时 (${timeoutMs}ms): ${lockPath}`);
      }
      attempt += 1;
      const backoff = Math.min(100, 12 + attempt * 8) + Math.floor(Math.random() * 18);
      sleepSync(backoff);
    }
  }

  try {
    const result = fn();
    if (result && typeof result === "object" && typeof result.then === "function") {
      throw new Error("withFileLock 仅支持同步回调，禁止传入返回 Promise 的异步函数");
    }
    return result;
  } finally {
    try {
      const currentRaw = fs.readFileSync(lockPath, "utf8");
      const currentData = JSON.parse(currentRaw);
      if (currentData?.token === token) {
        fs.rmSync(lockPath, { force: true });
      }
    } catch {}
  }
}

export function atomicWriteJson(filePath, obj, { retries = 8 } = {}) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const payload = JSON.stringify(obj, null, 2) + "\n";
  const rand = Math.random().toString(36).slice(2, 8);
  const tmp = `${resolved}.tmp.${process.pid}.${Date.now()}.${rand}`;

  try {
    fs.writeFileSync(tmp, payload, "utf8");
    let renamed = false;
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
      try {
        fs.renameSync(tmp, resolved);
        renamed = true;
        break;
      } catch (e) {
        lastErr = e;
        if (!e || (e.code !== "EPERM" && e.code !== "EBUSY" && e.code !== "EACCES")) {
          throw e;
        }
        sleepSync(15 + i * 15 + Math.floor(Math.random() * 15));
      }
    }
    if (!renamed) {
      try {
        fs.writeFileSync(resolved, payload, "utf8");
      } catch (fallbackErr) {
        throw lastErr || fallbackErr;
      }
    }
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
  }
}

export function cleanStaleTempFiles(dirPath, maxAgeMs = 60_000) {
  if (!dirPath || !fs.existsSync(dirPath)) return 0;
  let removed = 0;
  const now = Date.now();
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const match = ent.name.match(/\.tmp\.(\d+)\.[^.]+/);
    if (!match) continue;
    const pid = Number(match[1]);
    const fullPath = path.join(dirPath, ent.name);
    let stale = pid > 0 && !isPidAlive(pid);
    if (!stale) {
      try {
        const st = fs.statSync(fullPath);
        if (now - st.mtimeMs > maxAgeMs) stale = true;
      } catch {
        stale = false;
      }
    }
    if (stale) {
      try {
        fs.rmSync(fullPath, { force: true });
        removed += 1;
      } catch {}
    }
  }
  return removed;
}
