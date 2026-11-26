/**
 * zee Pi Extension v5.0.0 — 极简个人主厨编排器 + zee_subagent 并行引擎
 *
 * 保留硬核能力：
 * 1. 7 个干净命令（/zee、/zee-plan、/zee-verify、/zee-review、/zee-night、/zee-retro、/zee-mode），无 /skill:zee* 重影
 * 2. 1 行状态栏徽章（setStatus("zee-mode")，绝不调用 setFooter()，静默支持 Print/JSON/ZEE_WORKER=1）
 * 3. 工具级安全守卫：项目 denyCommands + 破坏性命令 + plan/review 写路径锁（不拦截 Bash 只读操作）
 * 4. zee_subagent：-ne -e worker-guard.ts、429/5xx 跨会话熔断 0ms 切备免扣预算、10s 心跳、
 *    声明式原子 worktree + junction node_modules + 嵌套分支扁平化、>2KB 抢救落盘、70% 截断、只读事后脏区回滚
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
	checkProjectDenyCommands,
	enforcePiRoleTools,
	evaluateDestructiveCommand,
	extractModelFamily,
	isWriteAllowedUnderGate as sharedIsWriteAllowedUnderGate,
	normalizeToolPath,
} from "../skills/zee/scripts/lib/guard-core.mjs";
import {
	classifyTransientProviderFailure,
	clearModelCooldown,
	findHealthyPiFallback,
	getModelCooldown,
	makeModelHealthKey,
	recordModelCooldown,
} from "../skills/zee/scripts/lib/provider-health.mjs";
import { atomicWriteJson, withFileLock } from "../skills/zee/scripts/lib/fs-atomic.mjs";

export type ZeeMode = "off" | "auto" | "strict";
export type GateMode = "none" | "plan" | "review" | "init-design";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(EXTENSION_DIR, "..", "skills");
const ZEE_SKILL_DIR = path.join(SKILLS_ROOT, "zee");
const WORKER_GUARD_PATH = path.join(EXTENSION_DIR, "worker-guard.ts");

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
const ROLE_DEFAULT_IDLE_TIMEOUT_MS: Record<string, number> = { reviewer: 180_000 };
const TOOL_EXEC_IDLE_TIMEOUT_MS = 180_000;
const THINKING_STREAM_TIMEOUT_MS = 240_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_MAX_REPEAT_ERRORS = 4;
const READ_ONLY_AUDIT_ROLES = new Set(["scout", "architect", "judge", "verifier", "reviewer"]);
const MIN_ROLE_TIMEOUT_FLOOR_MS = 120_000;
const SAFE_TIMEOUT_ROLES = new Set(["scout", "verifier", "reviewer", "coder", "ui", "architect"]);

export function resolveEffectiveSubagentTimeout(role: string, requestedMs?: number): number {
	const r = String(role || "").trim().toLowerCase();
	const fallbackDefault = ROLE_DEFAULT_TIMEOUT_MS[r] ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
	let candidate = typeof requestedMs === "number" && Number.isFinite(requestedMs) ? requestedMs : fallbackDefault;
	if (process.env.ZEE_ALLOW_SHORT_TIMEOUT !== "1" && SAFE_TIMEOUT_ROLES.has(r)) {
		candidate = Math.max(MIN_ROLE_TIMEOUT_FLOOR_MS, candidate);
	}
	return Math.min(MAX_SUBAGENT_TIMEOUT_MS, Math.max(5000, candidate));
}
const WORKER_SENTINELS = ["[zee-worker]", "# zee Worker Standing Contract", "You are already running as a delegate"];

export function expandBundledZeeSkill(skillName: string, args = ""): string {
	const skillBaseDir = path.join(SKILLS_ROOT, skillName);
	const skillFilePath = path.join(skillBaseDir, "SKILL.md");
	const raw = fs.readFileSync(skillFilePath, "utf8");
	const body = raw.replace(/^(?:\ufeff)?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
	const zeeToolCli = path.join(ZEE_SKILL_DIR, "scripts", "zee-tool.mjs");
	const block = `<skill name="${skillName}" location="${skillFilePath}">\nReferences are relative to ${skillBaseDir}.\nZee Core Root: ${ZEE_SKILL_DIR}\nZee Tool CLI: node "${zeeToolCli}"\n\n${body}\n</skill>`;
	const trimmedArgs = String(args || "").trim();
	return trimmedArgs ? `${block}\n\n${trimmedArgs}` : block;
}

function containsWorkerSentinel(text: string): boolean {
	return Boolean(text && WORKER_SENTINELS.some((marker) => text.includes(marker)));
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: string; text: string } => Boolean(b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string"))
		.map((b) => b.text)
		.join("\n");
}

function isSubagentContext(event: BeforeAgentStartEvent, ctx: ExtensionContext): boolean {
	if (process.env.ZEE_WORKER === "1" || !ctx.hasUI) return true;
	if (event.messageType === "user" && containsWorkerSentinel(event.prompt)) return true;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message && entry.message.role === "user") {
			if (containsWorkerSentinel(extractMessageText(entry.message.content))) return true;
			break;
		}
	}
	return false;
}

function sameResolvedPath(a: string, b: string): boolean {
	const ra = path.resolve(a);
	const rb = path.resolve(b);
	return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

export function isWriteAllowedUnderGate(rawPath: string, cwd: string, gateMode: Exclude<GateMode, "none">): boolean {
	return sharedIsWriteAllowedUnderGate(rawPath, cwd, gateMode);
}

function sanitizeSlug(s: string): string {
	return String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "task";
}

function repoKeyFor(repoPath: string): string {
	const absRepo = path.resolve(repoPath);
	const hash = crypto.createHash("sha256").update(absRepo).digest("hex").slice(0, 8);
	return `${sanitizeSlug(path.basename(absRepo))}-${hash}`;
}

export function resolveSafeWorktreeBranch(absRepo: string, rawBranch: string): { branch: string; flattened: boolean } {
	let candidate = rawBranch.trim().replace(/^refs\/heads\//, "").replace(/^\/+|\/+$/g, "");
	let flattened = false;
	const refExists = (refName: string): boolean => {
		try { execFileSync("git", ["-C", absRepo, "show-ref", "--verify", "--quiet", refName], { stdio: "ignore" }); return true; }
		catch { return false; }
	};
	const hasChildRefs = (prefix: string): boolean => {
		try {
			return execFileSync("git", ["-C", absRepo, "for-each-ref", "--format=%(refname)", `refs/heads/${prefix}/`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
		} catch { return false; }
	};
	for (let guard = 0; guard < 8; guard++) {
		const parts = candidate.split("/").filter(Boolean);
		let collidedIdx = -1;
		for (let i = 1; i < parts.length; i++) {
			if (refExists(`refs/heads/${parts.slice(0, i).join("/")}`)) { collidedIdx = i; break; }
		}
		if (collidedIdx > 0) {
			const merged = `${parts[collidedIdx - 1]}-${parts[collidedIdx]}`;
			candidate = [...parts.slice(0, collidedIdx - 1), merged, ...parts.slice(collidedIdx + 1)].join("/");
			flattened = true;
			continue;
		}
		if (hasChildRefs(candidate)) { candidate = `${candidate}-wt`; flattened = true; continue; }
		break;
	}
	return { branch: candidate, flattened };
}

function ensureWorktreeExcludesNodeModules(absRepo: string, wtPath: string): boolean {
	const srcModules = path.join(absRepo, "node_modules");
	const dstModules = path.join(wtPath, "node_modules");
	if (!fs.existsSync(srcModules) || fs.existsSync(dstModules)) return false;
	try {
		if (execFileSync("git", ["-C", absRepo, "ls-files", "node_modules"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) return false;
		const excludePath = execFileSync("git", ["-C", wtPath, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		const resolvedExclude = path.resolve(wtPath, excludePath);
		fs.mkdirSync(path.dirname(resolvedExclude), { recursive: true });
		const existing = fs.existsSync(resolvedExclude) ? fs.readFileSync(resolvedExclude, "utf8") : "";
		if (!existing.split(/\r?\n/).some((l) => l.trim() === "/node_modules" || l.trim() === "node_modules")) {
			fs.appendFileSync(resolvedExclude, `${existing && !existing.endsWith("\n") ? "\n" : ""}/node_modules\n`, "utf8");
		}
		fs.symlinkSync(srcModules, dstModules, process.platform === "win32" ? "junction" : undefined);
		return true;
	} catch {
		return false;
	}
}

function collectPiBindingsFromConfig(
	configPath = process.env.ZEE_CONFIG_PATH?.trim() || path.join(os.homedir(), ".agents", "zee-config.json"),
): Array<{ providerInstanceId: string; model: string }> {
	if (!fs.existsSync(configPath)) return [];
	try {
		const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
		const out: Array<{ providerInstanceId: string; model: string }> = [];
		const seen = new Set<string>();
		const pushPair = (pRaw: unknown, mRaw: unknown) => {
			if (typeof pRaw !== "string" || typeof mRaw !== "string") return;
			const p = pRaw.trim();
			const m = mRaw.trim();
			if (!p || !m) return;
			const key = `${p}\0${m}`;
			if (!seen.has(key)) { seen.add(key); out.push({ providerInstanceId: p, model: m }); }
		};
		const walk = (node: unknown) => {
			if (!node || typeof node !== "object") return;
			if (Array.isArray(node)) { node.forEach(walk); return; }
			const obj = node as Record<string, unknown>;
			if (typeof obj.providerInstanceId === "string" && typeof obj.model === "string") {
				pushPair(obj.providerInstanceId, obj.model);
			}
			if (obj.bindings && typeof obj.bindings === "object") {
				const piBind = (obj.bindings as Record<string, unknown>).pi;
				if (piBind) walk(piBind);
			}
			for (const [k, val] of Object.entries(obj)) {
				if (k !== "bindings" && val && typeof val === "object") walk(val);
			}
		};
		if (cfg?.slots) walk(cfg.slots);
		if (cfg?.roles) walk(cfg.roles);
		return out;
	} catch {
		return [];
	}
}

export function resolvePiProviderModel(
	rawProvider?: string,
	rawModel?: string,
	configPath?: string,
): { provider?: string; model?: string; normalized: boolean; notice?: string } {
	const provider = rawProvider?.trim() || undefined;
	const model = rawModel?.trim() || undefined;
	if (!provider && !model) return { provider, model, normalized: false };

	const bindings = collectPiBindingsFromConfig(configPath);
	const knownProviders = new Set(bindings.map((b) => b.providerInstanceId.toLowerCase()));

	if (provider && model) {
		const joined = `${provider}/${model}`.toLowerCase();
		const exactJoined = bindings.find((b) => b.model.toLowerCase() === joined);
		if (exactJoined) {
			return {
				provider: exactJoined.providerInstanceId,
				model: exactJoined.model,
				normalized: true,
				notice: `已按 zee-config.json 自动归一 -> ${exactJoined.providerInstanceId}/${exactJoined.model}`,
			};
		}
		if (knownProviders.size > 0 && !knownProviders.has(provider.toLowerCase())) {
			const lowModel = model.toLowerCase();
			const byModel =
				bindings.find((b) => b.model.toLowerCase() === lowModel) ||
				bindings.find((b) => b.model.toLowerCase().endsWith(`/${provider.toLowerCase()}/${lowModel}`)) ||
				bindings.find((b) => b.model.toLowerCase().endsWith(`/${lowModel}`));
			if (byModel) {
				return {
					provider: byModel.providerInstanceId,
					model: byModel.model,
					normalized: true,
					notice: `已按 zee-config.json 自动纠偏 provider -> ${byModel.providerInstanceId}`,
				};
			}
		}
		if (/^(vm|devin|codex|remote-[a-z0-9_-]+)$/i.test(provider) && !knownProviders.has(provider.toLowerCase())) {
			const validHint = knownProviders.size > 0 ? `可用 providerInstanceId：${[...knownProviders].join(", ")}` : "请查看 pi --list-models 第一列";
			throw new Error(`参数错误：provider="${provider}" 不是有效的 Pi provider ID（${validHint}）。`);
		}
		return { provider, model, normalized: false };
	}

	if (!provider && model && bindings.length > 0) {
		const low = model.toLowerCase();
		const matches = bindings.filter((b) => b.model.toLowerCase() === low || b.model.toLowerCase().endsWith(`/${low}`));
		const uniquePairs = new Map(matches.map((b) => [`${b.providerInstanceId}\0${b.model}`, b]));
		if (uniquePairs.size === 1) {
			const only = [...uniquePairs.values()][0];
			return {
				provider: only.providerInstanceId,
				model: only.model,
				normalized: true,
				notice: `已按 zee-config.json 自动补全 -> ${only.providerInstanceId}/${only.model}`,
			};
		}
	}
	return { provider, model, normalized: false };
}

export function recordSubagentBudgetAndCutoff(
	busDir: string,
	isAborted: boolean,
	delegateId?: string,
): { dispatched: number; maxDelegates: number; cutoffAt: number; cutoffTriggered: boolean; deduplicated: boolean } | null {
	if (!busDir) return null;
	const statePath = path.join(busDir, "state.json");
	if (!fs.existsSync(statePath)) return null;
	try {
		return withFileLock(statePath, () => {
			if (!fs.existsSync(statePath)) return null;
			const st = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
			const countedIds = Array.isArray(st.countedDelegateIds)
				? st.countedDelegateIds.filter((x): x is string => typeof x === "string" && x.length > 0)
				: [];
			const cleanId = delegateId?.trim() || "";
			const alreadyCounted = Boolean(cleanId && countedIds.includes(cleanId));

			let dispatched = Number(st.delegatesDispatched) || 0;
			if (!alreadyCounted) {
				dispatched += 1;
				st.delegatesDispatched = dispatched;
				if (isAborted) st.abortedDelegates = (Number(st.abortedDelegates) || 0) + 1;
				if (cleanId) st.countedDelegateIds = [...countedIds, cleanId].slice(-200);
				st.updatedAt = new Date().toISOString();
				atomicWriteJson(statePath, st);
			}
			const budget = (st.budget && typeof st.budget === "object" ? st.budget : {}) as Record<string, unknown>;
			const maxDelegates = Math.max(1, Number(budget.maxDelegates ?? budget.maxSubagents) || (st.mode === "night" ? 12 : 40));
			const cutoffRatio = Math.min(0.95, Math.max(0.5, Number(budget.cutoffRatio) || 0.7));
			const cutoffAt = Math.max(1, Math.ceil(maxDelegates * cutoffRatio));
			return { dispatched, maxDelegates, cutoffAt, cutoffTriggered: dispatched >= cutoffAt, deduplicated: alreadyCounted };
		});
	} catch {
		return null;
	}
}

function persistPartialSalvage(busDir: string, role: string, rescuedText: string): string | undefined {
	if (!busDir || !rescuedText || rescuedText.length < 2048) return undefined;
	try {
		const artDir = path.join(busDir, "artifacts");
		fs.mkdirSync(artDir, { recursive: true });
		const filePath = path.join(artDir, `partial-${sanitizeSlug(role)}-${Date.now()}.md`);
		fs.writeFileSync(filePath, rescuedText + "\n", "utf8");
		return filePath;
	} catch {
		return undefined;
	}
}

function prepareAtomicWorktree(spec: { repoRoot: string; slug: string; lane: string; baseRef: string; branch?: string }) {
	const absRepo = path.resolve(spec.repoRoot);
	if (!fs.existsSync(absRepo)) throw new Error(`主仓库不存在：${absRepo}`);
	const wtRoot = path.join(RUNS_ROOT, repoKeyFor(absRepo), sanitizeSlug(spec.slug), "worktrees");
	const wtPath = path.join(wtRoot, sanitizeSlug(spec.lane));
	fs.mkdirSync(wtRoot, { recursive: true });

	if (fs.existsSync(wtPath)) {
		let dirty = "";
		try { dirty = execFileSync("git", ["-C", wtPath, "status", "--porcelain"], { encoding: "utf8" }).trim(); } catch {}
		if (dirty) throw new Error(`worktree 目录存在未提交改动，拒绝覆盖：${wtPath}`);
		try { execFileSync("git", ["-C", absRepo, "worktree", "remove", "--force", wtPath], { stdio: "ignore" }); }
		catch { fs.rmSync(wtPath, { recursive: true, force: true }); }
	}

	const gitArgs = ["-C", absRepo, "worktree", "add"];
	const rawBranch = spec.branch?.trim();
	const branch = rawBranch ? resolveSafeWorktreeBranch(absRepo, rawBranch).branch : undefined;
	if (branch) {
		let exists = false;
		try { execFileSync("git", ["-C", absRepo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { stdio: "ignore" }); exists = true; } catch {}
		if (exists) gitArgs.push(wtPath, branch);
		else gitArgs.push("-b", branch, wtPath, spec.baseRef);
	} else {
		gitArgs.push("--detach", wtPath, spec.baseRef);
	}
	execFileSync("git", gitArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const mountedNodeModules = ensureWorktreeExcludesNodeModules(absRepo, wtPath);
	return { wtPath, branch, mountedNodeModules };
}

function writeWorktreeActiveLock(wtPath: string, role: string): string {
	const lockPath = `${wtPath}.zee-lock.json`;
	try { fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, role, createdAt: new Date().toISOString() }) + "\n", "utf8"); } catch {}
	return lockPath;
}

function removeWorktreeActiveLock(lockPath: string | undefined): void {
	if (!lockPath) return;
	try { fs.rmSync(lockPath, { force: true }); } catch {}
}

function readGitSnapshot(cwd: string): { isGit: boolean; head: string; statusLines: string[] } {
	try {
		const head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		const statusRaw = execFileSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return { isGit: true, head, statusLines: statusRaw.split(/\r?\n/).filter((l) => l.trim().length > 0) };
	} catch {
		return { isGit: false, head: "", statusLines: [] };
	}
}

function parsePorcelainPaths(line: string): string[] {
	const body = line.length > 3 ? line.slice(3).trim() : "";
	if (!body) return [];
	const parts = body.includes(" -> ") ? body.split(" -> ") : [body];
	return parts.map((p) => p.replace(/^"|"$/g, "").trim()).filter(Boolean);
}

function inferGateFromZeeArgs(args: string): GateMode {
	const t = args.trim();
	if (/^plan\b/i.test(t)) return "plan";
	if (/^(?:review|verify\s+run)\b/i.test(t)) return "review";
	if (/^init\b/i.test(t)) return "init-design";
	return "none";
}

function isBenignReadOnlySearchCommand(toolName: string, rawArgsObj: unknown): boolean {
	if (toolName !== "bash" && toolName !== "powershell") return false;
	const cmd = rawArgsObj && typeof rawArgsObj === "object" && "command" in rawArgsObj ? String((rawArgsObj as { command?: unknown }).command ?? "").trim() : "";
	return /^(?:rg|grep|egrep|fgrep|diff)\b/.test(cmd);
}

function buildZeeSection(mode: Exclude<ZeeMode, "off">, gate: GateMode): string {
	const lines = [
		"## zee 个人主厨路由",
		mode === "strict"
			? `- Mode: **STRICT**（非闲聊工程任务须先加载 \`${ZEE_SKILL_DIR}/SKILL.md\`）`
			: `- Mode: **AUTO**（简单问答直答；非平凡开发/修 Bug/重构/过夜加载 \`${ZEE_SKILL_DIR}/SKILL.md\`）`,
		`- **Skills Root**: \`${SKILLS_ROOT}\`（7 个核心技能：\`zee\`, \`zee-plan\`, \`zee-verify\`, \`zee-review\`, \`zee-night\`, \`zee-retro\`, \`zee-setup\`）`,
		"- **Subagents**: 并发/隔离工作树派发统一调用 `zee_subagent`（传递 `role`, `provider`, `model`, `thinkingLevel`, `worktree`, `authorFamily`）。",
	];
	if (gate === "plan") lines.push("- **ACTIVE WRITE LOCK (`plan`)**: 禁止写业务源码，仅允许写计划文档/总线/沙盒。");
	else if (gate === "init-design") lines.push("- **ACTIVE WRITE LOCK (`init-design`)**: 0→1 设计期禁止写业务源码，直到写入 `.agents/zee.project.json` 解锁。");
	else if (gate === "review") lines.push("- **ACTIVE WRITE LOCK (`review`)**: 只读审查/验收期禁止修改仓库文件。");
	return lines.join("\n");
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const envBin = process.env.ZEE_PI_BIN?.trim();
	if (envBin) {
		if (/\.(?:mjs|cjs|js|ts)$/i.test(envBin)) return { command: process.execPath, args: [envBin, ...args] };
		return { command: envBin, args };
	}
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript !== undefined && (currentScript.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(currentScript));
	const looksLikePiScript = currentScript !== undefined && (currentScript.includes("pi-coding-agent") || path.basename(currentScript).replace(/\.[^.]+$/, "") === "pi");
	if (currentScript && !isBunVirtual && looksLikePiScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName) && execName.includes("pi")) return { command: process.execPath, args };
	return { command: "pi", args };
}

function truncateSubagentOutput(output: string): string {
	const initial = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!initial.truncated) return output;
	return `${initial.content}\n\n[输出已截断：省略 ${initial.totalBytes - initial.outputBytes} 字节，完整内容请通过总线文件传递]`;
}

const ZeeSubagentParams = Type.Object({
	task: Type.String({ description: "完整子代理任务提示词（建议以 [zee-worker] 和 worker.md 契约开头）" }),
	role: Type.Optional(Type.String({ description: "角色标识（scout / architect / ui / coder / verifier / reviewer / judge）" })),
	provider: Type.Optional(Type.String({ description: "模型提供方 ID（必须与 model 同传，切勿传路径前缀如 vm/devin/codex）" })),
	model: Type.Optional(Type.String({ description: "目标模型 ID 或 provider/model" })),
	authorFamily: Type.Optional(Type.String({ description: "当 role='reviewer' 时传入作者家族（claude/openai/gemini/deepseek 等），拦截同家族自审" })),
	thinkingLevel: Type.Optional(
		Type.Union(
			[Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")],
			{ description: "思考强度" },
		),
	),
	tools: Type.Optional(Type.Array(Type.String(), { description: "最小权限工具白名单（按 role 硬兜底裁剪）" })),
	cwd: Type.Optional(Type.String({ description: "可选工作目录" })),
	busDir: Type.Optional(Type.String({ description: "运行总线绝对路径（用于预算计数、70% 截断及 >2KB 抢救落盘）" })),
	worktree: Type.Optional(
		Type.Object({
			repoRoot: Type.String(),
			slug: Type.String(),
			lane: Type.String(),
			baseRef: Type.String(),
			branch: Type.Optional(Type.String()),
			autoCleanup: Type.Optional(Type.Boolean()),
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			minimum: 5000,
			maximum: MAX_SUBAGENT_TIMEOUT_MS,
			description: "墙钟超时(ms)；推荐省略以使用角色默认值（scout/judge 240s, verifier 300s, reviewer 480s, coder/ui/architect 600s），勿传低于 120000",
		}),
	),
	idleTimeoutMs: Type.Optional(Type.Number({ minimum: 15000, maximum: 600000 })),
	maxRepeatToolErrors: Type.Optional(Type.Number({ minimum: 2, maximum: 10 })),
	includeSkills: Type.Optional(Type.Boolean()),
	bypassCooldown: Type.Optional(Type.Boolean()),
});

interface SubagentDetails {
	role: string;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	tools?: string[];
	cwd: string;
	worktreePath?: string;
	branch?: string;
	worktreeCleaned?: boolean;
	mountedNodeModules?: boolean;
	partialArtifactPath?: string;
	budgetCutoffTriggered?: boolean;
	cooldownSwitchedFrom?: string;
	status: "running" | "completed" | "failed" | "aborted" | "timeout" | "idle_timeout" | "stagnancy_loop";
	exitCode: number | null;
	stopReason?: string;
	errorMessage?: string;
	roleViolation?: boolean;
	lastActions: string[];
	usage: { turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens: number };
}

export default function zeeExtension(pi: ExtensionAPI) {
	let routingMode: ZeeMode = (() => {
		const raw = String(pi.getFlag("zee-mode") ?? "").trim().toLowerCase();
		return raw === "auto" || raw === "strict" || raw === "off" ? raw : "off";
	})();
	let writeGate: GateMode = "none";

	const isSilentSession = (ctx: ExtensionContext): boolean => {
		if (process.env.ZEE_WORKER === "1" || !ctx.hasUI) return true;
		const m = (ctx as { mode?: unknown }).mode;
		return m === "print" || m === "json";
	};

	const updateStatusBar = (ctx: ExtensionContext) => {
		if (isSilentSession(ctx)) return;
		if (writeGate !== "none") {
			const lockTag = writeGate === "plan" ? "plan🔒" : writeGate === "init-design" ? "init🔒" : "rev🔒";
			ctx.ui.setStatus("zee-mode", `zee:${lockTag}`);
			return;
		}
		ctx.ui.setStatus("zee-mode", routingMode === "off" ? undefined : `zee:${routingMode}`);
	};

	const setMode = (next: ZeeMode, ctx: ExtensionContext, persist = true) => {
		routingMode = next;
		if (persist) pi.appendEntry("zee-mode", { mode: next });
		updateStatusBar(ctx);
	};

	const setGate = (next: GateMode, ctx: ExtensionContext, persist = true) => {
		writeGate = next;
		if (persist) pi.appendEntry("zee-gate", { gate: next });
		updateStatusBar(ctx);
	};

	const restoreState = (ctx: ExtensionContext) => {
		const flagMode = String(pi.getFlag("zee-mode") ?? "").trim().toLowerCase();
		let nextMode: ZeeMode = flagMode === "auto" || flagMode === "strict" || flagMode === "off" ? flagMode : "off";
		let nextGate: GateMode = "none";
		let foundMode = false;
		let foundGate = false;
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as { type?: string; customType?: string; data?: { mode?: unknown; gate?: unknown } };
			if (entry.type !== "custom" || !entry.data) continue;
			if (!foundMode && entry.customType === "zee-mode") {
				const m = String(entry.data.mode ?? "").toLowerCase();
				if (m === "off" || m === "auto" || m === "strict") { nextMode = m; foundMode = true; }
			}
			if (!foundGate && entry.customType === "zee-gate") {
				const g = String(entry.data.gate ?? "").toLowerCase();
				if (g === "none" || g === "plan" || g === "review" || g === "init-design") { nextGate = g; foundGate = true; }
			}
			if (foundMode && foundGate) break;
		}
		routingMode = nextMode;
		writeGate = nextGate;
		updateStatusBar(ctx);
	};

	pi.registerFlag("zee-mode", { type: "string", description: "启动时启用 zee 自动路由模式：off | auto | strict" });
	pi.on("session_start", (_e, ctx) => restoreState(ctx));
	pi.on("session_tree", (_e, ctx) => restoreState(ctx));
	pi.on("session_shutdown", (_e, ctx) => { if (!isSilentSession(ctx)) ctx.ui.setStatus("zee-mode", undefined); });

function findUnfinishedNightRun(cwd: string): { slug: string; resumeNext: string | null } | null {
	if (!cwd) return null;
	const repoRunDir = path.join(RUNS_ROOT, repoKeyFor(cwd));
	if (!fs.existsSync(repoRunDir)) return null;
	let latest: { slug: string; resumeNext: string | null; updatedAt: string; hasReport: boolean } | null = null;
	try {
		for (const ent of fs.readdirSync(repoRunDir, { withFileTypes: true })) {
			if (!ent.isDirectory()) continue;
			const runDir = path.join(repoRunDir, ent.name);
			const sp = path.join(runDir, "state.json");
			if (!fs.existsSync(sp)) continue;
			try {
				const st = JSON.parse(fs.readFileSync(sp, "utf8")) as { mode?: string; status?: string; slug?: string; resumeNext?: string | null; updatedAt?: string };
				if (st.mode !== "night" || st.status !== "running") continue;
				const updatedAt = String(st.updatedAt || "");
				if (!latest || updatedAt.localeCompare(latest.updatedAt) > 0) {
					latest = {
						slug: String(st.slug || ent.name),
						resumeNext: st.resumeNext ?? null,
						updatedAt,
						hasReport: fs.existsSync(path.join(runDir, "morning-report.md")),
					};
				}
			} catch {}
		}
	} catch {
		return null;
	}
	return latest && !latest.hasReport ? { slug: latest.slug, resumeNext: latest.resumeNext } : null;
}

	pi.on("agent_settled", (_e, ctx) => {
		if (writeGate === "review") setGate("none", ctx);
		else if (writeGate === "init-design" && fs.existsSync(path.join(ctx.cwd, ".agents", "zee.project.json"))) setGate("none", ctx);

		const unfinishedNight = findUnfinishedNightRun(ctx.cwd);
		if (unfinishedNight && writeGate === "none" && !isSilentSession(ctx)) {
			ctx.ui.setStatus("zee-mode", "zee:night⚠");
			ctx.ui.notify(
				`[zee-night] 过夜任务 (${unfinishedNight.slug}) 仍处于 running 且尚未输出 morning-report.md${unfinishedNight.resumeNext ? `（resumeNext=${unfinishedNight.resumeNext}）` : ""}，请收尾并生成晨报。`,
				"warning",
			);
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		const promptTrimmed = (event.prompt || "").trim();
		if (event.messageType === "user") {
			const skillMatch = promptTrimmed.match(/^<skill\s+name="(zee(?:-[a-z-]+)?)"(?=[\s>])[\s\S]*\n<\/skill>([\s\S]*)$/i);
			if (skillMatch) {
				const sName = skillMatch[1].toLowerCase();
				const skillArgs = (skillMatch[2] || "").trim();
				let nextGate: GateMode = "none";
				if (sName === "zee-plan") nextGate = "plan";
				else if (sName === "zee-review") nextGate = "review";
				else if (sName === "zee-verify") nextGate = /^run\b/i.test(skillArgs) ? "review" : "none";
				else if (sName === "zee") nextGate = inferGateFromZeeArgs(skillArgs);
				if (writeGate !== nextGate) setGate(nextGate, ctx);
			} else if (/^\/(?:skill:)?zee-plan\b/i.test(promptTrimmed) || /^\/(?:skill:)?zee\s+plan\b/i.test(promptTrimmed)) {
				setGate("plan", ctx);
			} else if (/^\/(?:skill:)?zee-review\b/i.test(promptTrimmed) || /^\/(?:skill:)?zee\s+review\b/i.test(promptTrimmed) || /^\/(?:skill:)?zee-verify\s+run\b/i.test(promptTrimmed)) {
				setGate("review", ctx);
			} else if (
				/^\/(?:skill:)?zee(?:-(?:night|retro|verify|setup))?\b/i.test(promptTrimmed) ||
				/^(解锁|解除锁定|开始写代码|开始实现|执行计划)\b/.test(promptTrimmed)
			) {
				const subMatch = promptTrimmed.match(/^\/(?:skill:)?zee\s+(.+)$/i);
				const nextGate = subMatch ? inferGateFromZeeArgs(subMatch[1]) : "none";
				if (writeGate !== nextGate) setGate(nextGate, ctx);
			} else if (writeGate === "init-design" && fs.existsSync(path.join(ctx.cwd, ".agents", "zee.project.json"))) {
				setGate("none", ctx);
			}
		}

		if (isSubagentContext(event, ctx)) {
			delete event.systemPromptOptions.sections.zee;
			return undefined;
		}
		if (routingMode === "off" && writeGate === "none") {
			delete event.systemPromptOptions.sections.zee;
			return undefined;
		}
		if (routingMode === "off" && writeGate !== "none") {
			event.systemPromptOptions.sections.zee =
				writeGate === "plan"
					? "## zee Write Lock (`plan`)\n禁止修改业务源码，仅允许写入计划文档、GLOSSARY/ADR、总线或 /tmp/zee-*。"
					: writeGate === "init-design"
						? "## zee Write Lock (`init-design`)\n0→1 设计期禁止写入业务源码，直到 M0 写出 .agents/zee.project.json 解锁。"
						: "## zee Write Lock (`review`)\n只读验收/审查期禁止修改仓库文件，仅允许写运行总线或 /tmp/zee-*。";
			return undefined;
		}
		event.systemPromptOptions.sections.zee = buildZeeSection(routingMode, writeGate);
		return undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		if (writeGate === "init-design" && fs.existsSync(path.join(ctx.cwd, ".agents", "zee.project.json"))) {
			setGate("none", ctx);
		}
		if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
			const command = event.input.command;
			const denyReason = checkProjectDenyCommands(command, ctx.cwd);
			if (denyReason) {
				if (!isSilentSession(ctx)) ctx.ui.notify(denyReason, "warning");
				return { block: true, reason: denyReason };
			}
			const destructive = evaluateDestructiveCommand(command, ctx.cwd);
			if (destructive) {
				const reason = `[zee 安全护栏] ${destructive.reason}，已自动拦截。请由用户在终端亲自确认执行。`;
				if (!isSilentSession(ctx)) ctx.ui.notify(reason, "warning");
				return { block: true, reason };
			}
			return undefined;
		}
		if (writeGate !== "none" && (isToolCallEventType("write", event) || isToolCallEventType("edit", event))) {
			const rawPath = event.input.path;
			if (!sharedIsWriteAllowedUnderGate(rawPath, ctx.cwd, writeGate)) {
				const reason = `当前处于 zee-${writeGate} 保护锁，禁止修改 "${rawPath}"。如需写代码请调用 /zee 执行计划。`;
				if (!isSilentSession(ctx)) ctx.ui.notify(reason, "warning");
				return { block: true, reason };
			}
			if (writeGate === "init-design" && sameResolvedPath(normalizeToolPath(rawPath, ctx.cwd), path.join(ctx.cwd, ".agents", "zee.project.json"))) {
				setGate("none", ctx);
			}
		}
		return undefined;
	});

	// 1. /zee-mode
	pi.registerCommand("zee-mode", {
		description: "切换 zee 自动路由模式：auto | strict | off | status",
		getArgumentCompletions: (prefix) =>
			[
				{ value: "auto", label: "auto — 智能路由（简单直答，复杂进 zee）" },
				{ value: "strict", label: "strict — 严格编排模式" },
				{ value: "off", label: "off — 关闭自动路由" },
				{ value: "status", label: "status — 查看当前状态" },
			].filter((i) => !prefix.trim() || i.value.startsWith(prefix.trim().toLowerCase())),
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!arg || arg === "status") {
				if (!isSilentSession(ctx)) ctx.ui.notify(`zee 当前模式：${routingMode} | 写保护锁：${writeGate}`, "info");
				return;
			}
			if (arg === "off" || arg === "auto" || arg === "strict") {
				setMode(arg, ctx);
				if (!isSilentSession(ctx)) ctx.ui.notify(`zee 模式已切换为：${arg}`, "info");
				return;
			}
			if (!isSilentSession(ctx)) ctx.ui.notify("用法：/zee-mode auto | strict | off | status", "warning");
		},
	});

	// 2. 6 个极简核心技能命令
	const registerSkillCmd = (
		name: string,
		description: string,
		nextGate: GateMode | ((args: string) => GateMode),
		completions?: Array<{ value: string; label: string }>,
	) => {
		pi.registerCommand(name, {
			description,
			...(completions
				? {
						getArgumentCompletions: (p: string) =>
							completions.filter((i) => !p.trim() || i.value.startsWith(p.trim().toLowerCase())),
					}
				: {}),
			handler: async (args, ctx) => {
				const gate = typeof nextGate === "function" ? nextGate(args) : nextGate;
				setGate(gate, ctx);
				pi.sendUserMessage(expandBundledZeeSkill(name, args), { expandPromptTemplates: false, deliverAs: "followUp" });
			},
		});
	};

	registerSkillCmd("zee", "个人主厨研发主入口（直做 / 标准 / 高危 + 专项 Playbook）", (args) => inferGateFromZeeArgs(args));
	registerSkillCmd("zee-plan", "先查代码再极简提问，产出可执行计划或 0→1 方案（带 plan 锁）", "plan");
	registerSkillCmd("zee-verify", "项目实机验证技能全生命周期：init / maintain / run", (args) => (/^run\b/i.test(args.trim()) ? "review" : "none"));
	registerSkillCmd("zee-review", "只读跨家族三轴实证审查（含防作弊与防泄密扫描）", "review", [
		{ value: "--strict", label: "--strict — 跨家族三轴对抗审查（默认）" },
		{ value: "--quick", label: "--quick — 轻量单轮快审" },
	]);
	registerSkillCmd("zee-night", "个人主厨无人值守过夜模式（本地隔离分支 + 3 分钟中文晨报）", "none");
	registerSkillCmd("zee-retro", "复盘并固化进环境（架构/Lint/测试/删死规则 + Bite Proof）", "none");
	registerSkillCmd("zee-setup", "探活可用模型并配置 fast / workhorse / adversary 三槽位（Schema v3）", "none");

	// 3. zee_subagent 工具
	pi.registerTool({
		name: "zee_subagent",
		label: "zee 子代理",
		description:
			"在隔离 Pi 子进程中执行单个 zee 角色任务（-ne -e worker-guard.ts + ZEE_WORKER=1、429/5xx 跨会话熔断 0ms 切备免扣预算、10s 心跳、原子 worktree + junction node_modules、>2KB 抢救、70% 截断与同家族审查硬拦截）。",
		promptSnippet: "Delegate an isolated zee worker with explicit role, provider, model, thinkingLevel, worktree, and authorFamily",
		executionMode: "parallel",
		parameters: ZeeSubagentParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (process.env.ZEE_WORKER === "1") throw new Error("禁止递归派发：当前进程已是 zee 子代理（ZEE_WORKER=1）。");
			if (params.provider && !params.model) throw new Error("参数错误：指定 provider 时必须同时提供 model。");

			const resolvedTarget = resolvePiProviderModel(params.provider, params.model);
			let effectiveProvider = resolvedTarget.provider;
			let effectiveModel = resolvedTarget.model;
			const role = (params.role?.trim() || "worker").toLowerCase();

			let cooldownNoticeBanner = "";
			let cooldownSwitchedFrom: string | undefined;
			if (!params.bypassCooldown && effectiveModel) {
				const cd = getModelCooldown(effectiveProvider, effectiveModel);
				if (cd.active) {
					const alt = findHealthyPiFallback({ role, failedProvider: effectiveProvider, failedModel: effectiveModel, authorFamily: params.authorFamily });
					if (alt) {
						cooldownSwitchedFrom = cd.key;
						cooldownNoticeBanner = `[zee_subagent] 命中 429/5xx 冷却（${cd.key}，余 ${cd.remainingSec}s），0ms 切备至 ${alt.provider}/${alt.model}。\n`;
						effectiveProvider = alt.provider;
						effectiveModel = alt.model;
					} else {
						throw new Error(`[zee_subagent:${role}] 目标通道 "${cd.key}" 处于 429/5xx 熔断冷却期（剩余 ${cd.remainingSec}s），暂无健康备胎（未扣预算）。`);
					}
				}
			}

			if (role === "reviewer" && params.authorFamily && effectiveModel) {
				const authorFam = extractModelFamily(params.authorFamily);
				const reviewerFam = extractModelFamily(effectiveModel);
				if (authorFam && reviewerFam && authorFam === reviewerFam) {
					throw new Error(`[zee_subagent:reviewer] 跨家族拦截：审查员 "${effectiveModel}" (${reviewerFam}) 与作者家族 "${authorFam}" 相同！`);
				}
			}
			if (signal?.aborted) throw new Error(`[zee_subagent:${role}] 启动前已被取消。`);

			let createdWorktreePath: string | undefined;
			let resolvedWorktreeBranch: string | undefined;
			let mountedNodeModules = false;
			let activeLockPath: string | undefined;
			let effectiveCwd = path.resolve(ctx.cwd, params.cwd ?? ".");
			const effectiveBusDir =
				params.busDir?.trim() ||
				(params.worktree ? path.join(RUNS_ROOT, repoKeyFor(params.worktree.repoRoot), sanitizeSlug(params.worktree.slug)) : "");

			if (params.worktree) {
				const wtInfo = prepareAtomicWorktree(params.worktree);
				createdWorktreePath = wtInfo.wtPath;
				resolvedWorktreeBranch = wtInfo.branch;
				mountedNodeModules = wtInfo.mountedNodeModules;
				activeLockPath = writeWorktreeActiveLock(createdWorktreePath, role);
				effectiveCwd = createdWorktreePath;
			}
			if (!fs.existsSync(effectiveCwd)) {
				removeWorktreeActiveLock(activeLockPath);
				throw new Error(`工作目录不存在：${effectiveCwd}`);
			}

			const timeoutMs = resolveEffectiveSubagentTimeout(role, params.timeoutMs);
			const idleTimeoutMs = Math.min(600_000, Math.max(15_000, params.idleTimeoutMs ?? (ROLE_DEFAULT_IDLE_TIMEOUT_MS[role] ?? DEFAULT_IDLE_TIMEOUT_MS)));
			const toolIdleTimeoutMs = Math.max(idleTimeoutMs, TOOL_EXEC_IDLE_TIMEOUT_MS);
			const maxRepeatErrors = Math.min(10, Math.max(2, params.maxRepeatToolErrors ?? DEFAULT_MAX_REPEAT_ERRORS));
			const effectiveTools = enforcePiRoleTools(role, params.tools);

			const cliArgs: string[] = ["--mode", "json", "-p", "--no-session", "-ne"];
			if (fs.existsSync(WORKER_GUARD_PATH)) cliArgs.push("-e", WORKER_GUARD_PATH);
			cliArgs.push("--no-mcp");
			if (!params.includeSkills) cliArgs.push("-ns");
			if (effectiveModel) {
				if (effectiveProvider) cliArgs.push("--provider", effectiveProvider);
				cliArgs.push("--model", effectiveModel);
			}
			if (params.thinkingLevel) cliArgs.push("--thinking", params.thinkingLevel);
			if (effectiveTools?.length) cliArgs.push("--tools", effectiveTools.join(","));
			cliArgs.push("--", containsWorkerSentinel(params.task) ? params.task : `[zee-worker]\n${params.task}`);

			const preSnapshot = READ_ONLY_AUDIT_ROLES.has(role) ? readGitSnapshot(effectiveCwd) : null;
			const startedAt = Date.now();
			const details: SubagentDetails = {
				role,
				provider: effectiveProvider,
				model: effectiveModel,
				thinkingLevel: params.thinkingLevel,
				tools: effectiveTools ?? undefined,
				cwd: effectiveCwd,
				worktreePath: createdWorktreePath,
				branch: resolvedWorktreeBranch,
				mountedNodeModules,
				...(cooldownSwitchedFrom ? { cooldownSwitchedFrom } : {}),
				status: "running",
				exitCode: null,
				lastActions: [],
				usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
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
			let lastToolSig = "";
			let repeatSigCount = 0;
			let consecutiveToolErrors = 0;
			let lastToolLabel = "init";
			let toolSeq = 0;
			const inFlightTools = new Map<string, { name: string; startedAt: number; benignSearch: boolean }>();
			let thinkingStreamStartedAt = 0;

			const getOldestInFlight = () => {
				let oldest: { name: string; startedAt: number; benignSearch: boolean } | null = null;
				for (const item of inFlightTools.values()) if (!oldest || item.startedAt < oldest.startedAt) oldest = item;
				return oldest;
			};
			const recordAction = (label: string) => {
				lastToolLabel = label;
				details.lastActions.push(label);
				if (details.lastActions.length > 5) details.lastActions.shift();
			};
			const emitProgress = () => {
				const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
				const oldest = getOldestInFlight();
				const inFlightPart = oldest
					? ` | inFlight=${oldest.name}(${Math.round((Date.now() - oldest.startedAt) / 1000)}s)`
					: thinkingStreamStartedAt > 0 ? ` | thinking=${Math.round((Date.now() - thinkingStreamStartedAt) / 1000)}s` : "";
				const header = `[zee_subagent:${role}] model=${details.model || params.model || "default"} | ${elapsedSec}s | turns=${details.usage.turns} | cost=$${details.usage.cost.toFixed(4)} | last=${lastToolLabel}${inFlightPart}`;
				const preview = streamingAssistantText.trim() || latestAssistantText.trim();
				onUpdate?.({
					content: [{ type: "text", text: preview ? `${header}\n${truncateSubagentOutput(preview.slice(0, 600))}` : header }],
					details: { ...details, lastActions: [...details.lastActions], usage: { ...details.usage } },
				});
			};

			emitProgress();
			let outcome: { code: number | null; termSignal: NodeJS.Signals | null; spawnError?: Error };
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

					const resetIdleTimer = (customWindowMs?: number) => {
						if (idleTimer) clearTimeout(idleTimer);
						const oldest = getOldestInFlight();
						const windowMs = customWindowMs ?? (oldest ? toolIdleTimeoutMs : idleTimeoutMs);
						idleTimer = setTimeout(() => {
							idleTimedOut = true;
							const curOldest = getOldestInFlight();
							idleReasonDetail = curOldest
								? `工具 ${curOldest.name} 执行超过 ${Math.round(windowMs / 1000)}s 无新事件`
								: `空闲看门狗超时（>${Math.round(windowMs / 1000)}s 无新事件）`;
							terminateChild();
						}, windowMs);
					};

					const finish = (result: { code: number | null; termSignal: NodeJS.Signals | null; spawnError?: Error }) => {
						if (settled) return;
						settled = true; closed = true;
						if (killTimer) clearTimeout(killTimer);
						if (timeoutTimer) clearTimeout(timeoutTimer);
						if (idleTimer) clearTimeout(idleTimer);
						if (heartbeatTimer) clearInterval(heartbeatTimer);
						if (signal) signal.removeEventListener("abort", onAbort);
						resolve(result);
					};

					const terminateChild = () => {
						if (closed || exited || proc.exitCode !== null || proc.signalCode !== null) return;
						try { proc.kill("SIGTERM"); } catch { return; }
						killTimer = setTimeout(() => { if (!closed && !exited) { try { proc.kill("SIGKILL"); } catch {} } }, 5000);
					};

					const processLine = (line: string) => {
						if (!line.trim()) return;
						let evt: JsonAgentSessionEvent & Record<string, unknown>;
						try { evt = JSON.parse(line) as JsonAgentSessionEvent & Record<string, unknown>; } catch { return; }

						if (evt.type === "tool_execution_start") {
							thinkingStreamStartedAt = 0;
							const tName = String(evt.toolName ?? "tool");
							const callKey = String(evt.toolCallId ?? `${tName}#${++toolSeq}`);
							const rawArgs = evt.args !== undefined ? JSON.stringify(evt.args) : "";
							const shortArg = rawArgs.length > 80 ? `${rawArgs.slice(0, 77)}...` : rawArgs;
							inFlightTools.set(callKey, { name: tName, startedAt: Date.now(), benignSearch: isBenignReadOnlySearchCommand(tName, evt.args) });
							recordAction(`${tName}(${shortArg})`);
							resetIdleTimer(toolIdleTimeoutMs);
							const sig = `${tName}:${crypto.createHash("sha1").update(rawArgs).digest("hex").slice(0, 12)}`;
							repeatSigCount = sig === lastToolSig ? repeatSigCount + 1 : 1;
							lastToolSig = sig;
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
							let finishedEntry: { name: string; startedAt: number; benignSearch: boolean } | undefined;
							if (evt.toolCallId !== undefined && inFlightTools.has(String(evt.toolCallId))) {
								finishedEntry = inFlightTools.get(String(evt.toolCallId));
								inFlightTools.delete(String(evt.toolCallId));
							} else {
								for (const [k, v] of inFlightTools.entries()) {
									if (v.name === tName) { finishedEntry = v; inFlightTools.delete(k); break; }
								}
							}
							resetIdleTimer(inFlightTools.size > 0 ? toolIdleTimeoutMs : idleTimeoutMs);
							if (Boolean(evt.isError) && !finishedEntry?.benignSearch) {
								consecutiveToolErrors += 1;
								recordAction(`${tName}:ERROR#${consecutiveToolErrors}`);
								if (consecutiveToolErrors >= maxRepeatErrors) {
									stagnancyTripped = true;
									stagnancyDetail = `连续 ${consecutiveToolErrors} 次工具调用报错（最近：${tName}）`;
									terminateChild();
								}
							} else consecutiveToolErrors = 0;
							emitProgress();
							return;
						}

						if (evt.type === "message_start") {
							if ((evt.message as { role?: string } | undefined)?.role === "assistant") {
								streamingAssistantText = "";
								thinkingStreamStartedAt = 0;
							}
							resetIdleTimer();
							return;
						}

						if (evt.type === "message_update") {
							const ame = evt.assistantMessageEvent as { type?: string; delta?: string; content?: string } | undefined;
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
								const elapsed = Date.now() - thinkingStreamStartedAt;
								if (elapsed >= THINKING_STREAM_TIMEOUT_MS) {
									idleTimedOut = true;
									idleReasonDetail = `连续纯思考超过 ${Math.round(THINKING_STREAM_TIMEOUT_MS / 1000)}s 未产出正文或工具调用`;
									terminateChild();
								} else resetIdleTimer(Math.min(idleTimeoutMs, THINKING_STREAM_TIMEOUT_MS - elapsed));
							} else resetIdleTimer();
							return;
						}

						if (evt.type !== "message_end") { resetIdleTimer(); return; }
						resetIdleTimer();
						const msg = evt.message as {
							role?: string; content?: unknown; model?: string; stopReason?: string; errorMessage?: string;
							usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } };
						};
						if (msg?.role !== "assistant") return;

						thinkingStreamStartedAt = 0;
						const text = extractMessageText(msg.content).trim();
						const msgOutTokens = msg.usage?.output ?? 0;
						if (!(msg.stopReason === "error" && !text && msgOutTokens === 0 && details.lastActions.length === 0)) {
							details.usage.turns += 1;
						}
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
						if (text) latestAssistantText = text;
						streamingAssistantText = "";
						emitProgress();
					};

					const onAbort = () => { aborted = true; terminateChild(); };

					try {
						proc = spawn(invocation.command, invocation.args, {
							cwd: effectiveCwd,
							shell: false,
							stdio: ["ignore", "pipe", "pipe"],
							env: { ...process.env, ZEE_WORKER: "1", ZEE_ROLE: role, ...(effectiveBusDir ? { ZEE_BUS_DIR: effectiveBusDir } : {}) },
						});
					} catch (error) {
						finish({ code: null, termSignal: null, spawnError: error instanceof Error ? error : new Error(String(error)) });
						return;
					}

					timeoutTimer = setTimeout(() => { timedOut = true; terminateChild(); }, timeoutMs);
					resetIdleTimer(idleTimeoutMs);
					heartbeatTimer = setInterval(() => { if (!settled) emitProgress(); }, HEARTBEAT_INTERVAL_MS);
					proc.stdout?.on("data", (chunk) => {
						buffer += chunk.toString();
						const lines = buffer.split("\n");
						buffer = lines.pop() ?? "";
						for (const line of lines) processLine(line);
					});
					proc.stderr?.on("data", (chunk) => { stderrText += chunk.toString(); });
					proc.on("exit", () => { exited = true; });
					proc.on("close", (code, termSignal) => { if (buffer.trim()) processLine(buffer); finish({ code, termSignal }); });
					proc.on("error", (error) => { finish({ code: null, termSignal: null, spawnError: error }); });
					if (signal) {
						if (signal.aborted) onAbort();
						else signal.addEventListener("abort", onAbort, { once: true });
					}
				});
			} finally {
				removeWorktreeActiveLock(activeLockPath);
			}

			details.exitCode = outcome.code;

			let violationBanner = "";
			const postSnapshot = readGitSnapshot(effectiveCwd);
			if (preSnapshot?.isGit && postSnapshot.isGit) {
				const preSet = new Set(preSnapshot.statusLines);
				const isBenignSymlink = (line: string): boolean => {
					const t = line.trim();
					if (t !== "?? node_modules" && t !== "?? node_modules/") return false;
					try { return fs.lstatSync(path.join(effectiveCwd, "node_modules")).isSymbolicLink(); } catch { return false; }
				};
				const newDirty = postSnapshot.statusLines.filter((line) => !preSet.has(line) && !isBenignSymlink(line));
				const headMoved = Boolean(preSnapshot.head && postSnapshot.head && preSnapshot.head !== postSnapshot.head);
				if (newDirty.length > 0 || headMoved) {
					details.roleViolation = true;
					const tracked = new Set<string>();
					const untracked = new Set<string>();
					for (const line of newDirty) {
						for (const p of parsePorcelainPaths(line)) {
							if (line.startsWith("?? ")) untracked.add(p);
							else tracked.add(p);
						}
					}
					try {
						if (tracked.size > 0) {
							const rels = [...tracked];
							try { execFileSync("git", ["-C", effectiveCwd, "reset", "HEAD", "--", ...rels], { stdio: "ignore" }); } catch {}
							for (const relFile of rels) {
								let inHead = false;
								try { execFileSync("git", ["-C", effectiveCwd, "cat-file", "-e", `HEAD:${relFile}`], { stdio: "ignore" }); inHead = true; } catch {}
								if (inHead) { try { execFileSync("git", ["-C", effectiveCwd, "checkout", "HEAD", "--", relFile], { stdio: "ignore" }); } catch {} }
								else untracked.add(relFile);
							}
						}
						for (const relFile of untracked) {
							const fullPath = path.resolve(effectiveCwd, relFile);
							if (fullPath.startsWith(path.resolve(effectiveCwd) + path.sep)) fs.rmSync(fullPath, { recursive: true, force: true });
						}
						if (headMoved && createdWorktreePath && !params.worktree?.branch) {
							try { execFileSync("git", ["-C", effectiveCwd, "reset", "--hard", preSnapshot.head], { stdio: "ignore" }); } catch {}
						}
					} catch {}
					violationBanner = `\n[ROLE_VIOLATION] 只读/门禁角色 (${role}) 越权修改仓库工作区，已精准回滚。\n`;
				}
			}

			if (createdWorktreePath && params.worktree) {
				const shouldCleanup = params.worktree.autoCleanup ?? !params.worktree.branch;
				if (shouldCleanup) {
					const nmLink = path.join(createdWorktreePath, "node_modules");
					try {
						if (fs.lstatSync(nmLink).isSymbolicLink()) {
							try { fs.unlinkSync(nmLink); } catch { fs.rmdirSync(nmLink); }
						}
					} catch {}
				}
				const curSnap = readGitSnapshot(createdWorktreePath);
				if (shouldCleanup && (!curSnap.isGit || curSnap.statusLines.length === 0)) {
					try {
						execFileSync("git", ["-C", path.resolve(params.worktree.repoRoot), "worktree", "remove", "--force", createdWorktreePath], { stdio: "ignore" });
						details.worktreeCleaned = true;
					} catch { details.worktreeCleaned = false; }
				}
			}

			if (outcome.spawnError) {
				details.status = "failed";
				throw new Error(`[zee_subagent:${role}] 启动 Pi 子进程失败：${outcome.spawnError.message}`);
			}

			const isPartialOutcome = aborted || timedOut || idleTimedOut || stagnancyTripped;
			const hasProducedText = Boolean(latestAssistantText.trim() || streamingAssistantText.trim());
			const isRunError = !isPartialOutcome && (outcome.code !== 0 || details.stopReason === "error" || Boolean(outcome.termSignal));

			if (isRunError) {
				details.status = "failed";
				const transientInfo = classifyTransientProviderFailure({
					errorMessage: details.errorMessage || "",
					stderrText,
					exitCode: outcome.code,
					turns: details.usage.turns,
					hasOutput: hasProducedText,
					hasToolCalls: details.lastActions.length > 0,
					outputTokens: details.usage.output,
				});
				if (transientInfo.transient) {
					let cooldownNote = "";
					if (effectiveModel || effectiveProvider) {
						recordModelCooldown(effectiveProvider, effectiveModel, {
							kind: transientInfo.kind ?? "rate_limit",
							reason: transientInfo.reason,
							ttlMs: transientInfo.ttlMs,
							errorSnippet: details.errorMessage || stderrText,
						});
						cooldownNote = `已写入 ${Math.round(transientInfo.ttlMs / 60000)}m 熔断冷却，`;
					}
					const reasonParts = [
						`[BUDGET_EXEMPT: ${transientInfo.reason} 未扣减预算，${cooldownNote}下次将自动 0ms 切备]`,
						details.errorMessage,
						outcome.code !== null && outcome.code !== 0 ? `退出码 ${outcome.code}` : "",
						stderrText.trim() ? `stderr: ${stderrText.trim().slice(0, 600)}` : "",
					].filter(Boolean);
					throw new Error(`[zee_subagent:${role}] 上游故障未执行：${reasonParts.join(" | ")}`);
				}
				recordSubagentBudgetAndCutoff(effectiveBusDir, false, toolCallId);
				const reasonParts = [
					details.errorMessage,
					outcome.termSignal ? `信号 ${outcome.termSignal}` : "",
					outcome.code !== null && outcome.code !== 0 ? `退出码 ${outcome.code}` : "",
					stderrText.trim() ? `stderr: ${stderrText.trim().slice(0, 800)}` : "",
					latestAssistantText ? `最后输出: ${latestAssistantText.slice(0, 800)}` : "",
				].filter(Boolean);
				throw new Error(`[zee_subagent:${role}] 执行失败：${reasonParts.join(" | ") || "未知错误"}`);
			}

			if (!isPartialOutcome && (effectiveModel || effectiveProvider)) {
				const hk = makeModelHealthKey(effectiveProvider, effectiveModel);
				if (hk) clearModelCooldown(hk);
			}

			const budgetTick = recordSubagentBudgetAndCutoff(effectiveBusDir, isPartialOutcome, toolCallId);
			let budgetCutoffBanner = "";
			if (budgetTick?.cutoffTriggered) {
				details.budgetCutoffTriggered = true;
				budgetCutoffBanner = `\n[ZEE_BUDGET_CUTOFF] 已派发 ${budgetTick.dispatched}/${budgetTick.maxDelegates}（达 70% 截断线 ${budgetTick.cutoffAt}）：请停止新开切片，完成合流与中文交付！\n`;
			}

			const normNoticeBanner = resolvedTarget.notice ? `[zee_subagent] ${resolvedTarget.notice}\n` : "";
			const branchNote = resolvedWorktreeBranch && params.worktree?.branch && resolvedWorktreeBranch !== params.worktree.branch.trim()
				? `[zee_subagent] 嵌套分支已扁平化为 "${resolvedWorktreeBranch}"。\n` : "";
			const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
			const shortHead = postSnapshot.head ? postSnapshot.head.slice(0, 8) : "none";
			const gitSummary = postSnapshot.isGit ? `HEAD=${shortHead} dirty=${postSnapshot.statusLines.length}` : "non-git";
			const metaLine = `\n\n---\n[zee_subagent] role=${role} status=${details.status} model=${details.model ?? "default"} elapsed=${elapsedSec}s turns=${details.usage.turns} cost=$${details.usage.cost.toFixed(4)} ${gitSummary}${resolvedWorktreeBranch ? ` branch=${resolvedWorktreeBranch}` : ""}${createdWorktreePath ? ` worktree=${createdWorktreePath}(cleaned=${Boolean(details.worktreeCleaned)})` : ""}`;

			if (isPartialOutcome) {
				let tag = "ABORTED_PARTIAL";
				let reasonLine = "子代理已被外部中止";
				if (stagnancyTripped) { details.status = "stagnancy_loop"; details.stopReason = "stagnancy_loop"; tag = "STAGNANCY_LOOP_PARTIAL"; reasonLine = `循环早停：${stagnancyDetail}`; }
				else if (idleTimedOut) { details.status = "idle_timeout"; details.stopReason = "idle_timeout"; tag = "IDLE_TIMEOUT_PARTIAL"; reasonLine = idleReasonDetail; }
				else if (timedOut) { details.status = "timeout"; details.stopReason = "timeout"; tag = "TIMEOUT_PARTIAL"; reasonLine = `墙钟超时（>${Math.round(timeoutMs / 1000)}s）`; }
				else { details.status = "aborted"; details.stopReason = "aborted"; }

				const streamTrimmed = streamingAssistantText.trim();
				const rescuedText = streamTrimmed || latestAssistantText.trim();
				const partialArtifactPath = persistPartialSalvage(effectiveBusDir, role, rescuedText);
				if (partialArtifactPath) details.partialArtifactPath = partialArtifactPath;

				const partialParts = [
					cooldownNoticeBanner.trim(), normNoticeBanner.trim(), branchNote.trim(),
					`[STATUS: ${tag}] ${reasonLine}`,
					`[进度] elapsed=${elapsedSec}s | turns=${details.usage.turns} | cost=$${details.usage.cost.toFixed(4)} | ${gitSummary}`,
					partialArtifactPath ? `[已落盘完整抢救稿] ${partialArtifactPath}` : "",
					violationBanner.trim(), budgetCutoffBanner.trim(),
					rescuedText ? `${streamTrimmed ? "[已抢救的部分输出（流式未结正文）]" : "[已抢救的部分输出]"}\n${truncateSubagentOutput(rescuedText)}` : "[已抢救的部分输出] （无正文）",
					stderrText.trim() ? `[stderr 摘要]\n${stderrText.trim().slice(0, 400)}` : "",
				].filter(Boolean);
				return { content: [{ type: "text", text: `${partialParts.join("\n\n")}${metaLine.replace("status=running", `status=${details.status}`)}` }], details };
			}

			details.status = "completed";
			const body = truncateSubagentOutput((latestAssistantText.trim() || streamingAssistantText.trim()) || "(子代理未返回文本输出)");
			return {
				content: [{ type: "text", text: `${cooldownNoticeBanner}${normNoticeBanner}${branchNote}${violationBanner}${budgetCutoffBanner}${body}${metaLine.replace("status=running", "status=completed")}` }],
				details,
			};
		},
	});
}
