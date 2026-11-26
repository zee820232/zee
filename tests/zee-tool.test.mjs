import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZEE_TOOL = path.join(REPO_ROOT, "skills", "zee", "scripts", "zee-tool.mjs");

function runTool(args, { env = {}, allowFail = false, input = undefined } = {}) {
  const res = spawnSync(process.execPath, [ZEE_TOOL, ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, ...env },
  });
  if (!allowFail) {
    assert.equal(res.status, 0, `zee-tool ${args.join(" ")} 失败:\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function initGitRepo(prefix = "zee-tool-repo-") {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "zee@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "zee"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "init\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
  return repo;
}

test("init-run / update-state / list-runs 完整管理任务总线并去重 delegate 计数", () => {
  const repo = initGitRepo();
  let busDir = "";
  try {
    const init = JSON.parse(runTool(["init-run", repo, "poke-test", "--mode", "night", "--conversation-id", "c-1"]).stdout);
    assert.equal(init.ok, true);
    busDir = init.busDir;
    assert.equal(fs.existsSync(init.statePath), true);
    assert.equal(fs.existsSync(init.tsvPath), true);

    runTool([
      "update-state",
      busDir,
      "--status",
      "running",
      "--resume-next",
      "U2",
      "--budget",
      JSON.stringify({ maxSubagents: 12 }),
      "--unit-upsert",
      JSON.stringify({ id: "U1", status: "done" }),
      "--delegate-id",
      "d-1",
    ]);
    // 同一 delegate-id 不重复累加
    const upd = JSON.parse(runTool(["update-state", busDir, "--delegate-id", "d-1"]).stdout);
    assert.equal(upd.state.status, "running");
    assert.equal(upd.state.resumeNext, "U2");
    assert.equal(upd.state.delegatesDispatched, 1);
    assert.equal(upd.state.units.length, 1);

    const list = JSON.parse(runTool(["list-runs", repo]).stdout);
    assert.equal(list.ok, true);
    assert.ok(list.runs.some((r) => r.slug === "poke-test"));
  } finally {
    if (busDir) fs.rmSync(path.dirname(busDir), { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-create 与 cleanup-worktrees 自动处理嵌套分支碰撞并挂载 node_modules", () => {
  const repo = initGitRepo("zee-wt-");
  try {
    // 制造 refs/heads/feat 与 feat/lane 的嵌套分支名碰撞
    execFileSync("git", ["branch", "feat"], { cwd: repo });
    fs.mkdirSync(path.join(repo, "node_modules", "demo"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "demo", "index.js"), "module.exports = 1;\n", "utf8");

    const created = JSON.parse(runTool(["worktree-create", repo, "s1", "lane1", "HEAD", "--branch", "feat/lane1"]).stdout);
    assert.equal(created.ok, true);
    assert.equal(created.flattened, true);
    assert.equal(created.branch, "feat-lane1");
    assert.equal(fs.existsSync(path.join(created.worktreePath, "node_modules", "demo", "index.js")), true);

    const cleaned = JSON.parse(runTool(["cleanup-worktrees", repo, "--prune-safe"]).stdout);
    assert.equal(cleaned.ok, true);
    assert.equal(fs.existsSync(created.worktreePath), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("sandbox-export 与 sandbox-clean 正确导出工作区改动并拒绝清理非法目录", () => {
  const repo = initGitRepo("zee-sbx-");
  try {
    fs.writeFileSync(path.join(repo, "untracked.txt"), "hello sandbox\n", "utf8");
    const exported = JSON.parse(runTool(["sandbox-export", "--repo", repo, "--working-tree", "--prefix", "rev"]).stdout);
    assert.equal(exported.ok, true);
    assert.equal(fs.readFileSync(path.join(exported.sandboxDir, "untracked.txt"), "utf8"), "hello sandbox\n");

    const cleaned = JSON.parse(runTool(["sandbox-clean", exported.sandboxDir]).stdout);
    assert.equal(cleaned.ok, true);
    assert.equal(fs.existsSync(exported.sandboxDir), false);

    const bad = runTool(["sandbox-clean", repo], { allowFail: true });
    assert.notEqual(bad.status, 0);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("gate-tamper-diff 检查门禁、抑制注解、密钥与 UTF-8 乱码，且不误拦普通 IP 地址", () => {
  const repo = initGitRepo("zee-tamper-");
  try {
    // 1. 普通 IP 字面量必须放行（ips 不要）
    fs.writeFileSync(
      path.join(repo, "server.js"),
      'export const LOCAL = "127.0.0.1"; export const LAN = "192.168.1.50";\n',
      "utf8",
    );
    const cleanOut = JSON.parse(runTool(["gate-tamper-diff", "--repo", repo, "--working-tree"]).stdout);
    assert.equal(cleanOut.ok, true);
    assert.equal(cleanOut.requiresCountersign, false);
    assert.equal(cleanOut.secretsAdded.length, 0);

    // 2. 注入抑制注解、门禁文件改动（含 .agents/verify-ctl.mjs / .agents/zee.project.json / test/）、伪密钥与 \uFFFD 乱码
    fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
    fs.mkdirSync(path.join(repo, "test"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(repo, "tests", "smoke.test.mjs"), "// ok\n", "utf8");
    fs.writeFileSync(path.join(repo, "test", "helper.js"), "// ok\n", "utf8");
    fs.writeFileSync(path.join(repo, ".agents", "verify-ctl.mjs"), "// ok\n", "utf8");
    fs.writeFileSync(path.join(repo, ".agents", "zee.project.json"), "{}\n", "utf8");
    const fakeKey = ["sk", "1234567890abcdef123456"].join("-");
    fs.writeFileSync(
      path.join(repo, "bad.ts"),
      `// @ts-ignore\nconst token = "${fakeKey}";\nconst broken = "你好\uFFFD世界";\n`,
      "utf8",
    );

    const dirtyOut = JSON.parse(runTool(["gate-tamper-diff", "--repo", repo, "--working-tree"]).stdout);
    assert.equal(dirtyOut.requiresCountersign, true);
    assert.ok(dirtyOut.gateFilesTouched.includes("tests/smoke.test.mjs"));
    assert.ok(dirtyOut.gateFilesTouched.includes("test/helper.js"));
    assert.ok(dirtyOut.gateFilesTouched.includes(".agents/verify-ctl.mjs"));
    assert.ok(dirtyOut.gateFilesTouched.includes(".agents/zee.project.json"));
    assert.ok(dirtyOut.suppressionsAdded.some((x) => x.pattern === "@ts-ignore"));
    assert.ok(dirtyOut.secretsAdded.some((x) => x.pattern === "api_key_prefix"));
    assert.ok(dirtyOut.encodingIssues.some((x) => x.pattern === "utf8_replacement_char"));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("resolve-model 与 doctor 支持 Schema v3 3 槽位、跨家族校验、--allow-standalone 及冷却切备", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zee-cfg-"));
  const cfgPath = path.join(tmp, "zee-config.json");
  const healthPath = path.join(tmp, "provider-health.json");
  const env = { ZEE_CONFIG_PATH: cfgPath, ZEE_PROVIDER_HEALTH_PATH: healthPath };
  try {
    // 无配置文件：默认报错，带 --allow-standalone 走单兵降级
    const missing = runTool(["resolve-model", "--role", "coder"], { env, allowFail: true });
    assert.notEqual(missing.status, 0);
    const standalone = JSON.parse(runTool(["resolve-model", "--role", "coder", "--allow-standalone"], { env }).stdout);
    assert.equal(standalone.ok, true);
    assert.equal(standalone.standalone, true);

    // 写入 Schema v3 3 槽位（workhorse=openai, adversary=claude）
    const cfgV3 = {
      version: 3,
      authorizedFallback: true,
      slots: {
        fast: {
          prefer: { family: "gemini", modelHint: "gemini-4-hydrogen", tier: "fast", effort: "low", bindings: { pi: { providerInstanceId: "magpie", model: "auto/gemini-4-hydrogen" } } },
          backup: { family: "deepseek", modelHint: "deepseek-v4.1-flash", tier: "fast", effort: "low", bindings: { pi: { providerInstanceId: "magpie", model: "auto/deepseek-v4.1-flash" } } },
        },
        workhorse: {
          prefer: { family: "openai", modelHint: "gpt-6.2-astra", tier: "standard", effort: "medium", bindings: { pi: { providerInstanceId: "magpie", model: "auto/gpt-6.2-astra" } } },
          backup: { family: "gemini", modelHint: "gemini-4-hydrogen", tier: "standard", effort: "medium", bindings: { pi: { providerInstanceId: "magpie", model: "auto/gemini-4-hydrogen" } } },
        },
        adversary: {
          prefer: { family: "claude", modelHint: "claude-sonnet-5-5", tier: "pro", effort: "high", bindings: { pi: { providerInstanceId: "magpie", model: "magpie-2/vm/claude-sonnet-5-5" } } },
          backup: { family: "gemini", modelHint: "gemini-4-hydrogen", tier: "standard", effort: "high", bindings: { pi: { providerInstanceId: "magpie", model: "auto/gemini-4-hydrogen" } } },
        },
      },
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfgV3, null, 2), "utf8");

    const docOk = JSON.parse(runTool(["doctor"], { env }).stdout);
    assert.equal(docOk.ok, true);

    const rScout = JSON.parse(runTool(["resolve-model", "--harness", "pi", "--role", "scout"], { env }).stdout);
    assert.equal(rScout.resolved.slot, "fast");
    assert.equal(rScout.resolved.binding.model, "auto/gemini-4-hydrogen");

    const rVerifier = JSON.parse(runTool(["resolve-model", "--harness", "pi", "--role", "verifier"], { env }).stdout);
    assert.equal(rVerifier.resolved.slot, "workhorse");
    assert.equal(rVerifier.resolved.subagentArgs.provider, "magpie");
    assert.equal(rVerifier.resolved.subagentArgs.model, "auto/gpt-6.2-astra");
    assert.equal(rVerifier.resolved.subagentArgs.thinkingLevel, "medium");

    const rRev = JSON.parse(runTool(["resolve-model", "--harness", "pi", "--role", "reviewer"], { env }).stdout);
    assert.equal(rRev.resolved.slot, "adversary");
    assert.equal(rRev.resolved.family, "claude");

    // 模拟 prefer 进入 429 冷却 -> resolve-model 自动切 backup
    fs.writeFileSync(
      healthPath,
      JSON.stringify({ version: 1, models: { "magpie/auto/gpt-6.2-astra": { cooldownUntil: Date.now() + 60_000, reason: "http_429" } } }),
      "utf8",
    );
    const rFallback = JSON.parse(runTool(["resolve-model", "--harness", "pi", "--role", "coder"], { env }).stdout);
    assert.equal(rFallback.resolved.binding.model, "auto/gemini-4-hydrogen");
    assert.ok(rFallback.resolved.cooldownFallback);

    const clr = JSON.parse(runTool(["provider-health", "--clear"], { env }).stdout);
    assert.equal(clr.ok, true);

    // 同家族校验失败：把 adversary 也改成 openai -> doctor 报错
    cfgV3.slots.adversary.prefer.family = "openai";
    fs.writeFileSync(cfgPath, JSON.stringify(cfgV3, null, 2), "utf8");
    const docBad = runTool(["doctor"], { env, allowFail: true });
    assert.notEqual(docBad.status, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("多宿主严格隔离：宿主环境变量检测、legacy slots 不串读、harnesses.<h> 共存与 AGY inherit 锁", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zee-multi-harness-"));
  const cfgPath = path.join(tmp, "zee-config.json");
  const cleanHarnessEnv = {
    ZEE_CONFIG_PATH: cfgPath,
    PI_CODING_AGENT: "",
    AI_AGENT: "",
    T3CODE_THREAD_ID: "",
    T3_ACP_MCP_ENDPOINT: "",
    T3_ACP_MCP_NODE: "",
    ANTIGRAVITY_AGENT: "",
    ANTIGRAVITY_CLI: "",
    CLAUDECODE: "",
    CLAUDE_CODE: "",
    CODEX_THREAD_ID: "",
    CODEX_SANDBOX: "",
    PLUGIN_ROOT: "",
  };

  try {
    // 1. 宿主检测优先级验证
    const piDoc = JSON.parse(runTool(["doctor"], { env: { ...cleanHarnessEnv, PI_CODING_AGENT: "true" } }).stdout);
    assert.equal(piDoc.activeHarness, "pi");

    const t3Doc = JSON.parse(
      runTool(["doctor"], { env: { ...cleanHarnessEnv, T3CODE_THREAD_ID: "th-1", ANTIGRAVITY_AGENT: "1" } }).stdout,
    );
    assert.equal(t3Doc.activeHarness, "t3");
    assert.equal(t3Doc.runtimeProvider, "antigravity");

    const agyDoc = JSON.parse(runTool(["doctor"], { env: { ...cleanHarnessEnv, ANTIGRAVITY_AGENT: "1" } }).stdout);
    assert.equal(agyDoc.activeHarness, "antigravity");

    // 2. legacy Pi-only slots 不得串读进 t3 / agy
    const legacyPiOnly = {
      version: 3,
      authorizedFallback: true,
      slots: {
        fast: { prefer: { family: "deepseek", bindings: { pi: { providerInstanceId: "magpie", model: "auto/deepseek-v4.1-flash" } } } },
        workhorse: { prefer: { family: "openai", bindings: { pi: { providerInstanceId: "magpie", model: "auto/gpt-6.2-astra" } } } },
        adversary: { prefer: { family: "gemini", modelHint: "gemini-4-hydrogen", tier: "pro", bindings: { pi: { providerInstanceId: "magpie", model: "auto/gemini-4-hydrogen" } } } },
      },
    };
    fs.writeFileSync(cfgPath, JSON.stringify(legacyPiOnly, null, 2), "utf8");

    const t3Blocked = runTool(["resolve-model", "--harness", "t3", "--role", "coder"], { env: cleanHarnessEnv, allowFail: true });
    assert.notEqual(t3Blocked.status, 0);
    assert.doesNotMatch(t3Blocked.stdout + t3Blocked.stderr, /magpie/);

    const t3Standalone = JSON.parse(
      runTool(["resolve-model", "--harness", "t3", "--role", "coder", "--allow-standalone"], { env: cleanHarnessEnv }).stdout,
    );
    assert.equal(t3Standalone.ok, true);
    assert.equal(t3Standalone.standalone, true);

    const agyStandalone = JSON.parse(
      runTool(["resolve-model", "--harness", "agy", "--role", "reviewer", "--allow-standalone"], { env: cleanHarnessEnv }).stdout,
    );
    assert.equal(agyStandalone.ok, true);
    assert.equal(agyStandalone.resolved.model, "inherit");

    const docT3Legacy = JSON.parse(runTool(["doctor", "--harness", "t3"], { env: cleanHarnessEnv }).stdout);
    assert.equal(docT3Legacy.ok, true);
    assert.equal(docT3Legacy.activeHarnessConfigured, false);
    assert.ok(docT3Legacy.warnings.some((w) => /t3/.test(w)));

    // 3. harnesses.pi / harnesses.t3 / harnesses.agy 共存互不串台
    const multiCfg = {
      version: 3,
      authorizedFallback: true,
      harnesses: {
        pi: {
          slots: {
            fast: { prefer: { family: "deepseek", effort: "low", providerInstanceId: "magpie", model: "auto/deepseek-v4.1-flash" } },
            workhorse: { prefer: { family: "openai", effort: "medium", providerInstanceId: "magpie", model: "auto/gpt-6.2-astra" } },
            adversary: { prefer: { family: "claude", effort: "medium", providerInstanceId: "magpie", model: "magpie-2/vm/claude-sonnet-5-5" } },
          },
        },
        t3: {
          slots: {
            fast: {
              prefer: { family: "gemini", effort: "low", providerInstanceId: "antigravity", model: "gemini-4-hydrogen", options: { thought_level: "low" } },
            },
            workhorse: {
              prefer: { family: "gemini", effort: "medium", providerInstanceId: "antigravity", model: "gemini-4-neon", options: { thought_level: "high" } },
            },
            adversary: {
              prefer: { family: "openai", effort: "medium", providerInstanceId: "codex", model: "gpt-6.2-astra", options: { reasoningEffort: "medium" } },
            },
          },
        },
        agy: {
          singleFamily: true,
          slots: {
            fast: { prefer: { family: "gemini", effort: "low", model: "inherit", swarmModel: "gemini-4-hydrogen-low" } },
            workhorse: { prefer: { family: "gemini", effort: "high", model: "inherit", swarmModel: "gemini-4-neon-high" } },
            adversary: { prefer: { family: "gemini", effort: "medium", model: "inherit", swarmModel: "gemini-4-carbon-medium" } },
          },
        },
      },
    };
    fs.writeFileSync(cfgPath, JSON.stringify(multiCfg, null, 2), "utf8");

    const t3Rev = JSON.parse(runTool(["resolve-model", "--harness", "t3", "--role", "reviewer"], { env: cleanHarnessEnv }).stdout);
    assert.equal(t3Rev.resolved.harness, "t3");
    assert.equal(t3Rev.resolved.surface, "delegate_task");
    assert.equal(t3Rev.resolved.family, "openai");
    assert.deepEqual(t3Rev.resolved.delegateTarget, {
      providerInstanceId: "codex",
      model: "gpt-6.2-astra",
      options: { reasoningEffort: "medium" },
    });

    const agySub = JSON.parse(runTool(["resolve-model", "--harness", "agy", "--role", "reviewer"], { env: cleanHarnessEnv }).stdout);
    assert.equal(agySub.resolved.harness, "antigravity");
    assert.equal(agySub.resolved.model, "inherit");

    const agySwarm = JSON.parse(
      runTool(["resolve-model", "--harness", "agy", "--surface", "swarm", "--role", "reviewer"], { env: cleanHarnessEnv }).stdout,
    );
    assert.equal(agySwarm.resolved.model, "gemini-4-carbon-medium");

    const agyDocPass = JSON.parse(runTool(["doctor", "--harness", "agy"], { env: cleanHarnessEnv }).stdout);
    assert.equal(agyDocPass.ok, true);
    assert.equal(agyDocPass.activeHarnessConfigured, true);
    assert.ok(agyDocPass.warnings.some((w) => /singleFamily/.test(w)));

    const piCoder = JSON.parse(runTool(["resolve-model", "--harness", "pi", "--role", "coder"], { env: cleanHarnessEnv }).stdout);
    assert.deepEqual(piCoder.resolved.subagentArgs, {
      provider: "magpie",
      model: "auto/gpt-6.2-astra",
      thinkingLevel: "medium",
    });

    // t3 未开启 singleFamily 且同家族 -> doctor 报错
    multiCfg.harnesses.t3.slots.adversary.prefer = { family: "gemini", effort: "medium", providerInstanceId: "antigravity", model: "gemini-4-carbon" };
    fs.writeFileSync(cfgPath, JSON.stringify(multiCfg, null, 2), "utf8");
    const t3BadDoc = runTool(["doctor", "--harness", "t3"], { env: cleanHarnessEnv, allowFail: true });
    assert.notEqual(t3BadDoc.status, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("recommend-models 对齐 pstack 能力梯队与预算阶梯，且支持 inherit-parent 别名", () => {
  const piCatalog = [
    "provider  model                                   context  max-out  thinking  images",
    "magpie    auto/deepseek-v4.1-flash                1M       128K     yes       yes   ",
    "magpie    auto/gemini-4-hydrogen                  1.0M     65.5K    yes       yes   ",
    "magpie    auto/gpt-6.1-sol                        500K     128K     yes       yes   ",
    "magpie    auto/gpt-6.2-astra                      272K     128K     yes       yes   ",
    "magpie    magpie-2/agy-cli/gemini-4-hydrogen      1.0M     65.5K    yes       yes   ",
    "magpie    magpie-2/codex/gpt-6.1-sol              500K     128K     yes       yes   ",
    "magpie    magpie-2/codex/gpt-6.2-astra            272K     128K     yes       yes   ",
    "magpie    magpie-2/vm/claude-sonnet-5-5           1M       128K     yes       yes   ",
    "magpie    magpie-2/workbuddy/deepseek-v4.1-flash  1M       128K     yes       yes   ",
  ].join("\n");

  // 1. Pi 9 模型实测目录 (--budget medium)：零 deepseek，去重优先 auto/*
  const piMed = JSON.parse(runTool(["recommend-models", "--harness", "pi", "--budget", "medium"], { input: piCatalog }).stdout);
  assert.equal(piMed.ok, true);
  const piSlots = piMed.harnessConfig.slots;
  assert.equal(piSlots.workhorse.prefer.model, "auto/gpt-6.2-astra");
  assert.equal(piSlots.workhorse.prefer.effort, "high");
  assert.equal(piSlots.workhorse.backup.model, "magpie-2/vm/claude-sonnet-5-5");
  assert.equal(piSlots.adversary.prefer.model, "magpie-2/vm/claude-sonnet-5-5");
  assert.equal(piSlots.adversary.backup.model, "auto/gemini-4-hydrogen");
  assert.equal(piSlots.fast.prefer.model, "auto/gemini-4-hydrogen");
  assert.equal(piSlots.fast.prefer.effort, "low");
  assert.equal(piSlots.fast.backup.model, "auto/gpt-6.1-sol");
  assert.doesNotMatch(JSON.stringify(piSlots), /deepseek/i);
  assert.ok(piMed.optInModels.some((m) => /deepseek-v4\.1-flash/.test(m.model)));
  assert.ok(piMed.skippedDuplicates.length >= 4);

  // 2. --budget large (xhigh/xhigh/medium + carbon 钳制到 high) 与 --budget small (medium/medium/low)
  const carbonCatalog = JSON.stringify([
    { providerInstanceId: "t3", model: "gemini-4-carbon" },
    { providerInstanceId: "codex", model: "gpt-6.2-astra" },
    { providerInstanceId: "t3", model: "gemini-4-hydrogen" },
  ]);
  const largeRes = JSON.parse(runTool(["recommend-models", "--harness", "pi", "--budget", "large"], { input: carbonCatalog }).stdout);
  assert.equal(largeRes.harnessConfig.slots.workhorse.prefer.effort, "xhigh");
  assert.equal(largeRes.harnessConfig.slots.adversary.prefer.effort, "high");
  assert.equal(largeRes.harnessConfig.slots.fast.prefer.effort, "medium");

  const smallRes = JSON.parse(runTool(["recommend-models", "--harness", "pi", "--budget", "small"], { input: piCatalog }).stdout);
  assert.equal(smallRes.harnessConfig.slots.workhorse.prefer.effort, "medium");
  assert.equal(smallRes.harnessConfig.slots.adversary.prefer.effort, "medium");
  assert.equal(smallRes.harnessConfig.slots.fast.prefer.effort, "low");

  // 3. T3 orchestrator_capabilities JSON：排除 disabled / pi / gemini-pro-orchestrator / deepseek / gemini-3.8-flash
  const t3Caps = JSON.stringify({
    inheritedProviderInstanceId: "antigravity",
    providers: [
      {
        providerInstanceId: "antigravity",
        driverKind: "antigravity",
        canRunChildTask: true,
        models: [
          { id: "gemini-4-neon", options: [{ id: "thought_level", values: ["low", "medium", "high", "xhigh"] }] },
          { id: "gemini-4-hydrogen", options: [{ id: "thought_level", values: ["low", "medium", "high", "xhigh"] }] },
          { id: "gemini-pro-orchestrator-neon", options: [{ id: "thought_level", values: ["low", "medium", "high", "xhigh"] }] },
          { id: "gemini-3.8-flash", options: [{ id: "thought_level", values: ["low", "medium", "high"] }] },
        ],
      },
      {
        providerInstanceId: "codex",
        driverKind: "codex",
        canRunChildTask: true,
        models: [
          { id: "gpt-6.2-astra", options: [{ id: "reasoningEffort", values: ["low", "medium", "high", "xhigh"] }] },
          { id: "gpt-6.2-sol", options: [{ id: "reasoningEffort", values: ["low", "medium", "high", "xhigh"] }] },
          { id: "auto/deepseek-v4.1-flash", options: [{ id: "reasoningEffort", values: ["none", "low", "high", "max"] }] },
        ],
      },
      {
        providerInstanceId: "pi",
        driverKind: "pi",
        canRunChildTask: true,
        models: [{ id: "magpie/auto/gpt-6.2-astra" }],
      },
      {
        providerInstanceId: "claudeAgent",
        driverKind: "claudeAgent",
        canRunChildTask: false,
        models: [{ id: "claude-opus-5-5" }],
      },
    ],
  });
  const t3Med = JSON.parse(runTool(["recommend-models", "--harness", "t3", "--budget", "medium"], { input: t3Caps }).stdout);
  const t3Slots = t3Med.harnessConfig.slots;
  assert.equal(t3Slots.workhorse.prefer.providerInstanceId, "antigravity");
  assert.equal(t3Slots.workhorse.prefer.model, "gemini-4-neon");
  assert.deepEqual(t3Slots.workhorse.prefer.options, { thought_level: "high" });
  assert.equal(t3Slots.adversary.prefer.providerInstanceId, "codex");
  assert.equal(t3Slots.adversary.prefer.model, "gpt-6.2-astra");
  assert.deepEqual(t3Slots.adversary.prefer.options, { reasoningEffort: "high" });
  assert.equal(t3Slots.fast.prefer.providerInstanceId, "antigravity");
  assert.equal(t3Slots.fast.prefer.model, "gemini-4-hydrogen");
  assert.deepEqual(t3Slots.fast.prefer.options, { thought_level: "low" });
  assert.doesNotMatch(JSON.stringify(t3Slots), /deepseek|gemini-3\.8|orchestrator|"providerInstanceId":"pi"/i);

  // 4. 仅剩 optInOnly 模型时自动兜底放行并标记 fallbackToOptIn
  const optInOnlyInput = JSON.stringify([{ providerInstanceId: "magpie", model: "auto/deepseek-v4.1-flash" }]);
  const optRes = JSON.parse(runTool(["recommend-models", "--harness", "pi", "--budget", "medium"], { input: optInOnlyInput }).stdout);
  assert.equal(optRes.fallbackToOptIn, true);
  assert.equal(optRes.harnessConfig.slots.workhorse.prefer.model, "auto/deepseek-v4.1-flash");

  // 5. inherit-parent 别名兼容 doctor 与跨宿主 resolve-model
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zee-inherit-alias-"));
  const cfgPath = path.join(tmp, "zee-config.json");
  try {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 3,
        harnesses: {
          pi: {
            slots: {
              fast: { prefer: { model: "inherit-parent", effort: "low" } },
              workhorse: { prefer: { model: "inherit-parent", effort: "high" } },
              adversary: { prefer: { model: "auto", effort: "high" } },
            },
          },
          t3: {
            slots: {
              fast: { prefer: { model: "inherit-parent", effort: "low" } },
              workhorse: { prefer: { model: "inherit-parent", effort: "high" } },
              adversary: { prefer: { model: "inherit-parent", effort: "high" } },
            },
          },
          agy: {
            singleFamily: true,
            slots: {
              fast: { prefer: { model: "inherit-parent", effort: "low" } },
              workhorse: { prefer: { model: "inherit-parent", effort: "high" } },
              adversary: { prefer: { model: "inherit-parent", effort: "high" } },
            },
          },
        },
      }),
      "utf8",
    );
    const doc = JSON.parse(runTool(["doctor", "--harness", "pi"], { env: { ZEE_CONFIG_PATH: cfgPath } }).stdout);
    assert.equal(doc.ok, true);
    assert.ok(doc.warnings.some((w) => /父模型别名/.test(w)));

    const piRes = JSON.parse(runTool(["resolve-model", "--harness", "pi", "--role", "coder"], { env: { ZEE_CONFIG_PATH: cfgPath } }).stdout);
    assert.equal(piRes.resolved.inheritParent, true);
    assert.deepEqual(piRes.resolved.subagentArgs, { thinkingLevel: "high" });

    const t3Res = JSON.parse(runTool(["resolve-model", "--harness", "t3", "--role", "coder"], { env: { ZEE_CONFIG_PATH: cfgPath } }).stdout);
    assert.equal(t3Res.resolved.inheritParent, true);
    assert.equal(t3Res.resolved.delegateTarget, null);

    const agyRes = JSON.parse(runTool(["resolve-model", "--harness", "agy", "--role", "coder"], { env: { ZEE_CONFIG_PATH: cfgPath } }).stdout);
    assert.equal(agyRes.resolved.inheritParent, true);
    assert.equal(agyRes.resolved.model, "inherit");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("update-state 支持多 --unit-upsert/--units/6 并发子进程无锁冲突零孤儿 + log-decision + doctor --repo 基线警告", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-empty-repo-"));
  let busDir = "";
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const init = JSON.parse(runTool(["init-run", repo, "conc-test"]).stdout);
    busDir = init.busDir;

    // 1. doctor 检查无 HEAD commit 空仓 -> 给出 warning
    const emptyDoc = JSON.parse(runTool(["doctor", "--repo", repo]).stdout);
    assert.equal(emptyDoc.repoStatus.hasHeadCommit, false);
    assert.ok(emptyDoc.warnings.some((w) => /HEAD|基线/.test(w)));

    // 2. 多 --unit-upsert 累加 + --units 批量 + --decision
    runTool([
      "update-state",
      busDir,
      "--unit-upsert",
      JSON.stringify({ id: "M1", status: "pending" }),
      "--unit-upsert",
      JSON.stringify({ id: "M2", status: "pending" }),
      "--units",
      JSON.stringify([{ id: "M3", status: "done" }, { id: "M4", status: "pending" }]),
      "--decision",
      JSON.stringify({ unit: "M3", phase: "execute", decision: "batch\tcheck", why: "line1\nline2", evidence: "ok", result: "pass" }),
    ]);

    // 预先写入一个死 PID 孤儿临时文件，验证 update-state 自动清理
    fs.writeFileSync(path.join(busDir, "state.json.tmp.999999.1000"), "{\"stale\":true}\n", "utf8");

    // 3. 6 个并发子进程同时写同一个 state.json
    const spawnAsync = (args) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [ZEE_TOOL, ...args], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit=${code}: ${stderr}`))));
      });

    await Promise.all(
      ["C1", "C2", "C3", "C4", "C5", "C6"].map((id) =>
        spawnAsync(["update-state", busDir, "--unit-upsert", JSON.stringify({ id, status: "done" })]),
      ),
    );

    const state = JSON.parse(fs.readFileSync(path.join(busDir, "state.json"), "utf8"));
    const ids = new Set(state.units.map((u) => u.id));
    for (const id of ["M1", "M2", "M3", "M4", "C1", "C2", "C3", "C4", "C5", "C6"]) {
      assert.equal(ids.has(id), true, `并发更新后应保留 unit ${id}`);
    }

    const dirEntries = fs.readdirSync(busDir);
    assert.equal(dirEntries.some((n) => n.includes(".tmp.") || n.endsWith(".lock")), false, `不应遗留临时或锁文件: ${dirEntries.join(",")}`);

    runTool([
      "log-decision",
      busDir,
      "--unit",
      "C1",
      "--phase",
      "night",
      "--decision",
      "stop\tafter\t2",
      "--why",
      "verify\nfail",
      "--evidence",
      "exit 1",
      "--result",
      "blocked",
    ]);
    const tsvLines = fs.readFileSync(path.join(busDir, "decisions.tsv"), "utf8").trim().split(/\r?\n/);
    assert.equal(tsvLines.length, 3);
    assert.match(tsvLines[1], /batch check/);
    assert.match(tsvLines[2], /\tC1\tnight\tstop after 2\tverify fail\texit 1\tblocked$/);
  } finally {
    if (busDir) fs.rmSync(path.dirname(busDir), { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
