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

const EXPECTED_SKILLS = ["zee", "zee-init", "zee-night", "zee-plan", "zee-review", "zee-setup"];
const ROLE_SUBAGENTS = ["zee-scout", "zee-architect", "zee-ui", "zee-coder", "zee-verifier", "zee-reviewer"];

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, "Missing YAML frontmatter");
  return match[1];
}

test("package.json 与 .antigravity-plugin/plugin.json 版本严格一致", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const plugin = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".antigravity-plugin", "plugin.json"), "utf8"));
  assert.equal(pkg.version, plugin.version);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test("6 个技能目录完整、保持 disable-model-invocation: true、无 /swarm 命名冲突且含 openai.yaml", () => {
  const actualDirs = fs
    .readdirSync(path.join(REPO_ROOT, "skills"))
    .filter((d) => fs.statSync(path.join(REPO_ROOT, "skills", d)).isDirectory())
    .sort();
  assert.deepEqual(actualDirs, EXPECTED_SKILLS);
  assert.equal(actualDirs.includes("swarm"), false, "严禁占用 AGY 内置 /swarm 名称");

  for (const name of EXPECTED_SKILLS) {
    const skillMd = fs.readFileSync(path.join(REPO_ROOT, "skills", name, "SKILL.md"), "utf8");
    const fm = parseFrontmatter(skillMd);
    assert.match(fm, new RegExp(`^name:\\s*${name}$`, "m"));
    assert.match(fm, /^disable-model-invocation:\s*true$/m, `${name} 必须设置 disable-model-invocation: true`);
    assert.equal(fs.existsSync(path.join(REPO_ROOT, "skills", name, "agents", "openai.yaml")), true);
  }
});

test("插件零内置 rules/AGENTS.md（绝不劫持日常普通会话）且 hooks.json 覆盖三生命周期事件", () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "rules", "AGENTS.md")), false);
  const hooks = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "hooks.json"), "utf8"));
  const group = Object.values(hooks)[0];
  assert.ok(Array.isArray(group.PreInvocation) && group.PreInvocation.length > 0);
  assert.ok(Array.isArray(group.PreToolUse) && group.PreToolUse.length > 0);
  assert.ok(Array.isArray(group.Stop) && group.Stop.length > 0);
});

test("7 个 AGY Agent 契约：6 专职子代理全部具备合法 OneHarness tools 白名单与最小权限隔离", () => {
  const mainFm = parseFrontmatter(fs.readFileSync(path.join(REPO_ROOT, "agents", "zee.md"), "utf8"));
  assert.match(mainFm, /^mainAgent:\s*true$/m);
  assert.match(mainFm, /^subagent:\s*false$/m);

  for (const name of ROLE_SUBAGENTS) {
    const content = fs.readFileSync(path.join(REPO_ROOT, "agents", `${name}.md`), "utf8");
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
    // 禁止任何子代理递归派发或直接问用户
    assert.equal(tools.includes("invoke_subagent"), false, `${name} 禁止持有 invoke_subagent`);
    assert.equal(tools.includes("define_subagent"), false, `${name} 禁止持有 define_subagent`);
    assert.equal(tools.includes("ask_question"), false, `${name} 禁止持有 ask_question`);

    // 严格只读/门禁角色硬剥离 edit_file
    if (["zee-scout", "zee-architect", "zee-verifier", "zee-reviewer"].includes(name)) {
      assert.equal(tools.includes("edit_file"), false, `${name} 必须剥离 edit_file`);
    }
    if (name === "zee-scout") {
      assert.equal(tools.includes("write_file"), false, "zee-scout 必须剥离 write_file");
    }
  }
});

test("关键文档无历史残留 /skill:zee 文案且无 Verifier/Reviewer 拥有 edit 的矛盾描述", () => {
  const planMode = fs.readFileSync(path.join(REPO_ROOT, "skills", "zee", "references", "plan-mode.md"), "utf8");
  assert.equal(/\/skill:zee/.test(planMode), false, "plan-mode.md 不应残留 /skill:zee");

  const harness = fs.readFileSync(path.join(REPO_ROOT, "skills", "zee", "references", "harness.md"), "utf8");
  assert.match(harness, /hard-strips `edit`/i);

  const skillMd = fs.readFileSync(path.join(REPO_ROOT, "skills", "zee", "SKILL.md"), "utf8");
  assert.match(skillMd, /Strict Serial Gate 1 -> Gate 2/);
  assert.match(skillMd, /70%/);
});
