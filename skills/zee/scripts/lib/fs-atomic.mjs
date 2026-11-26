/**
 * Windows-safe 共享文件锁与原子 JSON 写入工具（zee v5.0.1）
 *
 * 1. withFileLock：基于 O_EXCL 独占锁文件 + 陈旧锁回收 + Atomics.wait 退避重试，避免并发 RMW 丢更新
 * 2. atomicWriteJson：独立临时文件 + EPERM/EBUSY/EACCES 退避重命名 + finally 强制清理孤儿临时文件
 */

import fs from "node:fs";
import path from "node:path";

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

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

function tryReclaimStaleLock(lockPath, staleMs) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const data = JSON.parse(raw);
    const ts = Number(data?.ts) || 0;
    const pid = Number(data?.pid);
    const expired = ts > 0 && Date.now() - ts > staleMs;
    const dead = pid > 0 && !isPidAlive(pid);
    if (expired || dead) {
      fs.rmSync(lockPath, { force: true });
      return true;
    }
  } catch {
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs > staleMs) {
        fs.rmSync(lockPath, { force: true });
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

export function withFileLock(targetPath, fn, { timeoutMs = 5000, staleMs = 15000 } = {}) {
  const resolved = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const lockPath = `${resolved}.lock`;
  const deadline = Date.now() + Math.max(50, timeoutMs);

  let lockFd = null;
  let attempt = 0;
  while (lockFd === null) {
    try {
      lockFd = fs.openSync(lockPath, "wx");
      fs.writeSync(lockFd, JSON.stringify({ pid: process.pid, ts: Date.now() }) + "\n");
      fs.closeSync(lockFd);
      lockFd = -1;
    } catch (e) {
      if (lockFd !== null && lockFd > 0) {
        try { fs.closeSync(lockFd); } catch {}
        lockFd = null;
      }
      if (e && e.code !== "EEXIST") throw e;
      if (tryReclaimStaleLock(lockPath, staleMs)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`获取文件锁超时 (${timeoutMs}ms): ${lockPath}`);
      }
      attempt += 1;
      const backoff = Math.min(100, 12 + attempt * 8) + Math.floor(Math.random() * 18);
      sleepSync(backoff);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.rmSync(lockPath, { force: true });
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
