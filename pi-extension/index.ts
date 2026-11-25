/**
 * zee Pi Extension v4.0.0 — 常驻自动路由 (/zee-mode)、短命令转发、跨回合路径锁、共享安全核与 zee_subagent v2
 *
 * 设计原则（严格对齐 Pi v1.6.0 源码 + v3.2/v4 实测优化）：
 * 1. 不写死任何第三方技能/扩展；所有领域技能由 Pi 原生 <available_skills> 自动发现。
 * 2. mode 与 gate 均通过 pi.appendEntry 持久化并仅从 ctx.sessionManager.getBranch() 逆序恢复，
 *    彻底修复 /zee-plan 第 2 轮 Grill 访谈掉锁与 /zee-init Stage 1–2 裸奔问题。
 * 3. 与 AGY 共用 skills/zee/scripts/lib/guard-core.mjs：无条件执行项目 denyCommands 与破坏性命令拦截，
 *    并在锁态下精准放行白名单目录上的 mkdir/cp/touch/tee 与 zee-tool.mjs。
 * 4. 四层防递归：默认 off + !ctx.hasUI + ZEE_WORKER=1 + [zee-worker] 首消息哨兵。
 * 5. zee_subagent v2：角色分级超时 + 120s 空闲看门狗 + StagnancyTracker 4 连错早停 + 超时/中止必返 PARTIAL_RECEIPT
 *    + 声明式原子 worktree 托管 + 按角色硬裁剪 --tools 与事后脏区审计 + authorFamily 同家族硬拦截。
 */

import { execFileSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
} from "../skills/zee/scripts/lib/guard-core.mjs";

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
		// 检查分支是否已存在：存在则直接检出该分支，否则从 baseRef 创建
		let branchExists = false;
		try {
			execFileSync("git", ["-C", absRepo, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
			branchExists = true;
		} catch {
			branchExists = false;
		}
		if (branchExists) {
			args.push(wtPath, branchName);
		} else {
			args.push("-b", branchName, wtPath, spec.baseRef);
		}
	} else {
		args.push("--detach", wtPath, spec.baseRef);
	}

	execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	return wtPath;
}

function readGitSnapshot(cwd: string): { isGit: boolean; head: string; statusLines: string[] } {
	try {
		const head = execFileSync("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const stRaw = execFileSync("git", ["-C", cwd, "status", "--porcelain"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return {
			isGit: true,
			head,
			statusLines: stRaw ? stRaw.split(/\r?\n/).filter(Boolean) : [],
		};
	} catch {
		return { isGit: false, head: "", statusLines: [] };
	}
}

function buildZeeSection(mode: Exclude<ZeeMode, "off">, gate: GateMode): string {
	const modeLine =
		mode === "strict"
			? "- Mode: **STRICT**. Every non-chat engineering task MUST start with zee Preflight (`zee-tool.mjs init-run` + risk leveling) before editing any repo file."
			: "- Mode: **AUTO**. Answer pure Q&A / quick lookups / trivial ≤1-file non-risk edits directly; route all non-trivial engineering tasks to `zee`.";

	const lines = [
		"## zee Auto-Routing Policy",
		modeLine,
		"- **Language**: All user-facing replies, questions, status updates, plans, and reports MUST be in Simplified Chinese (简体中文).",
		"- **Global Template Isolation**: Ignore repo-irrelevant global `~/CLAUDE.md` template rules (e.g., hardcoded `pnpm test` in non-JS repos or mandatory `CHANGELOG.md` edits on parallel feature branches); follow the actual repository stack and `.agents/zee.project.json`.",
		"- **Shared-File Single-Writer**: Parallel workers MUST NOT modify repo-wide shared index files (`CHANGELOG.md`, `README.md`, global test registries); only the Orchestrator or dedicated integration step updates them.",
		"- **Route by Intent** (read the matching skill's `SKILL.md` from `<available_skills>` before acting):",
		"  - Build / Bug Fix / Refactor / Multi-file change -> `zee` (Risk-routed L1/L2/L3 + Gate 1 `Verifier` PASS before Gate 2 cross-family `Reviewer` + 70% wall-clock cutoff)",
		"  - Requirements Interview & Plan Only (no prod code edits) -> `zee-plan`",
		"  - 0→1 New Project / Empty Repo -> `zee-init`",
		"  - Code / PR / Diff Review Only -> `zee-review`",
		"  - Overnight Autonomous Execution -> `zee-night`",
		"  - Model / Harness Configuration -> `zee-setup`",
		"- **Subagents & Skills**: Use `zee_subagent` with explicit `role`, `provider`, `model`, `thinkingLevel`, `worktree` (atomic out-of-tree isolation under `~/.local/state/zee/runs/.../worktrees/`), and `authorFamily` (when `role === 'reviewer'`) to prevent same-family collisions. Reuse host domain skills from `<available_skills>` via absolute `location` path (`references/interop.md`).",
	];

	if (gate === "plan") {
		lines.push(
			"- **ACTIVE WRITE LOCK (`plan`)**: Production code writes/edits and mutating bash commands are blocked across turns until `/zee` execution starts. Write ONLY to `~/.local/state/zee/runs/`, `.scratch/`, or `docs/plans/`.",
		);
	} else if (gate === "init-design") {
		lines.push(
			"- **ACTIVE WRITE LOCK (`init-design`)**: 0→1 Stage 1–2 design freeze is active. Write ONLY to `~/.local/state/zee/runs/`, `.scratch/`, `.agents/`, or root `SPEC.md`/`ARCHITECTURE.md`/`GLOSSARY.md`/`DESIGN.md` until Stage 3 M0 unlocks.",
		);
	} else if (gate === "review") {
		lines.push(
			"- **ACTIVE WRITE LOCK (`review`)**: Repository writes/edits and mutating bash commands are blocked by the runtime gate. Write ONLY to `~/.local/state/zee/runs/`.",
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
			description: "可选模型提供方 ID（如 vm / codex / devin / anthropic / openai；必须与 model 同时传入）",
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
			description: "可选空闲心跳超时毫秒数（默认 120000，无新流式事件即提前熔断）",
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
			// 兼容直接调用原生 /skill:zee-* 或显式解锁口令
			if (/<skill\s+name="zee-plan"\b/.test(prompt) || /^\/skill:zee-plan\b/.test(prompt)) {
				setGate("plan", ctx);
			} else if (/<skill\s+name="zee-review"\b/.test(prompt) || /^\/skill:zee-review\b/.test(prompt)) {
				setGate("review", ctx);
			} else if (/<skill\s+name="zee-init"\b/.test(prompt) || /^\/skill:zee-init\b/.test(prompt)) {
				const alreadyBootstrapped = fs.existsSync(path.join(ctx.cwd, ".agents", "zee.project.json"));
				setGate(alreadyBootstrapped ? "none" : "init-design", ctx);
			} else if (
				/<skill\s+name="zee(?:-(?:night|setup))?"\b/.test(prompt) ||
				/^\/skill:zee(?:-(?:night|setup))?\b/.test(prompt) ||
				/^(解锁|解除锁定|开始写代码|开始实现|执行计划)\b/.test(prompt)
			) {
				if (gate !== "none") setGate("none", ctx);
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
					? "## zee Active Write Lock (`plan`)\nProduction code writes/edits and mutating bash commands are blocked across turns until `/zee` execution starts. Write ONLY to `~/.local/state/zee/runs/`, `.scratch/`, or `docs/plans/`."
					: gate === "init-design"
						? "## zee Active Write Lock (`init-design`)\n0→1 Stage 1–2 design freeze is active. Write ONLY to `~/.local/state/zee/runs/`, `.scratch/`, `.agents/`, or root `SPEC.md`/`ARCHITECTURE.md`/`GLOSSARY.md`/`DESIGN.md` until M0 unlocks."
						: "## zee Active Write Lock (`review`)\nRepository writes/edits and mutating bash commands are blocked by the runtime gate. Write ONLY to `~/.local/state/zee/runs/`.";
			event.systemPromptOptions.sections.zee = lockDesc;
			return undefined;
		}

		event.systemPromptOptions.sections.zee = buildZeeSection(mode as Exclude<ZeeMode, "off">, gate);
		return undefined;
	});

	pi.on("tool_call", (event, ctx) => {
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
						? "~/.local/state/zee/runs/、.scratch/ 或 docs/plans/"
						: gate === "init-design"
							? "~/.local/state/zee/runs/、.scratch/、.agents/ 或 SPEC/ARCHITECTURE/DESIGN.md"
							: "~/.local/state/zee/runs/";
				const reason = `当前处于 zee-${gate} 保护锁，禁止修改 "${rawPath}"（仅允许写入 ${allowedHint}）。如需开始写代码，请调用 /zee 执行计划。`;
				if (ctx.hasUI) ctx.ui.notify(reason, "warning");
				return { block: true, reason };
			}
			// 写入 .agents/zee.project.json 标志着 M0 启程，自动解除 init-design 锁
			if (gate === "init-design" && path.resolve(ctx.cwd, rawPath) === path.join(ctx.cwd, ".agents", "zee.project.json")) {
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

	// 2. 6 个短斜杠命令转发到对应 /skill:<name>
	const registerShortcut = (
		name: string,
		skillName: string,
		description: string,
		nextGate: GateMode | ((ctx: ExtensionContext) => GateMode),
		lockNotice?: string,
	) => {
		pi.registerCommand(name, {
			description,
			handler: async (args, ctx) => {
				const resolvedGate = typeof nextGate === "function" ? nextGate(ctx) : nextGate;
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
		"运行 zee 全自动多模型工程工作流（按风险自动定级，支持接棒已确认的 plan.md）",
		"none",
	);
	registerShortcut(
		"zee-plan",
		"zee-plan",
		"先 Grill 深度访谈再沉淀计划文档（跨回合启用写保护锁，禁止修改业务代码）",
		"plan",
		"已启用 zee-plan 跨回合规划保护锁：仅允许写入计划文档与运行总线，禁止修改业务代码（直到调用 /zee 执行）。",
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
		"只读跨家族三轴对抗审查（自动启用只读保护锁，仅报告实证问题）",
		"review",
		"已启用 zee-review 只读审查锁：仅允许写入运行总线，禁止改动仓库文件。",
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
		"配置 zee 六大角色模型、思考强度与备胎，并执行当前 Pi 宿主全面体检",
		"none",
	);

	// 3. 内置独立子代理工具 zee_subagent v2
	pi.registerTool({
		name: "zee_subagent",
		label: "zee 子代理 v2",
		description:
			"在独立隔离的 Pi 子进程中执行单个 zee 角色任务（强制 -ne + ZEE_WORKER=1、按角色分级超时与硬最小权限裁剪、120s 空闲看门狗、StagnancyTracker 循环早停、超时/中止必返 PARTIAL_RECEIPT、支持声明式原子 worktree 托管与同家族 Reviewer 硬拦截）。",
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

			const role = (params.role?.trim() || "worker").toLowerCase();

			// 同家族 Reviewer 静态硬拦截
			if (role === "reviewer" && params.authorFamily && params.model) {
				const authorFam = params.authorFamily.trim().toLowerCase();
				const reviewerFam = extractModelFamily(params.model);
				if (authorFam && reviewerFam && authorFam === reviewerFam) {
					throw new Error(
						`[zee_subagent:reviewer] 跨家族拦截：审查员模型 "${params.model}"（家族 ${reviewerFam}）与作者家族 "${authorFam}" 相同，禁止同源审查！请切换为其他家族审查员（如 gemini / openai / claude / devin）。`,
					);
				}
			}

			// 声明式原子 Worktree 托管（spawn 之前同步就绪，消灭 0ms 并发竞态）
			let createdWorktreePath: string | undefined;
			let effectiveCwd = path.resolve(ctx.cwd, params.cwd ?? ".");
			if (params.worktree) {
				createdWorktreePath = prepareAtomicWorktree(params.worktree);
				effectiveCwd = createdWorktreePath;
			}
			if (!fs.existsSync(effectiveCwd)) {
				throw new Error(`工作目录不存在：${effectiveCwd}`);
			}

			const roleDefaultTimeout = ROLE_DEFAULT_TIMEOUT_MS[role] ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
			const timeoutMs = Math.min(
				MAX_SUBAGENT_TIMEOUT_MS,
				Math.max(5000, params.timeoutMs ?? roleDefaultTimeout),
			);
			const idleTimeoutMs = Math.min(600_000, Math.max(15_000, params.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS));
			const maxRepeatErrors = Math.min(10, Math.max(2, params.maxRepeatToolErrors ?? DEFAULT_MAX_REPEAT_ERRORS));

			// 按角色硬收敛最小权限 --tools（防止 verifier/reviewer 拿到 edit 改脏源码）
			const effectiveTools = enforcePiRoleTools(role, params.tools);

			const cliArgs: string[] = ["--mode", "json", "-p", "--no-session", "-ne", "--no-mcp"];
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

			// 只读/验证角色派发前快照工作区状态，用于事后越权脏区审计
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
			let stderrText = "";
			let timedOut = false;
			let idleTimedOut = false;
			let stagnancyTripped = false;
			let stagnancyDetail = "";
			let aborted = false;

			// StagnancyTracker 状态
			let lastToolSig = "";
			let repeatSigCount = 0;
			let consecutiveToolErrors = 0;
			let lastToolLabel = "init";

			const recordAction = (label: string) => {
				lastToolLabel = label;
				details.lastActions.push(label);
				if (details.lastActions.length > 5) details.lastActions.shift();
			};

			const emitProgress = () => {
				const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
				const modelLabel = details.model || params.model || "default";
				const header = `[zee_subagent:${role}] model=${modelLabel} | ${elapsedSec}s | turns=${details.usage.turns} | last=${lastToolLabel}`;
				const body = latestAssistantText ? `\n${truncateSubagentOutput(latestAssistantText.slice(0, 600))}` : "";
				onUpdate?.({
					content: [{ type: "text", text: `${header}${body}` }],
					details: { ...details, lastActions: [...details.lastActions], usage: { ...details.usage } },
				});
			};

			if (signal?.aborted) {
				throw new Error(`[zee_subagent:${role}] 启动前已被取消。`);
			}

			emitProgress();

			const outcome = await new Promise<{
				code: number | null;
				termSignal: NodeJS.Signals | null;
				spawnError?: Error;
			}>((resolve) => {
				const invocation = getPiInvocation(cliArgs);
				let settled = false;
				let exited = false;
				let closed = false;
				let buffer = "";
				let killTimer: ReturnType<typeof setTimeout> | undefined;
				let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
				let idleTimer: ReturnType<typeof setTimeout> | undefined;
				let proc: ReturnType<typeof spawn>;

				const resetIdleTimer = () => {
					if (idleTimer) clearTimeout(idleTimer);
					idleTimer = setTimeout(() => {
						idleTimedOut = true;
						terminateChild();
					}, idleTimeoutMs);
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
					resetIdleTimer();

					// 追踪工具执行事件以驱动实时进度与 StagnancyTracker
					if (evt.type === "tool_execution_start") {
						const tName = String(evt.toolName ?? "tool");
						const rawArgs = evt.args !== undefined ? JSON.stringify(evt.args) : "";
						const shortArg = rawArgs.length > 80 ? `${rawArgs.slice(0, 77)}...` : rawArgs;
						recordAction(`${tName}(${shortArg})`);

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
						if (isErr) {
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

					if (evt.type !== "message_end") return;
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
				resetIdleTimer();

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

			details.exitCode = outcome.code;

			// 事后越权脏区审计（堵死 -ne 子进程越权改业务码的漏洞）
			let violationBanner = "";
			const postSnapshot = readGitSnapshot(effectiveCwd);
			if (preSnapshot?.isGit && postSnapshot.isGit) {
				const preSet = new Set(preSnapshot.statusLines);
				const newDirty = postSnapshot.statusLines.filter((line) => !preSet.has(line));
				if (newDirty.length > 0) {
					details.roleViolation = true;
					try {
						execFileSync("git", ["-C", effectiveCwd, "checkout", "--", "."], { stdio: "ignore" });
						// 仅清理本次新增的未跟踪文件
						for (const line of newDirty) {
							if (line.startsWith("?? ")) {
								const relFile = line.slice(3).trim();
								const fullPath = path.resolve(effectiveCwd, relFile);
								if (fullPath.startsWith(path.resolve(effectiveCwd) + path.sep)) {
									fs.rmSync(fullPath, { recursive: true, force: true });
								}
							}
						}
					} catch {}
					violationBanner = `\n[ROLE_VIOLATION] 只读/验收角色 (${role}) 试图修改仓库工作区文件（${newDirty.slice(0, 5).join(", ")}），已自动回滚并标记违规！\n`;
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
			const gitSummary = postSnapshot.isGit
				? `HEAD=${postSnapshot.head || "none"} dirty=${postSnapshot.statusLines.length}`
				: "non-git";
			const metaLine = `\n\n---\n[zee_subagent] role=${role} status=${details.status} model=${details.model ?? "default"} elapsed=${elapsedSec}s turns=${details.usage.turns} in=${details.usage.input} out=${details.usage.output} cost=$${details.usage.cost.toFixed(4)} ${gitSummary}${createdWorktreePath ? ` worktree=${createdWorktreePath}(cleaned=${Boolean(details.worktreeCleaned)})` : ""}`;

			// 中止 / 墙钟超时 / 空闲超时 / StagnancyTracker 早停：绝不空壳抛错丢弃已付费成果，强制返回 PARTIAL_RECEIPT！
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
					reasonLine = `空闲看门狗超时（>${Math.round(idleTimeoutMs / 1000)}s 无新事件）`;
				} else if (timedOut) {
					details.status = "timeout";
					details.stopReason = "timeout";
					tag = "TIMEOUT_PARTIAL";
					reasonLine = `墙钟超时（>${Math.round(timeoutMs / 1000)}s）`;
				} else {
					details.status = "aborted";
					details.stopReason = "aborted";
				}

				const partialParts = [
					`[STATUS: ${tag}] ${reasonLine}`,
					`[进度快照] elapsed=${elapsedSec}s | turns=${details.usage.turns} | cost=$${details.usage.cost.toFixed(4)} | ${gitSummary}`,
					details.lastActions.length > 0 ? `[最近动作] ${details.lastActions.join(" -> ")}` : "",
					violationBanner.trim(),
					latestAssistantText
						? `[已抢救的部分输出]\n${truncateSubagentOutput(latestAssistantText)}`
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
			const body = truncateSubagentOutput(latestAssistantText || "(子代理未返回文本输出)");
			const finalMeta = metaLine.replace("status=running", "status=completed");
			return {
				content: [{ type: "text", text: `${violationBanner}${body}${finalMeta}` }],
				details,
			};
		},
	});
}
