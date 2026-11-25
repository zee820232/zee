import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RUNS_ROOT } from "../skills/zee/scripts/lib/guard-core.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 为 Pi 可选 peerDependencies 注册轻量内存桩，直接用 Node 原生 TS 运行真实行为单测
module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { url: "zee-mock://pi-coding-agent", shortCircuit: true };
    }
    if (specifier === "typebox") {
      return { url: "zee-mock://typebox", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "zee-mock://pi-coding-agent") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const DEFAULT_MAX_BYTES = 32768;
          export const DEFAULT_MAX_LINES = 500;
          export function isToolCallEventType(name, evt) {
            return Boolean(evt && evt.toolName === name);
          }
          export function truncateHead(text, opts = {}) {
            const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
            const buf = Buffer.from(String(text || ""), "utf8");
            if (buf.length <= maxBytes) {
              return { truncated: false, content: String(text || ""), totalBytes: buf.length, outputBytes: buf.length };
            }
            const sliced = buf.subarray(0, maxBytes).toString("utf8");
            return { truncated: true, content: sliced, totalBytes: buf.length, outputBytes: Buffer.byteLength(sliced, "utf8") };
          }
        `,
      };
    }
    if (url === "zee-mock://typebox") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const Type = {
            Object: (p, o) => ({ type: "object", properties: p, ...o }),
            String: (o) => ({ type: "string", ...o }),
            Number: (o) => ({ type: "number", ...o }),
            Boolean: (o) => ({ type: "boolean", ...o }),
            Array: (i, o) => ({ type: "array", items: i, ...o }),
            Optional: (x) => ({ optional: true, inner: x }),
            Union: (x, o) => ({ union: x, ...o }),
            Literal: (v) => ({ literal: v }),
          };
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { default: zeeExtension, resolvePiProviderModel, resolveSafeWorktreeBranch } = await import(
  pathToFileURL(path.join(REPO_ROOT, "pi-extension", "index.ts")).href
);
const { default: zeeWorkerGuard } = await import(pathToFileURL(path.join(REPO_ROOT, "pi-extension", "worker-guard.ts")).href);

function createMockPi() {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  const messages = [];
  const flags = new Map();

  const pi = {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    registerFlag(name, spec) {
      flags.set(name, spec.default);
    },
    getFlag(name) {
      return flags.get(name);
    },
    registerCommand(name, spec) {
      commands.set(name, spec);
    },
    registerTool(spec) {
      tools.set(spec.name, spec);
    },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage(msg, opts) {
      messages.push({ msg, opts });
    },
  };

  const makeCtx = (cwd, hasUI = true) => ({
    cwd,
    hasUI,
    sessionManager: {
      getBranch: () => entries,
    },
    ui: {
      statuses: new Map(),
      notices: [],
      setStatus(k, v) {
        this.statuses.set(k, v);
      },
      notify(msg, level) {
        this.notices.push({ msg, level });
      },
    },
  });

  const emit = (eventName, event, ctx) => {
    let last;
    for (const fn of handlers.get(eventName) || []) {
      last = fn(event, ctx);
      if (last !== undefined) return last;
    }
    return last;
  };

  return { pi, handlers, commands, tools, entries, messages, flags, makeCtx, emit };
}

test("行为测试 [H5]：/zee plan 空格子命令正确上锁、init-design 磁盘自动解锁、auto 模式注入 <zeeDir> 绝对路径", async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-pi-beh-"));
  try {
    const mock = createMockPi();
    zeeExtension(mock.pi);
    const ctx = mock.makeCtx(tmpRepo, true);

    // 1. /zee 快捷命令支持 9 个技能入口（含新增 /zee-verify）+ /zee-mode
    for (const cmd of ["zee", "zee-plan", "zee-init", "zee-review", "zee-verify", "zee-arch", "zee-retro", "zee-night", "zee-setup", "zee-mode"]) {
      assert.ok(mock.commands.has(cmd), `缺少命令 /${cmd}`);
    }
    // /zee-verify run 启用只读 review 锁，/zee-verify init 放行写验证技能
    await mock.commands.get("zee-verify").handler("run", ctx);
    assert.equal(mock.emit("tool_call", { toolName: "write", input: { path: "src/app.ts" } }, ctx)?.block, true);
    await mock.commands.get("zee-verify").handler("init", ctx);
    assert.equal(mock.emit("tool_call", { toolName: "write", input: { path: ".agents/skills/verify-demo/SKILL.md" } }, ctx), undefined);

    // 2. /zee plan 设计新特性 -> 必须启用 plan 写锁
    await mock.commands.get("zee").handler("plan 设计新特性", ctx);
    const blocked = mock.emit("tool_call", { toolName: "write", input: { path: "src/app.ts" } }, ctx);
    assert.equal(blocked?.block, true);
    const allowedGlossary = mock.emit("tool_call", { toolName: "write", input: { path: "GLOSSARY.md" } }, ctx);
    assert.equal(allowedGlossary, undefined);

    // 3. 切入 /zee-init -> 锁 init-design；当磁盘已存在 .agents/zee.project.json 时 tool_call 实时解锁
    await mock.commands.get("zee-init").handler("新建项目", ctx);
    assert.equal(mock.emit("tool_call", { toolName: "write", input: { path: "src/main.ts" } }, ctx)?.block, true);
    fs.mkdirSync(path.join(tmpRepo, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".agents", "zee.project.json"), "{}");
    assert.equal(mock.emit("tool_call", { toolName: "write", input: { path: "src/main.ts" } }, ctx), undefined);

    // 4. 开启 /zee-mode auto -> before_agent_start 注入含真实 <zeeDir> 绝对路径的路由段
    await mock.commands.get("zee-mode").handler("auto", ctx);
    const startEvt = { messageType: "user", prompt: "做一个功能", systemPromptOptions: { sections: {} } };
    mock.emit("before_agent_start", startEvt, ctx);
    assert.ok(startEvt.systemPromptOptions.sections.zee.includes(path.join(REPO_ROOT, "skills", "zee")));
    assert.ok(startEvt.systemPromptOptions.sections.zee.includes("zee-arch"));
    assert.ok(startEvt.systemPromptOptions.sections.zee.includes("zee-retro"));
    assert.ok(startEvt.systemPromptOptions.sections.zee.includes("zee-verify"));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("行为测试 [C2]：worker-guard.ts 在子进程内拦截 denyCommands、破坏性命令与只读角色越权写仓", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-wg-beh-"));
  const prevRole = process.env.ZEE_ROLE;
  try {
    fs.mkdirSync(path.join(tmpRepo, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".agents", "zee.project.json"), JSON.stringify({ denyCommands: ["--live"] }));

    const mock = createMockPi();
    zeeWorkerGuard(mock.pi);
    const ctx = mock.makeCtx(tmpRepo, false);

    // coder 角色：放行普通写码，但硬拦截 denyCommands 与 bash -e -c 删根
    process.env.ZEE_ROLE = "coder";
    assert.equal(mock.emit("tool_call", { toolName: "write", input: { path: "src/a.ts" } }, ctx), undefined);
    assert.equal(mock.emit("tool_call", { toolName: "bash", input: { command: "node trade.js --live" } }, ctx)?.block, true);
    assert.equal(mock.emit("tool_call", { toolName: "bash", input: { command: 'bash -e -c "rm -rf /"' } }, ctx)?.block, true);

    // reviewer 角色：拦截 edit 与写仓，放行总线与 /tmp/zee-*
    process.env.ZEE_ROLE = "reviewer";
    assert.equal(mock.emit("tool_call", { toolName: "edit", input: { path: "src/a.ts" } }, ctx)?.block, true);
    assert.equal(mock.emit("tool_call", { toolName: "write", input: { path: "src/a.ts" } }, ctx)?.block, true);
    assert.equal(mock.emit("tool_call", { toolName: "write", input: { path: "/tmp/zee-rev-1/report.md" } }, ctx), undefined);
    assert.equal(mock.emit("tool_call", { toolName: "write", input: { path: path.join(RUNS_ROOT, "demo", "s", "r.md") } }, ctx), undefined);

    // scout 角色：纯只读 bash 拦截 git commit
    process.env.ZEE_ROLE = "scout";
    assert.equal(mock.emit("tool_call", { toolName: "bash", input: { command: "git commit -m 'sneak'" } }, ctx)?.block, true);
    assert.equal(mock.emit("tool_call", { toolName: "bash", input: { command: "git status" } }, ctx), undefined);
  } finally {
    if (prevRole === undefined) delete process.env.ZEE_ROLE;
    else process.env.ZEE_ROLE = prevRole;
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("行为测试 [C1/C2/C3/H6/M3]：真实驱动 zee_subagent 验证流式抢救优先级、精准增量脏区回滚、worker-guard 传参、rg 退出码 1 豁免与家族别名拦截", async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-sub-beh-"));
  const metaDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-sub-meta-"));
  const fakeBin = path.join(metaDir, "fake-pi.mjs");
  const prevBin = process.env.ZEE_PI_BIN;
  const prevScenario = process.env.FAKE_SCENARIO;
  const prevArgsDump = process.env.FAKE_ARGS_DUMP;

  try {
    // 初始化真实 git 仓库并制造用户未提交修改（验证 C1 零误杀）
    execFileSync("git", ["-C", tmpRepo, "init", "-b", "main"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.email", "test@zee.dev"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.name", "zee"], { stdio: "ignore" });
    fs.writeFileSync(path.join(tmpRepo, "user.txt"), "original-user\n");
    fs.writeFileSync(path.join(tmpRepo, "target.txt"), "original-target\n");
    execFileSync("git", ["-C", tmpRepo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "commit", "-m", "init"], { stdio: "ignore" });
    // 用户自己的未提交改动（绝不能被只读子代理脏区审计清掉！）
    fs.writeFileSync(path.join(tmpRepo, "user.txt"), "USER_UNCOMMITTED_WORK\n");

    // 编写可编程的假 Pi JSONL 子进程
    fs.writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

if (process.env.FAKE_ARGS_DUMP) {
  fs.writeFileSync(process.env.FAKE_ARGS_DUMP, JSON.stringify(process.argv.slice(2)), "utf8");
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const scenario = process.env.FAKE_SCENARIO;

if (scenario === "stream_rescue") {
  // Turn 1 结束（产出过渡废话）
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({ type: "message_end", message: { role: "assistant", content: "I will inspect the files first...", usage: { input: 10, output: 5, cost: { total: 0.01 } } } });
  // Turn 2 流式输出真正的高价值报告但超时前未 message_end
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "TURN2_REAL_FINAL_REPORT: " } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "all critical findings rescued!" } });
  setTimeout(() => {}, 30000);
} else if (scenario === "dirty_audit_and_rg") {
  // 连续 4 次只读 rg exit 1 不得触发 StagnancyTracker 误杀，且并发工具不缩看门狗
  for (let i = 1; i <= 4; i++) {
    const id = "rg-" + i;
    emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: "rg pattern_" + i + " src/" } });
    emit({ type: "tool_execution_end", toolCallId: id, toolName: "bash", isError: true });
  }
  // 模拟只读角色越权改了 target.txt 并新建 sneak.txt
  fs.writeFileSync(path.join(process.cwd(), "target.txt"), "CORRUPTED_BY_REVIEWER\\n");
  fs.writeFileSync(path.join(process.cwd(), "sneak.txt"), "untracked_sneak\\n");
  emit({ type: "message_end", message: { role: "assistant", content: "DONE_REVIEW", stopReason: "stop" } });
  process.exit(0);
}
`,
      { mode: 0o755 },
    );

    const mock = createMockPi();
    zeeExtension(mock.pi);
    const subTool = mock.tools.get("zee_subagent");
    assert.ok(subTool);
    const ctx = mock.makeCtx(tmpRepo, true);

    // M3: authorFamily 别名归一化拦截（anthropic === claude）
    await assert.rejects(
      () =>
        subTool.execute(
          "call-fam",
          { role: "reviewer", authorFamily: "anthropic", model: "claude-sonnet-4", task: "review" },
          undefined,
          undefined,
          ctx,
        ),
      /跨家族拦截/,
    );

    // C3 + C2: Turn 2 流式抢救压倒 Turn 1 旧正文，且命令行挂载了 worker-guard.ts
    const argsDump = path.join(metaDir, "args-dump.json");
    process.env.ZEE_PI_BIN = fakeBin;
    process.env.FAKE_SCENARIO = "stream_rescue";
    process.env.FAKE_ARGS_DUMP = argsDump;

    const rescueRes = await subTool.execute(
      "call-stream",
      { role: "reviewer", model: "gemini-4-neon", task: "[zee-worker] audit", timeoutMs: 5000 },
      AbortSignal.timeout(800),
      undefined,
      ctx,
    );
    const rescueOut = rescueRes.content[0].text;
    assert.ok(rescueOut.includes("TURN2_REAL_FINAL_REPORT: all critical findings rescued!"), `应优先抢救 Turn 2 流式正文，实际：\n${rescueOut}`);
    assert.ok(rescueOut.includes("[已抢救的部分输出（流式未结正文）]"));
    const passedArgs = JSON.parse(fs.readFileSync(argsDump, "utf8"));
    assert.ok(passedArgs.includes("-ne"));
    assert.ok(passedArgs.includes("-e"));
    assert.ok(passedArgs.some((a) => a.endsWith(path.join("pi-extension", "worker-guard.ts"))));

    // C1 + H6: 精准增量脏区回滚保留用户未提交修改，且 4 次 rg 无匹配不被 StagnancyTracker 误杀
    process.env.FAKE_SCENARIO = "dirty_audit_and_rg";
    const auditRes = await subTool.execute(
      "call-audit",
      { role: "reviewer", model: "gemini-4-neon", task: "[zee-worker] audit" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(auditRes.details.status, "completed");
    assert.equal(auditRes.details.roleViolation, true);
    assert.equal(fs.readFileSync(path.join(tmpRepo, "target.txt"), "utf8"), "original-target\n", "越权修改的 target.txt 必须精确回滚");
    assert.equal(fs.existsSync(path.join(tmpRepo, "sneak.txt")), false, "越权新建的 sneak.txt 必须删除");
    assert.equal(fs.readFileSync(path.join(tmpRepo, "user.txt"), "utf8"), "USER_UNCOMMITTED_WORK\n", "用户原有未提交修改必须 100% 保留！");
  } finally {
    if (prevBin === undefined) delete process.env.ZEE_PI_BIN;
    else process.env.ZEE_PI_BIN = prevBin;
    if (prevScenario === undefined) delete process.env.FAKE_SCENARIO;
    else process.env.FAKE_SCENARIO = prevScenario;
    if (prevArgsDump === undefined) delete process.env.FAKE_ARGS_DUMP;
    else process.env.FAKE_ARGS_DUMP = prevArgsDump;
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(metaDir, { recursive: true, force: true });
  }
});

test("v4.1.1 回归 [P1-1/P1-2/P1-3/P2-1/P2-2]：provider 自动归一、嵌套分支扁平化、预挂 node_modules 零误报、70% 截断与 >2KB 抢救落盘", async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v411-pi-"));
  const metaDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v411-meta-"));
  const fakeCfg = path.join(metaDir, "zee-config.json");
  const fakeBin = path.join(metaDir, "fake-pi.mjs");
  const busDir = path.join(metaDir, "bus");
  const prevBin = process.env.ZEE_PI_BIN;
  const prevScenario = process.env.FAKE_SCENARIO;
  let wtPathToClean = "";

  try {
    // 1. P1-2: resolvePiProviderModel 自动归一 remote-magpie + vm/... 与单模型名补全
    fs.writeFileSync(
      fakeCfg,
      JSON.stringify({
        version: 2,
        roles: {
          coder: {
            standard: {
              bindings: {
                pi: {
                  prefer: { providerInstanceId: "magpie", model: "remote-magpie/vm/claude-sonnet-5-5" },
                },
              },
            },
          },
          scout: {
            bindings: {
              pi: {
                prefer: { providerInstanceId: "magpie", model: "remote-magpie/devin/gemini-4-hydrogen" },
              },
            },
          },
        },
      }),
    );
    const norm1 = resolvePiProviderModel("remote-magpie", "vm/claude-sonnet-5-5", fakeCfg);
    assert.equal(norm1.provider, "magpie");
    assert.equal(norm1.model, "remote-magpie/vm/claude-sonnet-5-5");
    assert.equal(norm1.normalized, true);

    const norm2 = resolvePiProviderModel(undefined, "gemini-4-hydrogen", fakeCfg);
    assert.equal(norm2.provider, "magpie");
    assert.equal(norm2.model, "remote-magpie/devin/gemini-4-hydrogen");
    assert.equal(norm2.normalized, true);

    assert.throws(() => resolvePiProviderModel("remote-unknown", "vm/foo", fakeCfg), /Pi provider ID/);

    // 2. 初始化带 node_modules/ 尾斜杠 .gitignore 和嵌套冲突分支的真实仓库
    execFileSync("git", ["-C", tmpRepo, "init", "-b", "main"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.email", "test@zee.dev"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.name", "zee"], { stdio: "ignore" });
    fs.writeFileSync(path.join(tmpRepo, ".gitignore"), "node_modules/\n");
    fs.writeFileSync(path.join(tmpRepo, "index.ts"), "export const x = 1;\n");
    fs.mkdirSync(path.join(tmpRepo, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "node_modules", "pkg", "index.js"), "module.exports = 42;\n");
    execFileSync("git", ["-C", tmpRepo, "add", ".gitignore", "index.ts"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "commit", "-m", "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "branch", "zee/night-polish"], { stdio: "ignore" });

    // P2-1: 嵌套分支 zee/night-polish/u1 必须自动扁平化为 zee/night-polish-u1
    const safeBr = resolveSafeWorktreeBranch(tmpRepo, "zee/night-polish/u1");
    assert.equal(safeBr.branch, "zee/night-polish-u1");
    assert.equal(safeBr.flattened, true);

    // 3. 构造总线 state.json（预算 maxDelegates=3，70% 截断线为 3 -> 设 maxDelegates=4 截断线为 3，预置 dispatched=2 跑 1 次即触发！）
    fs.mkdirSync(path.join(busDir, "artifacts"), { recursive: true });
    fs.writeFileSync(
      path.join(busDir, "state.json"),
      JSON.stringify({
        slug: "v411-test",
        mode: "night",
        status: "running",
        delegatesDispatched: 2,
        budget: { maxDelegates: 4, cutoffRatio: 0.7 },
      }),
    );

    fs.writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
if (process.env.FAKE_SCENARIO === "verifier_ok") {
  const hasNm = fs.existsSync(path.join(process.cwd(), "node_modules", "pkg", "index.js"));
  emit({ type: "message_end", message: { role: "assistant", content: "NODE_MODULES_READY=" + hasNm, stopReason: "stop" } });
  process.exit(0);
}
if (process.env.FAKE_SCENARIO === "big_partial") {
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "SALVAGE_HEAD\\n" + "A".repeat(2500) } });
  setTimeout(() => {}, 30000);
}
`,
      { mode: 0o755 },
    );

    const mock = createMockPi();
    zeeExtension(mock.pi);
    const subTool = mock.tools.get("zee_subagent");
    const ctx = mock.makeCtx(tmpRepo, true);

    // P1-3 + P1-1: Verifier detached worktree 预挂 node_modules（零 ROLE_VIOLATION）+ 触发 70% [ZEE_BUDGET_CUTOFF] + delegatesDispatched 自动 +1
    process.env.ZEE_PI_BIN = fakeBin;
    process.env.FAKE_SCENARIO = "verifier_ok";
    const verRes = await subTool.execute(
      "call-v411-ver",
      {
        role: "verifier",
        busDir,
        worktree: { repoRoot: tmpRepo, slug: "v411-wt", lane: "verify-nm", baseRef: "HEAD" },
        task: "[zee-worker] verify",
      },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(verRes.content[0].text.includes("NODE_MODULES_READY=true"), "worktree 必须自动预挂只读 node_modules");
    assert.equal(verRes.details.roleViolation, undefined, "只读预挂 node_modules 绝不得触发 ROLE_VIOLATION 误报");
    assert.equal(verRes.details.worktreeCleaned, true, "detached worktree 结束后必须干净自动回收");
    assert.equal(verRes.details.budgetCutoffTriggered, true, "跨过 70% 预算必须触发截断标志");
    assert.ok(verRes.content[0].text.includes("[ZEE_BUDGET_CUTOFF]"));
    const stAfter = JSON.parse(fs.readFileSync(path.join(busDir, "state.json"), "utf8"));
    assert.equal(stAfter.delegatesDispatched, 3);

    // P2-2: >2KB 流式抢救正文自动落盘到 busDir/artifacts/partial-*.md，并记录 abortedDelegates
    process.env.FAKE_SCENARIO = "big_partial";
    const partRes = await subTool.execute(
      "call-v411-part",
      {
        role: "architect",
        busDir,
        task: "[zee-worker] design",
        timeoutMs: 5000,
      },
      AbortSignal.timeout(700),
      undefined,
      ctx,
    );
    assert.ok(partRes.details.partialArtifactPath && fs.existsSync(partRes.details.partialArtifactPath));
    assert.ok(fs.readFileSync(partRes.details.partialArtifactPath, "utf8").includes("SALVAGE_HEAD"));
    assert.ok(partRes.content[0].text.includes("[已落盘完整抢救稿]"));
    const stAfterAbort = JSON.parse(fs.readFileSync(path.join(busDir, "state.json"), "utf8"));
    assert.equal(stAfterAbort.abortedDelegates, 1);

    // 清理测试创建的 runs 目录
    wtPathToClean = verRes.details.worktreePath || "";
  } finally {
    if (prevBin === undefined) delete process.env.ZEE_PI_BIN;
    else process.env.ZEE_PI_BIN = prevBin;
    if (prevScenario === undefined) delete process.env.FAKE_SCENARIO;
    else process.env.FAKE_SCENARIO = prevScenario;
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(metaDir, { recursive: true, force: true });
    if (wtPathToClean) {
      fs.rmSync(path.dirname(path.dirname(path.dirname(wtPathToClean))), { recursive: true, force: true });
    }
  }
});
