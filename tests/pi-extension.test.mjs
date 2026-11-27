import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RUNS_ROOT } from "../skills/zee/scripts/lib/guard-core.mjs";
import {
  classifyTransientProviderFailure,
  clearModelCooldown,
  findHealthyPiFallback,
  recordModelCooldown,
} from "../skills/zee/scripts/lib/provider-health.mjs";

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
  readGitSnapshot,
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

test("v5.2.0 路由注入默认 auto 开箱即用、非交互 pi -p 正常注入、off 删除、ZEE_WORKER=1 不注入", async () => {
  const m = createMockPi();
  zeeExtension(m.pi);

  // 默认即为 auto 自动驾驶模式
  const defaultAutoSections = {};
  await m.emit("before_agent_start", { messageType: "user", prompt: "build feature", systemPromptOptions: { sections: defaultAutoSections } });
  assert.match(defaultAutoSections.zee, /zee 个人主厨自动驾驶路由/);

  // 手动切换 off 后删除注入
  await m.commands.get("zee-mode").handler("off", m.ctx);
  assert.equal(m.statuses.at(-1)?.value, undefined);
  const offSections = { zee: "stale" };
  await m.emit("before_agent_start", { messageType: "user", prompt: "hi", systemPromptOptions: { sections: offSections } });
  assert.equal(offSections.zee, undefined);

  // 非交互模式 (!ctx.hasUI，例如 pi -p) 主进程不能被误判为子代理
  const mHeadless = createMockPi({ hasUI: false, mode: "print" });
  zeeExtension(mHeadless.pi);
  const headlessSections = {};
  await mHeadless.emit("before_agent_start", { messageType: "user", prompt: "fix bug", systemPromptOptions: { sections: headlessSections } });
  assert.match(headlessSections.zee, /zee 个人主厨自动驾驶路由/, "非交互主进程不应因 !ctx.hasUI 丢失路由注入");

  // 子代理环境静默隔离
  process.env.ZEE_WORKER = "1";
  try {
    const workerSections = { zee: "stale" };
    await mHeadless.emit("before_agent_start", { messageType: "user", prompt: "do work", systemPromptOptions: { sections: workerSections } });
    assert.equal(workerSections.zee, undefined);
  } finally {
    delete process.env.ZEE_WORKER;
  }
});

test("writeGate 保护锁守卫 write/edit 与 denyCommands，支持自然语言解锁且不误拦只读 Bash", async () => {
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

    // 自然语言确认（如 LGTM / 好的，按计划开始）可自动解锁 plan 锁
    await m.emit("before_agent_start", { messageType: "user", prompt: "LGTM proceed", systemPromptOptions: { sections: {} } });
    assert.equal(m.statuses.at(-1)?.value, "zee:auto");
    assert.equal(await m.emit("tool_call", { toolName: "write", input: { path: "src/app.ts" } }), undefined);

    const allowBash = await m.emit("tool_call", { toolName: "bash", input: { command: "git status && node --version" } });
    assert.equal(allowBash, undefined);

    const blockDeny = await m.emit("tool_call", { toolName: "bash", input: { command: "npm publish" } });
    assert.equal(blockDeny?.block, true);

    const blockDestroy = await m.emit("tool_call", { toolName: "bash", input: { command: "git push --force origin main" } });
    assert.equal(blockDestroy?.block, true);

    // review 锁结束自动释放回到 zee:auto
    await m.commands.get("zee-review").handler("", m.ctx);
    assert.equal(m.statuses.at(-1)?.value, "zee:rev🔒");
    await m.emit("agent_settled", {});
    assert.equal(m.statuses.at(-1)?.value, "zee:auto");

    // /zee-verify run 展开后再进 before_agent_start，锁不能自毁
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

    // /zee plan|review 经 expandBundledZeeSkill 展开后再进 before_agent_start，锁不能自毁
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
      await m.emit("agent_settled", {});
    }

    // /zee init 统一归入 plan 锁（带 --autopilot 则不挂锁直通），并向下兼容旧分支 init-design 恢复
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
      assert.equal(mInit.statuses.at(-1)?.value, "zee:plan🔒");
      const blkInit = await mInit.emit("tool_call", { toolName: "edit", input: { path: "src/a.js" } });
      assert.equal(blkInit?.block, true);
      assert.equal(await mInit.emit("tool_call", { toolName: "write", input: { path: "SPEC.md" } }), undefined);

      // 兼容旧分支条目 zee-gate: "init-design" -> 恢复为 plan🔒
      mInit.entries.push({ type: "custom", customType: "zee-gate", data: { gate: "init-design" } });
      await mInit.emit("session_start", {});
      assert.equal(mInit.statuses.at(-1)?.value, "zee:plan🔒");
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

test("zee_subagent 拦截 reviewer/judge/adversary/reviewer.0 同家族自审并拒发冷却模型", async () => {
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

    for (const advRole of ["reviewer", "judge", "adversary", "reviewer.0"]) {
      await assert.rejects(
        () => subTool.execute(`call-${advRole}`, { role: advRole, provider: "magpie", model: "auto/gpt-6.2-astra", authorFamily: "openai", task: "review" }, undefined, undefined, m.ctx),
        /跨家族拦截/,
        `${advRole} 必须执行同家族拦截`,
      );
    }

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

test("provider-health 严格隔离非 Pi bindings、拦截 adversary/reviewer.0 同家族且精准清理冷却", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zee-pi-harnesses-"));
  const cfgPath = path.join(tmp, "zee-config.json");
  const healthPath = path.join(tmp, "provider-health.json");
  try {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 3,
        authorizedFallback: true,
        slots: {
          // 含非 Pi bindings 且顶层有冗余字段：绝不得泄漏进 Pi 切备
          workhorse: {
            prefer: {
              providerInstanceId: "codex",
              model: "gpt-6.2-astra",
              bindings: { t3: { providerInstanceId: "codex", model: "gpt-6.2-astra" } },
            },
          },
        },
        harnesses: {
          pi: {
            slots: {
              fast: { prefer: { family: "gemini", providerInstanceId: "magpie", model: "auto/gemini-4-hydrogen" } },
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

    // adversary / reviewer.0 切备同样严禁返回 authorFamily (openai)
    for (const r of ["adversary", "reviewer.0"]) {
      const advFb = findHealthyPiFallback({
        role: r,
        failedProvider: "magpie",
        failedModel: "magpie-2/vm/claude-sonnet-5-5",
        authorFamily: "openai",
        configPath: cfgPath,
        healthPath,
      });
      assert.ok(advFb);
      assert.notEqual(advFb.family, "openai");
      assert.notEqual(advFb.provider, "codex");
    }

    // clearModelCooldown 精确匹配，不因共享前缀误清其他通道
    recordModelCooldown("magpie", "gpt-6.2-astra", { kind: "rate_limit" }, healthPath);
    recordModelCooldown("codex", "gpt-6.2-sol", { kind: "rate_limit" }, healthPath);
    const noMatch = clearModelCooldown("gpt-6.2", healthPath);
    assert.equal(noMatch.clearedCount, 0);
    assert.equal(noMatch.remainingCount, 2);
    const exactMatch = clearModelCooldown("gpt-6.2-astra", healthPath);
    assert.equal(exactMatch.clearedCount, 1);
    assert.equal(exactMatch.remainingCount, 1);
    clearModelCooldown("*", healthPath);

    // classifyTransientProviderFailure：0 token 错误不因 hasOutput=false 漏判
    const t429 = classifyTransientProviderFailure({ errorMessage: "429 Too Many Requests", turns: 0, hasOutput: false, outputTokens: 0 });
    assert.equal(t429.transient, true);
    assert.equal(t429.kind, "rate_limit");
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

test("getPiInvocation、resolveSafeWorktreeBranch 与空仓 readGitSnapshot 正确工作", () => {
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
    // 0 提交空仓下 readGitSnapshot 必须返回 isGit: true 且能抓到未跟踪脏文件
    fs.writeFileSync(path.join(repo, "untracked.ts"), "1\n");
    const emptySnap = readGitSnapshot(repo);
    assert.equal(emptySnap.isGit, true);
    assert.equal(emptySnap.head, "");
    assert.ok(emptySnap.statusLines.some((l) => l.includes("untracked.ts")));

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
    assert.equal(resolveEffectiveSubagentTimeout("judge", 45_000), 120_000);
    assert.equal(resolveEffectiveSubagentTimeout("judge", undefined), 240_000);
  } finally {
    if (prev === undefined) delete process.env.ZEE_ALLOW_SHORT_TIMEOUT;
    else process.env.ZEE_ALLOW_SHORT_TIMEOUT = prev;
  }
});

test("v5.1+/v5.2：judge 双重跨家族拦截、plan/review 锁增量脏树告警与过夜 24h 陈旧总线过滤", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v510-pi-"));
  const cfgPath = path.join(tmpDir, "zee-config.json");
  const healthPath = path.join(tmpDir, "provider-health.json");
  const repo = path.join(tmpDir, "repo");
  const prevCfg = process.env.ZEE_CONFIG_PATH;
  const prevHealth = process.env.ZEE_PROVIDER_HEALTH_PATH;
  const prevStale = process.env.ZEE_NIGHT_STALE_MS;
  let staleBusDir = "";
  try {
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "z@e.c"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "z"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "app.ts"), "export const a = 1;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });

    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 3,
        harnesses: {
          pi: {
            slots: {
              fast: { prefer: { providerInstanceId: "magpie", model: "auto/gemini-4-hydrogen" } },
              workhorse: { prefer: { providerInstanceId: "magpie", model: "auto/gpt-6.2-astra" } },
              adversary: { prefer: { providerInstanceId: "magpie", model: "magpie-2/vm/claude-sonnet-5-5" } },
            },
          },
        },
      }),
      "utf8",
    );
    process.env.ZEE_CONFIG_PATH = cfgPath;
    process.env.ZEE_PROVIDER_HEALTH_PATH = healthPath;

    const m = createMockPi({ cwd: repo });
    zeeExtension(m.pi);
    const subTool = m.tools.get("zee_subagent");
    await assert.rejects(
      () =>
        subTool.execute("tc-judge-same", {
          task: "judge diff",
          role: "judge",
          provider: "magpie",
          model: "auto/gpt-6.2-astra",
          authorFamily: "openai",
        }, undefined, undefined, m.ctx),
      /跨家族拦截/,
    );

    recordModelCooldown("magpie", "magpie-2/vm/claude-sonnet-5-5", { kind: "rate_limit" }, healthPath);
    const alt = findHealthyPiFallback({
      role: "judge",
      failedProvider: "magpie",
      failedModel: "magpie-2/vm/claude-sonnet-5-5",
      authorFamily: "openai",
      configPath: cfgPath,
      healthPath,
    });
    assert.ok(alt, "应切到不同家族的健康备胎");
    assert.notEqual(alt.family, "openai");
    assert.equal(alt.family, "gemini");
    clearModelCooldown("", healthPath);

    fs.writeFileSync(path.join(repo, "pre-existing.ts"), "export const old = 1;\n", "utf8");
    await m.commands.get("zee-review").handler("--quick", m.ctx);
    const notifCountBefore = m.notifications.length;
    await m.emit("agent_settled", {});
    assert.equal(
      m.notifications.slice(notifCountBefore).some((n) => /保护锁期间新增非白名单/.test(n.msg)),
      false,
    );

    await m.commands.get("zee-plan").handler("架构规划", m.ctx);
    fs.mkdirSync(path.join(repo, "docs", "plans"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs", "plans", "arch.md"), "# Plan\n", "utf8");
    const notifBeforePlan = m.notifications.length;
    await m.emit("agent_settled", {});
    assert.equal(
      m.notifications.slice(notifBeforePlan).some((n) => /保护锁期间新增非白名单/.test(n.msg)),
      false,
    );
    await m.commands.get("zee").handler("执行计划", m.ctx);

    await m.commands.get("zee-review").handler("--strict", m.ctx);
    // review 锁期间写入 .agents/gardening-queue.jsonl（即使首次新建 .agents/）不应触发误报
    fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".agents", "gardening-queue.jsonl"), '{"pattern":"demo"}\n', "utf8");
    const notifBeforeQueue = m.notifications.length;
    await m.emit("agent_settled", {});
    assert.equal(
      m.notifications.slice(notifBeforeQueue).some((n) => /保护锁期间新增非白名单/.test(n.msg)),
      false,
      "review 锁期间合法写入 .agents/gardening-queue.jsonl 不应触发脏树误报",
    );

    await m.commands.get("zee-review").handler("--strict", m.ctx);
    fs.writeFileSync(path.join(repo, "app.ts"), "export const a = 2;\n", "utf8");
    fs.writeFileSync(path.join(repo, "越权中文文件.md"), "oops\n", "utf8");
    const notifCountBeforeDirty = m.notifications.length;
    await m.emit("agent_settled", {});
    assert.equal(
      m.notifications.slice(notifCountBeforeDirty).some((n) => n.level === "warning" && /保护锁期间新增非白名单[\s\S]*app\.ts/.test(n.msg)),
      true,
    );
    assert.equal(
      m.notifications.slice(notifCountBeforeDirty).some((n) => n.level === "warning" && /越权中文文件\.md/.test(n.msg)),
      true,
    );

    const zeeTool = path.join(REPO_ROOT, "skills", "zee", "scripts", "zee-tool.mjs");
    const init = JSON.parse(execFileSync(process.execPath, [zeeTool, "init-run", repo, "stale-night", "--mode", "night"], { encoding: "utf8" }));
    staleBusDir = init.busDir;
    const sp = path.join(staleBusDir, "state.json");
    const st = JSON.parse(fs.readFileSync(sp, "utf8"));
    st.status = "running";
    st.updatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(sp, JSON.stringify(st, null, 2), "utf8");

    const mFresh = createMockPi({ cwd: repo });
    zeeExtension(mFresh.pi);
    await mFresh.emit("agent_settled", {});
    assert.notEqual(mFresh.statuses.at(-1)?.value, "zee:night⚠");
  } finally {
    if (prevCfg === undefined) delete process.env.ZEE_CONFIG_PATH; else process.env.ZEE_CONFIG_PATH = prevCfg;
    if (prevHealth === undefined) delete process.env.ZEE_PROVIDER_HEALTH_PATH; else process.env.ZEE_PROVIDER_HEALTH_PATH = prevHealth;
    if (prevStale === undefined) delete process.env.ZEE_NIGHT_STALE_MS; else process.env.ZEE_NIGHT_STALE_MS = prevStale;
    if (staleBusDir) fs.rmSync(path.dirname(staleBusDir), { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v5.2.0：harnesses.pi.singleFamily 同家族放行标牌 + 只读角色回滚严禁误删运行前暂存/脏文件 (P0)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v52-pi-safe-"));
  const cfgPath = path.join(tmpDir, "zee-config.json");
  const healthPath = path.join(tmpDir, "provider-health.json");
  const fakePi = path.join(tmpDir, "fake-pi.mjs");
  const repo = path.join(tmpDir, "repo");
  const prevCfg = process.env.ZEE_CONFIG_PATH;
  const prevHealth = process.env.ZEE_PROVIDER_HEALTH_PATH;
  const prevBin = process.env.ZEE_PI_BIN;
  const prevMode = process.env.ZEE_FAKE_PI_MODE;

  try {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "z@e.c"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "z"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "app.ts"), "export const a = 1;\n", "utf8");
    fs.writeFileSync(path.join(repo, "src", "existing.ts"), "export const v = 1;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });

    // 写入测试用 fake Pi 子进程：根据 ZEE_FAKE_PI_MODE 决定是否制造脏改动
    fs.writeFileSync(
      fakePi,
      `import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
if (process.env.ZEE_FAKE_PI_MODE === "mutate") {
  fs.appendFileSync(path.join(process.cwd(), "src", "new-feature.ts"), "// touched by verifier\\n", "utf8");
  execFileSync("git", ["add", "src/existing.ts"], { cwd: process.cwd(), stdio: "ignore" });
  fs.writeFileSync(path.join(process.cwd(), "app.ts"), "export const a = 999;\\n", "utf8");
  fs.writeFileSync(path.join(process.cwd(), "rogue.txt"), "unauthorized\\n", "utf8");
}
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "fake pi done" }],
    stopReason: "stop",
    usage: { input: 10, output: 5, cost: { total: 0 } },
  },
}) + "\\n");
`,
      "utf8",
    );

    // 1. harnesses.pi.singleFamily: true 时，findHealthyPiFallback 与 zee_subagent 均放行同家族并带 [单家族降级] 提示
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 3,
        authorizedFallback: true,
        harnesses: {
          pi: {
            singleFamily: true,
            slots: {
              fast: { prefer: { family: "openai", providerInstanceId: "magpie", model: "auto/gpt-6.1-sol" } },
              workhorse: { prefer: { family: "openai", providerInstanceId: "magpie", model: "auto/gpt-6.2-astra" } },
              adversary: { prefer: { family: "openai", providerInstanceId: "magpie", model: "auto/gpt-6.2-astra" } },
            },
          },
        },
      }),
      "utf8",
    );
    process.env.ZEE_CONFIG_PATH = cfgPath;
    process.env.ZEE_PROVIDER_HEALTH_PATH = healthPath;
    process.env.ZEE_PI_BIN = fakePi;

    const sfFallback = findHealthyPiFallback({
      role: "reviewer",
      failedProvider: "magpie",
      failedModel: "auto/gpt-6.2-astra",
      authorFamily: "openai",
      configPath: cfgPath,
      healthPath,
    });
    assert.ok(sfFallback, "harnesses.pi.singleFamily=true 时应允许同家族切备");
    assert.equal(sfFallback.model, "auto/gpt-6.1-sol");

    const m = createMockPi({ cwd: repo });
    zeeExtension(m.pi);
    const subTool = m.tools.get("zee_subagent");

    process.env.ZEE_FAKE_PI_MODE = "clean";
    const sfRes = await subTool.execute(
      "tc-sf",
      {
        task: "review code",
        role: "reviewer",
        provider: "magpie",
        model: "auto/gpt-6.2-astra",
        authorFamily: "openai",
      },
      undefined,
      undefined,
      m.ctx,
    );
    assert.match(sfRes.content[0].text, /\[单家族降级\]/);

    // 2. P0 数据安全：运行前已有暂存新文件 (A src/new-feature.ts) 与既有编辑 (M src/existing.ts)
    // verifier 越权修改了它们 + 篡改干净 app.ts + 新建 rogue.txt
    // 回滚必须精准恢复 app.ts 并删除 rogue.txt，但严禁删掉用户的 src/new-feature.ts 或抹掉 src/existing.ts 的既有改动
    fs.writeFileSync(path.join(repo, "src", "new-feature.ts"), "export const userWork = true;\n", "utf8");
    execFileSync("git", ["add", "src/new-feature.ts"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "src", "existing.ts"), "export const v = 2; // user-uncommitted-edit\n", "utf8");

    process.env.ZEE_FAKE_PI_MODE = "mutate";
    const mutRes = await subTool.execute(
      "tc-p0-rollback",
      {
        task: "verify repo",
        role: "verifier",
        provider: "magpie",
        model: "auto/gpt-6.2-astra",
      },
      undefined,
      undefined,
      m.ctx,
    );
    assert.equal(mutRes.details.roleViolation, true);
    assert.match(mutRes.content[0].text, /已保护运行前既有未提交文件不误删/);
    assert.equal(fs.existsSync(path.join(repo, "rogue.txt")), false, "越权新建的 rogue.txt 必须被回滚删除");
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf8").replace(/\r\n/g, "\n"), "export const a = 1;\n", "越权篡改的干净跟踪文件必须恢复到 HEAD");
    assert.equal(fs.existsSync(path.join(repo, "src", "new-feature.ts")), true, "运行前用户暂存的新文件严禁被误删");
    assert.match(fs.readFileSync(path.join(repo, "src", "existing.ts"), "utf8"), /user-uncommitted-edit/, "运行前用户的未提交编辑严禁被 checkout HEAD 抹掉");
  } finally {
    if (prevCfg === undefined) delete process.env.ZEE_CONFIG_PATH; else process.env.ZEE_CONFIG_PATH = prevCfg;
    if (prevHealth === undefined) delete process.env.ZEE_PROVIDER_HEALTH_PATH; else process.env.ZEE_PROVIDER_HEALTH_PATH = prevHealth;
    if (prevBin === undefined) delete process.env.ZEE_PI_BIN; else process.env.ZEE_PI_BIN = prevBin;
    if (prevMode === undefined) delete process.env.ZEE_FAKE_PI_MODE; else process.env.ZEE_FAKE_PI_MODE = prevMode;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
