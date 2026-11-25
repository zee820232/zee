import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PI_EXT_PATH = path.join(REPO_ROOT, "pi-extension", "index.ts");

test("pi-extension/index.ts 接入共享 guard-core、跨回合持久化 gate 与 zee_subagent v2 全部关键护栏", () => {
  const src = fs.readFileSync(PI_EXT_PATH, "utf8");

  // 1. 共用 guard-core.mjs
  assert.match(src, /from\s+"\.\.\/skills\/zee\/scripts\/lib\/guard-core\.mjs"/);

  // 2. 跨回合持久化 zee-gate 且 agent_settled 仅释放 review 锁（不误清 plan 锁）
  assert.match(src, /pi\.appendEntry<ZeeGateEntry>\("zee-gate"/);
  assert.match(src, /if\s*\(gate\s*===\s*"review"\)\s*\{\s*setGate\("none",\s*ctx\);/);
  assert.equal(/pi\.on\("agent_settled"[\s\S]{0,120}if\s*\(gate\s*!==\s*"none"\)/.test(src), false, "严禁在 agent_settled 无条件清零 plan 锁");

  // 3. 常驻 denyCommands 与破坏性命令拦截位于 gate 检查之前
  const toolCallIdx = src.indexOf('pi.on("tool_call"');
  const denyIdx = src.indexOf("checkProjectDenyCommands", toolCallIdx);
  const destructiveIdx = src.indexOf("evaluateDestructiveCommand", toolCallIdx);
  assert.ok(toolCallIdx > 0 && denyIdx > toolCallIdx && destructiveIdx > toolCallIdx);

  // 4. zee_subagent v2 关键能力：分级超时、空闲看门狗、StagnancyTracker、PARTIAL_RECEIPT、原子 worktree、authorFamily、脏区审计
  assert.match(src, /ROLE_DEFAULT_TIMEOUT_MS/);
  assert.match(src, /idleTimeoutMs/);
  assert.match(src, /stagnancy_loop/);
  assert.match(src, /TIMEOUT_PARTIAL/);
  assert.match(src, /prepareAtomicWorktree/);
  assert.match(src, /authorFamily/);
  assert.match(src, /enforcePiRoleTools/);
  assert.match(src, /ROLE_VIOLATION/);

  // 5. 全局 CLAUDE.md 防串扰与共享文件单写者规则
  assert.match(src, /Ignore repo-irrelevant global `~\/CLAUDE\.md`/);
  assert.match(src, /CHANGELOG\.md/);
});

test("v4.0.1 回归：pi-extension 支持 message_update 流式正文抢救、15s 心跳、双态看门狗与 provider 前缀自愈", () => {
  const src = fs.readFileSync(PI_EXT_PATH, "utf8");

  // 1. 流式正文实时累加与抢救回退
  assert.match(src, /evt\.type === "message_update"/);
  assert.match(src, /streamingAssistantText \+= ame\.delta/);
  assert.match(src, /latestAssistantText \|\| streamingAssistantText/);

  // 2. 15s 节流心跳与 inFlightTool 追踪
  assert.match(src, /HEARTBEAT_INTERVAL_MS = 15_000/);
  assert.match(src, /inFlightTool/);
  assert.match(src, /clearInterval\(heartbeatTimer\)/);

  // 3. 双态看门狗（reviewer 180s / 工具执行 180s / 纯思考 240s 上限）
  assert.match(src, /ROLE_DEFAULT_IDLE_TIMEOUT_MS[\s\S]*reviewer:\s*180_000/);
  assert.match(src, /TOOL_EXEC_IDLE_TIMEOUT_MS = 180_000/);
  assert.match(src, /THINKING_STREAM_TIMEOUT_MS = 240_000/);

  // 4. 修正 provider 参数说明并内置 vm/devin/codex 前缀误传拦截
  assert.equal(/如 vm \/ codex \/ devin/.test(src), false, "provider 说明不得再误列 vm/codex/devin 示例");
  assert.match(src, /bindings\.pi\.\*\.providerInstanceId/);
  assert.match(src, /\/\^\(vm\|devin\|codex\)\$\/i/);
});
