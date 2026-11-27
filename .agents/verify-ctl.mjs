#!/usr/bin/env node
/**
 * zee 项目自举确定性验证控制器 (.agents/verify-ctl.mjs)
 *
 * 子命令：
 *   doctor          纯只读环境、清单与语法自检
 *   run [--json]    执行全量语法/类型检查、单元测试、CLI 体检、安装器 dry-run 与端到端总线冒烟
 *   cleanup         清理 verify-ctl 产生的临时状态目录（绝不删除证据产物）
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZEE_TOOL = path.join(REPO_ROOT, "skills", "zee", "scripts", "zee-tool.mjs");
const INSTALL_SCRIPT = path.join(REPO_ROOT, "scripts", "install.mjs");
const TMP_PREFIX = "zee-verifyctl-";

function collectSourceFiles(dirs, exts) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === ".git" || ent.name === "node_modules") continue;
        walk(full);
      } else if (ent.isFile() && exts.some((ext) => ent.name.endsWith(ext))) {
        out.push(full);
      }
    }
  };
  for (const d of dirs) walk(path.join(REPO_ROOT, d));
  return out.sort();
}

function runCmd(name, bin, args, { cwd = REPO_ROOT, env = {} } = {}) {
  const started = Date.now();
  const res = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const ok = res.status === 0;
  return {
    name,
    ok,
    exitCode: res.status ?? 1,
    durationMs: Date.now() - started,
    ...(ok ? {} : { stderr: String(res.stderr || res.stdout || "").trim().slice(0, 600) }),
  };
}

function runSyntaxChecks() {
  const files = collectSourceFiles(["scripts", "skills", "pi-extension", ".agents"], [".mjs", ".ts"]);
  const failures = [];
  const started = Date.now();
  for (const file of files) {
    const res = spawnSync(process.execPath, ["--check", file], { cwd: REPO_ROOT, encoding: "utf8" });
    if (res.status !== 0) {
      failures.push(`${path.relative(REPO_ROOT, file)}: ${String(res.stderr || "").trim()}`);
    }
  }
  return {
    name: "syntax-typecheck",
    ok: failures.length === 0,
    checkedFiles: files.length,
    durationMs: Date.now() - started,
    ...(failures.length ? { errors: failures } : {}),
  };
}

function runEndToEndBusSmoke() {
  const started = Date.now();
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  let busDir = "";
  let sandboxDir = "";
  try {
    const step = (args) => {
      const res = spawnSync(process.execPath, [ZEE_TOOL, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
      if (res.status !== 0) throw new Error(`${args[0]} failed (${res.status}): ${res.stderr || res.stdout}`);
      return JSON.parse(res.stdout);
    };
    const init = step(["init-run", tmpRepo, "verify-smoke", "--ensure-git"]);
    busDir = init.busDir;
    step(["update-state", busDir, "--status", "running", "--unit-upsert", JSON.stringify({ id: "U1", status: "done" })]);
    step(["log-decision", busDir, "--unit", "U1", "--phase", "verify", "--decision", "smoke-ok", "--why", "e2e", "--result", "pass"]);
    step(["finding", "add", "--repo", tmpRepo, "--pattern", "smoke-pat", "--summary", "sample"]);
    const recalled = step(["recall", "--repo", tmpRepo, "--topic", "smoke"]);
    if (!recalled.capsule?.decisions?.length || !recalled.capsule?.openFindings?.length) {
      throw new Error("recall 未命中刚写入的决策或园艺项");
    }
    step(["finding", "resolve", "--repo", tmpRepo, "--pattern", "smoke-pat", "--note", "cleaned"]);
    const sbx = step(["sandbox-export", "--repo", tmpRepo, "--working-tree", "--prefix", "verify"]);
    sandboxDir = sbx.sandboxDir;
    const tamper = step(["gate-tamper-diff", "--repo", tmpRepo, "--working-tree"]);
    if (tamper.requiresCountersign !== false) {
      throw new Error("干净冒烟仓库不应触发 requiresCountersign");
    }
    step(["sandbox-clean", sandboxDir]);
    sandboxDir = "";
    return { name: "e2e-bus-smoke", ok: true, durationMs: Date.now() - started };
  } catch (err) {
    return { name: "e2e-bus-smoke", ok: false, durationMs: Date.now() - started, error: err.message };
  } finally {
    if (sandboxDir && fs.existsSync(sandboxDir)) fs.rmSync(sandboxDir, { recursive: true, force: true });
    if (busDir && fs.existsSync(path.dirname(busDir))) fs.rmSync(path.dirname(busDir), { recursive: true, force: true });
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
}

function cmdDoctor(asJson) {
  const checks = [
    { name: "node-runtime", ok: Number(process.versions.node.split(".")[0]) >= 20, version: process.version },
    { name: "zee-tool-exists", ok: fs.existsSync(ZEE_TOOL) },
    { name: "feature-map-exists", ok: fs.existsSync(path.join(REPO_ROOT, ".agents", "verify-features", "README.md")) },
    runSyntaxChecks(),
  ];
  const ok = checks.every((c) => c.ok);
  const out = { ok, mode: "doctor", repoRoot: REPO_ROOT, checks, cleanupPid: null };
  console.log(asJson ? JSON.stringify(out, null, 2) : `verify-ctl doctor: ${ok ? "PASS" : "FAIL"} (${checks.filter((c) => c.ok).length}/${checks.length})`);
  process.exit(ok ? 0 : 1);
}

function cmdRun(asJson) {
  const checks = [
    runSyntaxChecks(),
    runCmd("unit-tests", process.execPath, ["--test", "tests/agy-hook.test.mjs", "tests/guard-core.test.mjs", "tests/manifest-and-skills.test.mjs", "tests/pi-extension.test.mjs", "tests/zee-tool.test.mjs"]),
    runCmd("zee-doctor", process.execPath, [ZEE_TOOL, "doctor", "--repo", REPO_ROOT]),
    runCmd("install-dry-run", process.execPath, [INSTALL_SCRIPT, "--target", "skills", "--dry-run"]),
    runEndToEndBusSmoke(),
  ];
  const ok = checks.every((c) => c.ok);
  const out = { ok, mode: "run", repoRoot: REPO_ROOT, checks, cleanupPid: null };
  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const c of checks) {
      console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name} (${c.durationMs ?? 0}ms)`);
      if (!c.ok && (c.stderr || c.error || c.errors)) {
        console.error(c.stderr || c.error || c.errors.join("\n"));
      }
    }
  }
  process.exit(ok ? 0 : 1);
}

function cmdCleanup(asJson) {
  const tmpDir = os.tmpdir();
  let removed = 0;
  for (const name of fs.readdirSync(tmpDir)) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    try {
      fs.rmSync(path.join(tmpDir, name), { recursive: true, force: true });
      removed += 1;
    } catch {}
  }
  const out = { ok: true, mode: "cleanup", removedTempDirs: removed, evidencePreserved: true };
  console.log(asJson ? JSON.stringify(out, null, 2) : `verify-ctl cleanup: removed ${removed} temp dirs (evidence preserved)`);
}

const [, , sub = "run", ...rest] = process.argv;
const asJson = rest.includes("--json");
if (sub === "doctor") cmdDoctor(asJson);
else if (sub === "run" || sub === "launch") cmdRun(asJson);
else if (sub === "cleanup") cmdCleanup(asJson);
else {
  console.error("用法：node .agents/verify-ctl.mjs <doctor|run|cleanup> [--json]");
  process.exit(1);
}
