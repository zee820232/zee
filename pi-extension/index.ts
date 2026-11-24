/**
 * zee Pi Extension — 常驻自动路由 (/zee-mode)、短命令转发、规划/审查路径锁与内置子代理工具
 *
 * 设计原则（严格对齐 Pi v1.6.0 源码）：
 * 1. 不写死任何第三方技能/扩展；所有领域技能由 Pi 原生 <available_skills> 自动发现。
 * 2. 状态通过 pi.appendEntry("zee-mode", { mode }) 持久化，并仅从 ctx.sessionManager.getBranch() 逆序恢复。
 * 3. 在 before_agent_start 中无条件写入 event.systemPromptOptions.sections.zee（避免 user/custom 补丁抖动）。
 * 4. 四层防递归：默认 off + !ctx.hasUI + ZEE_WORKER=1 + [zee-worker] 首消息哨兵。
 * 5. Plan / Review 防改锁采用 tool_call 路径白名单拦截（绝不使用 setActiveTools），agent_settled 自动解锁。
 * 6. 内置 zee_subagent 工具支持动态 provider/model/thinkingLevel/tools/cwd 与并行执行，子进程强制 -ne + ZEE_WORKER=1。
 */

import { spawn } from "node:child_process";
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

type ZeeMode = "off" | "auto" | "strict";
type GateMode = "none" | "plan" | "review";

interface ZeeModeEntry {
	mode: ZeeMode;
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
	status: "running" | "completed" | "failed" | "aborted" | "timeout";
	exitCode: number | null;
	stopReason?: string;
	errorMessage?: string;
	usage: SubagentUsage;
}

const VALID_MODES = new Set<ZeeMode>(["off", "auto", "strict"]);
const RUNS_ROOT = path.join(os.homedir(), ".local", "state", "zee", "runs");
const DEFAULT_SUBAGENT_TIMEOUT_MS = 300_000;
const MAX_SUBAGENT_TIMEOUT_MS = 1_800_000;
const WORKER_SENTINELS = [
	"[zee-worker]",
	"# zee Worker Standing Contract",
	"You are already running as a delegate",
];

function isValidMode(value: unknown): value is ZeeMode {
	return typeof value === "string" && VALID_MODES.has(value as ZeeMode);
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

function normalizeToolPath(rawPath: string, cwd: string): string {
	let cleaned = rawPath.trim();
	if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
	if (cleaned === "~") {
		cleaned = os.homedir();
	} else if (cleaned.startsWith("~/") || cleaned.startsWith("~\\")) {
		cleaned = path.join(os.homedir(), cleaned.slice(2));
	}
	return path.resolve(cwd, cleaned);
}

function isWithinDir(targetPath: string, parentDir: string): boolean {
	const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function isWriteAllowedUnderGate(rawPath: string, cwd: string, gateMode: Exclude<GateMode, "none">): boolean {
	const target = normalizeToolPath(rawPath, cwd);
	if (isWithinDir(target, RUNS_ROOT)) return true;
	if (gateMode === "plan") {
		if (isWithinDir(target, path.join(cwd, ".scratch"))) return true;
		if (isWithinDir(target, path.join(cwd, "docs", "plans"))) return true;
	}
	return false;
}

const BLOCKED_BASH_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
	{
		pattern:
			/\bgit\s+(add|commit|push|merge|rebase|cherry-pick|reset|checkout|switch|restore|clean|am|apply|stash\s+(push|pop|drop|apply)|branch\s+-[dDmM])\b/,
		label: "修改 Git 工作区或提交历史的命令",
	},
	{
		pattern: /(^|[;&|]\s*)(rm|mv|cp|chmod|chown|truncate|dd|mkfs|tee|patch)\b/,
		label: "文件增删改或重定向落盘命令",
	},
	{
		pattern: /\bsed\s+-[^\s]*i|\bperl\s+-[^\s]*i/,
		label: "原地修改文件命令 (sed -i / perl -i)",
	},
	{
		pattern: /\b(npm|pnpm|yarn|bun)\s+(install|i|add|remove|rm|uninstall|update|up|ci|publish)\b/,
		label: "包管理变更命令",
	},
	{
		pattern: /\b(pip|pip3|uv|poetry|cargo|brew)\s+(install|add|remove|uninstall|upgrade)\b|\bgo\s+(get|mod\s+tidy)\b/,
		label: "依赖安装或修改命令",
	},
];

export function checkBashUnderGate(command: string, gateMode: Exclude<GateMode, "none">): string | null {
	const trimmed = command.trim();
	if (!trimmed) return null;

	for (const { pattern, label } of BLOCKED_BASH_PATTERNS) {
		if (pattern.test(trimmed)) {
			return `当前处于 zee ${gateMode === "plan" ? "规划保护" : "只读审查"}模式，已拦截${label}。`;
		}
	}

	// 检测输出重定向（放行 /dev/null、>&2、以及写入 zee 运行总线或计划目录）
	const redirectRegex = /(?:^|[^0-9&>])>>?\s*(?!&\d)(\S+)/g;
	for (const match of trimmed.matchAll(redirectRegex)) {
		const target = match[1].replace(/^['"]|['"]$/g, "");
		if (target === "/dev/null") continue;
		const allowedTarget =
			target.includes(".local/state/zee/runs") ||
			(gateMode === "plan" && (target.startsWith(".scratch/") || target.startsWith("docs/plans/")));
		if (!allowedTarget) {
			return `当前处于 zee ${gateMode === "plan" ? "规划保护" : "只读审查"}模式，已拦截向 "${target}" 的 Shell 重定向写入。`;
		}
	}

	return null;
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
		"- **Route by Intent** (read the matching skill's `SKILL.md` from `<available_skills>` before acting):",
		"  - Build / Bug Fix / Refactor / Multi-file change -> `zee` (Risk-routed L1/L2/L3 + `Verifier` + cross-family `Reviewer`)",
		"  - Requirements Interview & Plan Only (no prod code edits) -> `zee-plan`",
		"  - 0→1 New Project / Empty Repo -> `zee-init`",
		"  - Code / PR / Diff Review Only -> `zee-review`",
		"  - Overnight Autonomous Execution -> `zee-night`",
		"  - Model / Harness Configuration -> `zee-setup`",
		"- **Subagents & Skills**: Use `zee_subagent` (passing explicit `provider`, `model`, `thinkingLevel`, and least-privilege `tools`) for isolated worker roles. Reuse matching domain skills from `<available_skills>` by passing their absolute `location` path in Worker Briefs (`references/interop.md`).",
	];

	if (gate === "plan") {
		lines.push(
			"- **ACTIVE WRITE LOCK (`plan`)**: Production code writes/edits and mutating bash commands are blocked by the runtime gate. Write ONLY to `~/.local/state/zee/runs/`, `.scratch/`, or `docs/plans/`.",
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
			description: "可选角色标识（如 scout / architect / ui / coder / verifier / reviewer），用于状态展示",
		}),
	),
	provider: Type.Optional(
		Type.String({
			description: "可选模型提供方 ID（如 anthropic / openai / magpie；必须与 model 同时传入）",
		}),
	),
	model: Type.Optional(
		Type.String({
			description: "可选目标模型 ID 或 provider/model 模式（建议显式指定，避免继承父会话模型）",
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
			description: "可选最小权限工具白名单，例如只读角色使用 ['read','grep','find','ls']",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "可选工作目录（如隔离 git worktree 路径，默认继承当前会话目录）",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "可选超时毫秒数（默认 300000，范围 5000–1800000）",
			minimum: 5000,
			maximum: MAX_SUBAGENT_TIMEOUT_MS,
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
		else if (gate === "review") parts.push("review🔒");
		ctx.ui.setStatus("zee-mode", parts.length > 0 ? parts.join("|") : undefined);
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
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "custom" && entry.customType === "zee-mode") {
				const data = entry.data as Partial<ZeeModeEntry> | undefined;
				if (isValidMode(data?.mode)) {
					mode = data.mode;
					break;
				}
			}
		}
		updateStatus(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (gate !== "none") {
			gate = "none";
			updateStatus(ctx);
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (event.messageType === "user") {
			const prompt = event.prompt || "";
			// 兼容直接调用原生 /skill:zee-plan 或 /skill:zee-review 时自动挂锁
			if (/<skill\s+name="zee-plan"\b/.test(prompt) || /^\/skill:zee-plan\b/.test(prompt.trim())) {
				gate = "plan";
				updateStatus(ctx);
			} else if (/<skill\s+name="zee-review"\b/.test(prompt) || /^\/skill:zee-review\b/.test(prompt.trim())) {
				gate = "review";
				updateStatus(ctx);
			} else if (
				/<skill\s+name="zee(?:-(?:init|night|setup))?"\b/.test(prompt) ||
				/^\/skill:zee(?:-(?:init|night|setup))?\b/.test(prompt.trim())
			) {
				if (gate !== "none") {
					gate = "none";
					updateStatus(ctx);
				}
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
			event.systemPromptOptions.sections.zee =
				gate === "plan"
					? "## zee Active Write Lock (`plan`)\nProduction code writes/edits and mutating bash commands are blocked by the runtime gate. Write ONLY to `~/.local/state/zee/runs/`, `.scratch/`, or `docs/plans/`."
					: "## zee Active Write Lock (`review`)\nRepository writes/edits and mutating bash commands are blocked by the runtime gate. Write ONLY to `~/.local/state/zee/runs/`.";
			return undefined;
		}

		// 无论 messageType 是 "user" 还是 "custom"，激活态每次必须写入 sections.zee，避免系统提示补丁抖动
		event.systemPromptOptions.sections.zee = buildZeeSection(mode as Exclude<ZeeMode, "off">, gate);
		return undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		if (gate === "none") return undefined;

		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const rawPath = event.input.path;
			if (!isWriteAllowedUnderGate(rawPath, ctx.cwd, gate)) {
				const allowedHint =
					gate === "plan"
						? "~/.local/state/zee/runs/、.scratch/ 或 docs/plans/"
						: "~/.local/state/zee/runs/";
				const reason = `当前处于 zee-${gate} 保护锁，禁止修改 "${rawPath}"（仅允许写入 ${allowedHint}）。如需开始写代码，请调用 /zee 执行计划。`;
				if (ctx.hasUI) ctx.ui.notify(reason, "warning");
				return { block: true, reason };
			}
			return undefined;
		}

		if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
			const command = event.input.command;
			const violation = checkBashUnderGate(command, gate);
			if (violation) {
				if (ctx.hasUI) ctx.ui.notify(violation, "warning");
				return { block: true, reason: violation };
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
				const lockLabel = gate === "none" ? "无" : gate === "plan" ? "plan（仅限计划与总线写入）" : "review（只读）";
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
			if (mode === "off") gate = "none";
			pi.appendEntry<ZeeModeEntry>("zee-mode", { mode });
			updateStatus(ctx);

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
		nextGate: GateMode,
		lockNotice?: string,
	) => {
		pi.registerCommand(name, {
			description,
			handler: async (args, ctx) => {
				gate = nextGate;
				updateStatus(ctx);
				if (lockNotice && ctx.hasUI) {
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
		"先 Grill 深度访谈再沉淀计划文档（自动启用写保护锁，禁止修改业务代码）",
		"plan",
		"已启用 zee-plan 规划保护锁：仅允许写入计划文档与运行总线，禁止修改业务代码。",
	);
	registerShortcut(
		"zee-init",
		"zee-init",
		"项目 0→1 建项模式：从需求访谈到可运行且验收通过的 v1",
		"none",
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
		"配置 zee 六大角色模型、思考强度与备胎，并审计当前 Pi 宿主冲突",
		"none",
	);

	// 3. 内置独立子代理工具 zee_subagent（支持动态模型/思考强度/最小工具集/并行执行）
	pi.registerTool({
		name: "zee_subagent",
		label: "zee 子代理",
		description:
			"在独立隔离的 Pi 子进程中执行单个 zee 角色任务（强制关闭扩展与递归保护，支持动态指定 provider/model/thinkingLevel/tools/cwd，支持同一回合内并行调用多个角色）。",
		promptSnippet: "Delegate an isolated zee role worker with explicit provider, model, thinkingLevel, tools, and cwd",
		executionMode: "parallel",
		parameters: ZeeSubagentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (process.env.ZEE_WORKER === "1") {
				throw new Error("禁止递归派发：当前进程已是 zee 子代理（ZEE_WORKER=1），请直接执行任务。");
			}
			if (params.provider && !params.model) {
				throw new Error("参数错误：指定 provider 时必须同时提供 model。");
			}

			const role = params.role?.trim() || "worker";
			const effectiveCwd = path.resolve(ctx.cwd, params.cwd ?? ".");
			if (!fs.existsSync(effectiveCwd)) {
				throw new Error(`工作目录不存在：${effectiveCwd}`);
			}

			const timeoutMs = Math.min(
				MAX_SUBAGENT_TIMEOUT_MS,
				Math.max(5000, params.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS),
			);

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
			if (params.tools && params.tools.length > 0) {
				cliArgs.push("--tools", params.tools.join(","));
			}

			const workerPrompt = containsWorkerSentinel(params.task)
				? params.task
				: `[zee-worker]\n${params.task}`;
			cliArgs.push("--", workerPrompt);

			const details: SubagentDetails = {
				role,
				provider: params.provider,
				model: params.model,
				thinkingLevel: params.thinkingLevel,
				tools: params.tools,
				cwd: effectiveCwd,
				status: "running",
				exitCode: null,
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
			let aborted = false;

			const emitProgress = () => {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: latestAssistantText
								? truncateSubagentOutput(latestAssistantText)
								: `[zee_subagent:${role}] 正在运行（turns=${details.usage.turns}）...`,
						},
					],
					details: { ...details, usage: { ...details.usage } },
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
				let proc: ReturnType<typeof spawn>;

				const processLine = (line: string) => {
					if (!line.trim()) return;
					let evt: JsonAgentSessionEvent;
					try {
						evt = JSON.parse(line) as JsonAgentSessionEvent;
					} catch {
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
							} catch {
								/* ignore */
							}
						}
					}, 5000);
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
						env: { ...process.env, ZEE_WORKER: "1" },
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

			if (aborted) {
				details.status = "aborted";
				throw new Error(`[zee_subagent:${role}] 子代理已中止。`);
			}
			if (timedOut) {
				details.status = "timeout";
				const extra = [
					details.model ? `model=${details.model}` : "",
					`turns=${details.usage.turns}`,
					stderrText.trim() ? `stderr=${stderrText.trim().slice(0, 400)}` : "",
				]
					.filter(Boolean)
					.join(", ");
				throw new Error(`[zee_subagent:${role}] 子代理执行超时（>${timeoutMs}ms${extra ? `；${extra}` : ""}）。`);
			}
			if (outcome.spawnError) {
				details.status = "failed";
				throw new Error(`[zee_subagent:${role}] 启动 Pi 子进程失败：${outcome.spawnError.message}`);
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
			const metaLine = `\n\n---\n[zee_subagent] role=${role} model=${details.model ?? "default"} turns=${details.usage.turns} in=${details.usage.input} out=${details.usage.output}`;
			return {
				content: [{ type: "text", text: `${body}${metaLine}` }],
				details,
			};
		},
	});
}
