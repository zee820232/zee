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
    if (specifier === "@earendil-works/pi-tui") {
      return { url: "zee-mock://pi-tui", shortCircuit: true };
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
          export function copyToClipboard(text) {
            globalThis.__zeePiExtMockClipboard = String(text ?? "");
          }
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
    if (url === "zee-mock://pi-tui") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const Key = {
            ctrlAlt: (k) => "ctrl+alt+" + String(k).toLowerCase(),
            ctrl: (k) => "ctrl+" + String(k).toLowerCase(),
            shift: (k) => "shift+" + String(k).toLowerCase(),
            f2: "f2",
            escape: "escape",
            tab: "tab",
            left: "left",
            right: "right",
            up: "up",
            down: "down",
            enter: "enter",
            space: "space",
            backspace: "backspace",
          };
          export function matchesKey(data, key) {
            if (data === key) return true;
            const aliases = {
              escape: ["\\x1b"],
              tab: ["\\t"],
              "shift+tab": ["\\x1b[Z"],
              left: ["\\x1b[D"],
              right: ["\\x1b[C"],
              up: ["\\x1b[A"],
              down: ["\\x1b[B"],
              enter: ["\\r", "\\n"],
              space: [" "],
              backspace: ["\\x7f", "\\b"],
              "ctrl+c": ["\\x03"],
              f2: ["\\x1bOQ", "\\x1b[12~"],
              "ctrl+alt+h": ["\\x1b\\x08"],
            }[key];
            return Boolean(aliases && aliases.includes(data));
          }
          function charDisplayWidth(cp) {
            if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
            if (
              (cp >= 0x1100 && cp <= 0x115f) ||
              (cp >= 0x2e80 && cp <= 0xa4cf) ||
              (cp >= 0xac00 && cp <= 0xd7a3) ||
              (cp >= 0xf900 && cp <= 0xfaff) ||
              (cp >= 0xfe10 && cp <= 0xfe6f) ||
              (cp >= 0xff00 && cp <= 0xff60) ||
              (cp >= 0x1f000 && cp <= 0x1fbff)
            ) {
              return 2;
            }
            return 1;
          }
          export function visibleWidth(str) {
            const plain = String(str ?? "").replace(/\\x1b\\[[0-9;]*m/g, "");
            let w = 0;
            for (const ch of plain) {
              w += charDisplayWidth(ch.codePointAt(0) ?? 0);
            }
            return w;
          }
          export function truncateToWidth(str, maxWidth, ellipsis = "…") {
            if (maxWidth <= 0) return "";
            const s = String(str ?? "");
            if (visibleWidth(s) <= maxWidth) return s;
            const ellW = visibleWidth(ellipsis);
            const target = Math.max(0, maxWidth - ellW);
            const plain = s.replace(/\\x1b\\[[0-9;]*m/g, "");
            let out = "";
            let w = 0;
            for (const ch of plain) {
              const cw = charDisplayWidth(ch.codePointAt(0) ?? 0);
              if (w + cw > target) break;
              out += ch;
              w += cw;
            }
            return out + (ellW <= maxWidth ? ellipsis : "");
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

const {
  default: zeeExtension,
  expandBundledZeeSkill,
  resolvePiProviderModel,
  resolveSafeWorktreeBranch,
  recordSubagentBudgetAndCutoff,
  getPiInvocation,
} = await import(pathToFileURL(path.join(REPO_ROOT, "pi-extension", "index.ts")).href);
const { default: zeeWorkerGuard } = await import(pathToFileURL(path.join(REPO_ROOT, "pi-extension", "worker-guard.ts")).href);
const { getModelCooldown, recordModelCooldown } = await import(
  pathToFileURL(path.join(REPO_ROOT, "skills", "zee", "scripts", "lib", "provider-health.mjs")).href
);
const { Key } = await import("@earendil-works/pi-tui");

function createMockPi() {
  const handlers = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const tools = new Map();
  const entries = [];
  const messages = [];
  const flags = new Map();
  const execCalls = [];

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
    registerShortcut(key, spec) {
      shortcuts.set(key, spec);
    },
    registerTool(spec) {
      tools.set(spec.name, spec);
    },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data, timestamp: Date.now() });
    },
    sendUserMessage(msg, opts) {
      messages.push({ msg, opts });
    },
    async exec(cmd, args = [], opts = {}) {
      execCalls.push({ cmd, args, opts });
      return { code: 0, stdout: "", stderr: "" };
    },
  };

  const makeCtx = (cwd, hasUI = true, mode = "tui") => ({
    cwd,
    hasUI,
    mode,
    sessionManager: {
      getBranch: () => entries,
    },
    ui: {
      statuses: new Map(),
      widgets: new Map(),
      notices: [],
      customCalls: [],
      footerCalls: [],
      onCustomOpen: null,
      setStatus(k, v) {
        this.statuses.set(k, v);
      },
      setWidget(k, v, opts) {
        this.widgets.set(k, { value: v, opts });
      },
      setFooter(...args) {
        this.footerCalls.push(args);
      },
      notify(msg, level) {
        this.notices.push({ msg, level });
      },
      async custom(factory, opts) {
        this.customCalls.push({ factory, opts });
        const fakeTui = { terminal: { rows: 40 }, requestRender() {} };
        const fakeTheme = { fg: (_c, t) => t, bold: (t) => t };
        return await new Promise((resolve) => {
          let settled = false;
          const done = (val) => {
            if (!settled) {
              settled = true;
              resolve(val);
            }
          };
          const comp = factory(fakeTui, fakeTheme, {}, done);
          if (typeof this.onCustomOpen === "function") {
            this.onCustomOpen(comp, opts, done);
          } else {
            comp.render(100);
            comp.dispose?.();
            done(undefined);
          }
        });
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

  return { pi, handlers, commands, shortcuts, tools, entries, messages, flags, execCalls, makeCtx, emit };
}

test("行为测试 [H5]：/zee plan 空格子命令正确上锁、init-design 磁盘自动解锁、auto 模式注入 <zeeDir> 绝对路径", async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-pi-beh-"));
  try {
    const mock = createMockPi();
    zeeExtension(mock.pi);
    const ctx = mock.makeCtx(tmpRepo, true, "tui");

    // 1. /zee 快捷命令支持 9 个技能入口（含 /zee-verify）+ /zee-mode + /zee-hub
    for (const cmd of ["zee", "zee-plan", "zee-init", "zee-review", "zee-verify", "zee-arch", "zee-retro", "zee-night", "zee-setup", "zee-mode", "zee-hub"]) {
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
    assert.equal(mock.emit("tool_call", { toolName: "write", input: { path: path.join(os.tmpdir(), "zee-rev-1", "report.md") } }, ctx), undefined);
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
    execFileSync("git", ["-C", tmpRepo, "init", "-b", "main"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "core.autocrlf", "false"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.email", "test@zee.dev"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.name", "zee"], { stdio: "ignore" });
    fs.writeFileSync(path.join(tmpRepo, "user.txt"), "original-user\n");
    fs.writeFileSync(path.join(tmpRepo, "target.txt"), "original-target\n");
    execFileSync("git", ["-C", tmpRepo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "commit", "-m", "init"], { stdio: "ignore" });
    fs.writeFileSync(path.join(tmpRepo, "user.txt"), "USER_UNCOMMITTED_WORK\n");

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
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({ type: "message_end", message: { role: "assistant", content: "I will inspect the files first...", usage: { input: 10, output: 5, cost: { total: 0.01 } } } });
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "TURN2_REAL_FINAL_REPORT: " } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "all critical findings rescued!" } });
  setTimeout(() => {}, 30000);
} else if (scenario === "dirty_audit_and_rg") {
  for (let i = 1; i <= 4; i++) {
    const id = "rg-" + i;
    emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: "rg pattern_" + i + " src/" } });
    emit({ type: "tool_execution_end", toolCallId: id, toolName: "bash", isError: true });
  }
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
    const ctx = mock.makeCtx(tmpRepo, true, "tui");

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

    execFileSync("git", ["-C", tmpRepo, "init", "-b", "main"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "core.autocrlf", "false"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.email", "test@zee.dev"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.name", "zee"], { stdio: "ignore" });
    fs.writeFileSync(path.join(tmpRepo, ".gitignore"), "node_modules/\n");
    fs.writeFileSync(path.join(tmpRepo, "index.ts"), "export const x = 1;\n");
    fs.mkdirSync(path.join(tmpRepo, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "node_modules", "pkg", "index.js"), "module.exports = 42;\n");
    execFileSync("git", ["-C", tmpRepo, "add", ".gitignore", "index.ts"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "commit", "-m", "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "branch", "zee/night-polish"], { stdio: "ignore" });

    const safeBr = resolveSafeWorktreeBranch(tmpRepo, "zee/night-polish/u1");
    assert.equal(safeBr.branch, "zee/night-polish-u1");
    assert.equal(safeBr.flattened, true);

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
    const ctx = mock.makeCtx(tmpRepo, true, "tui");

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

test("v4.2.0 回归：countedDelegateIds 去重、G-02 Gate1->Gate2 守卫、/zee-hub 与零冲突快捷键（无 ctrl+g / 无 setFooter）、Windows ZEE_PI_BIN (.mjs) 防 EFTYPE", async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v420-pi-"));
  const metaDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v420-meta-"));
  const busDir = path.join(metaDir, "bus");
  const fakeBin = path.join(metaDir, "fake-pi.mjs");
  const prevBin = process.env.ZEE_PI_BIN;
  const prevScenario = process.env.FAKE_SCENARIO;

  try {
    // 1. Windows spawn EFTYPE 修复：ZEE_PI_BIN 指向 .mjs/.js/.ts/.cjs 时必须通过 process.execPath 启动
    process.env.ZEE_PI_BIN = fakeBin;
    const inv = getPiInvocation(["--mode", "json"]);
    assert.equal(inv.command, process.execPath);
    assert.equal(inv.args[0], fakeBin);
    assert.deepEqual(inv.args.slice(1), ["--mode", "json"]);

    // 2. countedDelegateIds 去重（修复 2x 双计数）
    fs.mkdirSync(busDir, { recursive: true });
    fs.writeFileSync(
      path.join(busDir, "state.json"),
      JSON.stringify({ slug: "dedup-run", mode: "standard", delegatesDispatched: 1, budget: { maxDelegates: 10, cutoffRatio: 0.7 } }),
    );
    const t1 = recordSubagentBudgetAndCutoff(busDir, false, "tool-call-100");
    assert.equal(t1.dispatched, 2);
    assert.equal(t1.deduplicated, false);
    const t2 = recordSubagentBudgetAndCutoff(busDir, false, "tool-call-100");
    assert.equal(t2.dispatched, 2, "同 toolCallId 不得重复累加 delegatesDispatched");
    assert.equal(t2.deduplicated, true);

    // 3. 零冲突注册检查：必须注册 Key.ctrlAlt("h") 与 Key.f2 与 /zee-hub，绝不注册 ctrl+g / session_switch / session_fork / setFooter
    const mock = createMockPi();
    zeeExtension(mock.pi);
    assert.ok(mock.shortcuts.has(Key.ctrlAlt("h")), "必须注册 Ctrl+Alt+H 快捷键");
    assert.ok(mock.shortcuts.has(Key.f2), "必须注册 F2 快捷键");
    assert.equal(mock.shortcuts.has("ctrl+g"), false, "严禁绑定 ctrl+g");
    assert.equal(mock.handlers.has("session_switch"), false, "不得使用非 Pi 事件 session_switch");
    assert.equal(mock.handlers.has("session_fork"), false, "不得使用非 Pi 事件 session_fork");
    assert.ok(mock.handlers.has("session_start"));
    assert.ok(mock.handlers.has("session_tree"));
    assert.ok(mock.handlers.has("session_shutdown"));
    assert.ok(mock.handlers.has("tool_result"));

    // TUI session_start 挂载 aboveEditor widget（且不调用 setFooter）
    const tuiCtx = mock.makeCtx(tmpRepo, true, "tui");
    mock.emit("session_start", {}, tuiCtx);
    assert.equal(tuiCtx.ui.footerCalls.length, 0, "严禁调用 ctx.ui.setFooter");
    assert.equal(typeof tuiCtx.ui.widgets.get("zee-hud")?.value, "function");
    assert.equal(tuiCtx.ui.widgets.get("zee-hud")?.opts?.placement, "aboveEditor");

    // /zee-hub 在 TUI 中打开 overlay（无 blocked 属性）
    await mock.commands.get("zee-hub").handler("", tuiCtx);
    assert.equal(tuiCtx.ui.customCalls.length, 1);
    const overlayCfg = tuiCtx.ui.customCalls[0].opts;
    assert.equal(overlayCfg.overlay, true);
    assert.equal("blocked" in overlayCfg.overlayOptions, false, "overlayOptions 不得包含 blocked");
    assert.equal("blocked" in overlayCfg, false, "custom opts 不得包含 blocked");

    // RPC 模式：降级为 string[] HUD + notify，绝不调用 custom
    const rpcCtx = mock.makeCtx(tmpRepo, true, "rpc");
    mock.emit("session_start", {}, rpcCtx);
    await mock.commands.get("zee-hub").handler("", rpcCtx);
    assert.equal(rpcCtx.ui.customCalls.length, 0);
    assert.ok(rpcCtx.ui.notices.some((n) => n.msg.includes("[zee Hub]")));

    // Print / JSON 模式 100% 静默
    const printCtx = mock.makeCtx(tmpRepo, true, "print");
    mock.emit("session_start", {}, printCtx);
    await mock.commands.get("zee-hub").handler("", printCtx);
    assert.equal(printCtx.ui.customCalls.length, 0);
    assert.equal(printCtx.ui.notices.length, 0);
    assert.equal(printCtx.ui.widgets.size, 0);

    // 4. G-02 Gate 1 -> Gate 2 守卫端到端验证（strict 拦截未过 Gate 1 的 reviewer；Verifier PASS 后同 SHA 放行）
    execFileSync("git", ["-C", tmpRepo, "init", "-b", "main"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "core.autocrlf", "false"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.email", "test@zee.dev"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.name", "zee"], { stdio: "ignore" });
    fs.writeFileSync(path.join(tmpRepo, "app.ts"), "export const v = 1;\n");
    execFileSync("git", ["-C", tmpRepo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "commit", "-m", "init"], { stdio: "ignore" });
    const headSha = execFileSync("git", ["-C", tmpRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    fs.writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
if (process.env.FAKE_SCENARIO === "ver_pass") {
  emit({ type: "message_end", message: { role: "assistant", content: "VERDICT: PASS\\nPINNED_SHA: ${headSha}", stopReason: "stop" } });
  process.exit(0);
}
emit({ type: "message_end", message: { role: "assistant", content: "VERDICT: PASS\\nREVIEW_OK", stopReason: "stop" } });
process.exit(0);
`,
      { mode: 0o755 },
    );

    mock.emit("session_start", {}, tuiCtx);
    await mock.commands.get("zee-mode").handler("strict", tuiCtx);
    // 通过 tool_result(init-run) + state.json(level=L2) 进入 L2 运行态
    fs.writeFileSync(
      path.join(busDir, "state.json"),
      JSON.stringify({ slug: "g2-run", mode: "standard", level: "L2", status: "running", updatedAt: new Date().toISOString() }),
    );
    mock.emit(
      "tool_result",
      {
        toolName: "bash",
        input: { command: `node zee-tool.mjs init-run "${tmpRepo}" g2-run` },
        content: [{ type: "text", text: JSON.stringify({ ok: true, busDir, statePath: path.join(busDir, "state.json") }) }],
      },
      tuiCtx,
    );

    const subTool = mock.tools.get("zee_subagent");
    // 未跑 Verifier 直接派发 Reviewer -> strict 模式必拦截 G-02
    await assert.rejects(
      () =>
        subTool.execute(
          "call-rev-early",
          { role: "reviewer", model: "gemini-4-neon", cwd: tmpRepo, task: "[zee-worker] review" },
          undefined,
          undefined,
          tuiCtx,
        ),
      /\[G-02\]/,
    );

    // auto 模式放行无 Gate 1 的 reviewer，但仅写入 1 条 G-02 告警（绝不重复双写）
    await mock.commands.get("zee-mode").handler("auto", tuiCtx);
    process.env.FAKE_SCENARIO = "rev_pass";
    const beforeAutoViolations = [...mock.entries].reverse().find((e) => e.customType === "zee-fsm")?.data?.violations?.length ?? 0;
    const revWarnRes = await subTool.execute(
      "call-rev-auto-warn",
      { role: "reviewer", model: "gemini-4-neon", authorFamily: "claude", busDir, cwd: tmpRepo, task: "[zee-worker] review" },
      undefined,
      undefined,
      tuiCtx,
    );
    assert.ok(revWarnRes.content[0].text.includes("[G-02]"));
    const afterAutoViolations = [...mock.entries].reverse().find((e) => e.customType === "zee-fsm")?.data?.violations ?? [];
    assert.equal(afterAutoViolations.length, beforeAutoViolations + 1, "auto 模式每次 G-02 放行仅允许写入 1 条 violation");
    assert.equal(afterAutoViolations.at(-1).guard, "G-02");

    // 切回 strict，先跑 Verifier PASS（传 baseRef: "HEAD"，校验 gate1.pinnedSha 解析为真实 40 位 hex headSha）
    await mock.commands.get("zee-mode").handler("strict", tuiCtx);
    process.env.FAKE_SCENARIO = "ver_pass";
    const verPassRes = await subTool.execute(
      "call-ver-pass",
      {
        role: "verifier",
        busDir,
        worktree: { repoRoot: tmpRepo, slug: "g2-run", lane: "ver-head", baseRef: "HEAD" },
        task: "[zee-worker] verify",
      },
      undefined,
      undefined,
      tuiCtx,
    );
    assert.equal(verPassRes.details.status, "completed");
    const latestFsmAfterVer = [...mock.entries].reverse().find((e) => e.customType === "zee-fsm")?.data;
    assert.equal(latestFsmAfterVer?.gate1?.pinnedSha, headSha, "baseRef='HEAD' 时 gate1.pinnedSha 必须记录真实 40 位 SHA");

    // 再派发 Reviewer -> Gate 1 PASS 已在同一 headSha 落账，放行通过！
    process.env.FAKE_SCENARIO = "rev_pass";
    const revPassRes = await subTool.execute(
      "call-rev-pass",
      { role: "reviewer", model: "gemini-4-neon", authorFamily: "claude", busDir, cwd: tmpRepo, task: "[zee-worker] review" },
      undefined,
      undefined,
      tuiCtx,
    );
    assert.equal(revPassRes.details.status, "completed");
    assert.ok(revPassRes.content[0].text.includes("REVIEW_OK"));

    // 清理测试 runs 目录
    if (verPassRes.details.worktreePath) {
      fs.rmSync(path.dirname(path.dirname(path.dirname(verPassRes.details.worktreePath))), { recursive: true, force: true });
    }

    // 清理 session_shutdown 无报错
    mock.emit("session_shutdown", {}, tuiCtx);
    assert.equal(tuiCtx.ui.widgets.get("zee-hud")?.value, undefined);
  } finally {
    if (prevBin === undefined) delete process.env.ZEE_PI_BIN;
    else process.env.ZEE_PI_BIN = prevBin;
    if (prevScenario === undefined) delete process.env.FAKE_SCENARIO;
    else process.env.FAKE_SCENARIO = prevScenario;
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(metaDir, { recursive: true, force: true });
  }
});

test("v4.2.1 回归：菜单去重展开 bundled skill、/zee-review --strict/--quick、429 熔断切备免扣预算、mode=off 全局规则隔离", async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v421-pi-"));
  const metaDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v421-meta-"));
  const healthPath = path.join(metaDir, "provider-health.json");
  const cfgPath = path.join(metaDir, "zee-config.json");
  const busDir = path.join(metaDir, "bus");
  const fakeBin = path.join(metaDir, "fake-pi-429.mjs");

  const prevBin = process.env.ZEE_PI_BIN;
  const prevHealth = process.env.ZEE_PROVIDER_HEALTH_PATH;
  const prevCfg = process.env.ZEE_CONFIG_PATH;
  let strictBusDirToClean = "";

  try {
    process.env.ZEE_PROVIDER_HEALTH_PATH = healthPath;
    process.env.ZEE_CONFIG_PATH = cfgPath;

    execFileSync("git", ["-C", tmpRepo, "init", "-b", "main"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.email", "t@zee.dev"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.name", "zee"], { stdio: "ignore" });
    fs.writeFileSync(path.join(tmpRepo, "README.md"), "# repo\n");
    execFileSync("git", ["-C", tmpRepo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "commit", "-m", "init"], { stdio: "ignore" });

    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 2,
        budget: "balanced",
        roles: {
          scout: {
            prefer: { family: "devin", modelHint: "devin/only-model", tier: "fast", effort: "low" },
            bindings: { pi: { providerInstanceId: "magpie", model: "remote-magpie/devin/only-model" } },
          },
          reviewers: [
            {
              prefer: { family: "gemini", modelHint: "gemini-4-hydrogen", tier: "fast", effort: "medium" },
              backup: { family: "openai", modelHint: "gpt-6.1-sol", tier: "pro", effort: "medium" },
              bindings: {
                pi: {
                  prefer: { providerInstanceId: "magpie", model: "remote-magpie/devin/gemini-4-hydrogen" },
                  backup: { providerInstanceId: "magpie", model: "remote-magpie/codex/gpt-6.1-sol" },
                },
              },
            },
          ],
        },
      }),
    );

    const mock = createMockPi();
    zeeExtension(mock.pi);
    const tuiCtx = mock.makeCtx(tmpRepo, true, "tui");
    mock.emit("session_start", {}, tuiCtx);

    // 1. 仅注册 11 个干净命令且短命令内置展开 <skill name="...">（不再发 /skill:zee*）
    assert.equal(mock.commands.size, 11);
    await mock.commands.get("zee-plan").handler("新增模块", tuiCtx);
    const planSent = mock.messages.at(-1);
    assert.match(planSent.msg, /^<skill name="zee-plan"/);
    assert.equal(planSent.opts.expandPromptTemplates, false);
    assert.ok(planSent.msg.includes("新增模块"));

    // 2. /zee-mode off 时普通问答零注入；显式运行 /zee-retro 时仍注入全局模板隔离与中文Policy
    await mock.commands.get("zee-mode").handler("off", tuiCtx);
    // 解除 plan 锁回到 idle
    mock.emit("before_agent_start", { messageType: "user", prompt: "/zee done", systemPromptOptions: { sections: {} } }, tuiCtx);

    const casualEvt = { messageType: "user", prompt: "你好解释下闭包", systemPromptOptions: { sections: { zee: "stale" } } };
    mock.emit("before_agent_start", casualEvt, tuiCtx);
    assert.equal(casualEvt.systemPromptOptions.sections.zee, undefined);

    const retroExpanded = expandBundledZeeSkill("zee-retro", "");
    const retroEvt = { messageType: "user", prompt: retroExpanded, systemPromptOptions: { sections: {} } };
    mock.emit("before_agent_start", retroEvt, tuiCtx);
    assert.ok(retroEvt.systemPromptOptions.sections.zee.includes("Global Template Isolation"));
    assert.ok(retroEvt.systemPromptOptions.sections.zee.includes("AGENTS.md"));

    // 3. /zee-review --strict 自动预建独立总线；未派 Reviewer 结算时记录 G-02 告警；--quick 走轻量提示
    await mock.commands.get("zee-review").handler("", tuiCtx);
    const strictMsg = mock.messages.at(-1).msg;
    assert.ok(strictMsg.includes("[ZEE_REVIEW_MODE: strict]"));
    const busMatch = strictMsg.match(/\[MANDATORY_BUS_DIR:\s*([^\]]+)\]/);
    assert.ok(busMatch, "strict review 必须机械创建并注入 MANDATORY_BUS_DIR");
    strictBusDirToClean = busMatch[1].trim();
    assert.equal(fs.existsSync(path.join(strictBusDirToClean, "state.json")), true);
    assert.equal(fs.existsSync(path.join(strictBusDirToClean, "decisions.tsv")), true);

    mock.emit("agent_settled", {}, tuiCtx);
    const latestAfterStrictSkip = [...mock.entries].reverse().find((e) => e.customType === "zee-fsm")?.data;
    assert.equal(latestAfterStrictSkip.violations.at(-1).guard, "G-02");
    assert.equal(latestAfterStrictSkip.violations.at(-1).severity, "warn");

    await mock.commands.get("zee-review").handler("--quick", tuiCtx);
    assert.ok(mock.messages.at(-1).msg.includes("[ZEE_REVIEW_MODE: quick]"));

    // 4. zee_subagent 429 建连即败：免扣预算 + 写入冷却 + 二次呼叫 0ms 自动切备（遵守 authorFamily）
    fs.writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const mIdx = args.indexOf("--model");
const model = mIdx >= 0 ? args[mIdx + 1] : "";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (model.includes("gemini-4-hydrogen")) {
  emit({ type: "message_end", message: { role: "assistant", content: "", stopReason: "error", errorMessage: "HTTP 429 quota_exhausted" } });
  process.exit(1);
}
emit({ type: "message_end", message: { role: "assistant", content: "VERDICT: PASS\\nHEALTHY_ALT", stopReason: "stop", usage: { input: 100, output: 20, cost: { total: 0.05 } } } });
process.exit(0);
`,
      { mode: 0o755 },
    );
    process.env.ZEE_PI_BIN = fakeBin;

    fs.mkdirSync(busDir, { recursive: true });
    fs.writeFileSync(
      path.join(busDir, "state.json"),
      JSON.stringify({ slug: "cd-test", mode: "night", level: "L2", delegatesDispatched: 0, budget: { maxDelegates: 4, cutoffRatio: 0.7 } }),
    );

    const subTool = mock.tools.get("zee_subagent");
    await assert.rejects(
      () =>
        subTool.execute(
          "call-429-fail",
          {
            role: "reviewer",
            provider: "magpie",
            model: "remote-magpie/devin/gemini-4-hydrogen",
            authorFamily: "claude",
            busDir,
            cwd: tmpRepo,
            task: "[zee-worker] review",
          },
          undefined,
          undefined,
          tuiCtx,
        ),
      /\[BUDGET_EXEMPT:/,
    );

    const stAfter429 = JSON.parse(fs.readFileSync(path.join(busDir, "state.json"), "utf8"));
    assert.equal(stAfter429.delegatesDispatched, 0, "429 建连即败绝不扣减 delegatesDispatched");
    assert.equal(getModelCooldown("magpie", "remote-magpie/devin/gemini-4-hydrogen").active, true);

    const updates = [];
    const altRes = await subTool.execute(
      "call-alt-switch",
      {
        role: "reviewer",
        provider: "magpie",
        model: "remote-magpie/devin/gemini-4-hydrogen",
        authorFamily: "claude",
        busDir,
        cwd: tmpRepo,
        task: "[zee-worker] review",
      },
      undefined,
      (u) => updates.push(u.content[0].text),
      tuiCtx,
    );
    assert.equal(altRes.details.status, "completed");
    assert.equal(altRes.details.model, "remote-magpie/codex/gpt-6.1-sol");
    assert.equal(altRes.details.cooldownSwitchedFrom, "magpie/remote-magpie/devin/gemini-4-hydrogen");
    assert.ok(altRes.content[0].text.includes("0ms 自动切备"));
    assert.ok(updates.some((t) => t.includes("cost=$")), "实时心跳必须包含 cost");

    const stAfterAlt = JSON.parse(fs.readFileSync(path.join(busDir, "state.json"), "utf8"));
    assert.equal(stAfterAlt.delegatesDispatched, 1, "成功切换并执行完成后仅计 1 次预算");

    // 5. 无可用健康备胎时命中冷却直接拒发（零 subprocess 等待、零扣预算）
    recordModelCooldown(
      "magpie",
      "remote-magpie/devin/only-model",
      { kind: "rate_limit", reason: "HTTP 429", ttlMs: 60_000 },
      healthPath,
    );
    await assert.rejects(
      () =>
        subTool.execute(
          "call-no-alt",
          {
            role: "scout",
            provider: "magpie",
            model: "remote-magpie/devin/only-model",
            busDir,
            cwd: tmpRepo,
            task: "[zee-worker] scout",
          },
          undefined,
          undefined,
          tuiCtx,
        ),
      /处于 429\/5xx 熔断冷却期[\s\S]*未扣减预算/,
    );
  } finally {
    if (prevBin === undefined) delete process.env.ZEE_PI_BIN;
    else process.env.ZEE_PI_BIN = prevBin;
    if (prevHealth === undefined) delete process.env.ZEE_PROVIDER_HEALTH_PATH;
    else process.env.ZEE_PROVIDER_HEALTH_PATH = prevHealth;
    if (prevCfg === undefined) delete process.env.ZEE_CONFIG_PATH;
    else process.env.ZEE_CONFIG_PATH = prevCfg;
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(metaDir, { recursive: true, force: true });
    if (strictBusDirToClean) {
      fs.rmSync(path.dirname(strictBusDirToClean), { recursive: true, force: true });
    }
  }
});
