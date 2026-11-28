import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildWinCmdInvocation, cleanDups, findDuplicateSkillDirs, isEphemeralSource, quoteWinCmdArg } from "../scripts/install.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_SKILLS = ["zee", "zee-plan", "zee-verify", "zee-review", "zee-night", "zee-retro", "zee-setup"];
const EXPLICIT_ONLY_SKILLS = ["zee-plan", "zee-verify", "zee-review", "zee-night", "zee-retro", "zee-setup"];
const EXPECTED_PLAYBOOKS = ["understand.md", "plan.md", "feature.md", "design.md", "bug-fix.md", "perf.md", "verify.md", "overnight.md", "ship.md"];
const EXPECTED_ROLES = ["scout.md", "architect.md", "ui.md", "coder.md", "verifier.md", "reviewer.md", "judge.md"];

test("v5.3.0 清单文件、发布白名单、自举验证设施与 AGY 1× 规则元数据符合规范", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.version, "5.3.0");
  assert.deepEqual(pkg.pi?.extensions, ["./pi-extension/index.ts"]);
  assert.equal(pkg.pi?.skills, undefined, "package.json 不应声明 pi.skills 以免与 /skill:zee* 冲突");
  assert.equal(pkg.peerDependencies?.["@earendil-works/pi-tui"], undefined, "不应保留 pi-tui 依赖");
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes("rules/") && pkg.files.includes("skills/"), "package.json 须配置 files 白名单防止打包研究/测试文件");
  assert.equal(pkg.files.includes("agents/"), false, "发布白名单严禁包含 agents/ 自定义代理，防止触发 AGY custom-agent 4× 计费");
  assert.equal(pkg.files.includes("docs/"), false);
  assert.equal(pkg.files.includes("tests/"), false);
  assert.equal(pkg.files.includes(".agents/"), false);
  assert.equal(pkg.files.includes("AGENTS.md"), false);
  assert.ok(pkg.scripts?.typecheck && pkg.scripts?.verify, "package.json 须配置 typecheck 与 verify 自举脚本");

  const plugin = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".antigravity-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.name, "zee");
  assert.equal(plugin.version, "5.3.0");

  const hooks = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "hooks.json"), "utf8"));
  const cfg = hooks["zee-lifecycle-guard"];
  assert.equal(cfg?.enabled, true);
  assert.equal(cfg.PreToolUse, undefined);
  assert.ok(Array.isArray(cfg.Stop) && cfg.Stop.length > 0);
  assert.equal(cfg.PostToolUse, undefined);
  assert.equal(cfg.SessionStart, undefined);

  assert.equal(fs.existsSync(path.join(REPO_ROOT, "rules", "AGENTS.md")), true, "须包含极薄 rules/AGENTS.md 实现 AGY 自然语言自动唤醒");
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "agents")), false, "严禁存在 agents/ 自定义代理目录（防触发 AGY custom-agent 4× 计费）");
  assert.equal(fs.existsSync(path.join(REPO_ROOT, ".agents", "verify-ctl.mjs")), true, "zee 自身须具备 .agents/verify-ctl.mjs 自举验证器");
  assert.equal(fs.existsSync(path.join(REPO_ROOT, ".agents", "verify-features", "README.md")), true, "zee 自身须具备 Feature Map 索引");
  assert.equal(fs.existsSync(path.join(REPO_ROOT, ".agents", "RULES.md")), true, "zee 须具备 .agents/RULES.md 规则映射表");
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "AGENTS.md")), false, "AGY 插件根目录严禁放置 AGENTS.md，否则 agy plugin validate --strict 会报错");
});

test("主技能开放自然语言隐式唤醒，6 把专项单刀保留显式触发隔离，v4 冗余已彻底清理", () => {
  const removedPaths = [
    "pi-extension/fsm.ts",
    "pi-extension/hub-ui.ts",
    "pi-extension/bus-sync.ts",
    "tests/fsm.test.mjs",
    "skills/zee-arch",
    "skills/zee-init",
    "skills/zee/references",
    "skills/zee/disciplines",
    "skills/zee/playbooks/ops-deploy.md",
    "agents",
    "agents/zee.md",
    "agents/zee-worker.md",
    "agents/zee-scout.md",
    "agents/zee-architect.md",
    "agents/zee-coder.md",
    "agents/zee-ui.md",
    "agents/zee-verifier.md",
    "agents/zee-reviewer.md",
  ];
  for (const rel of removedPaths) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, rel)), false, `冗余路径应已删除: ${rel}`);
  }

  const skillDirs = fs
    .readdirSync(path.join(REPO_ROOT, "skills"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  assert.deepEqual(skillDirs, [...EXPECTED_SKILLS].sort());

  // 主入口 zee 必须开放隐式调用实现“下载即用自动驾驶”
  const mainMd = fs.readFileSync(path.join(REPO_ROOT, "skills", "zee", "SKILL.md"), "utf8");
  assert.doesNotMatch(mainMd, /disable-model-invocation:\s*true/, "主入口 skills/zee/SKILL.md 应允许模型按需隐式唤醒");
  const mainYaml = fs.readFileSync(path.join(REPO_ROOT, "skills", "zee", "agents", "openai.yaml"), "utf8");
  assert.match(mainYaml, /allow_implicit_invocation:\s*true/, "主入口 skills/zee/agents/openai.yaml 须开启 allow_implicit_invocation: true");

  // 其余 6 把专项单刀保持显式触发，防止劫持普通对话
  for (const name of EXPLICIT_ONLY_SKILLS) {
    const mdPath = path.join(REPO_ROOT, "skills", name, "SKILL.md");
    const yamlPath = path.join(REPO_ROOT, "skills", name, "agents", "openai.yaml");
    assert.equal(fs.existsSync(mdPath), true, `缺少 ${mdPath}`);
    assert.equal(fs.existsSync(yamlPath), true, `缺少 ${yamlPath}`);
    const md = fs.readFileSync(mdPath, "utf8");
    assert.match(md, /^---[\s\S]*?disable-model-invocation:\s*true[\s\S]*?---/, `${name}/SKILL.md 须显式禁用隐式触发`);
    const yaml = fs.readFileSync(yamlPath, "utf8");
    assert.match(yaml, /allow_implicit_invocation:\s*false/, `${name}/agents/openai.yaml 须设置 allow_implicit_invocation: false`);
  }
});

test("skills/zee 体积控制在 <= 4KB，9 份剧本/原则/角色卡契约完整对齐", () => {
  const mainSkillPath = path.join(REPO_ROOT, "skills", "zee", "SKILL.md");
  const mainSkillStat = fs.statSync(mainSkillPath);
  assert.ok(mainSkillStat.size <= 4096, `skills/zee/SKILL.md 体积应 <= 4096B，实际 ${mainSkillStat.size}B`);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "skills", "zee", "principles.md")), true);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "skills", "zee", "worker.md")), true);

  const setupSkill = fs.readFileSync(path.join(REPO_ROOT, "skills", "zee-setup", "SKILL.md"), "utf8");
  assert.match(setupSkill, /activeHarness/);
  assert.match(setupSkill, /harnesses\./);
  assert.match(setupSkill, /activeHarness !== "pi"[\s\S]*严禁[\s\S]*pi --list-models/);
  assert.match(setupSkill, /recommend-models/);
  assert.match(setupSkill, /large[\s\S]*medium[\s\S]*small/);
  assert.match(setupSkill, /inherit-parent/);

  const catalog = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "skills", "zee", "models.json"), "utf8"));
  assert.ok(catalog.budgets?.large && catalog.budgets?.medium && catalog.budgets?.small);
  assert.equal(catalog.effortLadder[0], "medium");
  assert.equal(catalog.effortLadder.includes("low"), false);
  for (const bSpec of Object.values(catalog.budgets)) {
    for (const eff of Object.values(bSpec.efforts || {})) {
      assert.notEqual(eff, "low");
    }
  }

  const playbooksDir = path.join(REPO_ROOT, "skills", "zee", "playbooks");
  const actualPlaybooks = fs.readdirSync(playbooksDir).sort();
  assert.deepEqual(actualPlaybooks, [...EXPECTED_PLAYBOOKS].sort());

  const rolesDir = path.join(REPO_ROOT, "skills", "zee", "roles");
  const actualRoles = fs.readdirSync(rolesDir).sort();
  assert.deepEqual(actualRoles, [...EXPECTED_ROLES].sort());

  const bannedRefs = ["queue-finding", "readiness", "match-skills", "mine-transcripts", "ops-deploy", "/zee-hub", "fsm.ts"];
  for (const rf of actualRoles) {
    const content = fs.readFileSync(path.join(rolesDir, rf), "utf8");
    const lines = content.trim().split(/\r?\n/).length;
    assert.ok(lines <= 35, `roles/${rf} 应精简（<=35行），实际 ${lines} 行`);
    assert.match(content, /Return:/, `roles/${rf} 须对齐 worker.md 要求的 Return: 字段`);
    for (const banned of bannedRefs) {
      assert.equal(content.includes(banned), false, `roles/${rf} 不应再引用已删除能力 ${banned}`);
    }
  }

  const agyRules = fs.readFileSync(path.join(REPO_ROOT, "rules", "AGENTS.md"), "utf8");
  assert.match(agyRules, /TypeName:\s*"self"/, "rules/AGENTS.md 须明确 AGY 子代理使用内置 self");
  assert.match(agyRules, /"research"/, "rules/AGENTS.md 须明确纯只读侦察可使用内置 research");
  assert.match(agyRules, /define_subagent/, "rules/AGENTS.md 须明确禁止调用 define_subagent");
  const mainSkillContent = fs.readFileSync(mainSkillPath, "utf8");
  assert.doesNotMatch(mainSkillContent, /TypeName:\s*"zee-worker"/, "skills/zee/SKILL.md 严禁再推荐自定义子代理 zee-worker");
  assert.match(mainSkillContent, /TypeName:"self"\\\|"research"/, "skills/zee/SKILL.md 须写明内置 self|research 派发");

  const principlesLines = fs.readFileSync(path.join(REPO_ROOT, "skills", "zee", "principles.md"), "utf8").trim().split(/\r?\n/);
  assert.ok(principlesLines.length <= 12, `principles.md 应保持 <=12 行，实际 ${principlesLines.length} 行`);

  const workerMd = fs.readFileSync(path.join(REPO_ROOT, "skills", "zee", "worker.md"), "utf8");
  assert.match(workerMd, /The bar in your brief is the whole bar/i);
  assert.match(workerMd, /untrusted data/i);

  const verifySkill = fs.readFileSync(path.join(REPO_ROOT, "skills", "zee-verify", "SKILL.md"), "utf8");
  assert.match(verifySkill, /\/zee-verify maintain/);
  assert.match(verifySkill, /Able to fail/i);
  assert.match(verifySkill, /--fuzz/);

  const reviewSkill = fs.readFileSync(path.join(REPO_ROOT, "skills", "zee-review", "SKILL.md"), "utf8");
  assert.match(reviewSkill, /--strict/);
  assert.match(reviewSkill, /--quick/);
  assert.match(reviewSkill, /--author-family/);
  assert.match(reviewSkill, /GATE_CHANGE_RATIONALE/);

  const retroSkill = fs.readFileSync(path.join(REPO_ROOT, "skills", "zee-retro", "SKILL.md"), "utf8");
  assert.match(retroSkill, /Bite Proof/);
  assert.match(retroSkill, /Rule -> Enforcer/);
  assert.match(retroSkill, /finding list/);
});

test("install.mjs 辅助函数、Windows 安全参数转义、--target auto/all 与 strict 参数拦截正确工作", () => {
  assert.equal(isEphemeralSource(true, REPO_ROOT), true);
  assert.equal(isEphemeralSource(false, REPO_ROOT), false);
  assert.equal(isEphemeralSource(false, path.join(os.tmpdir(), "_npx", "zee")), true);
  assert.equal(isEphemeralSource(false, path.join(os.tmpdir(), "node_modules", "zee")), true);

  // Windows 参数转义与延迟扩展传参：空格、括号、&、%、环境变量字面量与尾反斜杠均零损传递
  assert.equal(quoteWinCmdArg("C:\\Users\\John Doe (2026)\\R&D\\zee\\"), '"C:\\Users\\John Doe (2026)\\R&D\\zee\\\\"');
  assert.equal(quoteWinCmdArg("100%safe"), '"100%safe"');

  const winInv = buildWinCmdInvocation("C:\\tools\\pi.cmd", ["install", "C:\\Users\\John Doe (2026)\\R&D\\100%safe\\env%OS%leak"]);
  assert.equal(winInv.extraEnv.ZEE_CMD_BIN, "C:\\tools\\pi.cmd");
  assert.equal(winInv.extraEnv.ZEE_CMD_ARG_1, "C:\\Users\\John Doe (2026)\\R&D\\100%safe\\env%OS%leak");
  assert.ok(winInv.cmdArgs.includes("/v:on"));

  if (process.platform === "win32") {
    const cmdDir = fs.mkdtempSync(path.join(os.tmpdir(), "zee-wincmd-"));
    try {
      const shimPath = path.join(cmdDir, "echo args (test).cmd");
      fs.writeFileSync(
        shimPath,
        `@echo off\r\n"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" %*\r\n`,
        "utf8",
      );
      const trickyArgs = [
        "install",
        "C:\\Users\\John Doe (2026)\\R&D\\zee",
        "100%safe",
        "env%OS%leak",
      ];
      const inv = buildWinCmdInvocation(shimPath, trickyArgs);
      const out = spawnSync(inv.comspec, inv.cmdArgs, {
        encoding: "utf8",
        windowsVerbatimArguments: true,
        env: { ...process.env, ...inv.extraEnv },
      });
      assert.equal(out.status, 0, `Windows .cmd shim 执行失败: ${out.stderr}`);
      assert.deepEqual(JSON.parse(out.stdout), trickyArgs, "含空格/括号/&/%/%OS% 的参数必须原样透传零展开");
    } finally {
      fs.rmSync(cmdDir, { recursive: true, force: true });
    }
  }

  const tmpSkillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zee-inst-dups-"));
  try {
    const dupZee = path.join(tmpSkillsRoot, "zee");
    const dupPlan = path.join(tmpSkillsRoot, "zee-plan");
    const unrelated = path.join(tmpSkillsRoot, "other-skill");
    fs.mkdirSync(dupZee, { recursive: true });
    fs.mkdirSync(dupPlan, { recursive: true });
    fs.mkdirSync(unrelated, { recursive: true });

    const found = findDuplicateSkillDirs(tmpSkillsRoot, REPO_ROOT);
    assert.equal(found.length, 2);

    cleanDups([tmpSkillsRoot], true, REPO_ROOT);
    assert.equal(fs.existsSync(dupZee), true, "dry-run 不应删除目录");

    cleanDups([tmpSkillsRoot], false, REPO_ROOT);
    assert.equal(fs.existsSync(dupZee), false);
    assert.equal(fs.existsSync(dupPlan), false);
    assert.equal(fs.existsSync(unrelated), true, "不应误删非 zee 技能目录");
  } finally {
    fs.rmSync(tmpSkillsRoot, { recursive: true, force: true });
  }

  for (const target of ["auto", "pi", "agy", "skills", "both", "all"]) {
    const res = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "install.mjs"), "--target", target, "--dry-run"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    // 若某机器没装 pi，exitCode=1 但不应抛未捕获异常；有装时输出 [dry-run]
    assert.ok(res.stdout.includes("安装目标") || res.stdout.includes("自动探测") || res.stderr.includes("未检测到"), `target=${target} 输出异常`);
  }

  // 支持 --target=skills 语法且包含 -g -s * -y
  const skillsOut = execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts", "install.mjs"), "--target=skills", "--dry-run"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.match(skillsOut, /-g -s \* -y/);

  // 拼错 flag（如 --dryrun）必须严格报错退出，绝不静默真删
  const badFlag = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "install.mjs"), "--target", "pi", "--dryrun"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.notEqual(badFlag.status, 0);
  assert.match(badFlag.stderr, /参数错误/);

  // 经符号链接/Windows Junction 启动时（npx / 全局 bin 场景）isEntryPoint 必须仍触发 main()
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "zee-inst-link-"));
  const linkRepo = path.join(linkParent, "zee-link");
  try {
    fs.symlinkSync(REPO_ROOT, linkRepo, process.platform === "win32" ? "junction" : "dir");
    const linkHelp = execFileSync(process.execPath, [path.join(linkRepo, "scripts", "install.mjs"), "--help"], {
      cwd: linkParent,
      encoding: "utf8",
    });
    assert.match(linkHelp, /zee v5\.3\.0/, "通过软链/Junction 执行 install.mjs --help 必须正常输出帮助");
  } finally {
    try { fs.unlinkSync(linkRepo); } catch { fs.rmSync(linkRepo, { recursive: true, force: true }); }
    fs.rmSync(linkParent, { recursive: true, force: true });
  }

  // 验证盲测 Eval 工具自检通过
  const evalSelf = execFileSync(process.execPath, [path.join(REPO_ROOT, "tests", "eval", "blind-eval.mjs"), "--self-check"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(JSON.parse(evalSelf).ok, true);
});
