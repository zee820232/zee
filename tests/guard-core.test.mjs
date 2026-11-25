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

  // v4.1 家族别名归一化
  assert.equal(extractModelFamily("anthropic"), "claude");
  assert.equal(extractModelFamily("anthropic/claude-sonnet-4"), "claude");
  assert.equal(extractModelFamily("google"), "gemini");
  assert.equal(extractModelFamily("xai"), "grok");
});

test("v4.1 回归 [H1/H2]：放行项目内 rm -rf lib/bin/var/dev，同时穿透 bash -e -c / sh --norc -c 拦截删根", () => {
  const proj = "/Users/zee/my-project";
  assert.equal(evaluateDestructiveCommand("rm -rf lib", proj), null);
  assert.equal(evaluateDestructiveCommand("rm -rf bin var dev", proj), null);
  assert.ok(evaluateDestructiveCommand("rm -rf /lib", proj));
  assert.ok(evaluateDestructiveCommand("rm -rf /", proj));
  assert.ok(evaluateDestructiveCommand('bash -e -c "rm -rf /"', proj));
  assert.ok(evaluateDestructiveCommand('sh --norc -c "rm -rf /"', proj));
  assert.ok(evaluateDestructiveCommand('bash -o pipefail -c "rm -rf ~"', proj));

  // Heredoc 文档正文包含 rm -rf / 不得误报
  const docHeredoc = `cat <<'EOF' > /tmp/zee-doc/note.md
Never run rm -rf / in production!
EOF`;
  assert.equal(evaluateDestructiveCommand(docHeredoc, proj), null);
});

test("v4.1 回归 [H3]：denyCommands 放行只读搜索与 commit 消息；词法锁支持 export/rm 白名单/领域文档并拦截内联写码", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v41-guard-"));
  try {
    fs.mkdirSync(path.join(tmpRepo, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, ".agents", "zee.project.json"),
      JSON.stringify({ denyCommands: ["--live", "deploy --prod"] }),
    );
    // 只读搜索、commit 消息与 heredoc 文档放行
    assert.equal(checkProjectDenyCommands('rg "--live" src/', tmpRepo), null);
    assert.equal(checkProjectDenyCommands('git commit -m "block --live in prod"', tmpRepo), null);
    assert.equal(checkProjectDenyCommands(`cat <<'EOF' > /tmp/zee-note/a.md\nforbid --live\nEOF`, tmpRepo), null);
    // 嵌套带前缀标志的真实违规命令仍必须硬拦
    assert.ok(checkProjectDenyCommands('bash -e -c "node run.js --live"', tmpRepo));

    const busDir = path.join(RUNS_ROOT, "demo-v41", "s");
    // export 变量跟踪、白名单 rm/tmp、GLOSSARY/ADR/docs/SPEC 均放行
    assert.equal(checkBashUnderGate(`export B=${busDir}; echo hi > $B/context.md`, tmpRepo, "plan"), null);
    assert.equal(checkBashUnderGate("rm .scratch/old.md && rm -rf /tmp/zee-probe-123", tmpRepo, "plan"), null);
    assert.equal(checkBashUnderGate("echo x > /tmp/zee-probe-123/a.js", tmpRepo, "review"), null);
    assert.equal(checkBashUnderGate("cat > docs/adr/0001-auth.md", tmpRepo, "plan"), null);
    assert.equal(checkBashUnderGate("cat > GLOSSARY.md", tmpRepo, "plan"), null);
    assert.equal(checkBashUnderGate("cat > docs/SPEC.md", tmpRepo, "init-design"), null);

    // 此前可绕过的假阴性必须硬拦截
    assert.ok(checkBashUnderGate(`python3 - <<'EOF'\nopen("src/app.ts","w").write("hack")\nEOF`, tmpRepo, "plan"));
    assert.ok(checkBashUnderGate(`node -e "require('fs').writeFileSync('src/app.ts','x')"`, tmpRepo, "review"));
    assert.ok(checkBashUnderGate("git branch rogue-branch", tmpRepo, "plan"));
    assert.ok(checkBashUnderGate(`node /path/to/zee-tool.mjs cleanup-worktrees ${tmpRepo} --prune-safe`, tmpRepo, "review"));
    // 只读 cleanup-worktrees（不带 --prune-safe）仍放行
    assert.equal(checkBashUnderGate(`node /path/to/zee-tool.mjs cleanup-worktrees ${tmpRepo}`, tmpRepo, "review"), null);
    // 业务目录 rm 仍硬拦截
    assert.ok(checkBashUnderGate("rm src/app.ts", tmpRepo, "plan"));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("v4.1.1 回归 [P0-1/P0-2/P0-3]：封堵括号/花括号/perl -0pi/$(...) 绕过，解开 /tmp/zee-* 沙盒与 denyCommands 边界误杀", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v411-guard-"));
  try {
    fs.mkdirSync(path.join(tmpRepo, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, ".agents", "zee.project.json"),
      JSON.stringify({ denyCommands: ["rm -rf /", "rm -rf ~", "--live", "playwright install"] }),
    );

    // P0-1: 括号子 shell、命令分组花括号、$(...) 命令替换、perl -0pi 必须全部硬拦截！
    assert.ok(evaluateDestructiveCommand("(rm -rf /)", tmpRepo));
    assert.ok(evaluateDestructiveCommand("{ rm -rf /; }", tmpRepo));
    assert.ok(evaluateDestructiveCommand("echo $(rm -rf /)", tmpRepo));
    assert.ok(checkBashUnderGate("(pnpm add vite)", tmpRepo, "init-design"));
    assert.ok(checkBashUnderGate("{ pnpm add vite; }", tmpRepo, "review"));
    assert.ok(checkBashUnderGate("perl -0pi -e 's/a/b/g' src/app.ts", tmpRepo, "plan"));
    assert.ok(checkBashUnderGate("perl -i.bak -pe 's/a/b/' src/app.ts", tmpRepo, "init-design"));

    // P0-2: 0→1 Scout 在 /tmp/zee-probe-* 沙盒内使用 $(mktemp) + pnpm add + 探针脚本必须放行；但逃逸至仓库必须硬拦
    const scoutProbeCmd = `T=$(mktemp -d /tmp/zee-probe-XXXXXX); cd "$T" && pnpm add -D playwright && node -e "require('fs').writeFileSync('probe.mjs', 'console.log(1)')"`;
    assert.equal(checkBashUnderGate(scoutProbeCmd, tmpRepo, "review"), null);
    assert.equal(checkBashUnderGate(scoutProbeCmd, tmpRepo, "init-design"), null);
    // 逃逸企图：在沙盒内试图指向仓库目录或 -C 指向仓库或 -g 全局装包，仍必须硬拦截！
    assert.ok(checkBashUnderGate(`T=$(mktemp -d /tmp/zee-probe-XXXXXX); cd "$T" && pnpm -C "${tmpRepo}" add evil`, tmpRepo, "review"));
    assert.ok(checkBashUnderGate(`T=$(mktemp -d /tmp/zee-probe-XXXXXX); cd "$T" && npm install -g evil`, tmpRepo, "review"));
    assert.ok(
      checkBashUnderGate(
        `T=$(mktemp -d /tmp/zee-probe-XXXXXX); cd "$T" && node -e "require('fs').writeFileSync('${tmpRepo}/src/hack.ts','x')"`,
        tmpRepo,
        "review",
      ),
    );

    // P0-3: /tmp/zee-sim-* 等通用前缀必须放行；plan 锁内显式针对白名单 docs/adr/ 的内联 python 放行，但写 src/ 或动态变量仍硬拦
    assert.equal(checkBashUnderGate("mkdir -p /tmp/zee-sim-1 && echo ok > /tmp/zee-sim-1/out.txt", tmpRepo, "plan"), null);
    assert.equal(
      checkBashUnderGate(`python3 -I - <<'EOF'\nopen("docs/adr/0002-weather.md", "w").write("# ADR\\n")\nEOF`, tmpRepo, "plan"),
      null,
    );
    assert.ok(
      checkBashUnderGate(`python3 -I - <<'EOF'\np = "src/core.ts"\nopen(p, "w").write("hack")\nEOF`, tmpRepo, "plan"),
    );

    // P0-3: denyCommands "rm -rf /" 必须拦截 rm -rf / 与 rm -rf /*，但绝不误杀 rm -rf /tmp/zee-retro-*！
    assert.ok(checkProjectDenyCommands("rm -rf /", tmpRepo));
    assert.ok(checkProjectDenyCommands("rm -rf /*", tmpRepo));
    assert.ok(checkProjectDenyCommands("rm -rf ~", tmpRepo));
    assert.ok(checkProjectDenyCommands("(rm -rf /)", tmpRepo));
    assert.equal(checkProjectDenyCommands("rm -rf /tmp/zee-retro-KPzm9g", tmpRepo), null);
    assert.equal(checkProjectDenyCommands("rm -rf /tmp/zee-retro-*", tmpRepo), null);
    assert.equal(checkProjectDenyCommands("node run.js --livestream", tmpRepo), null);
    assert.ok(checkProjectDenyCommands("node run.js --live=true", tmpRepo));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
