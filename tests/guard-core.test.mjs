import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RUNS_ROOT,
  checkProjectDenyCommands,
  enforcePiRoleTools,
  evaluateDestructiveCommand,
  extractModelFamily,
  getAllNestedCommands,
  isAllowedZeeTmpPath,
  isReadOnlyRoleWriteAllowed,
  isWriteAllowedUnderGate,
  stripHeredocBodies,
} from "../skills/zee/scripts/lib/guard-core.mjs";

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zee-guard-test-"));
}

test("isWriteAllowedUnderGate 与 isReadOnlyRoleWriteAllowed 精准守卫规划/审查写路径", () => {
  const repo = makeTempRepo();
  try {
    assert.equal(isWriteAllowedUnderGate("plan.md", repo, "plan"), true);
    assert.equal(isWriteAllowedUnderGate("docs/plans/arch.md", repo, "plan"), true);
    assert.equal(isWriteAllowedUnderGate("docs/arch.md", repo, "plan"), false);
    assert.equal(isWriteAllowedUnderGate("GLOSSARY.md", repo, "plan"), true);
    assert.equal(isWriteAllowedUnderGate("src/index.ts", repo, "plan"), false);

    assert.equal(isWriteAllowedUnderGate(".agents/zee.project.json", repo, "init-design"), true);
    assert.equal(isWriteAllowedUnderGate("src/main.ts", repo, "init-design"), false);

    assert.equal(isWriteAllowedUnderGate("src/main.ts", repo, "review"), false);
    assert.equal(isWriteAllowedUnderGate("plan.md", repo, "review"), false);

    const busFile = path.join(RUNS_ROOT, "sample-run", "artifacts", "report.md");
    assert.equal(isReadOnlyRoleWriteAllowed(busFile, repo), true);
    assert.equal(isWriteAllowedUnderGate(busFile, repo, "review"), true);

    const tmpZeeFile = path.join(os.tmpdir(), "zee-rev-123", "notes.md");
    assert.equal(isAllowedZeeTmpPath(tmpZeeFile, repo), true);
    assert.equal(isReadOnlyRoleWriteAllowed(tmpZeeFile, repo), true);
    assert.equal(isReadOnlyRoleWriteAllowed("src/app.js", repo), false);

    const extraBus = makeTempRepo();
    try {
      assert.equal(isReadOnlyRoleWriteAllowed(path.join(extraBus, "audit.md"), repo, [extraBus]), true);
    } finally {
      fs.rmSync(extraBus, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("evaluateDestructiveCommand 识别高危破坏性命令及嵌套调用，忽略安全 heredoc", () => {
  const repo = makeTempRepo();
  try {
    assert.ok(evaluateDestructiveCommand("rm -rf /", repo));
    assert.ok(evaluateDestructiveCommand("cd /etc && rm -rf .", repo));
    assert.ok(evaluateDestructiveCommand("rm -rf ~", repo));
    assert.ok(evaluateDestructiveCommand("git push --force origin main", repo));
    assert.ok(evaluateDestructiveCommand('psql -c "DROP DATABASE prod;"', repo));
    assert.ok(evaluateDestructiveCommand('bash -c "rm -rf /etc"', repo));

    assert.equal(evaluateDestructiveCommand("git status --short", repo), null);
    assert.equal(evaluateDestructiveCommand("node --test tests/*.test.mjs", repo), null);
    assert.equal(evaluateDestructiveCommand("rm -rf ./dist", repo), null);

    const safeHeredoc = "cat <<'EOF'\nrm -rf /tmp/example\nDROP DATABASE test;\nEOF";
    assert.equal(stripHeredocBodies(safeHeredoc).includes("DROP DATABASE"), false);
    assert.equal(evaluateDestructiveCommand(safeHeredoc, repo), null);

    const nested = getAllNestedCommands('bash -lc "echo hi && rm -rf /tmp/foo"');
    assert.ok(nested.length >= 2);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("checkProjectDenyCommands 按 token 边界匹配 .agents/zee.project.json denyCommands", () => {
  const repo = makeTempRepo();
  try {
    fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".agents", "zee.project.json"),
      JSON.stringify({ denyCommands: ["npm publish", "deploy-prod"] }),
      "utf8",
    );
    assert.ok(checkProjectDenyCommands("npm publish --access public", repo));
    assert.ok(checkProjectDenyCommands("echo ok && deploy-prod --yes", repo));
    assert.equal(checkProjectDenyCommands("npm run test", repo), null);
    assert.equal(checkProjectDenyCommands("cat README.md", repo), null);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("extractModelFamily 与 enforcePiRoleTools 行为准确", () => {
  assert.equal(extractModelFamily("magpie-2/vm/claude-sonnet-5-5"), "claude");
  assert.equal(extractModelFamily("auto/gpt-6.2-astra"), "openai");
  assert.equal(extractModelFamily("auto/gemini-4-hydrogen"), "gemini");
  assert.equal(extractModelFamily("auto/deepseek-v4.1-flash"), "deepseek");

  assert.deepEqual(enforcePiRoleTools("architect", ["read", "edit", "bash", "powershell", "write"]), ["read", "write"]);
  assert.deepEqual(enforcePiRoleTools("architect", undefined), ["read", "grep", "find", "ls"]);
  assert.deepEqual(enforcePiRoleTools("scout", ["read", "bash", "write", "edit"]), ["read", "bash"]);
  assert.deepEqual(enforcePiRoleTools("reviewer", ["read", "write", "edit", "grep"]), ["read", "write", "grep"]);
  assert.deepEqual(enforcePiRoleTools("coder", ["read", "write", "edit", "bash"]), ["read", "write", "edit", "bash"]);
});
