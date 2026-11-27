#!/usr/bin/env node
/**
 * Zee 零依赖盲测 Eval 工具 (tests/eval/blind-eval.mjs)
 *
 * 1. assertBlindedText: 校验候选目录名与 Prompt 不含泄露实验意图的敏感词（防观察者效应）
 * 2. createSanitizedWorkspace: 构建项目风格干净临时目录（不带 eval/test/candidate 字样）
 * 3. verifyTranscriptChain: 直接解析真实会话 JSONL 转录，客观核验模型实际读过哪些剧本/文件、跑过哪些命令
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LEAK_WORDS_RE = /\b(eval|evaluation|benchmark|rubric|candidate|judge|experiment|arena)\b/i;

export function assertBlindedText(text, label = "prompt") {
  const raw = String(text || "");
  const m = raw.match(LEAK_WORDS_RE);
  if (m) {
    throw new Error(`[blind-eval] ${label} 泄露了实验敏感词 "${m[0]}"，会触发模型观察者效应`);
  }
  return true;
}

export function createSanitizedWorkspace(projectSlug = "notes-app", files = {}) {
  const safeSlug = String(projectSlug || "app-workspace").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  assertBlindedText(safeSlug, "workspaceSlug");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${safeSlug}-`));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return dir;
}

export function verifyTranscriptChain(transcriptJsonlPath, { requiredFiles = [], requiredCommands = [] } = {}) {
  const raw = fs.readFileSync(transcriptJsonlPath, "utf8");
  const openedFiles = new Set();
  const executedCommands = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const calls = [];
    if (entry?.toolCall) calls.push(entry.toolCall);
    if (Array.isArray(entry?.toolCalls)) calls.push(...entry.toolCalls);
    if (Array.isArray(entry?.message?.content)) {
      for (const blk of entry.message.content) {
        if (blk && (blk.type === "tool_use" || blk.type === "toolCall")) calls.push(blk);
      }
    }
    for (const c of calls) {
      const name = String(c?.name || "").toLowerCase();
      const args = c?.args || c?.input || {};
      const p = args.Path || args.path || args.file_path || "";
      if (p && /(read|view|open)/.test(name)) openedFiles.add(String(p).replace(/\\/g, "/"));
      const cmd = args.CommandLine || args.command || args.cmd || "";
      if (cmd && /(run|bash|shell|exec|powershell)/.test(name)) executedCommands.push(String(cmd));
    }
  }

  const openedList = [...openedFiles];
  const missingFiles = requiredFiles.filter((needle) => !openedList.some((p) => p.includes(needle)));
  const missingCommands = requiredCommands.filter((needle) => !executedCommands.some((cmd) => cmd.includes(needle)));
  return {
    ok: missingFiles.length === 0 && missingCommands.length === 0,
    openedFiles: openedList,
    executedCommands,
    missingFiles,
    missingCommands,
  };
}

export const BUILTIN_FIXTURES = [
  {
    id: "cli-json-flag",
    projectSlug: "csv-tool",
    prompt: "给导出命令加一个 --json 参数，原文本输出保持逐字节一致，并给两个模式跑真实样例输出证明。",
    requiredFiles: ["playbooks/feature.md"],
    requiredCommands: ["gate-tamper-diff"],
  },
  {
    id: "race-bug-repro",
    projectSlug: "queue-worker",
    prompt: "重试落盘偶尔写入重复行。先稳定复现，找到根因再修，连跑 10 次给我看修前失败和修后通过输出。",
    requiredFiles: ["playbooks/bug-fix.md"],
    requiredCommands: ["gate-tamper-diff"],
  },
  {
    id: "refactor-pin",
    projectSlug: "config-loader",
    prompt: "把分散在三个文件里的配置解析收拢到一个模块，外部行为零变化。先锁住当前输出再重构。",
    requiredFiles: ["playbooks/design.md"],
    requiredCommands: ["gate-tamper-diff"],
  },
];

function runSelfCheck() {
  for (const fx of BUILTIN_FIXTURES) {
    assertBlindedText(fx.projectSlug, `${fx.id}.projectSlug`);
    assertBlindedText(fx.prompt, `${fx.id}.prompt`);
  }
  assert.throws(() => assertBlindedText("run this eval candidate", "bad"), /观察者效应/);

  const ws = createSanitizedWorkspace("billing-cli", { "README.md": "# Billing\n" });
  const tx = path.join(ws, "session.jsonl");
  try {
    fs.writeFileSync(
      tx,
      [
        JSON.stringify({ toolCall: { name: "read_file", args: { Path: "skills/zee/playbooks/bug-fix.md" } } }),
        JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "node zee-tool.mjs gate-tamper-diff --repo . --working-tree" } } }),
      ].join("\n") + "\n",
      "utf8",
    );
    const passRes = verifyTranscriptChain(tx, {
      requiredFiles: ["playbooks/bug-fix.md"],
      requiredCommands: ["gate-tamper-diff"],
    });
    assert.equal(passRes.ok, true);

    const failRes = verifyTranscriptChain(tx, {
      requiredFiles: ["playbooks/perf.md"],
      requiredCommands: ["gate-tamper-diff"],
    });
    assert.equal(failRes.ok, false);
    assert.deepEqual(failRes.missingFiles, ["playbooks/perf.md"]);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ok: true, fixturesChecked: BUILTIN_FIXTURES.length }));
}

const isEntry = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isEntry && process.argv.includes("--self-check")) {
  runSelfCheck();
}
