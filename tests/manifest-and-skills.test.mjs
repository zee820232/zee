import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cleanDups, findDuplicateSkillDirs, isEphemeralSource } from "../scripts/install.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_SKILLS = ["zee", "zee-plan", "zee-verify", "zee-review", "zee-night", "zee-retro", "zee-setup"];
const EXPECTED_PLAYBOOKS = ["understand.md", "plan.md", "feature.md", "bug-fix.md", "perf.md", "verify.md", "overnight.md", "ship.md"];
const EXPECTED_ROLES = ["scout.md", "architect.md", "ui.md", "coder.md", "verifier.md", "reviewer.md", "judge.md"];

test("v5.1.0 清单文件与包元数据符合精简规范", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.version, "5.1.0");
  assert.deepEqual(pkg.pi?.extensions, ["./pi-extension/index.ts"]);
  assert.equal(pkg.pi?.skills, undefined, "package.json 不应声明 pi.skills 以免与 /skill:zee* 冲突");
  assert.equal(pkg.peerDependencies?.["@earendil-works/pi-tui"], undefined, "不应保留 pi-tui 依赖");

  const plugin = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".antigravity-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.name, "zee");
  assert.equal(plugin.version, "5.1.0");

  const hooks = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "hooks.json"), "utf8"));
  const cfg = hooks["zee-lifecycle-guard"];
  assert.equal(cfg?.enabled, true);
  assert.equal(cfg.PreToolUse, undefined);
  assert.ok(Array.isArray(cfg.Stop) && cfg.Stop.length > 0);
  assert.equal(cfg.PostToolUse, undefined);
  assert.equal(cfg.SessionStart, undefined);
});

test("v4 冗余文件已彻底移除，仅保留 7 技能与核心剧本/角色卡", () => {
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

  for (const name of EXPECTED_SKILLS) {
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

test("skills/zee 体积控制在 <= 4KB，剧本/原则/角色卡契约干净无残留", () => {
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
  assert.ok(Array.isArray(catalog.tierRules?.flagship) && catalog.tierRules.flagship.length > 0);
  assert.ok(Array.isArray(catalog.tierRules?.fastQuality) && catalog.tierRules.fastQuality.length > 0);
  assert.ok(Array.isArray(catalog.tierRules?.optInOnly) && catalog.tierRules.optInOnly.length > 0);

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
    for (const banned of bannedRefs) {
      assert.equal(content.includes(banned), false, `roles/${rf} 不应再引用已删除能力 ${banned}`);
    }
  }

  const agyAgent = fs.readFileSync(path.join(REPO_ROOT, "agents", "zee.md"), "utf8");
  assert.ok(agyAgent.length < 2500, "agents/zee.md 应保持精简");
  assert.doesNotMatch(agyAgent, /\bgeneral-purpose\b/);
  assert.match(agyAgent, /\/zee-setup/);

  const principlesLines = fs.readFileSync(path.join(REPO_ROOT, "skills", "zee", "principles.md"), "utf8").trim().split(/\r?\n/);
  assert.ok(principlesLines.length <= 12, `principles.md 应保持 <=12 行，实际 ${principlesLines.length} 行`);

  const workerMd = fs.readFileSync(path.join(REPO_ROOT, "skills", "zee", "worker.md"), "utf8");
  assert.match(workerMd, /The bar in your brief is the whole bar/i);
  assert.match(workerMd, /untrusted data/i);

  const verifySkill = fs.readFileSync(path.join(REPO_ROOT, "skills", "zee-verify", "SKILL.md"), "utf8");
  assert.match(verifySkill, /\/zee-verify maintain/);
  assert.match(verifySkill, /Able to fail/i);

  const reviewSkill = fs.readFileSync(path.join(REPO_ROOT, "skills", "zee-review", "SKILL.md"), "utf8");
  assert.match(reviewSkill, /--strict/);
  assert.match(reviewSkill, /--quick/);

  const retroSkill = fs.readFileSync(path.join(REPO_ROOT, "skills", "zee-retro", "SKILL.md"), "utf8");
  assert.match(retroSkill, /Bite Proof/);
  assert.match(retroSkill, /Rule -> Enforcer/);
});

test("install.mjs 辅助函数（isEphemeralSource / cleanDups）与多目标 --dry-run 正确工作", () => {
  assert.equal(isEphemeralSource(true, REPO_ROOT), true);
  assert.equal(isEphemeralSource(false, REPO_ROOT), false);
  assert.equal(isEphemeralSource(false, path.join(os.tmpdir(), "_npx", "zee")), true);
  assert.equal(isEphemeralSource(false, path.join(os.tmpdir(), "node_modules", "zee")), true);

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

  for (const target of ["pi", "skills"]) {
    const out = execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts", "install.mjs"), "--target", target, "--dry-run"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.match(out, /\[dry-run\]/);
  }
  const piOut = execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts", "install.mjs"), "--target", "pi", "--dry-run"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.match(piOut, /\/zee-plan/);
  assert.match(piOut, /\/zee-setup/);
  assert.match(piOut, /\/zee-mode/);

  // 经符号链接/Windows Junction 启动时（npx / 全局 bin 场景）isEntryPoint 必须仍触发 main()
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "zee-inst-link-"));
  const linkRepo = path.join(linkParent, "zee-link");
  try {
    fs.symlinkSync(REPO_ROOT, linkRepo, process.platform === "win32" ? "junction" : "dir");
    const linkHelp = execFileSync(process.execPath, [path.join(linkRepo, "scripts", "install.mjs"), "--help"], {
      cwd: linkParent,
      encoding: "utf8",
    });
    assert.match(linkHelp, /zee v5\.1\.0/, "通过软链/Junction 执行 install.mjs --help 必须正常输出帮助");
  } finally {
    try { fs.unlinkSync(linkRepo); } catch { fs.rmSync(linkRepo, { recursive: true, force: true }); }
    fs.rmSync(linkParent, { recursive: true, force: true });
  }
});
