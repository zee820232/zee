import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_SKILLS = ["zee", "zee-plan", "zee-verify", "zee-review", "zee-night", "zee-retro"];
const EXPECTED_PLAYBOOKS = ["understand.md", "plan.md", "feature.md", "bug-fix.md", "perf.md", "verify.md", "overnight.md"];
const EXPECTED_ROLES = ["scout.md", "architect.md", "ui.md", "coder.md", "verifier.md", "reviewer.md"];

test("v5.0.2 清单文件与包元数据符合精简规范", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.version, "5.0.2");
  assert.deepEqual(pkg.pi?.extensions, ["./pi-extension/index.ts"]);
  assert.equal(pkg.pi?.skills, undefined, "package.json 不应声明 pi.skills 以免与 /skill:zee* 冲突");
  assert.equal(pkg.peerDependencies?.["@earendil-works/pi-tui"], undefined, "不应保留 pi-tui 依赖");

  const plugin = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".antigravity-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.name, "zee");
  assert.equal(plugin.version, "5.0.2");

  const hooks = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "hooks.json"), "utf8"));
  const cfg = hooks["zee-lifecycle-guard"];
  assert.equal(cfg?.enabled, true);
  assert.equal(cfg.PreToolUse?.[0]?.matcher, "run_command");
  assert.ok(Array.isArray(cfg.Stop) && cfg.Stop.length > 0);
  assert.equal(cfg.PostToolUse, undefined);
  assert.equal(cfg.SessionStart, undefined);
});

test("v4 冗余文件已彻底移除，仅保留 6 技能与核心剧本/角色卡", () => {
  const removedPaths = [
    "pi-extension/fsm.ts",
    "pi-extension/hub-ui.ts",
    "pi-extension/bus-sync.ts",
    "tests/fsm.test.mjs",
    "skills/zee-arch",
    "skills/zee-init",
    "skills/zee-setup",
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
});

test("install.mjs --dry-run 可正常输出 6 个命令且无异常", () => {
  const out = execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts", "install.mjs"), "--target", "pi", "--dry-run"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.match(out, /\/zee-plan/);
  assert.match(out, /\/zee-night/);
  assert.match(out, /\/zee-mode/);
});
