/**
 * zee Pi Extension v4.1.0 — 常驻自动路由 (/zee-mode)、8 快捷命令转发、跨回合路径锁、共享安全核与 zee_subagent v2.1
 *
 * 设计原则（严格对齐 Pi v1.6.0 源码 + v4.1 深度审计修复）：
 * 1. 不写死任何第三方技能/扩展/私有网关；所有领域技能由 Pi 原生 <available_skills> 自动发现，并向自动路由注入精确 <zeeDir> 路径。
 * 2. mode 与 gate 均通过 pi.appendEntry 持久化并仅从 ctx.sessionManager.getBranch() 逆序恢复，
 *    支持 /zee plan|review|init|arch 空格子命令同步上锁与 M0 磁盘解锁。
 * 3. 与 AGY 共用 skills/zee/scripts/lib/guard-core.mjs，并向子进程挂载轻量 worker-guard.ts 彻底消灭 `-ne` 安全真空。
 * 4. 四层防递归：默认 off + !ctx.hasUI + ZEE_WORKER=1 + [zee-worker] 首消息哨兵。
 * 5. zee_subagent v2.1：流式正文优先抢救、并发 Map 工具看门狗、精准增量脏区回滚（零误杀用户未提交改动）、
 *    工作树活锁 (.zee-lock.json) 防误删、authorFamily 别名归一化静态拦截。
 */

import { execFileSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type BeforeAgentStartEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type JsonAgentSessionEvent,
	isToolCallEventType,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	RUNS_ROOT,
	checkBashUnderGate as sharedCheckBashUnderGate,
	checkProjectDenyCommands,
	enforcePiRoleTools,
	evaluateDestructiveCommand,
	extractModelFamily,
	isWriteAllowedUnderGate as sharedIsWriteAllowedUnderGate,
	normalizeToolPath,
} from "../skills/zee/scripts/lib/guard-core.mjs";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(EXTENSION_DIR, "..", "skills");
const ZEE_SKILL_DIR = path.join(SKILLS_ROOT, "zee");
const WORKER_GUARD_PATH = path.join(EXTENSION_DIR, "worker-guard.ts");

type ZeeMode = "off" | "auto" | "strict";
type GateMode = "none" | "plan" | "review" | "init-design";

interface ZeeModeEntry {
	mode: ZeeMode;
}

interface ZeeGateEntry {
	gate: GateMode;
}

interface SubagentUsage {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
}

interface SubagentDetails {
	role: string;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	tools?: string[];
	cwd: string;
	worktreePath?: string;
	worktreeCleaned?: boolean;
	status: "running" | "completed" | "failed" | "aborted" | "timeout" | "idle_timeout" | "stagnancy_loop";
	exitCode: number | null;
	stopReason?: string;
	errorMessage?: string;
	roleViolation?: boolean;
	lastActions: string[];
	usage: SubagentUsage;
}

const VALID_MODES = new Set<ZeeMode>(["off", "auto", "strict"]);
const VALID_GATES = new Set<GateMode>(["none", "plan", "review", "init-design"]);

const ROLE_DEFAULT_TIMEOUT_MS: Record<string, number> = {
	scout: 240_000,
	judge: 240_000,
	verifier: 300_000,
	reviewer: 480_000,
	architect: 600_000,
	coder: 600_000,
	ui: 600_000,
};
const DEFAULT_SUBAGENT_TIMEOUT_MS = 300_000;
const MAX_SUBAGENT_TIMEOUT_MS = 1_800_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const ROLE_DEFAULT_IDLE_TIMEOUT_MS: Record<string, number> = {
	reviewer: 180_000,
};
const TOOL_EXEC_IDLE_TIMEOUT_MS = 180_000;
const THINKING_STREAM_TIMEOUT_MS = 240_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_REPEAT_ERRORS = 4;

const READ_ONLY_AUDIT_ROLES = new Set(["scout", "architect", "judge", "verifier", "reviewer"]);

const WORKER_SENTINELS = [
	"[zee-worker]",
	"# zee Worker Standing Contract",
	"You are already running as a delegate",
];

function isValidMode(value: unknown): value is ZeeMode {
	return typeof value === "string" && VALID_MODES.has(value as ZeeMode);
}

function isValidGate(value: unknown): value is GateMode {
	return typeof value === "string" && VALID_GATES.has(value as GateMode);
}

function containsWorkerSentinel(text: string): boolean {
	if (!text) return false;
	return WORKER_SENTINELS.some((marker) => text.includes(marker));
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
			if (typeof block.text === "string") parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function isSubagentContext(event: BeforeAgentStartEvent, ctx: ExtensionContext): boolean {
	if (process.env.ZEE_WORKER === "1") return true;
	if (!ctx.hasUI) return true;

	if (event.messageType === "user" && containsWorkerSentinel(event.prompt)) {
		return true;
	}

	const branch = ctx.sessionManager.getBranch();
	for (const entry of branch) {
		if (entry.type === "message" && entry.message && entry.message.role === "user") {
			const text = extractMessageText(entry.message.content);
			if (containsWorkerSentinel(text)) return true;
			break;
		}
	}
	return false;
}

export function isWriteAllowedUnderGate(rawPath: string, cwd: string, gateMode: Exclude<GateMode, "none">): boolean {
	return sharedIsWriteAllowedUnderGate(rawPath, cwd, gateMode);
}

export function checkBashUnderGate(command: string, gateMode: Exclude<GateMode, "none">, cwd = process.cwd()): string | null {
	return sharedCheckBashUnderGate(command, cwd, gateMode);
}

function sanitizeSlug(s: string): string {
	return String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "task";
}

function repoKeyFor(repoPath: string): string {
	const absRepo = path.resolve(repoPath);
	const hash = crypto.createHash("sha256").update(absRepo).digest("hex").slice(0, 8);
	return `${sanitizeSlug(path.basename(absRepo))}-${hash}`;
}

function prepareAtomicWorktree(spec: {
	repoRoot: string;
	slug: string;
	lane: string;
	baseRef: string;
	branch?: string;
}): string {
	const absRepo = path.resolve(spec.repoRoot);
	const wtRoot = path.join(RUNS_ROOT, repoKeyFor(absRepo), sanitizeSlug(spec.slug), "worktrees");
	const wtPath = path.join(wtRoot, sanitizeSlug(spec.lane));
	fs.mkdirSync(wtRoot, { recursive: true });

	// 若路径已存在且是合法干净 worktree，先移除再按最新 baseRef 重建，确保 Pinned SHA 100% 精确
	if (fs.existsSync(wtPath)) {
		try {
			const st = execFileSync("git", ["-C", wtPath, "status", "--porcelain"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			if (st) {
				throw new Error(`目标 worktree 目录存在未提交改动，拒绝覆盖：${wtPath}`);
			}
			execFileSync("git", ["-C", absRepo, "worktree", "remove", "--force", wtPath], {
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			if (e instanceof Error && e.message.includes("存在未提交改动")) throw e;
			fs.rmSync(wtPath, { recursive: true, force: true });
			try {
				execFileSync("git", ["-C", absRepo, "worktree", "prune"], { stdio: ["ignore", "ignore", "ignore"] });
			} catch {}
		}
	}

	const args = ["-C", absRepo, "worktree", "add"];
	if (spec.branch && spec.branch.trim()) {
		const branchName = spec.branch.trim();
		// 检查分支是否已存在：若旧分支已完全包含在 baseRef 祖先链内则安全重置至新 baseRef，否则保留未合并分支提交
		let branchExists = false;
		let branchAlreadyMergedIntoBase = false;
		try {
			execFileSync("git", ["-C", absRepo, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
			branchExists = true;
			try {
				execFileSync("git", ["-C", absRepo, "merge-base", "--is-ancestor", `refs/heads/${branchName}`, spec.baseRef], {
					stdio: "ignore",
				});
				branchAlreadyMergedIntoBase = true;
			} catch {
				branchAlreadyMergedIntoBase = false;
			}
		} catch {
			branchExists = false;
		}
		if (branchExists && !branchAlreadyMergedIntoBase) {
			args.push(wtPath, branchName);
		} else if (branchExists && branchAlreadyMergedIntoBase) {
			args.push("-B", branchName, wtPath, spec.baseRef);
		} else {
			args.push("-b", branchName, wtPath, spec.baseRef);
		}
	} else {
		args.push("--detach", wtPath, spec.baseRef);
	}

	execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	return wtPath;
}

function writeWorktreeActiveLock(wtPath: string, role: string): string {
	const lockPath = `${wtPath}.zee-lock.json`;
	try {
		fs.writeFileSync(
			lockPath,
			JSON.stringify({ pid: process.pid, role, createdAt: new Date().toISOString() }, null, 2) + "\n",
			"utf8",
		);
	} catch {}
	return lockPath;
}

function removeWorktreeActiveLock(lockPath: string | undefined): void {
	if (!lockPath) return;
	try {
		fs.rmSync(lockPath, { force: true });
	} catch {}
}

function readGitSnapshot(cwd: string): { isGit: boolean; head: string; statusLines: string[] } {
	try {
		const head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const stRaw = execFileSync("git", ["-C", cwd, "status", "--porcelain"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trimEnd();
		return {
			isGit: true,
			head,
			statusLines: stRaw ? stRaw.split(/\r?\n/).filter(Boolean) : [],
		};
	} catch {
		return { isGit: false, head: "", statusLines: [] };
	}
}

function parsePorcelainPaths(line: string): string[] {
	const raw = line.slice(3).trim();
	if (!raw) return [];
	const unquote = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);
	if (raw.includes(" -> ")) {
		return raw.split(" -> ").map((p) => unquote(p.trim())).filter(Boolean);
	}
	return [unquote(raw)];
}

function inferGateFromZeeArgs(args: string, cwd: string): GateMode {
	const firstToken = String(args || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
	if (firstToken === "plan" || firstToken === "arch") return "plan";
	if (firstToken === "review") return "review";
	if (firstToken === "init") {
		return fs.existsSync(path.join(cwd, ".agents", "zee.project.json")) ? "none" : "init-design";
	}
	return "none";
}

function isBenignReadOnlySearchCommand(toolName: string, rawArgsObj: unknown): boolean {
	if (toolName === "grep" || toolName === "find") return true;
	if (toolName !== "bash" && toolName !== "powershell") return false;
	const cmd =
		rawArgsObj && typeof rawArgsObj === "object" && "command" in rawArgsObj && typeof (rawArgsObj as { command?: unknown }).command === "string"
			? (rawArgsObj as { command: string }).command.trim()
			: "";
	if (!cmd) return false;
	return /^(?:rg|grep|egrep|fgrep|diff)\b/.test(cmd);
}

function buildZeeSection(mode: Exclude<ZeeMode, "off">, gate: GateMode): string {
	const modeLine =
		mode === "strict"
			? "- Mode: **STRICT**. Every non-chat engineering task MUST start with zee Preflight (`zee-tool.mjs init-run` + risk leveling) before editing any repo file."
			: "- Mode: **AUTO**. Answer pure Q&A / quick lookups / trivial ≤1-file non-risk edits directly; route all non-trivial engineering tasks to `zee`.";

	const lines = [
		"## zee Auto-Routing Policy",
		modeLine,
		`- **Skills Root (` + "`<zeeDir>`" + `)**: \`${ZEE_SKILL_DIR}\` (all 8 skills live under \`${SKILLS_ROOT}/<skill>/SKILL.md\`; read directly without searching).`,
		"- **Language**: All user-facing replies, questions, status updates, plans, and reports MUST be in Simplified Chinese (简体中文).",
		"- **Global Template Isolation**: Follow the actual repository stack and `.agents/zee.project.json`; ignore repo-irrelevant ambient template rules.",
		"- **Shared-File Single-Writer**: Parallel workers leave repo-wide shared index files (`CHANGELOG.md`, `README.md`, global test registries) to the Orchestrator integration step.",
		"- **Route by Intent** (read the matching `<skillsRoot>/<skill>/SKILL.md` before acting):",
		`  - Build / Bug Fix / Refactor / Multi-file change -> \`${ZEE_SKILL_DIR}/SKILL.md\` (L0–L3, L2 single-owner fast-track for ≤3 tightly coupled files, Gate 1 Verifier PASS before Gate 2 cross-family Reviewer)`,
		`  - Requirements Interview, Domain Modeling & Plan Only -> \`${path.join(SKILLS_ROOT, "zee-plan", "SKILL.md")}\``,
		`  - 0→1 New Project / Empty Repo -> \`${path.join(SKILLS_ROOT, "zee-init", "SKILL.md")}\``,
		`  - Code / PR / Uncommitted Diff Review Only -> \`${path.join(SKILLS_ROOT, "zee-review", "SKILL.md")}\``,
		`  - Codebase Deep-Module Architecture Audit -> \`${path.join(SKILLS_ROOT, "zee-arch", "SKILL.md")}\``,
		`  - Session Retro & 4-Level Error Hardening -> \`${path.join(SKILLS_ROOT, "zee-retro", "SKILL.md")}\``,
		`  - Overnight Autonomous Execution -> \`${path.join(SKILLS_ROOT, "zee-night", "SKILL.md")}\``,
		`  - Model / Harness Configuration & Verification Skill Setup -> \`${path.join(SKILLS_ROOT, "zee-setup", "SKILL.md")}\``,
		"- **Subagents & Skills**: Use `zee_subagent` with explicit `role`, `provider`, `model`, `thinkingLevel`, `worktree` (atomic out-of-tree isolation under `~/.local/state/zee/runs/.../worktrees/`), and `authorFamily` (when `role === 'reviewer'`). Reuse host domain skills from `<available_skills>` via absolute `location` path (`references/interop.md`).",
	];

	if (gate === "plan") {
		lines.push(
			"- **ACTIVE WRITE LOCK (`plan`)**: Production code writes/edits and mutating bash commands are blocked across turns until `/zee` execution starts. Write ONLY to `~/.local/state/zee/runs/`, `/tmp/zee-*`, `.scratch/`, `docs/plans/`, `docs/adr/`, or `GLOSSARY.md`.",
		);
	} else if (gate === "init-design") {
		lines.push(
			"- **ACTIVE WRITE LOCK (`init-design`)**: 0→1 Stage 1–2 design freeze is active. Write ONLY to `~/.local/state/zee/runs/`, `/tmp/zee-*`, `.scratch/`, `.agents/`, `docs/adr/`, or `SPEC.md`/`ARCHITECTURE.md`/`GLOSSARY.md`/`DESIGN.md` until Stage 3 M0 unlocks.",
		);
	} else if (gate === "review") {
		lines.push(
			"- **ACTIVE WRITE LOCK (`review`)**: Repository writes/edits and mutating bash commands are blocked by the runtime gate. Write ONLY to `~/.local/state/zee/runs/` or `/tmp/zee-*`.",
		);
	}

	return lines.join("\n");
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const envBin = process.env.ZEE_PI_BIN?.trim();
	if (envBin) return { command: envBin, args };

	const currentScript = process.argv[1];
	const isBunVirtualScript =
		currentScript !== undefined &&
		(currentScript.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(currentScript));
	const looksLikePiScript =
		currentScript !== undefined &&
		(currentScript.includes("pi-coding-agent") || path.basename(currentScript).replace(/\.[^.]+$/, "") === "pi");

	if (currentScript && !isBunVirtualScript && looksLikePiScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime && execName.includes("pi")) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function truncateSubagentOutput(output: string): string {
	const initial = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!initial.truncated) return output;
	const omittedBytes = initial.totalBytes - initial.outputBytes;
	return `${initial.content}\n\n[输出已截断：省略 ${omittedBytes} 字节，完整内容请通过总线文件传递]`;
}

const ZeeSubagentParams = Type.Object({
	task: Type.String({
		description: "完整子代理任务提示词（建议以 [zee-worker] 和 worker.md 契约开头，附角色卡与总线路径）",
	}),
	role: Type.Optional(
		Type.String({
			description: "角色标识（scout / architect / ui / coder / verifier / reviewer / judge），决定默认超时与最小权限裁剪",
		}),
	),
	provider: Type.Optional(
		Type.String({
			description:
				"可选模型提供方 ID（必须填写 ~/.agents/zee-config.json 的 bindings.pi.*.providerInstanceId 或 pi --list-models 第一列，切勿传入模型路径前缀如 vm/devin/codex；必须与 model 同时传入）",
		}),
	),
	model: Type.Optional(
		Type.String({
			description: "可选目标模型 ID 或 provider/model 模式（建议显式指定，避免继承父会话模型）",
		}),
	),
	authorFamily: Type.Optional(
		Type.String({
			description: "当 role='reviewer' 时强烈建议传入作者模型底层家族（如 claude/openai/gemini/devin），用于静态拦截同家族自审",
		}),
	),
	thinkingLevel: Type.Optional(
		Type.Union(
			[
				Type.Literal("off"),
				Type.Literal("minimal"),
				Type.Literal("low"),
				Type.Literal("medium"),
				Type.Literal("high"),
				Type.Literal("xhigh"),
				Type.Literal("max"),
			],
			{ description: "可选思考强度（建议显式传入，避免子代理默认继承父会话 max）" },
		),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description: "可选最小权限工具白名单；扩展会按 role 强制兜底剥离越权工具（如 verifier/reviewer 强制剥离 edit）",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "可选工作目录（与 worktree 二选一；传入 worktree 时自动原子创建隔离目录并作为 cwd）",
		}),
	),
	worktree: Type.Optional(
		Type.Object(
			{
				repoRoot: Type.String({ description: "主 Git 仓库根目录绝对路径" }),
				slug: Type.String({ description: "当前任务总线 slug" }),
				lane: Type.String({ description: "车道名称（如 slice-a / verify-r1 / review-gemini）" }),
				baseRef: Type.String({ description: "基准提交或分支（如 HEAD 或精确 PINNED_SHA）" }),
				branch: Type.Optional(Type.String({ description: "写角色分支名（如 zee/slug/slice-a）；省略则 --detach 只读检出" })),
				autoCleanup: Type.Optional(
					Type.Boolean({ description: "结束后工作区干净时自动删除 worktree（detached 默认 true，有 branch 默认 false）" }),
				),
			},
			{ description: "声明式原子 Worktree 托管：在 spawn 子进程前创建于 ~/.local/state/zee/runs/.../worktrees/<lane>，彻底消除并发竞态" },
		),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "可选墙钟超时毫秒数（未传时按 role 默认：scout 240s / verifier 300s / reviewer 480s / coder|ui|architect 600s；上限 1800000）",
			minimum: 5000,
			maximum: MAX_SUBAGENT_TIMEOUT_MS,
		}),
	),
	idleTimeoutMs: Type.Optional(
		Type.Number({
			description: "可选空闲心跳超时毫秒数（默认 reviewer 180000、其余 120000，工具执行中自动放宽至 ≥180000）",
			minimum: 15000,
			maximum: 600000,
		}),
	),
	maxRepeatToolErrors: Type.Optional(
		Type.Number({
			description: "StagnancyTracker 连续相同调用或连续工具错误早停阈值（默认 4）",
			minimum: 2,
			maximum: 10,
		}),
	),
	includeSkills: Type.Optional(
		Type.Boolean({
			description: "可选：是否在子进程中加载宿主技能列表（默认 false，传 -ns 节省上下文并避免误触发其他工作流）",
		}),
	),
});

export default function zeeExtension(pi: ExtensionAPI) {
	let mode: ZeeMode = "off";
	let gate: GateMode = "none";

	pi.registerFlag("zee-mode", {
		type: "string",
		description: "启动时启用 zee 自动路由模式：off | auto | strict",
	});

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const parts: string[] = [];
		if (mode !== "off") parts.push(`zee:${mode}`);
		if (gate === "plan") parts.push("plan🔒");
		else if (gate === "init-design") parts.push("init🔒");
		else if (gate === "review") parts.push("review🔒");
		ctx.ui.setStatus("zee-mode", parts.length > 0 ? parts.join("|") : undefined);
	};

	const setGate = (next: GateMode, ctx: ExtensionContext, persist = true) => {
		gate = next;
		if (persist) {
			pi.appendEntry<ZeeGateEntry>("zee-gate", { gate });
		}
		updateStatus(ctx);
	};

	const restoreState = (ctx: ExtensionContext) => {
		mode = "off";
		gate = "none";

		const flagVal = pi.getFlag("zee-mode");
		if (isValidMode(flagVal)) {
			mode = flagVal;
		}

		// 仅读取当前活动分支（getBranch），绝不读取 getEntries() 避免串分支污染
		const branch = ctx.sessionManager.getBranch();
		let foundMode = false;
		let foundGate = false;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "custom") continue;
			if (!foundMode && entry.customType === "zee-mode") {
				const data = entry.data as Partial<ZeeModeEntry> | undefined;
				if (isValidMode(data?.mode)) {
					mode = data.mode;
					foundMode = true;
				}
			} else if (!foundGate && entry.customType === "zee-gate") {
				const data = entry.data as Partial<ZeeGateEntry> | undefined;
				if (isValidGate(data?.gate)) {
					gate = data.gate;
					foundGate = true;
				}
			}
			if (foundMode && foundGate) break;
		}
		updateStatus(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreState(ctx);
	});

	// 修复跨回合掉锁漏洞：仅 review 为单轮锁；plan 与 init-design 跨回合保持，直到显式执行或 M0 落盘解锁
	pi.on("agent_settled", (_event, ctx) => {
		if (gate === "review") {
			setGate("none", ctx);
		} else if (gate === "init-design" && fs.existsSync(path.join(ctx.cwd, ".agents", "zee.project.json"))) {
			setGate("none", ctx);
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (event.messageType === "user") {
			const prompt = (event.prompt || "").trim();
			// 兼容直接调用原生 /skill:zee-*、/zee <subcmd> 空格子命令或显式解锁口令
			if (
				/<skill\s+name="zee-(?:plan|arch)"\b/.test(prompt) ||
				/^\/(?:skill:)?zee-(?:plan|arch)\b/i.test(prompt) ||
				/^\/(?:skill:)?zee\s+(?:plan|arch)\b/i.test(prompt)
			) {
				setGate("plan", ctx);
			} else if (
				/<skill\s+name="zee-review"\b/.test(prompt) ||
				/^\/(?:skill:)?zee-review\b/i.test(prompt) ||
				/^\/(?:skill:)?zee\s+review\b/i.test(prompt)
			) {
				setGate("review", ctx);
			} else if (
				/<skill\s+name="zee-init"\b/.test(prompt) ||
				/^\/(?:skill:)?zee-init\b/i.test(prompt) ||
				/^\/(?:skill:)?zee\s+init\b/i.test(prompt)
			) {
				const alreadyBootstrapped = fs.existsSync(path.join(ctx.cwd, ".agents", "zee.project.json"));
				setGate(alreadyBootstrapped ? "none" : "init-design", ctx);
			} else if (
				/<skill\s+name="zee(?:-(?:night|setup|retro))?"\b/.test(prompt) ||
				/^\/(?:skill:)?zee(?:-(?:night|setup|retro))?\b/i.test(prompt) ||
				/^(解锁|解除锁定|开始写代码|开始实现|执行计划)\b/.test(prompt)
			) {
				const subMatch = prompt.match(/^\/(?:skill:)?zee\s+(.+)$/i);
				const nextGate = subMatch ? inferGateFromZeeArgs(subMatch[1], ctx.cwd) : "none";
				if (gate !== nextGate) setGate(nextGate, ctx);
			} else if (gate === "init-design" && fs.existsSync(path.join(ctx.cwd, ".agents", "zee.project.json"))) {
				setGate("none", ctx);
			}
		}

		if (isSubagentContext(event, ctx)) {
			delete event.systemPromptOptions.sections.zee;
			return undefined;
		}

		if (mode === "off" && gate === "none") {
			delete event.systemPromptOptions.sections.zee;
			return undefined;
		}

		if (mode === "off" && gate !== "none") {
			const lockDesc =
				gate === "plan"
					? "## zee Active Write Lock (`plan`)\nProduction code writes/edits and mutating bash commands are blocked across turns until `/zee` execution starts. Write ONLY to `~/.local/state/zee/runs/`, `/tmp/zee-*`, `.scratch/`, `docs/plans/`, `docs/adr/`, or `GLOSSARY.md`."
					: gate === "init-design"
						? "## zee Active Write Lock (`init-design`)\n0→1 Stage 1–2 design freeze is active. Write ONLY to `~/.local/state/zee/runs/`, `/tmp/zee-*`, `.scratch/`, `.agents/`, `docs/adr/`, or `SPEC.md`/`ARCHITECTURE.md`/`GLOSSARY.md`/`DESIGN.md` until M0 unlocks."
						: "## zee Active Write Lock (`review`)\nRepository writes/edits and mutating bash commands are blocked by the runtime gate. Write ONLY to `~/.local/state/zee/runs/` or `/tmp/zee-*`.";
			event.systemPromptOptions.sections.zee = lockDesc;
			return undefined;
		}

		event.systemPromptOptions.sections.zee = buildZeeSection(mode as Exclude<ZeeMode, "off">, gate);
		return undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		// 若 Stage 3 M0 子代理已落盘 .agents/zee.project.json，实时解除 init-design 写锁
		if (gate === "init-design" && fs.existsSync(path.join(ctx.cwd, ".agents", "zee.project.json"))) {
			setGate("none", ctx);
		}

		// 1. 常驻安全红线（无论是否处于保护锁，均执行项目 denyCommands 与破坏性命令检查）
		if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
			const command = event.input.command;
			const denyReason = checkProjectDenyCommands(command, ctx.cwd);
			if (denyReason) {
				if (ctx.hasUI) ctx.ui.notify(denyReason, "warning");
				return { block: true, reason: denyReason };
			}
			const destructive = evaluateDestructiveCommand(command, ctx.cwd);
			if (destructive) {
				const reason = `[zee 安全护栏] ${destructive.reason}，已自动拦截。请由用户在终端亲自确认执行。`;
				if (ctx.hasUI) ctx.ui.notify(reason, "warning");
				return { block: true, reason };
			}
			if (gate !== "none") {
				const violation = sharedCheckBashUnderGate(command, ctx.cwd, gate);
				if (violation) {
					if (ctx.hasUI) ctx.ui.notify(violation, "warning");
					return { block: true, reason: violation };
				}
			}
			return undefined;
		}

		// 2. 保护锁下拦截 write/edit
		if (gate !== "none" && (isToolCallEventType("write", event) || isToolCallEventType("edit", event))) {
			const rawPath = event.input.path;
			if (!sharedIsWriteAllowedUnderGate(rawPath, ctx.cwd, gate)) {
				const allowedHint =
					gate === "plan"
						? "~/.local/state/zee/runs/、/tmp/zee-*、.scratch/、docs/plans/、docs/adr/ 或 GLOSSARY.md"
						: gate === "init-design"
							? "~/.local/state/zee/runs/、/tmp/zee-*、.scratch/、.agents/、docs/adr/ 或 SPEC/ARCHITECTURE/GLOSSARY/DESIGN.md"
							: "~/.local/state/zee/runs/ 或 /tmp/zee-*";
				const reason = `当前处于 zee-${gate} 保护锁，禁止修改 "${rawPath}"（仅允许写入 ${allowedHint}）。如需开始写代码，请调用 /zee 执行计划。`;
				if (ctx.hasUI) ctx.ui.notify(reason, "warning");
				return { block: true, reason };
			}
			// 写入 .agents/zee.project.json（兼容 @ 前缀）标志着 M0 启程，自动解除 init-design 锁
			if (gate === "init-design" && normalizeToolPath(rawPath, ctx.cwd) === path.resolve(ctx.cwd, ".agents", "zee.project.json")) {
				setGate("none", ctx);
			}
			return undefined;
		}

		return undefined;
	});

	// 1. /zee-mode 模式切换命令
	pi.registerCommand("zee-mode", {
		description: "切换 zee 自动路由模式：auto（智能路由）| strict（强制编排）| off（关闭）| status（查看）",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "auto", label: "auto — 智能自动路由（简单直答，复杂进 zee）" },
				{ value: "strict", label: "strict — 严格模式（所有工程改动强制走 zee）" },
				{ value: "off", label: "off — 关闭常驻自动路由" },
				{ value: "status", label: "status — 查看当前模式与保护锁状态" },
			];
			const trimmed = prefix.trim().toLowerCase();
			return trimmed ? items.filter((item) => item.value.startsWith(trimmed)) : items;
		},
		handler: async (args, ctx) => {
			const target = args.trim().toLowerCase();
			if (!target || target === "status") {
				const lockLabel =
					gate === "none"
						? "无"
						: gate === "plan"
							? "plan（跨回合锁定，仅限计划与总线写入）"
							: gate === "init-design"
								? "init-design（0→1 Stage 1–2 设计冻结锁）"
								: "review（只读）";
				if (ctx.hasUI) {
					ctx.ui.notify(
						`当前 zee-mode：${mode}｜保护锁：${lockLabel}（切换用法：/zee-mode auto | strict | off）`,
						"info",
					);
				}
				return;
			}

			if (!isValidMode(target)) {
				if (ctx.hasUI) {
					ctx.ui.notify(`无效模式 "${target}"，仅支持：/zee-mode auto | strict | off | status`, "warning");
				}
				return;
			}

			mode = target;
			pi.appendEntry<ZeeModeEntry>("zee-mode", { mode });
			if (mode === "off" && gate !== "none") {
				setGate("none", ctx);
			} else {
				updateStatus(ctx);
			}

			const descMap: Record<ZeeMode, string> = {
				off: "已关闭 zee 常驻自动路由（仍可随时通过 /zee、/zee-plan 等命令手动触发）",
				auto: "已开启 zee 自动路由模式（auto）：简单问题直接回答，复杂开发/排障/架构/UI 自动进入 zee 流水线",
				strict: "已开启 zee 严格编排模式（strict）：所有非问答工程任务均强制先走 zee Preflight、风险定级与门禁验收",
			};
			if (ctx.hasUI) ctx.ui.notify(descMap[mode], "info");
		},
	});

	// 2. 8 个短斜杠命令转发到对应 /skill:<name>
	const registerShortcut = (
		name: string,
		skillName: string,
		description: string,
		nextGate: GateMode | ((ctx: ExtensionContext, args: string) => GateMode),
		lockNotice?: string,
	) => {
		pi.registerCommand(name, {
			description,
			handler: async (args, ctx) => {
				const resolvedGate = typeof nextGate === "function" ? nextGate(ctx, args) : nextGate;
				setGate(resolvedGate, ctx);
				if (lockNotice && resolvedGate !== "none" && ctx.hasUI) {
					ctx.ui.notify(lockNotice, "info");
				}
				const trimmed = args.trim();
				const msg = trimmed ? `/skill:${skillName} ${trimmed}` : `/skill:${skillName}`;
				pi.sendUserMessage(msg, { expandPromptTemplates: true, deliverAs: "followUp" });
			},
		});
	};

	registerShortcut(
		"zee",
		"zee",
		"运行 zee 全自动多模型工程工作流（按风险自动定级，支持 /zee plan|review|init|arch 自动上锁与接棒 plan.md）",
		(ctx, args) => inferGateFromZeeArgs(args, ctx.cwd),
	);
	registerShortcut(
		"zee-plan",
		"zee-plan",
		"先 Grill 深度访谈与领域建模再沉淀计划文档（跨回合启用写保护锁，禁止修改业务代码）",
		"plan",
		"已启用 zee-plan 跨回合规划保护锁：仅允许写入计划文档、GLOSSARY/ADR 与运行总线，禁止修改业务代码（直到调用 /zee 执行）。",
	);
	registerShortcut(
		"zee-init",
		"zee-init",
		"项目 0→1 建项模式：从需求访谈到可运行且验收通过的 v1",
		(ctx) => (fs.existsSync(path.join(ctx.cwd, ".agents", "zee.project.json")) ? "none" : "init-design"),
		"已启用 zee-init Stage 1–2 设计保护锁：在 M0 写入 .agents/zee.project.json 前仅允许写设计文档与运行总线。",
	);
	registerShortcut(
		"zee-review",
		"zee-review",
		"只读跨家族三轴对抗审查（含未提交工作区，自动启用只读保护锁）",
		"review",
		"已启用 zee-review 只读审查锁：仅允许写入运行总线与 /tmp/zee-* 沙盒，禁止改动仓库文件。",
	);
	registerShortcut(
		"zee-arch",
		"zee-arch",
		"代码库深模块抗熵增巡检（只读扫描热点与浅模块，输出 HTML 报告，无缝衔接 /zee-plan）",
		"plan",
		"已启用 zee-arch 规划保护锁：仅允许输出架构报告与计划文档，禁止直接修改业务代码。",
	);
	registerShortcut(
		"zee-retro",
		"zee-retro",
		"会话复盘与 4 级结构化纠错飞轮（将重复错因固化进架构/Lint/Hook/测试）",
		"none",
	);
	registerShortcut(
		"zee-night",
		"zee-night",
		"无人值守过夜模式：独立分支、断点日志、预算熔断与中文晨报",
		"none",
	);
	registerShortcut(
		"zee-setup",
		"zee-setup",
		"配置 zee 模型槽位、执行当前 Pi 宿主全面体检并按需生成项目 verify-<app> 验证技能",
		"none",
	);

	// 3. 内置独立子代理工具 zee_subagent v2.1
	pi.registerTool({
		name: "zee_subagent",
		label: "zee 子代理 v2.1",
		description:
			"在独立隔离的 Pi 子进程中执行单个 zee 角色任务（-ne 挂载轻量 worker-guard.ts + ZEE_WORKER=1、流式正文优先抢救、并发工具双态看门狗、StagnancyTracker 循环早停、声明式原子 worktree 活锁、精准增量脏区回滚与 authorFamily 同家族硬拦截）。",
		promptSnippet:
			"Delegate an isolated zee role worker with explicit role, provider, model, thinkingLevel, atomic worktree, authorFamily, and least-privilege tools",
		executionMode: "parallel",
		parameters: ZeeSubagentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (process.env.ZEE_WORKER === "1") {
				throw new Error("禁止递归派发：当前进程已是 zee 子代理（ZEE_WORKER=1），请直接执行任务。");
			}
			if (params.provider && !params.model) {
				throw new Error("参数错误：指定 provider 时必须同时提供 model。");
			}
			if (
				params.provider &&
				/^(vm|devin|codex)$/i.test(params.provider.trim()) &&
				params.model &&
				!params.model.includes("/")
			) {
				throw new Error(
					`参数错误：provider="${params.provider}" 是模型路径前缀而非 Pi provider ID。请填写 ~/.agents/zee-config.json 的 bindings.pi.*.providerInstanceId 或 pi --list-models 第一列，并搭配完整 model（如 "<providerId>/${params.provider}/${params.model}"）。`,
				);
			}

			const role = (params.role?.trim() || "worker").toLowerCase();

			// 同家族 Reviewer 静态硬拦截（经 extractModelFamily 归一化 anthropic→claude 等别名）
			if (role === "reviewer" && params.authorFamily && params.model) {
				const authorFam = extractModelFamily(params.authorFamily);
				const reviewerFam = extractModelFamily(params.model);
				if (authorFam && reviewerFam && authorFam === reviewerFam) {
					throw new Error(
						`[zee_subagent:reviewer] 跨家族拦截：审查员模型 "${params.model}"（家族 ${reviewerFam}）与作者家族 "${authorFam}" 相同，禁止同源审查！请切换为其他家族审查员（如 gemini / openai / claude / devin）。`,
					);
				}
			}

			// 启动前先检查 abort，防止取消后仍创建 worktree 造成目录泄漏
			if (signal?.aborted) {
				throw new Error(`[zee_subagent:${role}] 启动前已被取消。`);
			}

			// 声明式原子 Worktree 托管（spawn 之前同步就绪并写入活锁，消灭并发竞态与 cleanup 误删）
			let createdWorktreePath: string | undefined;
			let activeLockPath: string | undefined;
			let effectiveCwd = path.resolve(ctx.cwd, params.cwd ?? ".");
			if (params.worktree) {
				createdWorktreePath = prepareAtomicWorktree(params.worktree);
				activeLockPath = writeWorktreeActiveLock(createdWorktreePath, role);
				effectiveCwd = createdWorktreePath;
			}
			if (!fs.existsSync(effectiveCwd)) {
				removeWorktreeActiveLock(activeLockPath);
				throw new Error(`工作目录不存在：${effectiveCwd}`);
			}

			const roleDefaultTimeout = ROLE_DEFAULT_TIMEOUT_MS[role] ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
			const timeoutMs = Math.min(
				MAX_SUBAGENT_TIMEOUT_MS,
				Math.max(5000, params.timeoutMs ?? roleDefaultTimeout),
			);
			const roleDefaultIdle = ROLE_DEFAULT_IDLE_TIMEOUT_MS[role] ?? DEFAULT_IDLE_TIMEOUT_MS;
			const idleTimeoutMs = Math.min(600_000, Math.max(15_000, params.idleTimeoutMs ?? roleDefaultIdle));
			const toolIdleTimeoutMs = Math.max(idleTimeoutMs, TOOL_EXEC_IDLE_TIMEOUT_MS);
			const maxRepeatErrors = Math.min(10, Math.max(2, params.maxRepeatToolErrors ?? DEFAULT_MAX_REPEAT_ERRORS));

			// 按角色硬收敛最小权限 --tools（防止 verifier/reviewer 拿到 edit 改脏源码）
			const effectiveTools = enforcePiRoleTools(role, params.tools);

			// 使用 -ne 屏蔽全局扩展，同时挂载仅含安全核的 worker-guard.ts，彻底消灭子进程安全真空
			const cliArgs: string[] = ["--mode", "json", "-p", "--no-session", "-ne"];
			if (fs.existsSync(WORKER_GUARD_PATH)) {
				cliArgs.push("-e", WORKER_GUARD_PATH);
			}
			cliArgs.push("--no-mcp");
			if (!params.includeSkills) {
				cliArgs.push("-ns");
			}
			if (params.model) {
				if (params.provider) cliArgs.push("--provider", params.provider);
				cliArgs.push("--model", params.model);
			}
			if (params.thinkingLevel) {
				cliArgs.push("--thinking", params.thinkingLevel);
			}
			if (effectiveTools && effectiveTools.length > 0) {
				cliArgs.push("--tools", effectiveTools.join(","));
			}

			const workerPrompt = containsWorkerSentinel(params.task)
				? params.task
				: `[zee-worker]\n${params.task}`;
			cliArgs.push("--", workerPrompt);

			// 只读/验证角色派发前快照工作区状态（含完整 HEAD），用于事后精准增量脏区审计
			const preSnapshot = READ_ONLY_AUDIT_ROLES.has(role) ? readGitSnapshot(effectiveCwd) : null;

			const startedAt = Date.now();
			const details: SubagentDetails = {
				role,
				provider: params.provider,
				model: params.model,
				thinkingLevel: params.thinkingLevel,
				tools: effectiveTools ?? undefined,
				cwd: effectiveCwd,
				worktreePath: createdWorktreePath,
				status: "running",
				exitCode: null,
				lastActions: [],
				usage: {
					turns: 0,
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					contextTokens: 0,
				},
			};

			let latestAssistantText = "";
			let streamingAssistantText = "";
			let stderrText = "";
			let timedOut = false;
			let idleTimedOut = false;
			let idleReasonDetail = "";
			let stagnancyTripped = false;
			let stagnancyDetail = "";
			let aborted = false;

			// StagnancyTracker 与并发工具 Map 心跳状态（修复单标量竞态缩看门狗漏洞）
			let lastToolSig = "";
			let repeatSigCount = 0;
			let consecutiveToolErrors = 0;
			let lastToolLabel = "init";
			let toolSeq = 0;
			const inFlightTools = new Map<string, { name: string; startedAt: number; benignSearch: boolean }>();
			let thinkingStreamStartedAt = 0;

			const getOldestInFlight = () => {
				let oldest: { name: string; startedAt: number; benignSearch: boolean } | null = null;
				for (const item of inFlightTools.values()) {
					if (!oldest || item.startedAt < oldest.startedAt) oldest = item;
				}
				return oldest;
			};

			const recordAction = (label: string) => {
				lastToolLabel = label;
				details.lastActions.push(label);
				if (details.lastActions.length > 5) details.lastActions.shift();
			};

			const emitProgress = () => {
				const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
				const modelLabel = details.model || params.model || "default";
				const oldest = getOldestInFlight();
				const inFlightPart = oldest
					? ` | inFlight=${oldest.name}${inFlightTools.size > 1 ? `+${inFlightTools.size - 1}` : ""}(${Math.round((Date.now() - oldest.startedAt) / 1000)}s)`
					: "";
				const streamPart = streamingAssistantText.length > 0 ? ` | streamChars=${streamingAssistantText.length}` : "";
				const header = `[zee_subagent:${role}] model=${modelLabel} | ${elapsedSec}s | turns=${details.usage.turns} | last=${lastToolLabel}${inFlightPart}${streamPart}`;
				const previewSource = streamingAssistantText.trim() || latestAssistantText.trim();
				const body = previewSource ? `\n${truncateSubagentOutput(previewSource.slice(0, 600))}` : "";
				onUpdate?.({
					content: [{ type: "text", text: `${header}${body}` }],
					details: { ...details, lastActions: [...details.lastActions], usage: { ...details.usage } },
				});
			};

			emitProgress();

			let outcome: {
				code: number | null;
				termSignal: NodeJS.Signals | null;
				spawnError?: Error;
			};

			try {
				outcome = await new Promise((resolve) => {
					const invocation = getPiInvocation(cliArgs);
					let settled = false;
					let exited = false;
					let closed = false;
					let buffer = "";
					let killTimer: ReturnType<typeof setTimeout> | undefined;
					let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
					let idleTimer: ReturnType<typeof setTimeout> | undefined;
					let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
					let proc: ReturnType<typeof spawn>;

					const resetIdleTimer = (customWindowMs?: number, reasonHint?: string) => {
						if (idleTimer) clearTimeout(idleTimer);
						const oldest = getOldestInFlight();
						const windowMs = customWindowMs ?? (oldest ? toolIdleTimeoutMs : idleTimeoutMs);
						idleTimer = setTimeout(() => {
							idleTimedOut = true;
							const curOldest = getOldestInFlight();
							idleReasonDetail =
								reasonHint ||
								(curOldest
									? `工具 ${curOldest.name} 执行超过 ${Math.round(windowMs / 1000)}s 无新事件`
									: `空闲看门狗超时（>${Math.round(windowMs / 1000)}s 无新事件）`);
							terminateChild();
						}, windowMs);
					};

					const finish = (result: {
						code: number | null;
						termSignal: NodeJS.Signals | null;
						spawnError?: Error;
					}) => {
						if (settled) return;
						settled = true;
						closed = true;
						if (killTimer) clearTimeout(killTimer);
						if (timeoutTimer) clearTimeout(timeoutTimer);
						if (idleTimer) clearTimeout(idleTimer);
						if (heartbeatTimer) clearInterval(heartbeatTimer);
						if (signal) signal.removeEventListener("abort", onAbort);
						resolve(result);
					};

					const terminateChild = () => {
						if (closed || exited || proc.exitCode !== null || proc.signalCode !== null) return;
						try {
							proc.kill("SIGTERM");
						} catch {
							return;
						}
						killTimer = setTimeout(() => {
							if (!closed && !exited) {
								try {
									proc.kill("SIGKILL");
								} catch {}
							}
						}, 5000);
					};

					const processLine = (line: string) => {
						if (!line.trim()) return;
						let evt: JsonAgentSessionEvent & Record<string, unknown>;
						try {
							evt = JSON.parse(line) as JsonAgentSessionEvent & Record<string, unknown>;
						} catch {
							return;
						}

						// 追踪工具执行事件以驱动并发 Map 看门狗与 StagnancyTracker
						if (evt.type === "tool_execution_start") {
							thinkingStreamStartedAt = 0;
							const tName = String(evt.toolName ?? "tool");
							const callKey = String(evt.toolCallId ?? `${tName}#${++toolSeq}`);
							const rawArgs = evt.args !== undefined ? JSON.stringify(evt.args) : "";
							const shortArg = rawArgs.length > 80 ? `${rawArgs.slice(0, 77)}...` : rawArgs;
							inFlightTools.set(callKey, {
								name: tName,
								startedAt: Date.now(),
								benignSearch: isBenignReadOnlySearchCommand(tName, evt.args),
							});
							recordAction(`${tName}(${shortArg})`);
							resetIdleTimer(toolIdleTimeoutMs);

							const sig = `${tName}:${crypto.createHash("sha1").update(rawArgs).digest("hex").slice(0, 12)}`;
							if (sig === lastToolSig) {
								repeatSigCount += 1;
							} else {
								lastToolSig = sig;
								repeatSigCount = 1;
							}
							emitProgress();

							if (repeatSigCount >= maxRepeatErrors) {
								stagnancyTripped = true;
								stagnancyDetail = `连续 ${repeatSigCount} 次重复相同调用 ${tName}(${shortArg})`;
								terminateChild();
							}
							return;
						}

						if (evt.type === "tool_execution_end") {
							const tName = String(evt.toolName ?? "tool");
							const isErr = Boolean(evt.isError);
							let finishedEntry: { name: string; startedAt: number; benignSearch: boolean } | undefined;
							if (evt.toolCallId !== undefined && inFlightTools.has(String(evt.toolCallId))) {
								const key = String(evt.toolCallId);
								finishedEntry = inFlightTools.get(key);
								inFlightTools.delete(key);
							} else {
								for (const [k, v] of inFlightTools.entries()) {
									if (v.name === tName) {
										finishedEntry = v;
										inFlightTools.delete(k);
										break;
									}
								}
							}
							resetIdleTimer(inFlightTools.size > 0 ? toolIdleTimeoutMs : idleTimeoutMs);

							if (isErr && !finishedEntry?.benignSearch) {
								consecutiveToolErrors += 1;
								recordAction(`${tName}:ERROR#${consecutiveToolErrors}`);
								if (consecutiveToolErrors >= maxRepeatErrors) {
									stagnancyTripped = true;
									stagnancyDetail = `连续 ${consecutiveToolErrors} 次工具调用报错（最近：${tName}）`;
									terminateChild();
								}
							} else {
								consecutiveToolErrors = 0;
							}
							emitProgress();
							return;
						}

						if (evt.type === "message_start") {
							const m = evt.message as { role?: string } | undefined;
							if (m?.role === "assistant") {
								streamingAssistantText = "";
								thinkingStreamStartedAt = 0;
							}
							resetIdleTimer();
							return;
						}

						// 监听 message_update 实时抢救流式正文，并对纯 thinking_delta 设独立上限防止看门狗被无限续命
						if (evt.type === "message_update") {
							const ame = evt.assistantMessageEvent as
								| { type?: string; delta?: string; content?: string }
								| undefined;
							if (ame?.type === "text_delta" && typeof ame.delta === "string") {
								thinkingStreamStartedAt = 0;
								streamingAssistantText += ame.delta;
								resetIdleTimer();
							} else if (ame?.type === "text_end" && typeof ame.content === "string" && ame.content.trim()) {
								thinkingStreamStartedAt = 0;
								streamingAssistantText = ame.content;
								resetIdleTimer();
							} else if (ame?.type === "thinking_delta" || ame?.type === "reasoning_delta") {
								if (!thinkingStreamStartedAt) thinkingStreamStartedAt = Date.now();
								const thinkingElapsed = Date.now() - thinkingStreamStartedAt;
								if (thinkingElapsed >= THINKING_STREAM_TIMEOUT_MS) {
									idleTimedOut = true;
									idleReasonDetail = `连续纯思考超过 ${Math.round(THINKING_STREAM_TIMEOUT_MS / 1000)}s 未产出正文或工具调用`;
									terminateChild();
								} else {
									resetIdleTimer(Math.min(idleTimeoutMs, THINKING_STREAM_TIMEOUT_MS - thinkingElapsed));
								}
							} else {
								resetIdleTimer();
							}
							return;
						}

						if (evt.type !== "message_end") {
							resetIdleTimer();
							return;
						}
						resetIdleTimer();
						const msg = evt.message as {
							role?: string;
							content?: unknown;
							model?: string;
							stopReason?: string;
							errorMessage?: string;
							usage?: {
								input?: number;
								output?: number;
								cacheRead?: number;
								cacheWrite?: number;
								totalTokens?: number;
								cost?: { total?: number };
							};
						};
						if (msg?.role !== "assistant") return;

						thinkingStreamStartedAt = 0;
						details.usage.turns += 1;
						if (msg.usage) {
							details.usage.input += msg.usage.input ?? 0;
							details.usage.output += msg.usage.output ?? 0;
							details.usage.cacheRead += msg.usage.cacheRead ?? 0;
							details.usage.cacheWrite += msg.usage.cacheWrite ?? 0;
							details.usage.cost += msg.usage.cost?.total ?? 0;
							details.usage.contextTokens = msg.usage.totalTokens ?? details.usage.contextTokens;
						}
						if (msg.model) details.model = msg.model;
						if (msg.stopReason) details.stopReason = msg.stopReason;
						if (msg.errorMessage) details.errorMessage = msg.errorMessage;

						const text = extractMessageText(msg.content).trim();
						if (text) latestAssistantText = text;
						streamingAssistantText = "";
						emitProgress();
					};

					const onAbort = () => {
						aborted = true;
						terminateChild();
					};

					try {
						proc = spawn(invocation.command, invocation.args, {
							cwd: effectiveCwd,
							shell: false,
							stdio: ["ignore", "pipe", "pipe"],
							env: {
								...process.env,
								ZEE_WORKER: "1",
								ZEE_ROLE: role,
							},
						});
					} catch (error) {
						finish({
							code: null,
							termSignal: null,
							spawnError: error instanceof Error ? error : new Error(String(error)),
						});
						return;
					}

					timeoutTimer = setTimeout(() => {
						timedOut = true;
						terminateChild();
					}, timeoutMs);
					resetIdleTimer(idleTimeoutMs);
					heartbeatTimer = setInterval(() => {
						if (!settled) emitProgress();
					}, HEARTBEAT_INTERVAL_MS);

					proc.stdout?.on("data", (chunk) => {
						buffer += chunk.toString();
						const lines = buffer.split("\n");
						buffer = lines.pop() ?? "";
						for (const line of lines) processLine(line);
					});

					proc.stderr?.on("data", (chunk) => {
						stderrText += chunk.toString();
					});

					proc.on("exit", () => {
						exited = true;
					});

					proc.on("close", (code, termSignal) => {
						if (buffer.trim()) processLine(buffer);
						finish({ code, termSignal });
					});

					proc.on("error", (error) => {
						finish({ code: null, termSignal: null, spawnError: error });
					});

					if (signal) {
						if (signal.aborted) onAbort();
						else signal.addEventListener("abort", onAbort, { once: true });
					}
				});
			} finally {
				removeWorktreeActiveLock(activeLockPath);
			}

			details.exitCode = outcome.code;

			// 精准增量脏区审计（仅撤销本次子代理新增的越权改动，绝不误杀用户原有未提交代码！）
			let violationBanner = "";
			const postSnapshot = readGitSnapshot(effectiveCwd);
			if (preSnapshot?.isGit && postSnapshot.isGit) {
				const preSet = new Set(preSnapshot.statusLines);
				const newDirty = postSnapshot.statusLines.filter((line) => !preSet.has(line));
				const headMoved = Boolean(preSnapshot.head && postSnapshot.head && preSnapshot.head !== postSnapshot.head);
				if (newDirty.length > 0 || headMoved) {
					details.roleViolation = true;
					const trackedToRestore = new Set<string>();
					const untrackedToRemove = new Set<string>();
					for (const line of newDirty) {
						const paths = parsePorcelainPaths(line);
						if (line.startsWith("?? ")) {
							for (const p of paths) untrackedToRemove.add(p);
						} else {
							for (const p of paths) trackedToRestore.add(p);
						}
					}

					try {
						if (trackedToRestore.size > 0) {
							const relList = [...trackedToRestore];
							// 先撤出暂存区（针对 git add）
							try {
								execFileSync("git", ["-C", effectiveCwd, "reset", "HEAD", "--", ...relList], { stdio: "ignore" });
							} catch {}
							// 仅逐文件恢复原本存在于 HEAD 中的跟踪路径，避免全局 git checkout -- . 误杀用户未提交修改
							for (const relFile of relList) {
								let inHead = false;
								try {
									execFileSync("git", ["-C", effectiveCwd, "cat-file", "-e", `HEAD:${relFile}`], { stdio: "ignore" });
									inHead = true;
								} catch {
									inHead = false;
								}
								if (inHead) {
									try {
										execFileSync("git", ["-C", effectiveCwd, "checkout", "HEAD", "--", relFile], { stdio: "ignore" });
									} catch {}
								} else {
									untrackedToRemove.add(relFile);
								}
							}
						}
						for (const relFile of untrackedToRemove) {
							const fullPath = path.resolve(effectiveCwd, relFile);
							if (fullPath.startsWith(path.resolve(effectiveCwd) + path.sep)) {
								fs.rmSync(fullPath, { recursive: true, force: true });
							}
						}
						// 若在 zee 专属隔离 detached worktree 中越权 commit，安全复位到原 HEAD
						if (headMoved && createdWorktreePath && !params.worktree?.branch) {
							try {
								execFileSync("git", ["-C", effectiveCwd, "reset", "--hard", preSnapshot.head], { stdio: "ignore" });
							} catch {}
						}
					} catch {}

					const detailsList = [
						...newDirty.slice(0, 5),
						...(headMoved ? [`HEAD_MOVED(${preSnapshot.head.slice(0, 8)}->${postSnapshot.head.slice(0, 8)})`] : []),
					];
					violationBanner = `\n[ROLE_VIOLATION] 只读/验收角色 (${role}) 试图修改仓库工作区或提交历史（${detailsList.join(", ")}），已精准回滚越权改动并标记违规！\n`;
				}
			}

			// 声明式 Worktree 自动清理（detached 默认清理，且仅在工作区干净时清理，绝不删 busDir 证据）
			if (createdWorktreePath && params.worktree) {
				const shouldCleanup = params.worktree.autoCleanup ?? !params.worktree.branch;
				const curSnap = readGitSnapshot(createdWorktreePath);
				if (shouldCleanup && (!curSnap.isGit || curSnap.statusLines.length === 0)) {
					try {
						execFileSync("git", ["-C", path.resolve(params.worktree.repoRoot), "worktree", "remove", "--force", createdWorktreePath], {
							stdio: "ignore",
						});
						details.worktreeCleaned = true;
					} catch {
						details.worktreeCleaned = false;
					}
				}
			}

			if (outcome.spawnError) {
				details.status = "failed";
				throw new Error(`[zee_subagent:${role}] 启动 Pi 子进程失败：${outcome.spawnError.message}`);
			}

			const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
			const shortHead = postSnapshot.head ? postSnapshot.head.slice(0, 8) : "none";
			const gitSummary = postSnapshot.isGit
				? `HEAD=${shortHead} dirty=${postSnapshot.statusLines.length}`
				: "non-git";
			const metaLine = `\n\n---\n[zee_subagent] role=${role} status=${details.status} model=${details.model ?? "default"} elapsed=${elapsedSec}s turns=${details.usage.turns} in=${details.usage.input} out=${details.usage.output} cost=$${details.usage.cost.toFixed(4)} ${gitSummary}${createdWorktreePath ? ` worktree=${createdWorktreePath}(cleaned=${Boolean(details.worktreeCleaned)})` : ""}`;

			// 中止 / 墙钟超时 / 空闲超时 / StagnancyTracker 早停：优先抢救当前轮流式正文，绝不丢弃已付费成果！
			if (aborted || timedOut || idleTimedOut || stagnancyTripped) {
				let tag = "ABORTED_PARTIAL";
				let reasonLine = "子代理已被外部中止";
				if (stagnancyTripped) {
					details.status = "stagnancy_loop";
					details.stopReason = "stagnancy_loop";
					tag = "STAGNANCY_LOOP_PARTIAL";
					reasonLine = `StagnancyTracker 循环熔断早停：${stagnancyDetail}`;
				} else if (idleTimedOut) {
					details.status = "idle_timeout";
					details.stopReason = "idle_timeout";
					tag = "IDLE_TIMEOUT_PARTIAL";
					reasonLine = idleReasonDetail || `空闲看门狗超时（>${Math.round(idleTimeoutMs / 1000)}s 无新事件）`;
				} else if (timedOut) {
					details.status = "timeout";
					details.stopReason = "timeout";
					tag = "TIMEOUT_PARTIAL";
					reasonLine = `墙钟超时（>${Math.round(timeoutMs / 1000)}s）`;
				} else {
					details.status = "aborted";
					details.stopReason = "aborted";
				}

				const streamTrimmed = streamingAssistantText.trim();
				const lastTrimmed = latestAssistantText.trim();
				const rescuedText = streamTrimmed || lastTrimmed;
				const rescuedLabel = streamTrimmed
					? "[已抢救的部分输出（流式未结正文）]"
					: "[已抢救的部分输出]";

				const partialParts = [
					`[STATUS: ${tag}] ${reasonLine}`,
					`[进度快照] elapsed=${elapsedSec}s | turns=${details.usage.turns} | cost=$${details.usage.cost.toFixed(4)} | ${gitSummary}`,
					details.lastActions.length > 0 ? `[最近动作] ${details.lastActions.join(" -> ")}` : "",
					violationBanner.trim(),
					rescuedText
						? `${rescuedLabel}\n${truncateSubagentOutput(rescuedText)}`
						: "[已抢救的部分输出] （中止前尚无最终文本输出）",
					stderrText.trim() ? `[stderr 摘要]\n${stderrText.trim().slice(0, 400)}` : "",
				].filter(Boolean);

				const updatedMeta = metaLine.replace("status=running", `status=${details.status}`);
				return {
					content: [{ type: "text", text: `${partialParts.join("\n\n")}${updatedMeta}` }],
					details,
				};
			}

			if (outcome.code !== 0 || details.stopReason === "error" || outcome.termSignal) {
				details.status = "failed";
				const reasonParts = [
					details.errorMessage,
					outcome.termSignal ? `信号 ${outcome.termSignal}` : "",
					outcome.code !== null && outcome.code !== 0 ? `退出码 ${outcome.code}` : "",
					stderrText.trim() ? `stderr: ${stderrText.trim().slice(0, 800)}` : "",
					latestAssistantText ? `最后输出: ${latestAssistantText.slice(0, 800)}` : "",
				].filter(Boolean);
				throw new Error(`[zee_subagent:${role}] 执行失败：${reasonParts.join(" | ") || "未知错误"}`);
			}

			details.status = "completed";
			const body = truncateSubagentOutput(latestAssistantText.trim() || streamingAssistantText.trim() || "(子代理未返回文本输出)");
			const finalMeta = metaLine.replace("status=running", "status=completed");
			return {
				content: [{ type: "text", text: `${violationBanner}${body}${finalMeta}` }],
				details,
			};
		},
	});
}
