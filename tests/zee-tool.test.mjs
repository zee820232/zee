import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withFileLock } from "../skills/zee/scripts/lib/fs-atomic.mjs";
import { sanitizeSlug } from "../skills/zee/scripts/lib/repo-utils.mjs";

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

test("init-run / update-state / list-runs(--repo --decisions) 完整管理任务总线并去重 delegate 计数", () => {
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
    const upd = JSON.parse(runTool(["update-state", busDir, "--delegate-id", "d-1"]).stdout);
    assert.equal(upd.state.status, "running");
    assert.equal(upd.state.resumeNext, "U2");
    assert.equal(upd.state.delegatesDispatched, 1);
    assert.equal(upd.state.units.length, 1);

    runTool(["log-decision", busDir, "--unit", "U1", "--phase", "bug-fix", "--decision", "ruled-out-cache", "--why", "redis miss", "--result", "rejected"]);

    const list = JSON.parse(runTool(["list-runs", "--repo", repo, "--decisions"]).stdout);
    assert.equal(list.ok, true);
    assert.ok(list.runs.some((r) => r.slug === "poke-test"));
    assert.ok(list.decisions.some((d) => d.decision === "ruled-out-cache"));
  } finally {
    if (busDir) fs.rmSync(path.dirname(busDir), { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-create 重复覆盖含 node_modules junction 不崩溃，cleanup-worktrees 保护未合并 detached worktree", () => {
  const repo = initGitRepo("zee-wt-");
  try {
    execFileSync("git", ["branch", "feat"], { cwd: repo });
    fs.mkdirSync(path.join(repo, "node_modules", "demo"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "demo", "index.js"), "module.exports = 1;\n", "utf8");

    const created1 = JSON.parse(runTool(["worktree-create", repo, "s1", "lane1", "HEAD", "--branch", "feat/lane1"]).stdout);
    assert.equal(created1.ok, true);
    assert.equal(created1.flattened, true);
    assert.equal(created1.branch, "feat-lane1");
    assert.equal(fs.existsSync(path.join(created1.worktreePath, "node_modules", "demo", "index.js")), true);

    // 同一 lane 第二次覆盖创建（Windows junction 场景）必须成功
    const created2 = JSON.parse(runTool(["worktree-create", repo, "s1", "lane1", "HEAD", "--branch", "feat/lane1"]).stdout);
    assert.equal(created2.ok, true);
    assert.equal(created2.reusedExistingBranch, true);

    // 创建含未合并提交的 detached worktree，--prune-safe 严禁自动删除
    const det = JSON.parse(runTool(["worktree-create", repo, "s2", "det-lane", "HEAD"]).stdout);
    fs.writeFileSync(path.join(det.worktreePath, "work.txt"), "precious\n", "utf8");
    execFileSync("git", ["-C", det.worktreePath, "add", "work.txt"]);
    execFileSync("git", ["-C", det.worktreePath, "commit", "-qm", "unmerged work"]);

    const cleaned = JSON.parse(runTool(["cleanup-worktrees", repo, "--prune-safe"]).stdout);
    assert.equal(cleaned.ok, true);
    assert.equal(fs.existsSync(created2.worktreePath), false, "已合并 worktree 应被回收");
    assert.equal(fs.existsSync(det.worktreePath), true, "含未合并 commit 的 detached worktree 严禁被 --prune-safe 删除");
    const detInfo = cleaned.worktrees.find((w) => w.path === det.worktreePath);
    assert.equal(detInfo?.bucket, "review_unmerged_detached");

    // 手动清理测试残留 detached worktree
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", det.worktreePath]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("sandbox-export 与 sandbox-clean 支持 .agents/zee.project.json、export-ignore、无 HEAD 空仓与非 Git 目录", () => {
  const repo = initGitRepo("zee-sbx-");
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-nongit-"));
  const noHeadRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-nohead-"));
  try {
    // 1. 含 .agents/zee.project.json 与 .gitattributes (export-ignore) 的仓库
    fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
    fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".agents", "zee.project.json"), JSON.stringify({ denyCommands: ["npm publish"] }), "utf8");
    fs.writeFileSync(path.join(repo, ".gitattributes"), "tests/ export-ignore\n", "utf8");
    fs.writeFileSync(path.join(repo, "tests", "a.test.js"), "// keep me\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "add project json and gitattributes"], { cwd: repo });

    fs.writeFileSync(path.join(repo, "untracked.txt"), "hello sandbox\n", "utf8");
    const exported = JSON.parse(runTool(["sandbox-export", "--repo", repo, "--working-tree", "--prefix", "rev"]).stdout);
    assert.equal(exported.ok, true);
    assert.equal(fs.readFileSync(path.join(exported.sandboxDir, "untracked.txt"), "utf8"), "hello sandbox\n");
    assert.equal(fs.existsSync(path.join(exported.sandboxDir, "tests", "a.test.js")), true, "export-ignore 不应导致测试目录丢失");

    // 即使导出目录含 .agents/zee.project.json，带 marker 的合法沙盒也必须能被 sandbox-clean 正常清理
    const cleaned = JSON.parse(runTool(["sandbox-clean", exported.sandboxDir]).stdout);
    assert.equal(cleaned.ok, true);
    assert.equal(fs.existsSync(exported.sandboxDir), false);

    // 拒绝清理真实仓库
    const bad = runTool(["sandbox-clean", repo], { allowFail: true });
    assert.notEqual(bad.status, 0);

    // 2. 纯非 Git 目录 --working-tree 导出并清理
    fs.writeFileSync(path.join(nonGitDir, "hello.txt"), "zero-git\n", "utf8");
    const nonGitExp = JSON.parse(runTool(["sandbox-export", "--repo", nonGitDir, "--working-tree", "--prefix", "probe"]).stdout);
    assert.equal(nonGitExp.ok, true);
    assert.equal(nonGitExp.nonGit, true);
    assert.equal(fs.readFileSync(path.join(nonGitExp.sandboxDir, "hello.txt"), "utf8"), "zero-git\n");
    runTool(["sandbox-clean", nonGitExp.sandboxDir]);

    // 3. 无 HEAD 空仓已暂存文件导出不丢失
    execFileSync("git", ["init", "-q"], { cwd: noHeadRepo });
    fs.writeFileSync(path.join(noHeadRepo, "staged.ts"), "export const s = 1;\n", "utf8");
    execFileSync("git", ["add", "staged.ts"], { cwd: noHeadRepo });
    const noHeadExp = JSON.parse(runTool(["sandbox-export", "--repo", noHeadRepo, "--working-tree", "--prefix", "probe"]).stdout);
    assert.equal(fs.readFileSync(path.join(noHeadExp.sandboxDir, "staged.ts"), "utf8"), "export const s = 1;\n");
    runTool(["sandbox-clean", noHeadExp.sandboxDir]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(nonGitDir, { recursive: true, force: true });
    fs.rmSync(noHeadRepo, { recursive: true, force: true });
  }
});

test("gate-tamper-diff 区分纯新增测试与篡改门禁、支持中文文件名与无 HEAD 未暂存改动、不误拦 IP", () => {
  const repo = initGitRepo("zee-tamper-");
  const noHeadRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-tamper-nohead-"));
  try {
    // 1. 普通 IP 字面量与纯新增测试文件不触发 requiresCountersign
    fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
    fs.writeFileSync(path.join(repo, "server.js"), 'export const LOCAL = "127.0.0.1";\n', "utf8");
    fs.writeFileSync(path.join(repo, "tests", "new-feature.test.mjs"), "// brand new test\n", "utf8");
    const cleanOut = JSON.parse(runTool(["gate-tamper-diff", "--repo", repo, "--working-tree"]).stdout);
    assert.equal(cleanOut.ok, true);
    assert.equal(cleanOut.requiresCountersign, false, "纯新增测试不应误报门禁篡改");
    assert.ok(cleanOut.testFilesAdded.includes("tests/new-feature.test.mjs"));
    assert.equal(cleanOut.gateFilesTouched.length, 0);

    // 先提交多种语言的测试文件，再修改它们 -> 必须全部触发 gateFilesTouched + requiresCountersign: true
    fs.mkdirSync(path.join(repo, "__tests__"), { recursive: true });
    fs.mkdirSync(path.join(repo, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(repo, "__tests__", "ui.js"), "// jest\n", "utf8");
    fs.writeFileSync(path.join(repo, "pkg", "foo_test.go"), "package pkg\n", "utf8");
    fs.writeFileSync(path.join(repo, "test_api.py"), "def test_ok(): pass\n", "utf8");
    execFileSync("git", ["add", "tests/new-feature.test.mjs", "__tests__/ui.js", "pkg/foo_test.go", "test_api.py"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "add multi-lang tests"], { cwd: repo });

    fs.writeFileSync(path.join(repo, "tests", "new-feature.test.mjs"), "// weakened test\n", "utf8");
    fs.writeFileSync(path.join(repo, "__tests__", "ui.js"), "// weakened jest\n", "utf8");
    fs.writeFileSync(path.join(repo, "pkg", "foo_test.go"), "package pkg // weakened\n", "utf8");
    fs.writeFileSync(path.join(repo, "test_api.py"), "def test_ok(): return\n", "utf8");

    fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".agents", "verify-ctl.mjs"), "// ok\n", "utf8");
    fs.writeFileSync(path.join(repo, ".agents", "zee.project.json"), "{}\n", "utf8");
    const fakeKey = ["sk", "1234567890abcdef123456"].join("-");
    const tsIgnoreTag = ["@", "ts-ignore"].join("");
    const asAnyTag = ["as", "any"].join(" ");
    // .md 文档中包含抑制注解示例不得误报
    fs.writeFileSync(path.join(repo, "DOC.md"), `严禁使用 \`${tsIgnoreTag}\` 与 \`${asAnyTag}\`。\n`, "utf8");
    fs.writeFileSync(
      path.join(repo, "测试文件.ts"),
      `// ${tsIgnoreTag}\nconst token = "${fakeKey}";\nconst broken = "你好\uFFFD世界";\n`,
      "utf8",
    );

    const dirtyOut = JSON.parse(runTool(["gate-tamper-diff", "--repo", repo, "--working-tree"]).stdout);
    assert.equal(dirtyOut.requiresCountersign, true);
    assert.ok(dirtyOut.gateFilesTouched.includes("tests/new-feature.test.mjs"));
    assert.ok(dirtyOut.gateFilesTouched.includes("__tests__/ui.js"));
    assert.ok(dirtyOut.gateFilesTouched.includes("pkg/foo_test.go"));
    assert.ok(dirtyOut.gateFilesTouched.includes("test_api.py"));
    assert.ok(dirtyOut.gateFilesTouched.includes(".agents/verify-ctl.mjs"));
    assert.ok(dirtyOut.gateFilesTouched.includes(".agents/zee.project.json"));
    assert.ok(dirtyOut.suppressionsAdded.some((x) => x.pattern === tsIgnoreTag && x.file === "测试文件.ts"), "中文文件名不得出现八进制转义乱码");
    assert.equal(dirtyOut.suppressionsAdded.some((x) => x.file === "DOC.md"), false, ".md 文档不应误报抑制注解");
    assert.ok(dirtyOut.secretsAdded.some((x) => x.pattern === "api_key_prefix"));
    assert.ok(dirtyOut.encodingIssues.some((x) => x.pattern === "utf8_replacement_char"));

    // 2. 无 HEAD 空仓已暂存文件被工作区继续追加抑制注解必须检出
    execFileSync("git", ["init", "-q"], { cwd: noHeadRepo });
    fs.writeFileSync(path.join(noHeadRepo, "app.ts"), "export const a = 1;\n", "utf8");
    execFileSync("git", ["add", "app.ts"], { cwd: noHeadRepo });
    fs.appendFileSync(path.join(noHeadRepo, "app.ts"), `// ${tsIgnoreTag}\nexport const b = 2;\n`, "utf8");
    const noHeadTamper = JSON.parse(runTool(["gate-tamper-diff", "--repo", noHeadRepo, "--working-tree"]).stdout);
    assert.equal(noHeadTamper.requiresCountersign, true);
    assert.ok(noHeadTamper.suppressionsAdded.some((x) => x.pattern === tsIgnoreTag));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(noHeadRepo, { recursive: true, force: true });
  }
});

test("resolve-model 与 doctor 支持 Schema v3、T3 思考下限钳制、冷却借调/告警、projectProfile 与非激活宿主隔离", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zee-cfg-"));
  const cfgPath = path.join(tmp, "zee-config.json");
  const healthPath = path.join(tmp, "provider-health.json");
  const env = { ZEE_CONFIG_PATH: cfgPath, ZEE_PROVIDER_HEALTH_PATH: healthPath };
  try {
    const missing = runTool(["resolve-model", "--role", "coder"], { env, allowFail: true });
    assert.notEqual(missing.status, 0);
    const standalonePi = JSON.parse(runTool(["resolve-model", "--harness", "pi", "--role", "coder", "--allow-standalone"], { env }).stdout);
    assert.equal(standalonePi.ok, true);
    assert.equal(standalonePi.standalone, true);
    assert.deepEqual(standalonePi.resolved.subagentArgs, {});
    assert.equal(standalonePi.resolved.effort, "medium");

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

    const docOk = JSON.parse(runTool(["doctor", "--repo", REPO_ROOT], { env }).stdout);
    assert.equal(docOk.ok, true);
    assert.equal(docOk.projectProfile.packageManager, "npm");
    assert.equal(docOk.projectProfile.detectedCmds.test, "npm test");

    // 3 槽位正常解析（fast / workhorse / adversary）
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

    // --repo 指向不存在路径必须报错
    const badRepoDoc = runTool(["doctor", "--repo", path.join(tmp, "does-not-exist")], { env, allowFail: true });
    assert.notEqual(badRepoDoc.status, 0);

    // 单槽位 prefer 冷却 -> 自动切 backup
    const future = Date.now() + 60_000;
    fs.writeFileSync(
      healthPath,
      JSON.stringify({ version: 1, models: { "magpie/auto/gpt-6.2-astra": { cooldownUntil: future, reason: "http_429" } } }),
      "utf8",
    );
    const rFallback = JSON.parse(runTool(["resolve-model", "--harness", "pi", "--role", "coder"], { env }).stdout);
    assert.equal(rFallback.resolved.binding.model, "auto/gemini-4-hydrogen");
    assert.ok(rFallback.resolved.cooldownFallback);

    // fast.prefer 与 fast.backup 均冷却 -> 对称借调 workhorse
    fs.writeFileSync(
      healthPath,
      JSON.stringify({
        version: 1,
        models: {
          "magpie/auto/gemini-4-hydrogen": { cooldownUntil: future, reason: "http_429" },
          "magpie/auto/deepseek-v4.1-flash": { cooldownUntil: future, reason: "http_429" },
        },
      }),
      "utf8",
    );
    const fastBorrow = JSON.parse(runTool(["resolve-model", "--harness", "pi", "--role", "scout"], { env }).stdout);
    assert.equal(fastBorrow.resolved.binding.model, "auto/gpt-6.2-astra");
    assert.ok(fastBorrow.resolved.cooldownFallback);

    // 模拟 prefer 与 backup 及 adversary 全员冷却 -> 返回 cooldownWarning
    fs.writeFileSync(
      healthPath,
      JSON.stringify({
        version: 1,
        models: {
          "magpie/auto/gpt-6.2-astra": { cooldownUntil: future, reason: "http_429" },
          "magpie/auto/gemini-4-hydrogen": { cooldownUntil: future, reason: "http_429" },
          "magpie/magpie-2/vm/claude-sonnet-5-5": { cooldownUntil: future, reason: "http_429" },
        },
      }),
      "utf8",
    );
    const allCooled = JSON.parse(runTool(["resolve-model", "--harness", "pi", "--role", "coder"], { env }).stdout);
    assert.equal(allCooled.resolved.cooldownWarning?.allCooledDown, true);
    runTool(["provider-health", "--clear"], { env });

    cfgV3.slots.adversary.prefer.family = "openai";
    fs.writeFileSync(cfgPath, JSON.stringify(cfgV3, null, 2), "utf8");
    const docBad = runTool(["doctor", "--harness", "pi"], { env, allowFail: true });
    assert.notEqual(docBad.status, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("多宿主严格隔离、T3 options medium 下限钳制与 AGY 代际锁", () => {
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
    // 1. 宿主环境变量检测优先级（PI / T3+AGY / AGY）
    const piDocEnv = JSON.parse(runTool(["doctor"], { env: { ...cleanHarnessEnv, PI_CODING_AGENT: "true" } }).stdout);
    assert.equal(piDocEnv.activeHarness, "pi");

    const t3DocEnv = JSON.parse(
      runTool(["doctor"], { env: { ...cleanHarnessEnv, T3CODE_THREAD_ID: "th-1", ANTIGRAVITY_AGENT: "1" } }).stdout,
    );
    assert.equal(t3DocEnv.activeHarness, "t3");
    assert.equal(t3DocEnv.runtimeProvider, "antigravity");

    const agyDocEnv = JSON.parse(runTool(["doctor"], { env: { ...cleanHarnessEnv, ANTIGRAVITY_AGENT: "1" } }).stdout);
    assert.equal(agyDocEnv.activeHarness, "antigravity");

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
            // 故意让 pi 坏掉，验证查 t3 时不被 pi 连坐
            fast: { prefer: { family: "openai", providerInstanceId: "magpie", model: "auto/gpt-6.2-astra" } },
            workhorse: { prefer: { family: "openai", providerInstanceId: "magpie", model: "auto/gpt-6.2-astra" } },
            adversary: { prefer: { family: "openai", providerInstanceId: "magpie", model: "auto/gpt-6.2-astra" } },
          },
        },
        t3: {
          slots: {
            fast: {
              prefer: { family: "gemini", effort: "low", providerInstanceId: "antigravity", model: "gemini-4-hydrogen", options: { thought_level: "low" } },
            },
            workhorse: {
              prefer: { family: "gemini", effort: "high", providerInstanceId: "antigravity", model: "gemini-4-neon", options: { thought_level: "high" } },
            },
            adversary: {
              prefer: { family: "openai", effort: "medium", providerInstanceId: "codex", model: "gpt-6.2-astra", options: { reasoningEffort: "medium" } },
            },
          },
        },
        agy: {
          singleFamily: true,
          slots: {
            fast: { prefer: { family: "gemini", effort: "low", tier: "lite", model: "flash_lite", swarmModel: "gemini-4-hydrogen-medium" } },
            workhorse: { prefer: { family: "gemini", effort: "xhigh", model: "gemini-4-carbon" } },
            adversary: { prefer: { family: "gemini", effort: "medium", model: "inherit", swarmModel: "gemini-4-carbon-medium" } },
          },
        },
      },
    };
    fs.writeFileSync(cfgPath, JSON.stringify(multiCfg, null, 2), "utf8");

    // 查 t3 不应因非激活宿主 pi 同家族配置而报错
    const t3Doc = JSON.parse(runTool(["doctor", "--harness", "t3"], { env: cleanHarnessEnv }).stdout);
    assert.equal(t3Doc.ok, true);
    assert.ok(t3Doc.warnings.some((w) => /\[非当前宿主\]/.test(w)));

    const t3Rev = JSON.parse(runTool(["resolve-model", "--harness", "t3", "--role", "reviewer"], { env: cleanHarnessEnv }).stdout);
    assert.equal(t3Rev.resolved.harness, "t3");
    assert.equal(t3Rev.resolved.surface, "delegate_task");
    assert.equal(t3Rev.resolved.family, "openai");
    assert.deepEqual(t3Rev.resolved.delegateTarget, {
      providerInstanceId: "codex",
      model: "gpt-6.2-astra",
      options: { reasoningEffort: "medium" },
    });

    // T3 options.thought_level=low 必须被强制提升至 medium
    const t3Fast = JSON.parse(runTool(["resolve-model", "--harness", "t3", "--role", "scout"], { env: cleanHarnessEnv }).stdout);
    assert.equal(t3Fast.resolved.effort, "medium");
    assert.equal(t3Fast.resolved.delegateTarget.options.thought_level, "medium");

    // AGY invoke_subagent 即使旧配置写了 tier=lite/flash_lite 也一律返回 inherit
    const agyFast = JSON.parse(runTool(["resolve-model", "--harness", "agy", "--role", "scout"], { env: cleanHarnessEnv }).stdout);
    assert.equal(agyFast.resolved.harness, "antigravity");
    assert.equal(agyFast.resolved.model, "inherit");

    const agySwarmRev = JSON.parse(
      runTool(["resolve-model", "--harness", "agy", "--surface", "swarm", "--role", "reviewer"], { env: cleanHarnessEnv }).stdout,
    );
    assert.equal(agySwarmRev.resolved.model, "gemini-4-carbon-medium");

    // AGY swarm 下 carbon 最高钳制到 high
    const agyCarbonSwarm = JSON.parse(
      runTool(["resolve-model", "--harness", "agy", "--surface", "swarm", "--role", "coder"], { env: cleanHarnessEnv }).stdout,
    );
    assert.equal(agyCarbonSwarm.resolved.model, "gemini-4-carbon-high");

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

test("recommend-models 剥离 ANSI/警告行、对齐能力梯队与预算阶梯、支持 T3 capabilities/inherit-parent 与主流公开模型", () => {
  const noisyCatalog = [
    "\x1b[33mWarning: deprecated flag\x1b[0m",
    "\x1b[1mprovider  model                                   context  max-out  thinking  images\x1b[0m",
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

  // 1. Pi 9 模型含 ANSI/警告行实测目录 (--budget medium)：零 deepseek，去重优先 auto/*
  const piMed = JSON.parse(runTool(["recommend-models", "--harness", "pi", "--budget", "medium"], { input: noisyCatalog }).stdout);
  assert.equal(piMed.ok, true);
  const piSlots = piMed.harnessConfig.slots;
  assert.doesNotMatch(JSON.stringify(piSlots), /Warning|deprecated|"model":"model"|deepseek/i);
  assert.equal(piSlots.workhorse.prefer.model, "auto/gpt-6.2-astra");
  assert.equal(piSlots.workhorse.prefer.effort, "high");
  assert.equal(piSlots.workhorse.backup.model, "magpie-2/vm/claude-sonnet-5-5");
  assert.equal(piSlots.adversary.prefer.model, "magpie-2/vm/claude-sonnet-5-5");
  assert.equal(piSlots.adversary.backup.model, "auto/gemini-4-hydrogen");
  assert.equal(piSlots.fast.prefer.model, "auto/gemini-4-hydrogen");
  assert.equal(piSlots.fast.prefer.effort, "medium");
  assert.equal(piSlots.fast.backup.model, "auto/gpt-6.1-sol");
  assert.equal(piSlots.fast.backup.effort, "medium");
  assert.ok(piMed.optInModels.some((m) => /deepseek-v4\.1-flash/.test(m.model)));
  assert.ok(piMed.skippedDuplicates.length >= 4);

  // 2. --budget large (xhigh/xhigh/high + carbon 钳制到 high) 与 --budget small (全 medium，无 low)
  const carbonCatalog = JSON.stringify([
    { providerInstanceId: "t3", model: "gemini-4-carbon" },
    { providerInstanceId: "codex", model: "gpt-6.2-astra" },
    { providerInstanceId: "t3", model: "gemini-4-hydrogen" },
  ]);
  const largeRes = JSON.parse(runTool(["recommend-models", "--harness", "pi", "--budget", "large"], { input: carbonCatalog }).stdout);
  assert.equal(largeRes.harnessConfig.slots.workhorse.prefer.effort, "xhigh");
  assert.equal(largeRes.harnessConfig.slots.adversary.prefer.effort, "high");
  assert.equal(largeRes.harnessConfig.slots.fast.prefer.effort, "high");

  const smallRes = JSON.parse(runTool(["recommend-models", "--harness", "pi", "--budget", "small"], { input: noisyCatalog }).stdout);
  assert.equal(smallRes.harnessConfig.slots.workhorse.prefer.effort, "medium");
  assert.equal(smallRes.harnessConfig.slots.adversary.prefer.effort, "medium");
  assert.equal(smallRes.harnessConfig.slots.fast.prefer.effort, "medium");

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
  assert.deepEqual(t3Slots.fast.prefer.options, { thought_level: "medium" });
  assert.doesNotMatch(JSON.stringify(t3Slots), /deepseek|gemini-3\.8|orchestrator|"providerInstanceId":"pi"/i);

  // 4. 仅剩 optInOnly 模型时自动兜底放行并标记 fallbackToOptIn
  const optInOnlyInput = JSON.stringify([{ providerInstanceId: "magpie", model: "auto/deepseek-v4.1-flash" }]);
  const optRes = JSON.parse(runTool(["recommend-models", "--harness", "pi", "--budget", "medium"], { input: optInOnlyInput }).stdout);
  assert.equal(optRes.fallbackToOptIn, true);
  assert.equal(optRes.harnessConfig.slots.workhorse.prefer.model, "auto/deepseek-v4.1-flash");

  // 5. AGY 输入带 -high/-medium 后缀时不生成双后缀
  const agyRes = JSON.parse(
    runTool(["recommend-models", "--harness", "agy", "--budget", "medium"], {
      input: JSON.stringify(["gemini-4-neon-high", "gemini-4-neon-medium", "gemini-4-hydrogen-high", "gemini-4-carbon-high"]),
    }).stdout,
  );
  assert.equal(agyRes.harnessConfig.slots.workhorse.prefer.swarmModel, "gemini-4-neon-high");
  assert.equal(agyRes.harnessConfig.slots.fast.prefer.swarmModel, "gemini-4-hydrogen-medium");
  assert.doesNotMatch(JSON.stringify(agyRes.harnessConfig.slots), /-(?:high|medium|xhigh)-(?:high|medium|xhigh)/);

  // 6. 主流公开模型（gemini-2.5-pro 不被踢进 optInOnly）
  const publicRes = JSON.parse(
    runTool(["recommend-models", "--harness", "codex", "--budget", "medium"], {
      input: JSON.stringify(["claude-opus-4-6", "gpt-5-codex", "gemini-2.5-pro", "o3"]),
    }).stdout,
  );
  assert.equal(publicRes.optInModels.length, 0);
  assert.equal(publicRes.harnessConfig.slots.workhorse.prefer.family, "claude");
  assert.equal(publicRes.harnessConfig.slots.adversary.prefer.family, "openai");

  // 7. inherit-parent / auto 别名兼容 doctor 与跨宿主 resolve-model
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
    assert.ok(doc.warnings.some((w) => /最低思考档位/.test(w)));

    const piFastRes = JSON.parse(runTool(["resolve-model", "--harness", "pi", "--role", "scout"], { env: { ZEE_CONFIG_PATH: cfgPath } }).stdout);
    assert.equal(piFastRes.resolved.inheritParent, true);
    assert.deepEqual(piFastRes.resolved.subagentArgs, { thinkingLevel: "medium" });

    const piRes = JSON.parse(runTool(["resolve-model", "--harness", "pi", "--role", "coder"], { env: { ZEE_CONFIG_PATH: cfgPath } }).stdout);
    assert.equal(piRes.resolved.inheritParent, true);
    assert.deepEqual(piRes.resolved.subagentArgs, { thinkingLevel: "high" });

    const t3Res = JSON.parse(runTool(["resolve-model", "--harness", "t3", "--role", "coder"], { env: { ZEE_CONFIG_PATH: cfgPath } }).stdout);
    assert.equal(t3Res.resolved.inheritParent, true);
    assert.equal(t3Res.resolved.delegateTarget, null);

    const agyInheritRes = JSON.parse(runTool(["resolve-model", "--harness", "agy", "--role", "coder"], { env: { ZEE_CONFIG_PATH: cfgPath } }).stdout);
    assert.equal(agyInheritRes.resolved.inheritParent, true);
    assert.equal(agyInheritRes.resolved.model, "inherit");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("v5.2.0 基础设施加固：sanitizeSlug、UUID 锁防误删、update-state 锁不泄漏、init-run --ensure-git 与 finding 园艺队列", async () => {
  // 1. sanitizeSlug 防路径穿越、纯中文碰撞、尾点与 Windows 保留字
  assert.notEqual(sanitizeSlug(".."), "..");
  assert.notEqual(sanitizeSlug("."), ".");
  assert.notEqual(sanitizeSlug("用户登录"), sanitizeSlug("支付模块"));
  assert.equal(sanitizeSlug("foo.").endsWith("."), false);
  assert.notEqual(sanitizeSlug("con"), "con");

  // 2. withFileLock owner token 防误删他人活锁 + 拒绝 async 回调
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-lock-owner-"));
  const target = path.join(lockDir, "state.json");
  try {
    assert.throws(() => withFileLock(target, async () => "bad"), /仅支持同步回调/);
    let bLockSurvived = false;
    withFileLock(target, () => {
      // 模拟锁已被进程 B 回收并替换为新 token
      fs.writeFileSync(`${target}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now(), token: "owner-B" }) + "\n", "utf8");
    });
    bLockSurvived = fs.existsSync(`${target}.lock`) && JSON.parse(fs.readFileSync(`${target}.lock`, "utf8")).token === "owner-B";
    assert.equal(bLockSurvived, true, "A 的 finally 严禁删除已被 B 持有的新锁");
    fs.rmSync(`${target}.lock`, { force: true });
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }

  // 3. init-run --ensure-git 空目录自举 + update-state 非法 JSON 不泄漏锁 + finding 园艺队列聚类/关单
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v52-auto-"));
  let busDir = "";
  try {
    const init = JSON.parse(runTool(["init-run", emptyDir, "bootstrap-app", "--ensure-git"]).stdout);
    busDir = init.busDir;
    assert.equal(init.gitBootstrap?.initializedGit, true);
    assert.equal(init.gitBootstrap?.createdBaselineCommit, true);

    // 无 HEAD 仓库存在已暂存文件时，init-run --ensure-git 创建纯空基线提交且完整保留用户暂存区
    const stagedNoHead = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v53-staged-"));
    let stagedBusDir = "";
    try {
      execFileSync("git", ["init", "-q"], { cwd: stagedNoHead });
      fs.writeFileSync(path.join(stagedNoHead, "staged-user.ts"), "export const keep = 1;\n", "utf8");
      execFileSync("git", ["add", "staged-user.ts"], { cwd: stagedNoHead });
      const stagedInit = JSON.parse(runTool(["init-run", stagedNoHead, "keep-index", "--ensure-git"]).stdout);
      stagedBusDir = stagedInit.busDir;
      assert.equal(stagedInit.gitBootstrap?.createdBaselineCommit, true);
      const headFiles = execFileSync("git", ["-C", stagedNoHead, "ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" }).trim();
      assert.equal(headFiles, "", "空基线提交不得吞掉用户暂存区文件");
      const cachedFiles = execFileSync("git", ["-C", stagedNoHead, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim();
      assert.equal(cachedFiles, "staged-user.ts", "用户已暂存文件须完整保留在 index 中");
    } finally {
      if (stagedBusDir) fs.rmSync(path.dirname(stagedBusDir), { recursive: true, force: true });
      fs.rmSync(stagedNoHead, { recursive: true, force: true });
    }

    const badUpd = runTool(["update-state", busDir, "--budget", "[]"], { allowFail: true });
    assert.notEqual(badUpd.status, 0);
    assert.equal(fs.existsSync(path.join(busDir, "state.json.lock")), false, "非法参数退出不得遗留 state.json.lock");

    // 园艺队列：累计 3 次标 systemic: true，resolve 后关闭
    for (let i = 1; i <= 3; i++) {
      runTool(["finding", "add", "--repo", emptyDir, "--pattern", "missing-seam", "--summary", `occ ${i}`, "--file", `src/a${i}.ts`]);
    }
    const listed = JSON.parse(runTool(["finding", "list", "--repo", emptyDir]).stdout);
    assert.equal(listed.systemicCount, 1);
    assert.equal(listed.clusters[0].pattern, "missing-seam");
    assert.equal(listed.clusters[0].systemic, true);
    assert.equal(listed.clusters[0].openCount, 3);

    runTool(["finding", "resolve", "--repo", emptyDir, "--pattern", "missing-seam", "--note", "added lint rule"]);
    const afterResolve = JSON.parse(runTool(["finding", "list", "--repo", emptyDir]).stdout);
    assert.equal(afterResolve.openClusters, 0);
    const withResolved = JSON.parse(runTool(["finding", "list", "--repo", emptyDir, "--include-resolved"]).stdout);
    assert.equal(withResolved.clusters[0].lastNote, "added lint rule");
  } finally {
    if (busDir) fs.rmSync(path.dirname(busDir), { recursive: true, force: true });
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("update-state 6 并发无锁冲突、hasChildRefs、过期锁 TTL、T3 跨家族冷却切备与 TSV 防公式注入", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v52-conc-"));
  const repo = path.join(tmpDir, "repo");
  const noHeadRepo = path.join(tmpDir, "nohead-repo");
  const healthPath = path.join(tmpDir, "provider-health.json");
  const cfgPath = path.join(tmpDir, "zee-config.json");
  let busDir = "";
  try {
    // 0. 无 HEAD commit 空仓 -> doctor 给出基线警告
    fs.mkdirSync(noHeadRepo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: noHeadRepo });
    const emptyDoc = JSON.parse(runTool(["doctor", "--repo", noHeadRepo]).stdout);
    assert.equal(emptyDoc.repoStatus.hasHeadCommit, false);
    assert.ok(emptyDoc.warnings.some((w) => /HEAD|基线/.test(w)));

    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "z@e.c"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "z"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "index.js"), "export const x = 1;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });

    const init = JSON.parse(runTool(["init-run", repo, "conc-cli"]).stdout);
    busDir = init.busDir;

    // 1. --units-file / stdin + 多 --unit-upsert / --units / --decision
    const unitsFile = path.join(tmpDir, "units.json");
    fs.writeFileSync(unitsFile, JSON.stringify([{ id: "U1", status: "pending" }, { id: "U2", status: "done" }]), "utf8");
    runTool(["update-state", busDir, "--units-file", unitsFile]);
    const stdinRes = spawnSync(process.execPath, [ZEE_TOOL, "update-state", busDir, "--units-file", "-"], {
      input: JSON.stringify([{ id: "U3", status: "pending" }]),
      encoding: "utf8",
    });
    assert.equal(stdinRes.status, 0, stdinRes.stderr);
    runTool([
      "update-state",
      busDir,
      "--unit-upsert",
      JSON.stringify({ id: "M1", status: "pending" }),
      "--unit-upsert",
      JSON.stringify({ id: "M2", status: "done" }),
      "--decision",
      JSON.stringify({ unit: "M2", phase: "execute", decision: "batch\tcheck", why: "line1\nline2", evidence: "ok", result: "pass" }),
    ]);

    fs.writeFileSync(path.join(busDir, "state.json.tmp.999999.1000"), "{\"stale\":true}\n", "utf8");
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
    for (const id of ["U1", "U2", "U3", "M1", "M2", "C1", "C2", "C3", "C4", "C5", "C6"]) {
      assert.equal(ids.has(id), true, `并发更新后应保留 unit ${id}`);
    }
    const dirEntries = fs.readdirSync(busDir);
    assert.equal(dirEntries.some((n) => n.includes(".tmp.") || n.endsWith(".lock")), false);

    // 2. log-decision 防公式注入、ANSI 剥离与保留 "-"
    runTool([
      "log-decision",
      busDir,
      "--unit",
      "U1",
      "--phase",
      "start",
      "--decision",
      "=SUM(A1:A2)\x1b[31mred\x1b[0m",
      "--why",
      "+cmd",
      "--result",
      "@ok",
    ]);
    const tsvRows = fs.readFileSync(path.join(busDir, "decisions.tsv"), "utf8").trim().split(/\r?\n/);
    assert.match(tsvRows[1], /batch check/);
    const cols = tsvRows.at(-1).split("\t");
    assert.equal(cols[3], "'=SUM(A1:A2)red");
    assert.equal(cols[4], "'+cmd");
    assert.equal(cols[5], "-", "空字段默认占位符 '-' 不应被误转义为 \"'-\"");
    assert.equal(cols[6], "'@ok");

    // 3. worktree-create hasChildRefs：已有 feat/u1 时建 --branch feat 自动扁平为 feat-wt
    execFileSync("git", ["branch", "feat/u1"], { cwd: repo });
    const wtCreated = JSON.parse(runTool(["worktree-create", repo, "v510-cli", "lane1", "HEAD", "--branch", "feat"]).stdout);
    assert.equal(wtCreated.branch, "feat-wt");
    assert.equal(wtCreated.flattened, true);

    // 4. cleanup-worktrees 识别超过 TTL 的陈旧 .zee-lock.json（即使 PID 仍存活）
    fs.writeFileSync(
      `${wtCreated.worktreePath}.zee-lock.json`,
      JSON.stringify({ pid: process.pid, role: "coder", createdAt: new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString() }),
      "utf8",
    );
    const cleaned = JSON.parse(
      execFileSync(process.execPath, [ZEE_TOOL, "cleanup-worktrees", repo, "--prune-safe"], {
        encoding: "utf8",
        env: { ...process.env, ZEE_WORKTREE_LOCK_TTL_MS: String(60 * 60 * 1000) },
      }),
    );
    assert.equal(cleaned.prunedCount, 1, "超过 TTL 的过期锁不应阻止 worktree 清理");

    // 5. provider-health --record（双传 --provider 去重）+ T3 resolve-model 冷却切备与 judge 跨家族校验
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 3,
        harnesses: {
          t3: {
            slots: {
              fast: { prefer: { providerInstanceId: "antigravity", model: "gemini-4-hydrogen", family: "gemini", effort: "medium" } },
              workhorse: {
                prefer: { providerInstanceId: "codex", model: "gpt-6.2-astra", family: "openai", effort: "high" },
                backup: { providerInstanceId: "antigravity", model: "gemini-4-neon", family: "gemini", effort: "high" },
              },
              adversary: {
                prefer: { providerInstanceId: "claudeAgent", model: "claude-opus-5-5", family: "claude", effort: "high" },
                backup: { providerInstanceId: "codex", model: "gpt-6.2-astra", family: "openai", effort: "high" },
              },
            },
          },
        },
      }),
      "utf8",
    );
    const recOut = JSON.parse(
      execFileSync(
        process.execPath,
        [ZEE_TOOL, "provider-health", "--record", "codex/gpt-6.2-astra", "--provider", "codex", "--kind", "rate_limit", "--reason", "429 quota"],
        { encoding: "utf8", env: { ...process.env, ZEE_PROVIDER_HEALTH_PATH: healthPath } },
      ),
    );
    assert.equal(recOut.ok, true);
    assert.equal(recOut.recorded.key, "codex/gpt-6.2-astra", "同时传 --record codex/... 与 --provider codex 不应拼成双前缀");

    const resolved = JSON.parse(
      execFileSync(process.execPath, [ZEE_TOOL, "resolve-model", "--harness", "t3", "--role", "coder", "--config", cfgPath], {
        encoding: "utf8",
        env: { ...process.env, ZEE_PROVIDER_HEALTH_PATH: healthPath },
      }),
    );
    assert.equal(resolved.resolved.delegateTarget.model, "gemini-4-neon");
    assert.equal(resolved.resolved.cooldownFallback.skippedKey, "codex/gpt-6.2-astra");

    // adversary.prefer (claude) 冷却且 authorFamily=openai 时，judge 必须跳过同家族 openai backup，切到异构 gemini
    execFileSync(
      process.execPath,
      [ZEE_TOOL, "provider-health", "--record", "claudeAgent/claude-opus-5-5", "--kind", "rate_limit"],
      { encoding: "utf8", env: { ...process.env, ZEE_PROVIDER_HEALTH_PATH: healthPath } },
    );
    const resolvedJudge = JSON.parse(
      execFileSync(
        process.execPath,
        [ZEE_TOOL, "resolve-model", "--harness", "t3", "--role", "judge", "--author-family", "openai", "--config", cfgPath],
        { encoding: "utf8", env: { ...process.env, ZEE_PROVIDER_HEALTH_PATH: healthPath } },
      ),
    );
    assert.equal(resolvedJudge.resolved.family, "gemini", "resolve-model --role judge --author-family openai 必须跳过同家族备胎");

    // --help 正常返回退出码 0
    const helpRes = runTool(["--help"]);
    assert.equal(helpRes.status, 0);
    assert.match(helpRes.stdout, /zee-tool\.mjs v5\.3\.0/);
  } finally {
    if (busDir) fs.rmSync(path.dirname(busDir), { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v5.3.0 trustLevel 硬闸门自动降级、Feature Map 探测与单仓只读 recall（含密钥脱敏）", () => {
  const repo = initGitRepo("zee-v53-");
  const txDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v53-tx-"));
  let busDir = "";
  try {
    // 1. 无 verify-ctl/typecheck 却配置 trustLevel=T3 -> 强制钳制回 T1 并列出缺口
    fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".agents", "zee.project.json"), JSON.stringify({ trustLevel: "T3", denyCommands: ["npm publish"] }), "utf8");
    const clamped = JSON.parse(runTool(["doctor", "--repo", repo]).stdout);
    assert.equal(clamped.projectProfile.configuredTrust, "T3");
    assert.equal(clamped.projectProfile.effectiveTrust, "T1");
    assert.ok(clamped.projectProfile.trustGateGaps.length >= 2);
    assert.ok(clamped.warnings.some((w) => /强制降级/.test(w)));

    // 2. zee 自身仓库（已自举 verify-ctl + Feature Map + typecheck + denyCommands）-> ready + T3
    const selfDoc = JSON.parse(runTool(["doctor", "--repo", REPO_ROOT]).stdout);
    assert.equal(selfDoc.ok, true);
    assert.equal(selfDoc.projectProfile.verifiability, "ready");
    assert.equal(selfDoc.projectProfile.effectiveTrust, "T3");
    assert.ok(selfDoc.projectProfile.verifyFeaturesMap);

    // 3. 单仓 recall 聚合决策、园艺队列、ADR、GLOSSARY 与脱敏转录
    const init = JSON.parse(runTool(["init-run", repo, "recall-demo"]).stdout);
    busDir = init.busDir;
    runTool(["log-decision", busDir, "--unit", "U1", "--phase", "bug-fix", "--decision", "retry-lock-fix", "--why", "prevent duplicate job", "--result", "pass"]);
    runTool(["finding", "add", "--repo", repo, "--pattern", "retry-leak", "--summary", "retry lock leaks on crash"]);

    fs.mkdirSync(path.join(repo, "docs", "adr"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "docs", "adr", "0001-retry-lock.md"),
      "---\nstatus: superseded by ADR-0002\n---\n\n# Retry lock lease\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(repo, "GLOSSARY.md"),
      "# Domain\n\n**Retry Lease**:\nLease protecting job retry.\n_Avoid_: mutex, token\n",
      "utf8",
    );
    const fakeSecret = ["sk", "secret1234567890abcd"].join("-");
    fs.writeFileSync(
      path.join(txDir, "chat-1.jsonl"),
      JSON.stringify({ role: "user", content: `<skill name="zee">expanded</skill> 请排查 retry lock 故障，临时测试 key=${fakeSecret}` }) + "\n",
      "utf8",
    );

    const recalled = JSON.parse(runTool(["recall", "--repo", repo, "--topic", "retry", "--transcripts-dir", txDir]).stdout);
    assert.equal(recalled.ok, true);
    assert.equal(recalled.capsule.decisions.length, 1);
    assert.equal(recalled.capsule.openFindings[0].pattern, "retry-leak");
    assert.equal(recalled.capsule.adrs[0].status, "superseded by ADR-0002");
    assert.equal(recalled.capsule.glossaryTerms[0].term, "Retry Lease");
    assert.equal(recalled.capsule.glossaryTerms[0].avoid, "mutex, token");
    assert.equal(recalled.capsule.transcriptHits.length, 1);
    assert.doesNotMatch(recalled.capsule.transcriptHits[0].excerpt, /secret1234567890/);
    assert.doesNotMatch(recalled.capsule.transcriptHits[0].excerpt, /<skill/);
    assert.match(recalled.capsule.transcriptHits[0].excerpt, /sk-\*\*\*\*abcd/);
  } finally {
    if (busDir) fs.rmSync(path.dirname(busDir), { recursive: true, force: true });
    fs.rmSync(txDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
