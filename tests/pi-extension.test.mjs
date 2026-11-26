import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RUNS_ROOT } from "../skills/zee/scripts/lib/guard-core.mjs";
import { clearModelCooldown, findHealthyPiFallback, recordModelCooldown } from "../skills/zee/scripts/lib/provider-health.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") return { url: "zee-mock://pi-coding-agent", shortCircuit: true };
    if (specifier === "typebox") return { url: "zee-mock://typebox", shortCircuit: true };
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
            if (buf.length <= maxBytes) return { truncated: false, content: String(text || ""), totalBytes: buf.length, outputBytes: buf.length };
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

const {
  default: zeeExtension,
  expandBundledZeeSkill,
  resolvePiProviderModel,
  resolveSafeWorktreeBranch,
  recordSubagentBudgetAndCutoff,
  getPiInvocation,
  resolveEffectiveSubagentTimeout,
} = await import(pathToFileURL(path.join(REPO_ROOT, "pi-extension", "index.ts")).href);
const { default: zeeWorkerGuard } = await import(pathToFileURL(path.join(REPO_ROOT, "pi-extension", "worker-guard.ts")).href);

function createMockPi({ cwd = REPO_ROOT, hasUI = true, mode = "interactive" } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const tools = new Map();
  const entries = [];
  const messages = [];
  const flags = new Map();
  const statuses = [];
  const notifications = [];
  let footerCalls = 0;

  const ctx = {
    cwd,
    hasUI,
    mode,
    sessionManager: {
      getBranch: () => entries,
    },
    ui: {
      setStatus(key, value) {
        statuses.push({ key, value });
      },
      setFooter() {
        footerCalls += 1;
      },
      notify(msg, level) {
        notifications.push({ msg, level });
      },
    },
  };

  const pi = {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    registerFlag(name, spec) {
      flags.set(name, spec?.default);
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
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage(msg, opts) {
      messages.push({ msg, opts });
    },
  };

  const emit = async (event, payload = {}) => {
    const list = handlers.get(event) || [];
    let last;
    for (const fn of list) {
      last = await fn(payload, ctx);
      if (last !== undefined) return last;
    }
    return last;
  };

  return { pi, ctx, commands, shortcuts, tools, entries, messages, flags, statuses, notifications, emit, getFooterCalls: () => footerCalls };
}

test("扩展仅注册 8 个干净命令、1 个工具、0 快捷键且不接管 footer", () => {
  const m = createMockPi();
  zeeExtension(m.pi);
  assert.deepEqual([...m.commands.keys()].sort(), ["zee", "zee-mode", "zee-night", "zee-plan", "zee-retro", "zee-review", "zee-setup", "zee-verify"]);
  assert.equal(m.shortcuts.size, 0);
  assert.deepEqual([...m.tools.keys()], ["zee_subagent"]);
  assert.equal(m.getFooterCalls(), 0);
  assert.equal(expandBundledZeeSkill("zee-plan", "make game").includes('<skill name="zee-plan"'), true);
});

test("路由注入与子代理静默隔离：auto 注入、off 删除、ZEE_WORKER=1 不注入", async () => {
  const m = createMockPi();
  zeeExtension(m.pi);

  const offSections = {};
  await m.emit("before_agent_start", { messageType: "user", prompt: "hi", systemPromptOptions: { sections: offSections } });
  assert.equal(offSections.zee, undefined);

  await m.commands.get("zee-mode").handler("auto", m.ctx);
  assert.equal(m.statuses.at(-1)?.value, "zee:auto");

  const autoSections = {};
  await m.emit("before_agent_start", { messageType: "user", prompt: "build feature", systemPromptOptions: { sections: autoSections } });
  assert.match(autoSections.zee, /zee 个人主厨路由/);

  process.env.ZEE_WORKER = "1";
  try {
    const workerSections = { zee: "stale" };
    await m.emit("before_agent_start", { messageType: "user", prompt: "do work", systemPromptOptions: { sections: workerSections } });
    assert.equal(workerSections.zee, undefined);
  } finally {
    delete process.env.ZEE_WORKER;
  }
});

test("writeGate 保护锁守卫 write/edit 与 denyCommands，且不误拦只读 Bash", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-pi-gate-"));
  try {
    fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".agents", "zee.project.json"), JSON.stringify({ denyCommands: ["npm publish"] }), "utf8");

    const m = createMockPi({ cwd: repo });
    zeeExtension(m.pi);

    await m.commands.get("zee-plan").handler("init", m.ctx);
    assert.equal(m.statuses.at(-1)?.value, "zee:plan🔒");

    const allowPlan = await m.emit("tool_call", { toolName: "write", input: { path: "plan.md" } });
    assert.equal(allowPlan, undefined);

    const blockSrc = await m.emit("tool_call", { toolName: "write", input: { path: "src/app.ts" } });
    assert.equal(blockSrc?.block, true);

    const allowBash = await m.emit("tool_call", { toolName: "bash", input: { command: "git status && node --version" } });
    assert.equal(allowBash, undefined);

    const blockDeny = await m.emit("tool_call", { toolName: "bash", input: { command: "npm publish" } });
    assert.equal(blockDeny?.block, true);

    const blockDestroy = await m.emit("tool_call", { toolName: "bash", input: { command: "git push --force origin main" } });
    assert.equal(blockDestroy?.block, true);

    // 切换分支历史恢复状态
    await m.commands.get("zee-review").handler("", m.ctx);
    assert.equal(m.statuses.at(-1)?.value, "zee:rev🔒");
    await m.emit("agent_settled", {});
    assert.equal(m.statuses.at(-1)?.value, undefined);

    // P0-1 闭环回归：/zee-verify run 及 /zee plan|review|init 经 expandBundledZeeSkill 展开后再进 before_agent_start，锁不能自毁
    await m.commands.get("zee-verify").handler("run 请执行验证", m.ctx);
    assert.equal(m.statuses.at(-1)?.value, "zee:rev🔒");
    await m.emit("before_agent_start", {
      messageType: "user",
      prompt: m.messages.at(-1).msg,
      systemPromptOptions: { sections: {} },
    });
    assert.equal(m.statuses.at(-1)?.value, "zee:rev🔒");
    const blockVerifyWrite = await m.emit("tool_call", { toolName: "write", input: { path: "src/a.js" } });
    assert.equal(blockVerifyWrite?.block, true);
    await m.emit("agent_settled", {});

    for (const [subArg, expectedBadge] of [
      ["plan 规划", "zee:plan🔒"],
      ["review 审查", "zee:rev🔒"],
    ]) {
      await m.commands.get("zee").handler(subArg, m.ctx);
      await m.emit("before_agent_start", {
        messageType: "user",
        prompt: m.messages.at(-1).msg,
        systemPromptOptions: { sections: {} },
      });
      assert.equal(m.statuses.at(-1)?.value, expectedBadge);
      const blk = await m.emit("tool_call", { toolName: "edit", input: { path: "src/a.js" } });
      assert.equal(blk?.block, true);
    }

    // init-design 在尚无 .agents/zee.project.json 的新仓应锁定业务源码直到写出该文件
    const cleanRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-pi-init-"));
    try {
      const mInit = createMockPi({ cwd: cleanRepo });
      zeeExtension(mInit.pi);
      await mInit.commands.get("zee").handler("init 初始化", mInit.ctx);
      await mInit.emit("before_agent_start", {
        messageType: "user",
        prompt: mInit.messages.at(-1).msg,
        systemPromptOptions: { sections: {} },
      });
      assert.equal(mInit.statuses.at(-1)?.value, "zee:init🔒");
      const blkInit = await mInit.emit("tool_call", { toolName: "edit", input: { path: "src/a.js" } });
      assert.equal(blkInit?.block, true);
      const allowProj = await mInit.emit("tool_call", { toolName: "write", input: { path: ".agents/zee.project.json" } });
      assert.equal(allowProj, undefined);
      assert.equal(mInit.statuses.at(-1)?.value, undefined);
    } finally {
      fs.rmSync(cleanRepo, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("agent_settled 在存在未完结且无晨报的 night 任务时发出状态栏与通知提醒", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-night-warn-"));
  const zeeTool = path.join(REPO_ROOT, "skills", "zee", "scripts", "zee-tool.mjs");
  let busDir = "";
  try {
    const init = JSON.parse(execFileSync(process.execPath, [zeeTool, "init-run", repo, "night-guard", "--mode", "night"], { encoding: "utf8" }));
    busDir = init.busDir;
    execFileSync(process.execPath, [zeeTool, "update-state", busDir, "--status", "running", "--mode", "night", "--resume-next", "U2"], {
      encoding: "utf8",
    });

    const m = createMockPi({ cwd: repo });
    zeeExtension(m.pi);
    await m.emit("agent_settled", {});
    assert.equal(m.statuses.at(-1)?.value, "zee:night⚠");
    assert.ok(m.notifications.some((n) => n.level === "warning" && /night-guard/.test(n.msg)));
  } finally {
    if (busDir) fs.rmSync(path.dirname(busDir), { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("resolvePiProviderModel 支持 Schema v3 槽位归一与防伪 provider 校验", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zee-pi-cfg-"));
  const cfgPath = path.join(tmp, "zee-config.json");
  try {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 3,
        slots: {
          fast: { prefer: { bindings: { pi: { providerInstanceId: "magpie", model: "auto/gemini-4-hydrogen" } } } },
          workhorse: { prefer: { bindings: { pi: { providerInstanceId: "magpie", model: "auto/gpt-6.2-astra" } } } },
          adversary: { prefer: { bindings: { pi: { providerInstanceId: "magpie", model: "magpie-2/vm/claude-sonnet-5-5" } } } },
        },
      }),
      "utf8",
    );

    const n1 = resolvePiProviderModel("vm", "claude-sonnet-5-5", cfgPath);
    assert.equal(n1.provider, "magpie");
    assert.equal(n1.model, "magpie-2/vm/claude-sonnet-5-5");

    const n2 = resolvePiProviderModel(undefined, "gpt-6.2-astra", cfgPath);
    assert.equal(n2.provider, "magpie");
    assert.equal(n2.model, "auto/gpt-6.2-astra");

    assert.throws(() => resolvePiProviderModel("devin", "unknown-model", cfgPath), /不是有效的 Pi provider ID/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("recordSubagentBudgetAndCutoff 去重计数、兼容 maxSubagents 并在 70% 触发截断提醒", () => {
  const busDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-budget-"));
  try {
    fs.writeFileSync(
      path.join(busDir, "state.json"),
      JSON.stringify({ mode: "night", delegatesDispatched: 0, budget: { maxSubagents: 10, cutoffRatio: 0.7 } }),
      "utf8",
    );
    let res = recordSubagentBudgetAndCutoff(busDir, false, "u-1");
    assert.equal(res.dispatched, 1);
    assert.equal(res.cutoffTriggered, false);

    // 同 delegateId 去重
    res = recordSubagentBudgetAndCutoff(busDir, false, "u-1");
    assert.equal(res.deduplicated, true);
    assert.equal(res.dispatched, 1);

    for (let i = 2; i <= 7; i++) {
      res = recordSubagentBudgetAndCutoff(busDir, false, `u-${i}`);
    }
    assert.equal(res.dispatched, 7);
    assert.equal(res.cutoffTriggered, true);
  } finally {
    fs.rmSync(busDir, { recursive: true, force: true });
  }
});

test("zee_subagent 拦截同家族自审并在无备胎时直接拒发冷却模型", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zee-cd-"));
  const cfgPath = path.join(tmp, "zee-config.json");
  const healthPath = path.join(tmp, "provider-health.json");
  const prevCfg = process.env.ZEE_CONFIG_PATH;
  const prevHealth = process.env.ZEE_PROVIDER_HEALTH_PATH;
  process.env.ZEE_CONFIG_PATH = cfgPath;
  process.env.ZEE_PROVIDER_HEALTH_PATH = healthPath;

  try {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 3,
        authorizedFallback: true,
        slots: {
          workhorse: { prefer: { family: "openai", bindings: { pi: { providerInstanceId: "magpie", model: "auto/gpt-6.2-astra" } } } },
          adversary: { prefer: { family: "claude", bindings: { pi: { providerInstanceId: "magpie", model: "magpie-2/vm/claude-sonnet-5-5" } } } },
        },
      }),
      "utf8",
    );

    const m = createMockPi();
    zeeExtension(m.pi);
    const subTool = m.tools.get("zee_subagent");

    await assert.rejects(
      () => subTool.execute("call-1", { role: "reviewer", provider: "magpie", model: "auto/gpt-6.2-astra", authorFamily: "openai", task: "review" }, undefined, undefined, m.ctx),
      /跨家族拦截/,
    );

    recordModelCooldown("magpie", "magpie-2/vm/claude-sonnet-5-5", { reason: "http_429", status: 429 }, healthPath);
    await assert.rejects(
      () => subTool.execute("call-2", { role: "reviewer", provider: "magpie", model: "magpie-2/vm/claude-sonnet-5-5", authorFamily: "openai", task: "review" }, undefined, undefined, m.ctx),
      /熔断冷却期/,
    );
    clearModelCooldown(undefined, healthPath);
  } finally {
    if (prevCfg === undefined) delete process.env.ZEE_CONFIG_PATH; else process.env.ZEE_CONFIG_PATH = prevCfg;
    if (prevHealth === undefined) delete process.env.ZEE_PROVIDER_HEALTH_PATH; else process.env.ZEE_PROVIDER_HEALTH_PATH = prevHealth;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolvePiProviderModel 与 findHealthyPiFallback 支持 harnesses.pi.slots 且隔离 harnesses.t3.slots", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zee-pi-harnesses-"));
  const cfgPath = path.join(tmp, "zee-config.json");
  const healthPath = path.join(tmp, "provider-health.json");
  try {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 3,
        authorizedFallback: true,
        harnesses: {
          pi: {
            slots: {
              fast: { prefer: { family: "deepseek", providerInstanceId: "magpie", model: "auto/deepseek-v4.1-flash" } },
              workhorse: {
                prefer: { family: "openai", providerInstanceId: "magpie", model: "auto/gpt-6.2-astra" },
                backup: { family: "gemini", providerInstanceId: "magpie", model: "auto/gemini-4-hydrogen" },
              },
              adversary: { prefer: { family: "claude", providerInstanceId: "magpie", model: "magpie-2/vm/claude-sonnet-5-5" } },
            },
          },
          t3: {
            slots: {
              fast: { prefer: { family: "gemini", providerInstanceId: "antigravity", model: "gemini-4-hydrogen" } },
              workhorse: { prefer: { family: "gemini", providerInstanceId: "antigravity", model: "gemini-4-neon" } },
              adversary: { prefer: { family: "openai", providerInstanceId: "codex", model: "gpt-6.2-astra" } },
            },
          },
        },
      }),
      "utf8",
    );

    const n1 = resolvePiProviderModel("vm", "claude-sonnet-5-5", cfgPath);
    assert.equal(n1.provider, "magpie");
    assert.equal(n1.model, "magpie-2/vm/claude-sonnet-5-5");

    assert.throws(() => resolvePiProviderModel("antigravity", "gemini-4-neon", cfgPath), /不是有效的 Pi provider ID/);

    const fb = findHealthyPiFallback({
      role: "coder",
      failedProvider: "magpie",
      failedModel: "auto/gpt-6.2-astra",
      configPath: cfgPath,
      healthPath,
    });
    assert.equal(fb?.provider, "magpie");
    assert.equal(fb?.model, "auto/gemini-4-hydrogen");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("worker-guard 守卫只读角色 write/edit 与危险命令，允许写入总线", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-wg-"));
  const prevRole = process.env.ZEE_ROLE;
  const prevBus = process.env.ZEE_BUS_DIR;
  process.env.ZEE_ROLE = "reviewer";
  process.env.ZEE_BUS_DIR = path.join(RUNS_ROOT, "wg-test");

  try {
    const m = createMockPi({ cwd: repo });
    zeeWorkerGuard(m.pi);

    const blockEdit = await m.emit("tool_call", { toolName: "edit", input: { path: "src/a.ts" } });
    assert.equal(blockEdit?.block, true);

    const blockRepoWrite = await m.emit("tool_call", { toolName: "write", input: { path: "src/a.ts" } });
    assert.equal(blockRepoWrite?.block, true);

    const allowBusWrite = await m.emit("tool_call", { toolName: "write", input: { path: path.join(RUNS_ROOT, "wg-test", "review.md") } });
    assert.equal(allowBusWrite, undefined);

    const blockDestroy = await m.emit("tool_call", { toolName: "bash", input: { command: "rm -rf /" } });
    assert.equal(blockDestroy?.block, true);

    const allowReadBash = await m.emit("tool_call", { toolName: "bash", input: { command: "git diff --stat" } });
    assert.equal(allowReadBash, undefined);
  } finally {
    if (prevRole === undefined) delete process.env.ZEE_ROLE; else process.env.ZEE_ROLE = prevRole;
    if (prevBus === undefined) delete process.env.ZEE_BUS_DIR; else process.env.ZEE_BUS_DIR = prevBus;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("getPiInvocation 与 resolveSafeWorktreeBranch 工具辅助函数正确工作", () => {
  const prev = process.env.ZEE_PI_BIN;
  process.env.ZEE_PI_BIN = "C:\\fake\\cli.js";
  try {
    const inv = getPiInvocation(["--mode", "json"]);
    assert.equal(inv.command, process.execPath);
    assert.deepEqual(inv.args, ["C:\\fake\\cli.js", "--mode", "json"]);
  } finally {
    if (prev === undefined) delete process.env.ZEE_PI_BIN; else process.env.ZEE_PI_BIN = prev;
  }

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-br-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "z@e.c"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "z"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
    execFileSync("git", ["branch", "feat"], { cwd: repo });
    const res = resolveSafeWorktreeBranch(repo, "feat/u1");
    assert.equal(res.flattened, true);
    assert.equal(res.branch, "feat-u1");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("resolveEffectiveSubagentTimeout 防止误传短超时掐死核心子代理，并保持角色默认值", () => {
  const prev = process.env.ZEE_ALLOW_SHORT_TIMEOUT;
  delete process.env.ZEE_ALLOW_SHORT_TIMEOUT;
  try {
    assert.equal(resolveEffectiveSubagentTimeout("reviewer", 60_000), 120_000);
    assert.equal(resolveEffectiveSubagentTimeout("verifier", 30_000), 120_000);
    assert.equal(resolveEffectiveSubagentTimeout("reviewer", undefined), 480_000);
    assert.equal(resolveEffectiveSubagentTimeout("verifier", undefined), 300_000);
    assert.equal(resolveEffectiveSubagentTimeout("coder", undefined), 600_000);
    assert.equal(resolveEffectiveSubagentTimeout("judge", 45_000), 45_000);
  } finally {
    if (prev === undefined) delete process.env.ZEE_ALLOW_SHORT_TIMEOUT;
    else process.env.ZEE_ALLOW_SHORT_TIMEOUT = prev;
  }
});
