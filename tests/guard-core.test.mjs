import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  tokenizeShell,
} from "../skills/zee/scripts/lib/guard-core.mjs";

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zee-guard-test-"));
}

test("isWriteAllowedUnderGate 与 isReadOnlyRoleWriteAllowed 精准守卫规划/审查写路径", () => {
  const repo = makeTempRepo();
  try {
    assert.equal(isWriteAllowedUnderGate("plan.md", repo, "plan"), true);
    assert.equal(isWriteAllowedUnderGate("SPEC.md", repo, "plan"), true);
    assert.equal(isWriteAllowedUnderGate("DESIGN.md", repo, "plan"), true);
    assert.equal(isWriteAllowedUnderGate(".agents/zee.project.json", repo, "plan"), true);
    assert.equal(isWriteAllowedUnderGate("docs/plans/arch.md", repo, "plan"), true);
    assert.equal(isWriteAllowedUnderGate("docs/arch.md", repo, "plan"), false);
    assert.equal(isWriteAllowedUnderGate("GLOSSARY.md", repo, "plan"), true);
    assert.equal(isWriteAllowedUnderGate("src/index.ts", repo, "plan"), false);

    // 废弃的 init-design 死分支已清理
    assert.equal(isWriteAllowedUnderGate("src/main.ts", repo, "init-design"), false);
    assert.equal(isWriteAllowedUnderGate("plan.md", repo, "init-design"), false);

    assert.equal(isWriteAllowedUnderGate("src/main.ts", repo, "review"), false);
    assert.equal(isWriteAllowedUnderGate("plan.md", repo, "review"), false);
    assert.equal(isWriteAllowedUnderGate(".agents/gardening-queue.jsonl", repo, "plan"), true);
    assert.equal(isWriteAllowedUnderGate(".agents/gardening-queue.jsonl", repo, "review"), true);

    // Monorepo 子目录写路径同样锚定到 Git 仓库根目录
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const subDir = path.join(repo, "packages", "web");
    fs.mkdirSync(subDir, { recursive: true });
    assert.equal(isWriteAllowedUnderGate(path.join(repo, "plan.md"), subDir, "plan"), true);
    assert.equal(isWriteAllowedUnderGate(path.join(repo, ".agents", "gardening-queue.jsonl"), subDir, "review"), true);
    assert.equal(isWriteAllowedUnderGate(path.join(subDir, "src", "index.ts"), subDir, "plan"), false);

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

test("evaluateDestructiveCommand 识别 POSIX 与 Windows 高危删除、嵌套 Shell 与主干强推，且防误拦", () => {
  const repo = makeTempRepo();
  try {
    // POSIX 破坏性命令
    assert.ok(evaluateDestructiveCommand("rm -rf /", repo));
    assert.ok(evaluateDestructiveCommand("cd /etc && rm -rf .", repo));
    assert.ok(evaluateDestructiveCommand("rm -rf ~", repo));
    assert.ok(evaluateDestructiveCommand("git push --force origin main", repo));
    assert.ok(evaluateDestructiveCommand('psql -c "DROP DATABASE prod;"', repo));
    assert.ok(evaluateDestructiveCommand('bash -c "rm -rf /etc"', repo));

    // Windows 破坏性删除、PowerShell/CMD 嵌套与反引号
    assert.deepEqual(tokenizeShell('rm -rf "C:\\"'), ["rm", "-rf", "C:\\"]);
    assert.ok(evaluateDestructiveCommand("rm -rf C:\\", repo));
    assert.ok(evaluateDestructiveCommand('rm -rf "C:\\"', repo));
    assert.ok(evaluateDestructiveCommand("rm -rf C:\\Windows", repo));
    assert.ok(evaluateDestructiveCommand("Remove-Item -Recurse -Force C:\\", repo));
    assert.ok(evaluateDestructiveCommand("rm -Recurse -Force ~", repo));
    assert.ok(evaluateDestructiveCommand("rd /s /q C:\\Windows", repo));
    assert.ok(evaluateDestructiveCommand("del -Recurse -Force C:\\Windows", repo));
    assert.ok(evaluateDestructiveCommand("rmdir -Recurse -Force C:\\Windows", repo));
    assert.ok(evaluateDestructiveCommand("rd -Recurse -Force C:\\", repo));
    assert.ok(evaluateDestructiveCommand("erase -Recurse -Force ~", repo));
    assert.ok(evaluateDestructiveCommand("sudo -u root rm -rf /", repo));
    assert.ok(evaluateDestructiveCommand("env -u PATH rm -rf /", repo));
    assert.ok(evaluateDestructiveCommand("sudo -u root -g wheel rm -rf /etc", repo));
    assert.ok(evaluateDestructiveCommand('powershell -Command "rm -rf /"', repo));
    assert.ok(evaluateDestructiveCommand('cmd /c "git push --force origin main"', repo));
    assert.ok(evaluateDestructiveCommand("echo `rm -rf /`", repo));

    // 主干强推绕过、容器删库与管道跨段删库封堵
    assert.ok(evaluateDestructiveCommand("git push --force --all", repo));
    assert.ok(evaluateDestructiveCommand('docker exec db psql -c "DROP DATABASE prod"', repo));
    assert.ok(evaluateDestructiveCommand('echo "DROP DATABASE prod;" | psql', repo));
    assert.ok(evaluateDestructiveCommand('printf "DROP DATABASE prod;" | mysql -u root', repo));

    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    assert.ok(evaluateDestructiveCommand("git push --force origin HEAD", repo));
    assert.ok(evaluateDestructiveCommand("git push --force -o ci.skip origin", repo));

    // 安全命令与防误拦
    assert.equal(evaluateDestructiveCommand("git status --short", repo), null);
    assert.equal(evaluateDestructiveCommand("node --test tests/*.test.mjs", repo), null);
    assert.equal(evaluateDestructiveCommand("rm -rf ./dist", repo), null);
    assert.equal(evaluateDestructiveCommand('echo bash -c "rm -rf /"', repo), null);
    assert.equal(evaluateDestructiveCommand('psql -c "SELECT 1" && echo "DROP DATABASE prod"', repo), null);
    assert.equal(evaluateDestructiveCommand('psql -c "SELECT 1" || echo "DROP DATABASE prod"', repo), null);

    const safeHeredoc = "cat <<'EOF'\nrm -rf /tmp/example\nDROP DATABASE test;\nEOF";
    assert.equal(stripHeredocBodies(safeHeredoc).includes("DROP DATABASE"), false);
    assert.equal(evaluateDestructiveCommand(safeHeredoc, repo), null);

    const nested = getAllNestedCommands('bash -lc "echo hi && rm -rf /tmp/foo"');
    assert.ok(nested.length >= 2);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("checkProjectDenyCommands 按词法边界拦截绝对路径与插旗绕过，且不误拦只读命令", () => {
  const repo = makeTempRepo();
  try {
    fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".agents", "zee.project.json"),
      JSON.stringify({ denyCommands: ["npm publish", "deploy-prod"] }),
      "utf8",
    );
    assert.ok(checkProjectDenyCommands("npm publish --access public", repo));
    assert.ok(checkProjectDenyCommands("/usr/bin/npm publish", repo));
    assert.ok(checkProjectDenyCommands("npm --tag next publish", repo));
    assert.ok(checkProjectDenyCommands("sudo -u deploy npm publish", repo));
    assert.ok(checkProjectDenyCommands("env -u PATH npm publish", repo));
    assert.ok(checkProjectDenyCommands("echo ok && deploy-prod --yes", repo));

    // Monorepo 子目录同样能向上找到仓库根的 .agents/zee.project.json denyCommands
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const subPkg = path.join(repo, "packages", "web");
    fs.mkdirSync(subPkg, { recursive: true });
    assert.ok(checkProjectDenyCommands("npm publish --access public", subPkg));
    assert.equal(checkProjectDenyCommands("npm run test", subPkg), null);

    assert.equal(checkProjectDenyCommands("npm run test", repo), null);
    assert.equal(checkProjectDenyCommands("cat README.md", repo), null);
    assert.equal(checkProjectDenyCommands("cat deploy-prod", repo), null);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("extractModelFamily 与 enforcePiRoleTools 行为准确", () => {
  assert.equal(extractModelFamily("magpie-2/vm/claude-sonnet-5-5"), "claude");
  assert.equal(extractModelFamily("auto/gpt-6.2-astra"), "openai");
  assert.equal(extractModelFamily("auto/gemini-4-hydrogen"), "gemini");
  assert.equal(extractModelFamily("neon"), "gemini");
  assert.equal(extractModelFamily("google/neon-4"), "gemini");
  assert.equal(extractModelFamily("carbon"), "gemini");
  assert.equal(extractModelFamily("auto/deepseek-v4.1-flash"), "deepseek");
  assert.equal(extractModelFamily("inherit-parent"), "");
  assert.equal(extractModelFamily("inherit"), "");
  assert.equal(extractModelFamily("auto"), "");

  assert.deepEqual(enforcePiRoleTools("architect", ["read", "edit", "bash", "powershell", "write"]), ["read", "write"]);
  assert.deepEqual(enforcePiRoleTools("architect", undefined), ["read", "grep", "find", "ls"]);
  assert.deepEqual(enforcePiRoleTools("architect", ["bash", "edit"]), ["read", "grep", "find", "ls"]);
  assert.deepEqual(enforcePiRoleTools("judge", undefined), ["read", "grep", "find", "ls"]);
  assert.deepEqual(enforcePiRoleTools("judge", ["bash"]), ["read", "grep", "find", "ls"]);
  assert.deepEqual(enforcePiRoleTools("scout", ["read", "bash", "write", "edit"]), ["read", "bash"]);
  assert.deepEqual(enforcePiRoleTools("scout", ["edit", "write"]), ["read", "grep", "find", "ls", "bash"]);
  assert.deepEqual(enforcePiRoleTools("reviewer", ["read", "write", "edit", "grep"]), ["read", "write", "grep"]);
  assert.deepEqual(enforcePiRoleTools("reviewer", ["edit"]), ["read", "grep", "find", "ls", "bash", "write"]);
  assert.deepEqual(enforcePiRoleTools("coder", ["read", "write", "edit", "bash"]), ["read", "write", "edit", "bash"]);
});
