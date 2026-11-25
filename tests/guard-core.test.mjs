import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RUNS_ROOT,
  checkBashUnderGate,
  checkProjectDenyCommands,
  enforcePiRoleTools,
  evaluateDestructiveCommand,
  extractModelFamily,
  getAllNestedCommands,
  isWriteAllowedUnderGate,
} from "../skills/zee/scripts/lib/guard-core.mjs";

test("getAllNestedCommands 递归拆解 sh/bash/zsh -c 与 eval", () => {
  const cmds = getAllNestedCommands(`bash -c "sh -c 'rm -rf /'" && eval "git push -f origin main"`);
  assert.ok(cmds.some((c) => c.includes("rm -rf /")));
  assert.ok(cmds.some((c) => c.includes("git push -f origin main")));
});

test("evaluateDestructiveCommand 拦截根删、主干强推与 DB 删库，但放行只读 grep", () => {
  assert.ok(evaluateDestructiveCommand("rm -rf /", "/tmp"));
  assert.ok(evaluateDestructiveCommand(`bash -c "rm -rf ~"`, "/tmp"));
  assert.ok(evaluateDestructiveCommand("rm --no-preserve-root -rf /tmp/x", "/tmp"));
  assert.ok(evaluateDestructiveCommand("git push --force origin main", "/tmp"));
  assert.ok(evaluateDestructiveCommand("git -C /tmp push origin +master", "/tmp"));
  assert.ok(evaluateDestructiveCommand(`psql -c "DROP DATABASE prod"`, "/tmp"));
  assert.ok(evaluateDestructiveCommand(`echo "DROP DATABASE prod" | mysql`, "/tmp"));

  // 安全命令与只读查询必须放行
  assert.equal(evaluateDestructiveCommand("rm -rf /tmp/my-build-cache", "/tmp"), null);
  assert.equal(evaluateDestructiveCommand(`grep -rn "DROP DATABASE" src/`, "/tmp"), null);
  assert.equal(evaluateDestructiveCommand("git push origin feature/mario", "/tmp"), null);
  assert.equal(evaluateDestructiveCommand("git push --force-with-lease origin feature/mario", "/tmp"), null);
});

test("checkProjectDenyCommands 穿透嵌套子 shell 拦截项目红线", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-deny-test-"));
  try {
    fs.mkdirSync(path.join(tmpRepo, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, ".agents", "zee.project.json"),
      JSON.stringify({ denyCommands: ["--live", "deploy --prod"] }),
    );
    assert.ok(checkProjectDenyCommands("node run.js --live", tmpRepo));
    assert.ok(checkProjectDenyCommands(`bash -c "npm run deploy --prod"`, tmpRepo));
    assert.equal(checkProjectDenyCommands("npm test", tmpRepo), null);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("isWriteAllowedUnderGate 区分 plan / review / init-design 路径白名单", () => {
  const repo = "/tmp/demo-repo";
  const busFile = path.join(RUNS_ROOT, "demo-1234", "feat", "plan.md");
  const artDir = "/tmp/agy-artifacts";

  // plan 模式
  assert.equal(isWriteAllowedUnderGate(busFile, repo, "plan", [artDir]), true);
  assert.equal(isWriteAllowedUnderGate(".scratch/feat/plan.md", repo, "plan", [artDir]), true);
  assert.equal(isWriteAllowedUnderGate("docs/plans/feat.md", repo, "plan", [artDir]), true);
  assert.equal(isWriteAllowedUnderGate(path.join(artDir, "implementation_plan.md"), repo, "plan", [artDir]), true);
  assert.equal(isWriteAllowedUnderGate("src/game.ts", repo, "plan", [artDir]), false);

  // review 模式
  assert.equal(isWriteAllowedUnderGate(busFile, repo, "review", [artDir]), true);
  assert.equal(isWriteAllowedUnderGate(".scratch/feat/plan.md", repo, "review", [artDir]), false);
  assert.equal(isWriteAllowedUnderGate("src/game.ts", repo, "review", [artDir]), false);

  // init-design 模式
  assert.equal(isWriteAllowedUnderGate("SPEC.md", repo, "init-design"), true);
  assert.equal(isWriteAllowedUnderGate("ARCHITECTURE.md", repo, "init-design"), true);
  assert.equal(isWriteAllowedUnderGate(".agents/zee.project.json", repo, "init-design"), true);
  assert.equal(isWriteAllowedUnderGate("src/index.ts", repo, "init-design"), false);
});

test("checkBashUnderGate 放行允许目录的 mkdir/cp 与 zee-tool.mjs，拦截非法写入与嵌套逃逸", () => {
  const repo = "/tmp/demo-repo";
  const busDir = path.join(RUNS_ROOT, "demo-1234", "feat");

  // 此前 v3.1 被误拦的合法操作在 v4 必须放行
  assert.equal(checkBashUnderGate(`mkdir -p .scratch/achievements && cp "${busDir}/plan.md" .scratch/achievements/plan.md`, repo, "plan"), null);
  assert.equal(checkBashUnderGate(`node "/path/to/zee-tool.mjs" update-state "${busDir}" --status planned`, repo, "plan"), null);
  assert.equal(checkBashUnderGate(`echo "ok" > "${busDir}/context.md"`, repo, "plan"), null);

  // 危险/越界操作必须拦截
  assert.ok(checkBashUnderGate(`cp "${busDir}/plan.md" src/app.ts`, repo, "plan"));
  assert.ok(checkBashUnderGate(`bash -c "sed -i 's/a/b/' src/app.ts"`, repo, "plan"));
  assert.ok(checkBashUnderGate("git commit -m 'sneak'", repo, "review"));
  assert.ok(checkBashUnderGate("npm install lodash", repo, "plan"));
  assert.ok(checkBashUnderGate("echo hack > src/app.ts", repo, "plan"));
});

test("v4.0.1 回归 #1：词法化 Git 校验放行 git merge-base，但仍拦截 git merge", () => {
  const repo = "/tmp/demo-repo";
  assert.equal(checkBashUnderGate("git merge-base main zee/fire-flower/impl", repo, "review"), null);
  assert.equal(checkBashUnderGate("git -C /tmp/demo-repo merge-base HEAD main", repo, "plan"), null);
  assert.equal(checkBashUnderGate("git stash list && git branch -vv", repo, "review"), null);

  assert.ok(checkBashUnderGate("git merge zee/fire-flower/impl", repo, "review"));
  assert.ok(checkBashUnderGate("git branch -D old-branch", repo, "review"));
  assert.ok(checkBashUnderGate("git stash pop", repo, "plan"));
});

test("v4.0.1 回归 #2：静态变量 $Z 展开 + 词法动词识别放行 update-state --predicate 'npm ci && ...'，仍拦真实 npm ci", () => {
  const repo = "/tmp/demo-repo";
  const busDir = path.join(RUNS_ROOT, "demo-1234", "mario");
  const cmd = `Z=/Users/zee/.pi/agent/git/github.com/zee820232/zee/skills/zee/scripts/zee-tool.mjs; B=${busDir}; node "$Z" update-state "$B" --predicate "npm ci && npm test && npm run build"`;
  assert.equal(checkBashUnderGate(cmd, repo, "init-design"), null);
  assert.equal(checkBashUnderGate(cmd, repo, "plan"), null);

  // 真实的 npm ci / pnpm install 仍必须拦截
  assert.ok(checkBashUnderGate("npm ci && npm test", repo, "init-design"));
  assert.ok(checkBashUnderGate("pnpm --filter web install", repo, "plan"));
});

test("v4.0.1 回归 #3：Heredoc 正文剥离放行 Python 内嵌反引号/泛型尖括号，但仍拦重定向写源码", () => {
  const repo = "/tmp/demo-repo";
  const pyHeredoc = `python3 -I - <<'EOF'
text = "Record<GameEvent['t'], () => void> -> \`code\`"
print(len(text))
EOF`;
  assert.equal(checkBashUnderGate(pyHeredoc, repo, "plan"), null);

  // 但 Heredoc 头本身带非法输出重定向时仍必须硬拦截
  const evilHeredoc = `cat <<'EOF' > src/app.ts
export const hacked = true;
EOF`;
  assert.ok(checkBashUnderGate(evilHeredoc, repo, "plan"));
});

test("v4.0.1 回归 #4：同命令静态变量 $B 展开精准放行总线重定向，但仍拦非法目标", () => {
  const repo = "/tmp/demo-repo";
  const busDir = path.join(RUNS_ROOT, "demo-1234", "mario");
  assert.equal(checkBashUnderGate(`B=${busDir}; cat > $B/context.md`, repo, "init-design"), null);
  assert.equal(checkBashUnderGate(`B=${busDir}; echo "hi" >> "\${B}/context.md"`, repo, "plan"), null);

  // 静态变量指向业务目录时必须硬拦截
  assert.ok(checkBashUnderGate(`B=${repo}/src; cat > $B/evil.ts`, repo, "init-design"));
  assert.ok(checkBashUnderGate(`B=/tmp/outside; echo hack > $B/evil.ts`, repo, "plan"));
});

test("v4.0.1 回归 #5：追踪同命令 cd $B 目录切换放行总线内 cp，但仍拦业务目录内 cp", () => {
  const repo = "/tmp/demo-repo";
  const busDir = path.join(RUNS_ROOT, "demo-1234", "fire-flower");
  assert.equal(checkBashUnderGate(`B=${busDir}; cd $B && cp plan.md artifacts-raw.md`, repo, "plan"), null);
  assert.equal(checkBashUnderGate(`cd .scratch && mkdir -p sub && cp ../docs/plans/a.md sub/a.md`, repo, "plan"), null);

  // 切入 src 后执行 cp 必须硬拦截
  assert.ok(checkBashUnderGate(`cd src && cp a.ts b.ts`, repo, "plan"));
});

test("extractModelFamily 与 enforcePiRoleTools 保持最小权限与家族精准识别", () => {
  assert.equal(extractModelFamily("vm/claude-sonnet-5-5"), "claude");
  assert.equal(extractModelFamily("codex/gpt-6.1-sol"), "openai");
  assert.equal(extractModelFamily("devin/gemini-4-hydrogen"), "gemini");
  assert.equal(extractModelFamily("devin/swe-2"), "devin");

  // Verifier / Reviewer 硬剥离 edit
  const verTools = enforcePiRoleTools("verifier", ["read", "edit", "write", "bash"]);
  assert.equal(verTools.includes("edit"), false);
  assert.equal(verTools.includes("bash"), true);

  const revTools = enforcePiRoleTools("reviewer", ["read", "edit", "write", "bash"]);
  assert.equal(revTools.includes("edit"), false);

  const scoutTools = enforcePiRoleTools("scout", ["read", "edit", "write", "bash", "grep"]);
  assert.equal(scoutTools.includes("edit"), false);
  assert.equal(scoutTools.includes("write"), false);

  const judgeTools = enforcePiRoleTools("judge", ["read", "bash", "edit", "write"]);
  assert.deepEqual(judgeTools, ["read"]);
});
