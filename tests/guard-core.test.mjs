import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  isAllowedZeeTmpPath,
  isWithinDir,
  isWriteAllowedUnderGate,
  splitShellSegments,
  tokenizeShell,
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

test("v4.2.0 跨平台：Windows 反斜杠路径保留、tmpRoots/盘符大小写、gardening-queue 与新 zee-tool 子命令白名单", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v420-guard-"));
  try {
    // 1. tokenizeShell & splitShellSegments 仅对 shell 特殊字符转义，完整保留 Windows 路径反斜杠
    const winToolPath = "C:\\Users\\47847\\zee\\skills\\zee\\scripts\\zee-tool.mjs";
    const winBusPath = "C:\\Users\\47847\\.local\\state\\zee\\runs\\demo\\bus";
    const toksUnquoted = tokenizeShell(`node ${winToolPath} update-state ${winBusPath}`);
    assert.deepEqual(toksUnquoted, ["node", winToolPath, "update-state", winBusPath]);

    const toksQuoted = tokenizeShell(`cp "${winBusPath}\\plan.md" "hello \\"world\\"" hello\\ space`);
    assert.deepEqual(toksQuoted, ["cp", `${winBusPath}\\plan.md`, 'hello "world"', "hello space"]);

    const segs = splitShellSegments(`echo "${winBusPath}\\a.md" && echo ok; echo "escaped\\;semi"`);
    assert.equal(segs.length, 3);
    assert.ok(segs[0].includes(`${winBusPath}\\a.md`));
    assert.equal(segs[2], 'echo "escaped\\;semi"');

    // 2. isAllowedZeeTmpPath / isWithinDir 兼容 /tmp/zee-*、os.tmpdir()/zee-* 与 Windows 盘符大小写
    const osTmpSandboxFile = path.join(os.tmpdir(), "zee-mut-win1", "out.txt");
    assert.equal(isAllowedZeeTmpPath("/tmp/zee-probe-win", tmpRepo), true);
    assert.equal(isAllowedZeeTmpPath(osTmpSandboxFile, tmpRepo), true);
    assert.equal(isAllowedZeeTmpPath(path.join(tmpRepo, "src", "app.ts"), tmpRepo), false);
    assert.equal(checkBashUnderGate(`echo "ok" > "${osTmpSandboxFile}"`, tmpRepo, "review"), null);
    assert.ok(checkBashUnderGate(`echo "evil" > "${path.join(tmpRepo, "src", "app.ts")}"`, tmpRepo, "review"));

    if (process.platform === "win32") {
      const lowerSandbox = osTmpSandboxFile.replace(/^[A-Z]:/, (d) => d.toLowerCase());
      const upperRoot = os.tmpdir().replace(/^[a-z]:/, (d) => d.toUpperCase());
      assert.equal(isWithinDir(lowerSandbox, upperRoot), true);
      assert.equal(isAllowedZeeTmpPath(lowerSandbox, tmpRepo), true);
    }

    // 3. .agents/gardening-queue.jsonl 在 review / plan / init-design 锁态均放行
    assert.equal(isWriteAllowedUnderGate(".agents/gardening-queue.jsonl", tmpRepo, "review"), true);
    assert.equal(isWriteAllowedUnderGate(".agents/gardening-queue.jsonl", tmpRepo, "plan"), true);
    assert.equal(isWriteAllowedUnderGate(".agents/gardening-queue.jsonl", tmpRepo, "init-design"), true);

    // 4. v4.2.0 新增安全 zee-tool.mjs 子命令在锁态精准放行
    for (const subCmd of [
      `sandbox-export --repo "${tmpRepo}" --prefix mut`,
      `sandbox-clean "${path.join(os.tmpdir(), "zee-mut-win1")}"`,
      `gate-tamper-diff --repo "${tmpRepo}" --working-tree`,
      `mine-transcripts --mode recall --repo "${tmpRepo}" --query auth`,
      `queue-finding --repo "${tmpRepo}" --category smell --pattern test-gap --summary "missing seam"`,
      `list-findings --repo "${tmpRepo}"`,
      `readiness "${tmpRepo}"`,
      `match-skills --repo "${tmpRepo}" --files src/a.ts`,
    ]) {
      assert.equal(
        checkBashUnderGate(`node "${winToolPath}" ${subCmd}`, tmpRepo, "review"),
        null,
        `review lock should allow zee-tool ${subCmd}`,
      );
    }
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("v4.2.1 只读锁自伤解除：sandbox git apply、cp -t /tmp/zee-*、<busDir> sed -i/python3 与 .gitignore 零跟踪产物清理", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v421-guard-"));
  const tmpBus = path.join(os.homedir(), ".local", "state", "zee", "runs", `v421-test-${process.pid}`, "demo-bus");
  try {
    // 初始化真实 Git 仓库验证 .gitignore 忽略且零跟踪产物清理
    execFileSync("git", ["-C", tmpRepo, "init", "-b", "main"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.email", "t@zee.dev"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.name", "zee"], { stdio: "ignore" });
    fs.mkdirSync(path.join(tmpRepo, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, "test-results"), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, "dist"), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".gitignore"), "test-results/\ndist/\nnode_modules/\n");
    fs.writeFileSync(path.join(tmpRepo, "src", "app.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(tmpRepo, "unignored.txt"), "keep\n");
    fs.writeFileSync(path.join(tmpRepo, ".env"), "SECRET=1\n");
    fs.writeFileSync(path.join(tmpRepo, "test-results", "trace.zip"), "zip");
    fs.writeFileSync(path.join(tmpRepo, "dist", "tracked.js"), "tracked");
    execFileSync("git", ["-C", tmpRepo, "add", ".gitignore", "src/app.ts"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "add", "-f", "dist/tracked.js"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "commit", "-m", "init"], { stdio: "ignore" });

    // 1. /tmp/zee-* 沙盒内本地 git -C apply/commit 放行；push 与主仓 apply 仍硬拦截
    assert.equal(checkBashUnderGate("git -C /tmp/zee-rev-box apply fix.patch", tmpRepo, "review"), null);
    assert.equal(checkBashUnderGate("git -C /tmp/zee-rev-box commit -m 'tmp'", tmpRepo, "review"), null);
    assert.ok(checkBashUnderGate("git -C /tmp/zee-rev-box push origin main", tmpRepo, "review"));
    assert.ok(checkBashUnderGate(`git -C "${tmpRepo}" apply fix.patch`, tmpRepo, "review"));

    // 2. cp -t /tmp/zee-* / --target-directory & ${TMPDIR:-/tmp}/zee-* mktemp 绑定放行
    assert.equal(checkBashUnderGate("cp -t /tmp/zee-rev-box src/app.ts", tmpRepo, "review"), null);
    assert.equal(checkBashUnderGate("cp --target-directory=/tmp/zee-rev-box README.md", tmpRepo, "review"), null);
    assert.equal(
      checkBashUnderGate('TMP=$(mktemp -d "${TMPDIR:-/tmp}/zee-rev-XXXXXX") && cp src/app.ts "$TMP"', tmpRepo, "review"),
      null,
    );
    assert.ok(checkBashUnderGate("cp -t src README.md", tmpRepo, "review"));

    // 3. <busDir> 内受控 sed -i (GNU + BSD '') 与 python3 写总线放行；改业务码或越权 .. 硬拦
    fs.mkdirSync(tmpBus, { recursive: true });
    const busFile = path.join(tmpBus, "partial-arch.md");
    fs.writeFileSync(busFile, "old\n");
    assert.equal(checkBashUnderGate(`sed -i 's/old/new/' "${busFile}"`, tmpRepo, "init-design"), null);
    assert.equal(checkBashUnderGate(`sed -i '' 's/old/new/' "${busFile}"`, tmpRepo, "init-design"), null);
    assert.equal(
      checkBashUnderGate(`cd "${tmpBus}" && python3 -c "open('summary.txt','w').write('ok')"`, tmpRepo, "init-design"),
      null,
    );
    assert.ok(checkBashUnderGate("sed -i 's/a/b/' src/app.ts", tmpRepo, "init-design"));
    assert.ok(
      checkBashUnderGate(`cd "${tmpBus}" && python3 -c "open('${tmpRepo.replace(/\\/g, "/")}/src/app.ts','w')"`, tmpRepo, "init-design"),
    );

    // 4. review 锁下放行清理 .gitignore 忽略且零 tracked 产物目录（test-results），拦截未忽略/含 tracked/.git/node_modules/.env
    assert.equal(checkBashUnderGate("rm -rf test-results", tmpRepo, "review"), null);
    assert.ok(checkBashUnderGate("rm -rf dist", tmpRepo, "review"), "含 tracked 文件的 dist/ 必须拦截");
    assert.ok(checkBashUnderGate("rm -rf unignored.txt", tmpRepo, "review"));
    assert.ok(checkBashUnderGate("rm -rf node_modules", tmpRepo, "review"));
    assert.ok(checkBashUnderGate("rm -rf .git", tmpRepo, "review"));
    assert.ok(checkBashUnderGate("rm -rf .env", tmpRepo, "review"));
    assert.equal(
      checkBashUnderGate("node skills/zee/scripts/zee-tool.mjs provider-health", tmpRepo, "review"),
      null,
    );
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(path.dirname(tmpBus), { recursive: true, force: true });
  }
});

test("v4.2.2 回归 [P1/P2]：剥离 2>&1 重定向放行沙盒 cp/rm、放行沙盒内 patch（仍拦仓库 patch）、放行 resolve-finding", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zee-v422-guard-"));
  try {
    execFileSync("git", ["-C", tmpRepo, "init", "-b", "main"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.email", "t@zee.dev"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "config", "user.name", "zee"], { stdio: "ignore" });
    fs.mkdirSync(path.join(tmpRepo, "test-results"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".gitignore"), "test-results/\n");
    execFileSync("git", ["-C", tmpRepo, "add", ".gitignore"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmpRepo, "commit", "-m", "init"], { stdio: "ignore" });

    // 1. cp -R node_modules $S/node_modules 2>&1 不得把 2>&1 误当目标路径
    assert.equal(
      checkBashUnderGate(
        "S=/tmp/zee-mut-abc123; cp -R node_modules $S/node_modules 2>&1 | tail -1",
        tmpRepo,
        "review",
      ),
      null,
    );
    assert.equal(checkBashUnderGate("rm -rf test-results 2>/dev/null", tmpRepo, "review"), null);
    // 仍严格拦截向仓库内目录的 cp 2>&1
    assert.ok(checkBashUnderGate("cp src/a.ts src/b.ts 2>&1", tmpRepo, "review"));

    // 2. 严格位于 /tmp/zee-* 沙盒内的 patch 放行；主仓 patch 或 -o 逃逸出沙盒必须硬拦
    assert.equal(
      checkBashUnderGate("(cd /tmp/zee-mut-abc123 && patch -p1 < /tmp/zee-rev-1/fix.patch)", tmpRepo, "review"),
      null,
    );
    assert.equal(
      checkBashUnderGate("patch -d /tmp/zee-mut-abc123 -p1 < /tmp/zee-rev-1/fix.patch", tmpRepo, "review"),
      null,
    );
    assert.ok(checkBashUnderGate("patch -p1 < /tmp/zee-rev-1/fix.patch", tmpRepo, "review"));
    assert.ok(
      checkBashUnderGate(
        `patch -d /tmp/zee-mut-abc123 -p1 -o "${path.join(tmpRepo, "src", "evil.ts")}" < /tmp/zee-rev-1/fix.patch`,
        tmpRepo,
        "review",
      ),
    );

    // 3. zee-tool.mjs resolve-finding 在只读锁下放行
    assert.equal(
      checkBashUnderGate(`node skills/zee/scripts/zee-tool.mjs resolve-finding --repo "${tmpRepo}" --pattern foo`, tmpRepo, "review"),
      null,
    );
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
