import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const VALID_ONEHARNESS_TOOLS = new Set([
  "read_file",
  "edit_file",
  "write_file",
  "run_command",
  "manage_task",
  "send_message",
  "schedule",
  "invoke_subagent",
  "manage_subagents",
  "define_subagent",
  "ask_question",
  "search_web",
  "generate_image",
  "finish",
]);

const EXPECTED_SKILLS = ["zee", "zee-arch", "zee-init", "zee-night", "zee-plan", "zee-retro", "zee-review", "zee-setup", "zee-verify"];
const ROLE_SUBAGENTS = ["zee-scout", "zee-architect", "zee-ui", "zee-coder", "zee-verifier", "zee-reviewer"];
const EXPECTED_DISCIPLINES = [
  "code-smells.md",
  "deep-modules.md",
  "diagnosing-bugs.md",
  "domain-modeling.md",
  "phase-boundaries.md",
  "verification-skill.md",
];

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, "Missing YAML frontmatter");
  return match[1];
}

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

test("package.json 与 .antigravity-plugin/plugin.json 版本严格一致且为 4.2.0（含可选 pi-tui peerDependency）", () => {
  const pkg = JSON.parse(readRepoFile("package.json"));
  const plugin = JSON.parse(readRepoFile(".antigravity-plugin/plugin.json"));
  assert.equal(pkg.version, "4.2.0");
  assert.equal(plugin.version, "4.2.0");
  assert.equal(pkg.version, plugin.version);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.ok(pkg.peerDependencies?.["@earendil-works/pi-tui"], "package.json 必须声明 @earendil-works/pi-tui peerDependency");
  assert.equal(pkg.peerDependenciesMeta?.["@earendil-works/pi-tui"]?.optional, true);
});

test("9 个技能目录完整（含 zee-verify）、保持 disable-model-invocation: true、无 /swarm 命名冲突且含 openai.yaml 与 6 份纪律文件", () => {
  const actualDirs = fs
    .readdirSync(path.join(REPO_ROOT, "skills"))
    .filter((d) => fs.statSync(path.join(REPO_ROOT, "skills", d)).isDirectory())
    .sort();
  assert.deepEqual(actualDirs, EXPECTED_SKILLS);
  assert.equal(actualDirs.includes("swarm"), false, "严禁占用 AGY 内置 /swarm 名称");

  for (const name of EXPECTED_SKILLS) {
    const skillMd = readRepoFile(path.join("skills", name, "SKILL.md"));
    const fm = parseFrontmatter(skillMd);
    assert.match(fm, new RegExp(`^name:\\s*${name}$`, "m"));
    assert.match(fm, /^disable-model-invocation:\s*true$/m, `${name} 必须设置 disable-model-invocation: true`);
    assert.equal(fs.existsSync(path.join(REPO_ROOT, "skills", name, "agents", "openai.yaml")), true);
  }

  const actualDisciplines = fs
    .readdirSync(path.join(REPO_ROOT, "skills", "zee", "disciplines"))
    .filter((f) => f.endsWith(".md"))
    .sort();
  assert.deepEqual(actualDisciplines, EXPECTED_DISCIPLINES);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "pi-extension", "worker-guard.ts")), true);
});

test("插件零内置 rules/AGENTS.md（绝不劫持日常普通会话）且 hooks.json 覆盖三生命周期事件", () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "rules", "AGENTS.md")), false);
  const hooks = JSON.parse(readRepoFile("hooks.json"));
  const group = Object.values(hooks)[0];
  assert.ok(Array.isArray(group.PreInvocation) && group.PreInvocation.length > 0);
  assert.ok(Array.isArray(group.PreToolUse) && group.PreToolUse.length > 0);
  assert.ok(Array.isArray(group.Stop) && group.Stop.length > 0);
});

test("7 个 AGY Agent 契约：6 专职子代理全部具备合法 OneHarness tools 白名单与最小权限隔离", () => {
  const mainFm = parseFrontmatter(readRepoFile(path.join("agents", "zee.md")));
  assert.match(mainFm, /^mainAgent:\s*true$/m);
  assert.match(mainFm, /^subagent:\s*false$/m);

  for (const name of ROLE_SUBAGENTS) {
    const content = readRepoFile(path.join("agents", `${name}.md`));
    const fm = parseFrontmatter(content);
    assert.match(fm, /^mainAgent:\s*false$/m, `${name} 不可设 mainAgent: true`);
    assert.match(fm, /^subagent:\s*true$/m, `${name} 必须设 subagent: true`);
    assert.match(fm, /^inheritCustomizations:\s*false$/m, `${name} 必须设 inheritCustomizations: false`);

    const toolsMatch = fm.match(/^tools:\s*\[([^\]]+)\]/m);
    assert.ok(toolsMatch, `${name} 必须显式声明 tools 白名单`);
    const tools = toolsMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
    assert.ok(tools.length > 0);

    for (const t of tools) {
      assert.equal(VALID_ONEHARNESS_TOOLS.has(t), true, `${name} 包含非法工具名: ${t}`);
    }
    assert.equal(tools.includes("invoke_subagent"), false, `${name} 禁止持有 invoke_subagent`);
    assert.equal(tools.includes("define_subagent"), false, `${name} 禁止持有 define_subagent`);
    assert.equal(tools.includes("ask_question"), false, `${name} 禁止持有 ask_question`);

    if (["zee-scout", "zee-architect", "zee-verifier", "zee-reviewer"].includes(name)) {
      assert.equal(tools.includes("edit_file"), false, `${name} 必须剥离 edit_file`);
    }
    if (name === "zee-scout" || name === "zee-architect") {
      assert.equal(tools.includes("write_file"), false, `${name} 必须剥离 write_file`);
    }
  }
});

test("关键文档无历史残留 /skill:zee 文案且无 Verifier/Reviewer 拥有 edit 的矛盾描述", () => {
  const planMode = readRepoFile("skills/zee/references/plan-mode.md");
  assert.equal(/\/skill:zee/.test(planMode), false, "plan-mode.md 不应残留 /skill:zee");

  const harness = readRepoFile("skills/zee/references/harness.md");
  assert.match(harness, /hard-strips `edit`/i);

  const skillMd = readRepoFile("skills/zee/SKILL.md");
  assert.match(skillMd, /Strict Serial Gate 1 -> Gate 2/);
  assert.match(skillMd, /70%/);
});

test("v4.2.0 契约：清理 verify-map.md 漂移、沙盒/门禁 CLI 卸载、--fuzz 与输出隔离", () => {
  const coder = readRepoFile("skills/zee/roles/coder.md");
  const scout = readRepoFile("skills/zee/roles/scout.md");
  const verifier = readRepoFile("skills/zee/roles/verifier.md");
  const reviewer = readRepoFile("skills/zee/roles/reviewer.md");
  const verDiscipline = readRepoFile("skills/zee/disciplines/verification-skill.md");
  const zeeVerify = readRepoFile("skills/zee-verify/SKILL.md");

  assert.equal(/\.agents\/verify-map\.md/.test(coder), false, "coder.md 不得保留过时 .agents/verify-map.md 指引");
  assert.equal(/\.agents\/verify-map\.md/.test(scout), false, "scout.md 不得保留过时 .agents/verify-map.md 指引");
  assert.match(coder, /VERIFY_MAP_DELTA:/);

  assert.match(verifier, /sandbox-export/);
  assert.match(verifier, /sandbox-clean/);
  assert.match(verifier, /--fuzz/);
  assert.match(verifier, /\/tmp\/zee-verify-/);

  assert.match(reviewer, /sandbox-export/);
  assert.match(reviewer, /sandbox-clean/);
  assert.match(reviewer, /gate-tamper-diff/);
  assert.match(reviewer, /queue-finding/);

  assert.match(verDiscipline, /verify-ctl/);
  assert.match(verDiscipline, /\/tmp\/zee-verify-/);
  assert.match(verDiscipline, /--fuzz/);
  assert.match(zeeVerify, /verify-ctl/);
  assert.match(zeeVerify, /\/tmp\/zee-verify-/);
  assert.match(zeeVerify, /--fuzz/);
});

test("v4.2.0 契约：recall/triage、花园队列、零配置单兵兜底、trustLevel/pathSkills 与 Pi HUD/Hub 文档完整", () => {
  const specialized = readRepoFile("skills/zee/references/specialized.md");
  assert.match(specialized, /\/zee recall/);
  assert.match(specialized, /mine-transcripts --mode recall/);
  assert.match(specialized, /\/zee triage/);
  assert.match(specialized, /queue-finding/);

  const skillMd = readRepoFile("skills/zee/SKILL.md");
  assert.match(skillMd, /\brecall\b/);
  assert.match(skillMd, /\btriage\b/);

  for (const rel of [
    "skills/zee/SKILL.md",
    "skills/zee-verify/SKILL.md",
    "skills/zee-retro/SKILL.md",
    "skills/zee-arch/SKILL.md",
    "skills/zee-review/SKILL.md",
    "skills/zee-plan/SKILL.md",
  ]) {
    const content = readRepoFile(rel);
    assert.match(content, /--allow-standalone/, `${rel} 必须文档化 --allow-standalone 零配置单兵兜底`);
  }

  const retro = readRepoFile("skills/zee-retro/SKILL.md");
  assert.match(retro, /mine-transcripts --mode retro/);
  assert.match(retro, /list-findings/);
  assert.match(retro, /Skill Creation \/ Dead-Rule Pruning/);

  const arch = readRepoFile("skills/zee-arch/SKILL.md");
  assert.match(arch, /list-findings/);
  assert.match(arch, /systemic:\s*true/i);

  const diagBugs = readRepoFile("skills/zee/disciplines/diagnosing-bugs.md");
  assert.match(diagBugs, /queue-finding/);
  assert.match(diagBugs, /gardening-queue\.jsonl/);

  const protocols = readRepoFile("skills/zee/references/protocols.md");
  const overnight = readRepoFile("skills/zee/references/overnight.md");
  const interop = readRepoFile("skills/zee/references/interop.md");
  const harness = readRepoFile("skills/zee/references/harness.md");
  const readme = readRepoFile("README.md");
  const changelog = readRepoFile("CHANGELOG.md");

  assert.match(protocols, /trustLevel/);
  assert.match(protocols, /\bT1\b[\s\S]*\bT2\b[\s\S]*\bT3\b/);
  assert.match(protocols, /readiness/);
  assert.match(protocols, /--delegate-id/);

  assert.match(overnight, /trustLevel/);
  assert.match(overnight, /--delegate-id/);
  assert.match(overnight, /schedule_task/);

  assert.match(interop, /pathSkills/);
  assert.match(interop, /match-skills/);

  assert.match(harness, /setWidget\("zee-hud"/);
  assert.match(harness, /\/zee-hub/);
  assert.match(harness, /Ctrl\+Alt\+H/);
  assert.match(harness, /F2/);
  assert.match(harness, /pi-cometix-footer/);

  assert.match(readme, /4\.2\.0/);
  assert.match(readme, /\/zee-hub/);
  assert.match(changelog, /4\.2\.0/);
});
