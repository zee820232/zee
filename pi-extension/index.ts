/**
 * zee Pi Extension v4.2.1 — Dual-Axis FSM + Zero-Conflict Layer 0/1/2 HUD & 5-Tab Hub + zee_subagent v2.4
 *
 * 设计原则（对齐 Pi v1.6.1 源码 + Mac 7 场景体验评审优化 + Windows 跨平台闭环）：
 * 1. 纯净零冲突界面：绝不调用 setFooter()（由 pi-cometix-footer 独占）、绝不绑定 ctrl+g、绝不发明 session_switch/session_fork；
 *    package.json 移除 pi.skills 改由扩展内置 expandBundledZeeSkill 展开，消除 19 项命令重影（仅保留 11 个干净命令）；
 *    TUI 组件严格以 ctx.mode === "tui" 门控，RPC 降级为 string[] widget + notify，Print/JSON/ZEE_WORKER=1 100% 静默。
 * 2. Dual-Axis FSM (14 Workflow x 9 WorkerLane + G-01..G-06)：通过 pi.appendEntry("zee-fsm", ...) 按分支持久化，
 *    并在 session_start / session_tree 逆序恢复（向后兼容旧 zee-mode / zee-gate）。
 * 3. Read-Only Bus Sync + /tree 回滚保护 + /zee-review --strict/--quick 双档位 + 全局 ~/CLAUDE.md|AGENTS.md 隔离。
 * 4. zee_subagent v2.4：跨会话 429/5xx 熔断冷却与 0ms 健康切备（建连即败免扣预算）、10s 实时进度心跳（含 turns/cost/thinking）、
 *    toolCallId 幂等记账、G-02 Gate1->Gate2 校验、60% 空闲 STALLED_WARN 与 Windows spawn/junction 兼容。
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
import { Key } from "@earendil-works/pi-tui";
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
import {
	classifyTransientProviderFailure,
	clearModelCooldown,
	findHealthyPiFallback,
	getModelCooldown,
	listActiveCooldowns,
	makeModelHealthKey,
	recordModelCooldown,
} from "../skills/zee/scripts/lib/provider-health.mjs";
import {
	BusSyncReader,
	fetchWorktreeInventoryAsync,
	parseWorktreeInventoryJson,
	pruneSafeWorktreesAsync,
	type WorktreeInventory,
} from "./bus-sync.ts";
import {
	checkCutoffPrecondition,
	checkGate2Precondition,
	createInitialFsmSnapshot,
	isValidGateMode,
	isValidRiskLevel,
	isValidZeeMode,
	reduceFsm,
	restoreFsmFromBranch,
	toPersistedFsmEntry,
	type FsmEvent,
	type GateMode,
	type RiskLevel,
	type ZeeFsmPersistedSnapshot,
	type ZeeMode,
	type ZeeTrack,
} from "./fsm.ts";
import {
	HubStore,
	createInitialHubSnapshot,
	createZeeHudWidget,
	formatCompactStatusBadge,
	formatRpcHubSummary,
	getCtxMode,
	isRpcContext,
	isTuiContext,
	openZeeHubOverlay,
	renderRpcHudLines,
	type HubActions,
	type HudDensity,
} from "./hub-ui.ts";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(EXTENSION_DIR, "..", "skills");
const ZEE_SKILL_DIR = path.join(SKILLS_ROOT, "zee");
const ZEE_TOOL_PATH = path.join(ZEE_SKILL_DIR, "scripts", "zee-tool.mjs");
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
const ROLE_DEFAULT_IDLE_TIMEOUT_MS: Record<string, number> = {
	reviewer: 180_000,
};
const TOOL_EXEC_IDLE_TIMEOUT_MS = 180_000;
const THINKING_STREAM_TIMEOUT_MS = 240_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_MAX_REPEAT_ERRORS = 4;

const AMBIENT_RULE_ISOLATION_LINE =
	"- **Global Template Isolation**: Follow the actual repository stack, `.agents/zee.project.json`, and zee slice budgets; IGNORE repo-irrelevant ambient rules from `~/CLAUDE.md`, `~/.claude/CLAUDE.md`, or `~/.pi/agent/AGENTS.md` (such as arbitrary 3-file refactor caps or hardcoded test commands).";

export function expandBundledZeeSkill(skillName: string, args = ""): string {
	const skillBaseDir = path.join(SKILLS_ROOT, skillName);
	const skillFilePath = path.join(skillBaseDir, "SKILL.md");
	const raw = fs.readFileSync(skillFilePath, "utf8");
	const body = raw.replace(/^(?:\ufeff)?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
	const block = `<skill name="${skillName}" location="${skillFilePath}">\nReferences are relative to ${skillBaseDir}.\n\n${body}\n</skill>`;
	const trimmedArgs = String(args || "").trim();
	return trimmedArgs ? `${block}\n\n${trimmedArgs}` : block;
}

function ensureIndependentReviewBus(
	cwd: string,
	rawArgs: string,
): { busDir: string; statePath: string; tsvPath: string; slug: string } | null {
	let absRepo = "";
	try {
		absRepo = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
	if (!absRepo) return null;
	absRepo = path.resolve(absRepo);
	const cleanedDesc = rawArgs.replace(/(?:^|\s)(?:--strict|--quick|-q)(?=\s|$)/gi, " ").trim();
	const rawBase = cleanedDesc ? sanitizeSlug(cleanedDesc).slice(0, 32) : "workspace";
	const slug = sanitizeSlug(`review-${rawBase}-${Date.now().toString(36)}`);
	const busDir = path.join(RUNS_ROOT, repoKeyFor(absRepo), slug);
	fs.mkdirSync(path.join(busDir, "artifacts"), { recursive: true });
	fs.mkdirSync(path.join(busDir, "screenshots"), { recursive: true });
	const nowIso = new Date().toISOString();
	const statePath = path.join(busDir, "state.json");
	if (!fs.existsSync(statePath)) {
		const initState = {
			version: 1,
			repoRoot: absRepo,
			slug,
			busDir,
			activeHarness: "pi",
			conversationId: null,
			createdAt: nowIso,
			updatedAt: nowIso,
			mode: "review",
			level: "L2",
			predicate: "3-axis read-only adversarial review completed",
			resumeNext: null,
			units: [],
			delegatesDispatched: 0,
			fallbacksUsed: [],
			status: "initialized",
		};
		const tmp = `${statePath}.tmp.${process.pid}.${Date.now()}`;
		fs.writeFileSync(tmp, JSON.stringify(initState, null, 2) + "\n", "utf8");
		fs.renameSync(tmp, statePath);
	}
	const tsvPath = path.join(busDir, "decisions.tsv");
	if (!fs.existsSync(tsvPath)) {
		fs.writeFileSync(tsvPath, "ts\tunit\tphase\tdecision\twhy\tevidence\tresult\n", "utf8");
	}
	return { busDir, statePath, tsvPath, slug };
}

const READ_ONLY_AUDIT_ROLES = new Set(["scout", "architect", "judge", "verifier", "reviewer"]);

const WORKER_SENTINELS = [
	"[zee-worker]",
	"# zee Worker Standing Contract",
	"You are already running as a delegate",
];

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

function sameResolvedPath(a: string, b: string): boolean {
	const ra = path.resolve(a);
	const rb = path.resolve(b);
	return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
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

export function resolveSafeWorktreeBranch(absRepo: string, rawBranch: string): { branch: string; flattened: boolean } {
	let candidate = rawBranch.trim().replace(/^refs\/heads\//, "").replace(/^\/+|\/+$/g, "");
	let flattened = false;

	const refExists = (refName: string): boolean => {
		try {
			execFileSync("git", ["-C", absRepo, "show-ref", "--verify", "--quiet", refName], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	};

	const hasChildRefs = (prefix: string): boolean => {
		try {
			const out = execFileSync("git", ["-C", absRepo, "for-each-ref", "--format=%(refname)", `refs/heads/${prefix}/`], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			return out.length > 0;
		} catch {
			return false;
		}
	};

	for (let guard = 0; guard < 8; guard++) {
		const parts = candidate.split("/").filter(Boolean);
		let collidedIdx = -1;
		for (let i = 1; i < parts.length; i++) {
			const parentRef = `refs/heads/${parts.slice(0, i).join("/")}`;
			if (refExists(parentRef)) {
				collidedIdx = i;
				break;
			}
		}
		if (collidedIdx > 0) {
			const merged = `${parts[collidedIdx - 1]}-${parts[collidedIdx]}`;
			const nextParts = [...parts.slice(0, collidedIdx - 1), merged, ...parts.slice(collidedIdx + 1)];
			candidate = nextParts.join("/");
			flattened = true;
			continue;
		}
		if (hasChildRefs(candidate)) {
			candidate = `${candidate}-wt`;
			flattened = true;
			continue;
		}
		break;
	}

	return { branch: candidate, flattened };
}

function ensureWorktreeExcludesNodeModules(absRepo: string, wtPath: string): boolean {
	const srcModules = path.join(absRepo, "node_modules");
	const dstModules = path.join(wtPath, "node_modules");
	if (!fs.existsSync(srcModules) || fs.existsSync(dstModules)) return false;

	try {
		const tracked = execFileSync("git", ["-C", absRepo, "ls-files", "node_modules"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (tracked) return false;
	} catch {
		return false;
	}

	try {
		const excludePath = execFileSync("git", ["-C", wtPath, "rev-parse", "--git-path", "info/exclude"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const resolvedExclude = path.resolve(wtPath, excludePath);
		fs.mkdirSync(path.dirname(resolvedExclude), { recursive: true });
		const existing = fs.existsSync(resolvedExclude) ? fs.readFileSync(resolvedExclude, "utf8") : "";
		const lines = existing.split(/\r?\n/).map((l) => l.trim());
		if (!lines.includes("/node_modules") && !lines.includes("node_modules")) {
			const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
			fs.appendFileSync(resolvedExclude, `${prefix}/node_modules\n`, "utf8");
		}
		fs.symlinkSync(srcModules, dstModules, process.platform === "win32" ? "junction" : undefined);
		return true;
	} catch {
		return false;
	}
}

function collectPiBindingsFromConfig(
	configPath = process.env.ZEE_CONFIG_PATH?.trim() || path.join(os.homedir(), ".agents", "zee-config.json"),
): Array<{
	providerInstanceId: string;
	model: string;
}> {
	if (!fs.existsSync(configPath)) return [];
	try {
		const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
		const out: Array<{ providerInstanceId: string; model: string }> = [];
		const seen = new Set<string>();
		const pushBinding = (b: unknown) => {
			if (!b || typeof b !== "object") return;
			const rec = b as { providerInstanceId?: unknown; model?: unknown; prefer?: unknown; backup?: unknown };
			if (typeof rec.providerInstanceId === "string" && typeof rec.model === "string") {
				const key = `${rec.providerInstanceId}\0${rec.model}`;
				if (!seen.has(key)) {
					seen.add(key);
					out.push({ providerInstanceId: rec.providerInstanceId.trim(), model: rec.model.trim() });
				}
			}
			if (rec.prefer) pushBinding(rec.prefer);
			if (rec.backup) pushBinding(rec.backup);
		};
		const walk = (node: unknown) => {
			if (!node || typeof node !== "object") return;
			if (Array.isArray(node)) {
				for (const item of node) walk(item);
				return;
			}
			const obj = node as Record<string, unknown>;
			if (obj.bindings && typeof obj.bindings === "object") {
				const piBind = (obj.bindings as Record<string, unknown>).pi;
				if (piBind) pushBinding(piBind);
			}
			for (const val of Object.values(obj)) {
				if (val && typeof val === "object") walk(val);
			}
		};
		walk(cfg?.roles);
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
				notice: `已按 zee-config.json 自动归一 provider="${provider}" + model="${model}" -> provider="${exactJoined.providerInstanceId}", model="${exactJoined.model}"`,
			};
		}
		if (knownProviders.size > 0 && !knownProviders.has(provider.toLowerCase())) {
			const byModel = bindings.find((b) => b.model.toLowerCase() === model.toLowerCase());
			if (byModel) {
				return {
					provider: byModel.providerInstanceId,
					model: byModel.model,
					normalized: true,
					notice: `已按 zee-config.json 自动纠偏 provider="${provider}" -> "${byModel.providerInstanceId}"`,
				};
			}
		}
		if (/^(vm|devin|codex|remote-[a-z0-9_-]+)$/i.test(provider) && !knownProviders.has(provider.toLowerCase())) {
			const validHint = knownProviders.size > 0 ? `可用 providerInstanceId：${[...knownProviders].join(", ")}` : "请查看 pi --list-models 第一列";
			throw new Error(
				`参数错误：provider="${provider}" 是模型路径前缀而非 Pi provider ID（${validHint}），请搭配完整 model（如 "${provider}/${model}"）与正确 provider。`,
			);
		}
		return { provider, model, normalized: false };
	}

	if (!provider && model && bindings.length > 0) {
		const low = model.toLowerCase();
		const matches = bindings.filter(
			(b) => b.model.toLowerCase() === low || b.model.toLowerCase().endsWith(`/${low}`),
		);
		const uniquePairs = new Map(matches.map((b) => [`${b.providerInstanceId}\0${b.model}`, b]));
		if (uniquePairs.size === 1) {
			const only = [...uniquePairs.values()][0];
			return {
				provider: only.providerInstanceId,
				model: only.model,
				normalized: true,
				notice: `已按 zee-config.json 自动补全 model="${model}" -> provider="${only.providerInstanceId}", model="${only.model}"`,
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
			if (isAborted) {
				st.abortedDelegates = (Number(st.abortedDelegates) || 0) + 1;
			}
			if (cleanId) {
				st.countedDelegateIds = [...countedIds, cleanId].slice(-200);
			}
			st.updatedAt = new Date().toISOString();
			const tmp = `${statePath}.tmp.${process.pid}.${Date.now()}`;
			fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + "\n", "utf8");
			fs.renameSync(tmp, statePath);
		}

		const budget = (st.budget && typeof st.budget === "object" ? st.budget : {}) as Record<string, unknown>;
		const defaultMax = st.mode === "night" ? 12 : 40;
		const maxDelegates = Math.max(1, Number(budget.maxDelegates) || defaultMax);
		const cutoffRatio = Math.min(0.95, Math.max(0.5, Number(budget.cutoffRatio) || 0.7));
		const cutoffAt = Math.max(1, Math.ceil(maxDelegates * cutoffRatio));
		return {
			dispatched,
			maxDelegates,
			cutoffAt,
			cutoffTriggered: dispatched >= cutoffAt,
			deduplicated: alreadyCounted,
		};
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

function prepareAtomicWorktree(spec: {
	repoRoot: string;
	slug: string;
	lane: string;
	baseRef: string;
	branch?: string;
}): { wtPath: string; branch?: string; mountedNodeModules: boolean } {
	const absRepo = path.resolve(spec.repoRoot);
	const wtRoot = path.join(RUNS_ROOT, repoKeyFor(absRepo), sanitizeSlug(spec.slug), "worktrees");
	const wtPath = path.join(wtRoot, sanitizeSlug(spec.lane));
	fs.mkdirSync(wtRoot, { recursive: true });

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
	let resolvedBranch: string | undefined;
	if (spec.branch && spec.branch.trim()) {
		const safe = resolveSafeWorktreeBranch(absRepo, spec.branch.trim());
		const branchName = safe.branch;
		resolvedBranch = branchName;
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
	const mountedNodeModules = ensureWorktreeExcludesNodeModules(absRepo, wtPath);
	return { wtPath, branch: resolvedBranch, mountedNodeModules };
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

function inferTrackFromZeeArgs(args: string): ZeeTrack {
	const firstToken = String(args || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
	if (firstToken === "plan") return "plan";
	if (firstToken === "arch") return "arch";
	if (firstToken === "review") return "review";
	if (firstToken === "init") return "init";
	if (firstToken === "night") return "night";
	if (firstToken === "retro") return "retro";
	if (firstToken === "triage") return "triage";
	if (firstToken === "recall") return "recall";
	if (firstToken.startsWith("verify")) return "verify";
	return "build";
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
		`- **Skills Root (` + "`<zeeDir>`" + `)**: \`${ZEE_SKILL_DIR}\` (all 9 skills live under \`${SKILLS_ROOT}/<skill>/SKILL.md\`; read directly without searching).`,
		"- **Language**: All user-facing replies, questions, status updates, plans, and reports MUST be in Simplified Chinese (简体中文).",
		AMBIENT_RULE_ISOLATION_LINE,
		"- **Shared-File Single-Writer**: Parallel workers leave repo-wide shared index files (`CHANGELOG.md`, `README.md`, global test registries) to the Orchestrator integration step.",
		"- **Route by Intent** (read the matching `<skillsRoot>/<skill>/SKILL.md` before acting):",
		`  - Build / Bug Fix / Refactor / Multi-file change -> \`${ZEE_SKILL_DIR}/SKILL.md\` (L0–L3, L2 single-owner fast-track for ≤3 tightly coupled files, Gate 1 Verifier PASS before Gate 2 cross-family Reviewer)`,
		`  - Requirements Interview, Domain Modeling & Plan Only -> \`${path.join(SKILLS_ROOT, "zee-plan", "SKILL.md")}\``,
		`  - 0→1 New Project / Empty Repo -> \`${path.join(SKILLS_ROOT, "zee-init", "SKILL.md")}\``,
		`  - Code / PR / Uncommitted Diff Review Only -> \`${path.join(SKILLS_ROOT, "zee-review", "SKILL.md")}\``,
		`  - Project Verification Skill Lifecycle (init / maintain / live run) -> \`${path.join(SKILLS_ROOT, "zee-verify", "SKILL.md")}\``,
		`  - Codebase Deep-Module Architecture Audit -> \`${path.join(SKILLS_ROOT, "zee-arch", "SKILL.md")}\``,
		`  - Session Retro & 4-Level Error Hardening -> \`${path.join(SKILLS_ROOT, "zee-retro", "SKILL.md")}\``,
		`  - Overnight Autonomous Execution -> \`${path.join(SKILLS_ROOT, "zee-night", "SKILL.md")}\``,
		`  - Model / Harness Configuration & Health Doctor -> \`${path.join(SKILLS_ROOT, "zee-setup", "SKILL.md")}\``,
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

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const envBin = process.env.ZEE_PI_BIN?.trim();
	if (envBin) {
		if (/\.(?:mjs|cjs|js|ts)$/i.test(envBin)) {
			return { command: process.execPath, args: [envBin, ...args] };
		}
		return { command: envBin, args };
	}

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

function parseJsonFromToolOutput(text: string): Record<string, unknown> | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("{")) {
		try {
			return JSON.parse(trimmed) as Record<string, unknown>;
		} catch {}
	}
	const startIdx = trimmed.indexOf("{");
	const endIdx = trimmed.lastIndexOf("}");
	if (startIdx >= 0 && endIdx > startIdx) {
		try {
			return JSON.parse(trimmed.slice(startIdx, endIdx + 1)) as Record<string, unknown>;
		} catch {}
	}
	return null;
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
	busDir: Type.Optional(
		Type.String({
			description: "可选运行总线绝对路径（传入 worktree 时自动推导；用于自动回写 delegatesDispatched、触发 70% 预算截断及落盘 >2KB 抢救正文）",
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
	bypassCooldown: Type.Optional(
		Type.Boolean({
			description: "可选：跳过 429/5xx 跨会话熔断冷却缓存强行探测原通道（默认 false）",
		}),
	),
});

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
	usage: SubagentUsage;
}

export default function zeeExtension(pi: ExtensionAPI) {
	const busSync = new BusSyncReader();
	const store = new HubStore(
		createInitialHubSnapshot(process.cwd(), createInitialFsmSnapshot(pi.getFlag("zee-mode"))),
	);
	let hudMounted = false;
	let hubOpen = false;
	let activeStrictReview: { busDir: string; dispatchedReviewer: boolean } | null = null;

	const readActiveCooldownSummaries = () =>
		listActiveCooldowns().map((cd) => ({ key: cd.key, reason: cd.reason, remainingSec: cd.remainingSec }));

	const isSilentSession = (ctx: ExtensionContext): boolean => {
		if (process.env.ZEE_WORKER === "1") return true;
		if (!ctx.hasUI) return true;
		const m = getCtxMode(ctx);
		return m === "print" || m === "json";
	};

	const syncStatusAndRpcHud = (ctx: ExtensionContext) => {
		if (isSilentSession(ctx)) return;
		const snap = store.getSnapshot();
		ctx.ui.setStatus("zee-mode", formatCompactStatusBadge(snap));
		if (hudMounted && isRpcContext(ctx) && typeof ctx.ui.setWidget === "function") {
			const rpcLines = renderRpcHudLines(snap);
			ctx.ui.setWidget("zee-hud", rpcLines.length > 0 ? rpcLines : undefined, { placement: "aboveEditor" });
		}
	};

	const mountHud = (ctx: ExtensionContext) => {
		if (isSilentSession(ctx)) return;
		if (typeof ctx.ui.setWidget !== "function") return;
		if (isTuiContext(ctx)) {
			ctx.ui.setWidget("zee-hud", createZeeHudWidget(store), { placement: "aboveEditor" });
			hudMounted = true;
		} else if (isRpcContext(ctx)) {
			hudMounted = true;
			syncStatusAndRpcHud(ctx);
		}
	};

	const dispatchFsm = (evt: FsmEvent, ctx: ExtensionContext, persist = false, immediateUi = false) => {
		const prev = store.getSnapshot();
		const nextFsm = reduceFsm(prev, evt, Date.now());
		let nextBranchEntryTs = prev.branchEntryTs;
		if (persist) {
			pi.appendEntry("zee-fsm", toPersistedFsmEntry(nextFsm));
			nextBranchEntryTs = Date.now();
		}
		store.setSnapshot(
			{
				...prev,
				...nextFsm,
				cwd: ctx.cwd || prev.cwd,
				branchEntryTs: nextBranchEntryTs,
			},
			immediateUi,
		);
		syncStatusAndRpcHud(ctx);
		return nextFsm;
	};

	const hydrateFromDisk = (ctx: ExtensionContext, explicitBusDir?: string) => {
		const prev = store.getSnapshot();
		const cwd = ctx.cwd || prev.cwd || process.cwd();
		const projectConfig = busSync.readProjectConfig(cwd);
		const busDir = explicitBusDir || prev.busDir;

		let nextSnap = {
			...prev,
			cwd,
			projectConfig,
		};

		if (busDir) {
			const hyd = busSync.hydrateBus(busDir, prev.branchEntryTs);
			const diskRisk = isValidRiskLevel(hyd.state?.level) ? (hyd.state?.level as RiskLevel) : undefined;
			const budget = hyd.state?.budget;
			const fsmAfter = reduceFsm(
				nextSnap,
				{
					type: "HYDRATE_FROM_BUS",
					slug: hyd.state?.slug,
					busDir: hyd.busDir,
					riskLevel: diskRisk,
					dispatched: typeof hyd.state?.delegatesDispatched === "number" ? hyd.state.delegatesDispatched : undefined,
					maxDelegates: typeof budget?.maxDelegates === "number" ? budget.maxDelegates : undefined,
					cutoffRatio: typeof budget?.cutoffRatio === "number" ? budget.cutoffRatio : undefined,
					abortedDelegates: typeof hyd.state?.abortedDelegates === "number" ? hyd.state.abortedDelegates : undefined,
					status: typeof hyd.state?.status === "string" ? hyd.state.status : undefined,
				},
				Date.now(),
			);
			nextSnap = {
				...nextSnap,
				...fsmAfter,
				busAheadOfBranch: hyd.busAheadOfBranch,
				busState: hyd.state,
				decisionsTail: hyd.decisionsTail,
				lastSyncAt: Date.now(),
			};
		} else {
			nextSnap = {
				...nextSnap,
				trustLevel: prev.trustLevel === "T1" && projectConfig.trustLevel ? projectConfig.trustLevel : prev.trustLevel,
				lastSyncAt: Date.now(),
			};
		}

		store.setSnapshot(
			{
				...nextSnap,
				providerCooldowns: readActiveCooldownSummaries(),
			},
			false,
		);
		syncStatusAndRpcHud(ctx);
	};

	const restoreState = (ctx: ExtensionContext, mountWidget = false) => {
		const branch = ctx.sessionManager.getBranch();
		const restored = restoreFsmFromBranch(branch, pi.getFlag("zee-mode"));
		const cwd = ctx.cwd || process.cwd();
		const projectConfig = busSync.readProjectConfig(cwd);

		const restoredSnap: ZeeFsmPersistedSnapshot = {
			...restored.snapshot,
			trustLevel: restored.source === "default" ? projectConfig.trustLevel : restored.snapshot.trustLevel,
		};

		const initialHub = {
			...createInitialHubSnapshot(cwd, restoredSnap),
			hudDensity: store.getHudDensity(),
			branchEntryTs: restored.branchEntryTs,
			projectConfig,
			providerCooldowns: readActiveCooldownSummaries(),
		};
		store.rearm(initialHub);

		if (restoredSnap.busDir) {
			hydrateFromDisk(ctx, restoredSnap.busDir);
		}
		if (mountWidget) {
			mountHud(ctx);
		}
		syncStatusAndRpcHud(ctx);
	};

	const setGate = (nextGate: GateMode, ctx: ExtensionContext, persist = true) => {
		dispatchFsm({ type: "SET_WRITE_GATE", gate: nextGate }, ctx, persist, true);
	};

	const openHub = async (ctx: ExtensionContext) => {
		if (isSilentSession(ctx)) return;
		if (hubOpen) return;

		const snap = store.getSnapshot();
		const fallbackBus = snap.busDir || busSync.findLatestRepoBus(ctx.cwd || snap.cwd);
		hydrateFromDisk(ctx, fallbackBus);

		if (!isTuiContext(ctx)) {
			ctx.ui.notify(formatRpcHubSummary(store.getSnapshot()), "info");
			return;
		}

		hubOpen = true;
		void fetchWorktreeInventoryAsync(ctx.cwd || snap.cwd, ZEE_TOOL_PATH).then((inv: WorktreeInventory) => {
			store.update((p) => ({ ...p, worktreeInventory: inv }), true);
		});

		const actions: HubActions = {
			onRefresh: async () => {
				busSync.clearCache();
				const cur = store.getSnapshot();
				hydrateFromDisk(ctx, cur.busDir || busSync.findLatestRepoBus(ctx.cwd || cur.cwd));
				const inv = await fetchWorktreeInventoryAsync(ctx.cwd || cur.cwd, ZEE_TOOL_PATH);
				store.update((p) => ({ ...p, worktreeInventory: inv }), true);
			},
			onCycleMode: () => {
				const order: ZeeMode[] = ["off", "auto", "strict"];
				const cur = store.getSnapshot().routingMode;
				const next = order[(order.indexOf(cur) + 1) % order.length];
				dispatchFsm({ type: "SET_ROUTING_MODE", mode: next }, ctx, true, true);
			},
			onUnlockGate: () => {
				dispatchFsm({ type: "SET_WRITE_GATE", gate: "none", reason: "Hub 控制台手动解锁" }, ctx, true, true);
			},
			onPruneWorktrees: async () => {
				const res = await pruneSafeWorktreesAsync(ctx.cwd || store.getSnapshot().cwd, ZEE_TOOL_PATH);
				store.update((p) => ({ ...p, worktreeInventory: res.inventory }), true);
				return res.ok ? `已清理 ${res.prunedCount} 个安全 worktree。` : `清理失败：${res.error || "未知错误"}`;
			},
			onCycleHudDensity: () => {
				const order: HudDensity[] = ["full", "compact", "hidden"];
				const cur = store.getHudDensity();
				const next = order[(order.indexOf(cur) + 1) % order.length];
				store.setHudDensity(next, true);
				syncStatusAndRpcHud(ctx);
			},
			onPauseRun: () => {
				dispatchFsm({ type: "SET_PHASE", phase: "PAUSED", reason: "Hub 手动暂停" }, ctx, true, true);
			},
			onClearCooldowns: () => {
				const res = clearModelCooldown();
				store.update((p) => ({ ...p, providerCooldowns: readActiveCooldownSummaries() }), true);
				return `已清除 ${res.clearedCount} 个模型冷却缓存。`;
			},
		};

		try {
			await openZeeHubOverlay(ctx, store, actions);
		} finally {
			hubOpen = false;
		}
	};

	pi.registerFlag("zee-mode", {
		type: "string",
		description: "启动时启用 zee 自动路由模式：off | auto | strict",
	});

	pi.on("session_start", (_event, ctx) => {
		restoreState(ctx, true);
	});

	pi.on("session_tree", (_event, ctx) => {
		busSync.clearCache();
		restoreState(ctx, true);
		const snap = store.getSnapshot();
		if (snap.busAheadOfBranch && !isSilentSession(ctx)) {
			ctx.ui.notify(
				"检测到 /tree 分支回退：磁盘 state.json 更新于当前会话分支（busAheadOfBranch），已启用只读保护，绝不覆盖磁盘状态。",
				"warning",
			);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		hudMounted = false;
		hubOpen = false;
		store.dispose();
		if (!isSilentSession(ctx)) {
			if (typeof ctx.ui.setWidget === "function") {
				ctx.ui.setWidget("zee-hud", undefined);
			}
			ctx.ui.setStatus("zee-mode", undefined);
		}
	});

	// 零轮询监听 tool_result：捕捉 zee-tool.mjs init-run / update-state / log-decision / cleanup-worktrees 并即时水合总线
	pi.on("tool_result", (event, ctx) => {
		if (process.env.ZEE_WORKER === "1") return;
		const evtRec = event as { toolName?: unknown; input?: { command?: unknown }; content?: unknown };
		const toolName = String(evtRec.toolName ?? "");
		if (toolName !== "bash" && toolName !== "powershell") return;

		const cmd = typeof evtRec.input?.command === "string" ? evtRec.input.command : "";
		const text = extractMessageText(evtRec.content);
		const looksLikeZeeTool = cmd.includes("zee-tool.mjs") || text.includes('"busDir"') || text.includes('"statePath"') || text.includes('"tsvPath"');
		if (!looksLikeZeeTool) return;

		const parsed = parseJsonFromToolOutput(text);
		if (parsed) {
			if (typeof parsed.busDir === "string" && typeof parsed.statePath === "string") {
				const busDir = parsed.busDir;
				const slug = path.basename(busDir);
				const prev = store.getSnapshot();
				dispatchFsm(
					{
						type: "START_RUN",
						track: prev.track === "direct" ? "build" : prev.track,
						slug,
						busDir,
						phase: prev.phase === "IDLE" ? "PREFLIGHT" : prev.phase,
					},
					ctx,
					true,
					true,
				);
				hydrateFromDisk(ctx, busDir);
				return;
			}
			if (typeof parsed.statePath === "string") {
				const bDir = path.dirname(parsed.statePath);
				const wasAhead = store.getSnapshot().busAheadOfBranch;
				hydrateFromDisk(ctx, bDir);
				if (!wasAhead) {
					pi.appendEntry("zee-fsm", toPersistedFsmEntry(store.getSnapshot()));
					store.update((p) => ({ ...p, branchEntryTs: Date.now() }), false);
				}
				return;
			}
			if (typeof parsed.tsvPath === "string") {
				const bDir = path.dirname(parsed.tsvPath);
				const wasAhead = store.getSnapshot().busAheadOfBranch;
				hydrateFromDisk(ctx, bDir);
				if (!wasAhead) {
					pi.appendEntry("zee-fsm", toPersistedFsmEntry(store.getSnapshot()));
					store.update((p) => ({ ...p, branchEntryTs: Date.now() }), false);
				}
				return;
			}
			if (Array.isArray(parsed.worktrees)) {
				const inv = parseWorktreeInventoryJson(JSON.stringify(parsed), ctx.cwd || store.getSnapshot().cwd);
				store.update((p) => ({ ...p, worktreeInventory: inv }), false);
				return;
			}
		}

		if (store.getSnapshot().busDir) {
			hydrateFromDisk(ctx, store.getSnapshot().busDir);
		}
	});

	// 修复跨回合掉锁漏洞：仅 review 为单轮锁；plan 与 init-design 跨回合保持，直到显式执行或 M0 落盘解锁
	pi.on("agent_settled", (_event, ctx) => {
		if (activeStrictReview) {
			const sr = activeStrictReview;
			activeStrictReview = null;
			const cfgPath = process.env.ZEE_CONFIG_PATH?.trim() || path.join(os.homedir(), ".agents", "zee-config.json");
			if (!sr.dispatchedReviewer && fs.existsSync(cfgPath)) {
				const msg = "[G-02] /zee-review --strict 模式未派发跨家族 Reviewer 子代理（存在 zee-config.json），已记录守卫告警。";
				dispatchFsm({ type: "RECORD_VIOLATION", guard: "G-02", severity: "warn", message: msg, detail: sr.busDir }, ctx, true, true);
				if (!isSilentSession(ctx)) ctx.ui.notify(msg, "warning");
			}
		}
		const gate = store.getSnapshot().writeGate;
		if (gate === "review") {
			setGate("none", ctx);
		} else if (gate === "init-design" && fs.existsSync(path.join(ctx.cwd, ".agents", "zee.project.json"))) {
			setGate("none", ctx);
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		const curGate = store.getSnapshot().writeGate;
		const promptTrimmed = (event.prompt || "").trim();
		if (event.messageType === "user") {
			const prompt = promptTrimmed;
			if (
				/<skill\s+name="zee-(?:plan|arch)"(?=[\s>])/i.test(prompt) ||
				/^\/(?:skill:)?zee-(?:plan|arch)\b/i.test(prompt) ||
				/^\/(?:skill:)?zee\s+(?:plan|arch)\b/i.test(prompt)
			) {
				setGate("plan", ctx);
			} else if (
				/<skill\s+name="zee-review"(?=[\s>])/i.test(prompt) ||
				/^\/(?:skill:)?zee-review\b/i.test(prompt) ||
				/^\/(?:skill:)?zee\s+review\b/i.test(prompt) ||
				/^\/(?:skill:)?zee-verify\s+run\b/i.test(prompt)
			) {
				setGate("review", ctx);
			} else if (
				/<skill\s+name="zee-init"(?=[\s>])/i.test(prompt) ||
				/^\/(?:skill:)?zee-init\b/i.test(prompt) ||
				/^\/(?:skill:)?zee\s+init\b/i.test(prompt)
			) {
				const alreadyBootstrapped = fs.existsSync(path.join(ctx.cwd, ".agents", "zee.project.json"));
				setGate(alreadyBootstrapped ? "none" : "init-design", ctx);
			} else if (
				/<skill\s+name="zee(?:-(?:night|setup|retro|verify))?"(?=[\s>])/i.test(prompt) ||
				/^\/(?:skill:)?zee(?:-(?:night|setup|retro|verify))?\b/i.test(prompt) ||
				/^(解锁|解除锁定|开始写代码|开始实现|执行计划)\b/.test(prompt)
			) {
				const subMatch = prompt.match(/^\/(?:skill:)?zee\s+(.+)$/i);
				const nextGate = subMatch ? inferGateFromZeeArgs(subMatch[1], ctx.cwd) : "none";
				if (curGate !== nextGate) setGate(nextGate, ctx);
			} else if (curGate === "init-design" && fs.existsSync(path.join(ctx.cwd, ".agents", "zee.project.json"))) {
				setGate("none", ctx);
			}
		}

		if (isSubagentContext(event, ctx)) {
			delete event.systemPromptOptions.sections.zee;
			return undefined;
		}

		const snap = store.getSnapshot();
		const mode = snap.routingMode;
		const gate = snap.writeGate;
		const isExplicitZeePrompt =
			/<skill\s+name="zee(?:-(?:plan|init|review|verify|arch|retro|night|setup))?"(?=[\s>])/i.test(promptTrimmed) ||
			/^\/(?:skill:)?zee(?:-(?:plan|init|review|verify|arch|retro|night|setup))?\b/i.test(promptTrimmed);

		if (mode === "off" && gate === "none") {
			if (isExplicitZeePrompt || snap.phase !== "IDLE") {
				event.systemPromptOptions.sections.zee = [
					"## zee Active Workflow Precedence",
					AMBIENT_RULE_ISOLATION_LINE,
					"- **Language**: All user-facing replies, questions, status updates, plans, and reports MUST be in Simplified Chinese (简体中文).",
				].join("\n");
				return undefined;
			}
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
			event.systemPromptOptions.sections.zee = `${lockDesc}\n${AMBIENT_RULE_ISOLATION_LINE}`;
			return undefined;
		}

		event.systemPromptOptions.sections.zee = buildZeeSection(mode as Exclude<ZeeMode, "off">, gate);
		return undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		let gate = store.getSnapshot().writeGate;
		if (gate === "init-design" && fs.existsSync(path.join(ctx.cwd, ".agents", "zee.project.json"))) {
			setGate("none", ctx);
			gate = "none";
		}

		if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
			const command = event.input.command;
			const denyReason = checkProjectDenyCommands(command, ctx.cwd);
			if (denyReason) {
				dispatchFsm({ type: "RECORD_VIOLATION", guard: "G-01", severity: "block", message: denyReason }, ctx);
				if (!isSilentSession(ctx)) ctx.ui.notify(denyReason, "warning");
				return { block: true, reason: denyReason };
			}
			const destructive = evaluateDestructiveCommand(command, ctx.cwd);
			if (destructive) {
				const reason = `[zee 安全护栏] ${destructive.reason}，已自动拦截。请由用户在终端亲自确认执行。`;
				dispatchFsm({ type: "RECORD_VIOLATION", guard: "G-01", severity: "block", message: reason }, ctx);
				if (!isSilentSession(ctx)) ctx.ui.notify(reason, "warning");
				return { block: true, reason };
			}
			if (gate !== "none") {
				const violation = sharedCheckBashUnderGate(command, ctx.cwd, gate);
				if (violation) {
					dispatchFsm({ type: "RECORD_VIOLATION", guard: "G-01", severity: "block", message: violation }, ctx);
					if (!isSilentSession(ctx)) ctx.ui.notify(violation, "warning");
					return { block: true, reason: violation };
				}
			}
			return undefined;
		}

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
				dispatchFsm({ type: "RECORD_VIOLATION", guard: "G-01", severity: "block", message: reason }, ctx);
				if (!isSilentSession(ctx)) ctx.ui.notify(reason, "warning");
				return { block: true, reason };
			}
			if (
				gate === "init-design" &&
				sameResolvedPath(normalizeToolPath(rawPath, ctx.cwd), path.join(ctx.cwd, ".agents", "zee.project.json"))
			) {
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
			const snap = store.getSnapshot();
			if (!target || target === "status") {
				const gate = snap.writeGate;
				const lockLabel =
					gate === "none"
						? "无"
						: gate === "plan"
							? "plan（跨回合锁定，仅限计划与总线写入）"
							: gate === "init-design"
								? "init-design（0→1 Stage 1–2 设计冻结锁）"
								: "review（只读）";
				if (!isSilentSession(ctx)) {
					ctx.ui.notify(
						`当前 zee-mode：${snap.routingMode}｜保护锁：${lockLabel}｜阶段：${snap.phase}（切换用法：/zee-mode auto | strict | off）`,
						"info",
					);
				}
				return;
			}

			if (!isValidZeeMode(target)) {
				if (!isSilentSession(ctx)) {
					ctx.ui.notify(`无效模式 "${target}"，仅支持：/zee-mode auto | strict | off | status`, "warning");
				}
				return;
			}

			dispatchFsm({ type: "SET_ROUTING_MODE", mode: target }, ctx, true, true);

			const descMap: Record<ZeeMode, string> = {
				off: "已关闭 zee 常驻自动路由（仍可随时通过 /zee、/zee-plan 等命令手动触发）",
				auto: "已开启 zee 自动路由模式（auto）：简单问题直接回答，复杂开发/排障/架构/UI 自动进入 zee 流水线",
				strict: "已开启 zee 严格编排模式（strict）：所有非问答工程任务均强制先走 zee Preflight、风险定级与门禁验收",
			};
			if (!isSilentSession(ctx)) ctx.ui.notify(descMap[target], "info");
		},
	});

	// 2. /zee-hub 与零冲突快捷键（Key.ctrlAlt("h") & Key.f2，严禁绑定 ctrl+g）
	pi.registerCommand("zee-hub", {
		description: "打开 zee 5 标签交互式状态中枢 (Overview & FSM / Workers / Gates / Worktrees & Cost / Controls)",
		handler: async (_args, ctx) => {
			await openHub(ctx);
		},
	});

	if (typeof pi.registerShortcut === "function") {
		pi.registerShortcut(Key.ctrlAlt("h"), {
			description: "打开 zee 状态中枢 (Hub)",
			handler: async (ctx) => {
				await openHub(ctx);
			},
		});
		pi.registerShortcut(Key.f2, {
			description: "打开 zee 状态中枢 (Hub)",
			handler: async (ctx) => {
				await openHub(ctx);
			},
		});
	}

	// 3. 9 个短斜杠命令直接内置展开 bundled Skill（package.json 不再暴露重复 skill:* 菜单）
	interface SkillCommandHookResult {
		extraPrefix?: string;
		gateOverride?: GateMode;
		trackOverride?: ZeeTrack;
		slugOverride?: string;
		busDirOverride?: string;
	}
	const registerSkillCommand = (
		name: string,
		skillName: string,
		description: string,
		nextGate: GateMode | ((ctx: ExtensionContext, args: string) => GateMode),
		trackResolver: ZeeTrack | ((args: string) => ZeeTrack),
		lockNotice?: string,
		options?: {
			getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }>;
			beforeDispatch?: (args: string, ctx: ExtensionContext) => SkillCommandHookResult;
		},
	) => {
		pi.registerCommand(name, {
			description,
			...(options?.getArgumentCompletions ? { getArgumentCompletions: options.getArgumentCompletions } : {}),
			handler: async (args, ctx) => {
				const hookRes = options?.beforeDispatch ? options.beforeDispatch(args, ctx) : {};
				const resolvedGate =
					hookRes.gateOverride ?? (typeof nextGate === "function" ? nextGate(ctx, args) : nextGate);
				const track =
					hookRes.trackOverride ?? (typeof trackResolver === "function" ? trackResolver(args) : trackResolver);
				const projectCfg = busSync.readProjectConfig(ctx.cwd);
				dispatchFsm(
					{
						type: "START_RUN",
						track,
						trustLevel: projectCfg.trustLevel,
						...(hookRes.slugOverride ? { slug: hookRes.slugOverride } : {}),
						...(hookRes.busDirOverride ? { busDir: hookRes.busDirOverride } : {}),
						phase:
							resolvedGate === "plan"
								? "PLANNING"
								: resolvedGate === "init-design"
									? "INIT_DESIGN"
									: resolvedGate === "review"
										? "REVIEWING"
										: "PREFLIGHT",
					},
					ctx,
					false,
					false,
				);
				if (hookRes.busDirOverride) {
					hydrateFromDisk(ctx, hookRes.busDirOverride);
				}
				setGate(resolvedGate, ctx, true);
				if (lockNotice && resolvedGate !== "none" && !isSilentSession(ctx)) {
					ctx.ui.notify(lockNotice, "info");
				}
				const expanded = expandBundledZeeSkill(skillName, args);
				const msg = hookRes.extraPrefix ? `${hookRes.extraPrefix}\n\n${expanded}` : expanded;
				pi.sendUserMessage(msg, { expandPromptTemplates: false, deliverAs: "followUp" });
			},
		});
	};

	registerSkillCommand(
		"zee",
		"zee",
		"运行 zee 全自动多模型工程工作流（按风险自动定级，支持 /zee plan|review|init|arch|recall|triage）",
		(ctx, args) => inferGateFromZeeArgs(args, ctx.cwd),
		(args) => inferTrackFromZeeArgs(args),
	);
	registerSkillCommand(
		"zee-plan",
		"zee-plan",
		"先 Grill 深度访谈与领域建模再沉淀计划文档（跨回合启用写保护锁，禁止修改业务代码）",
		"plan",
		"plan",
		"已启用 zee-plan 跨回合规划保护锁：仅允许写入计划文档、GLOSSARY/ADR 与运行总线，禁止修改业务代码（直到调用 /zee 执行）。",
	);
	registerSkillCommand(
		"zee-init",
		"zee-init",
		"项目 0→1 建项模式：从需求访谈到可运行且验收通过的 v1",
		(ctx) => (fs.existsSync(path.join(ctx.cwd, ".agents", "zee.project.json")) ? "none" : "init-design"),
		"init",
		"已启用 zee-init Stage 1–2 设计保护锁：在 M0 写入 .agents/zee.project.json 前仅允许写设计文档与运行总线。",
	);
	registerSkillCommand(
		"zee-review",
		"zee-review",
		"只读跨家族三轴对抗审查（支持 --strict 机械建总线与 --quick 轻量快审）",
		"review",
		"review",
		"已启用 zee-review 只读审查锁：仅允许写入运行总线与 /tmp/zee-* 沙盒，禁止改动仓库文件。",
		{
			getArgumentCompletions: (prefix) => {
				const items = [
					{ value: "--strict", label: "--strict — 严格只读审查（默认：自动建独立总线 + 强制跨家族 Reviewer）" },
					{ value: "--quick", label: "--quick — 轻量单轮快速审查（<45s，保留 review🔒）" },
				];
				const trimmed = prefix.trim().toLowerCase();
				return trimmed ? items.filter((item) => item.value.startsWith(trimmed)) : items;
			},
			beforeDispatch: (args, ctx) => {
				const isQuick = /(?:^|\s)(?:--quick|-q)(?=\s|$)/i.test(args);
				if (isQuick) {
					activeStrictReview = null;
					return {
						extraPrefix:
							"[ZEE_REVIEW_MODE: quick]\n本次为快速单轮审查模式（--quick）：保留 review🔒 只读锁与精准静态/单测核验，若改动很小可直接收敛，无需重型沙盒全跑。",
					};
				}
				const busInfo = ensureIndependentReviewBus(ctx.cwd, args);
				if (!busInfo) {
					activeStrictReview = null;
					return {
						extraPrefix:
							"[ZEE_REVIEW_MODE: strict]\n当前处于严格审查模式，如存在 zee-config.json 必须派发跨家族 Reviewer 并将结论落盘。",
					};
				}
				activeStrictReview = { busDir: busInfo.busDir, dispatchedReviewer: false };
				return {
					slugOverride: busInfo.slug,
					busDirOverride: busInfo.busDir,
					extraPrefix: `[ZEE_REVIEW_MODE: strict]\n[MANDATORY_BUS_DIR: ${busInfo.busDir}]\n必须将本轮审查决策与 P2 发现落盘到上述总线（decisions.tsv + status=completed），且当 ~/.agents/zee-config.json 存在时必须至少派发 1 次跨家族 Reviewer 子代理（若无配置文件则走 --allow-standalone 单兵兜底）。`,
				};
			},
		},
	);
	registerSkillCommand(
		"zee-verify",
		"zee-verify",
		"项目实机验证技能全生命周期：init 生成 verify-<app>、maintain 防腐维护、run 冷启动实机验收",
		(_ctx, args) => (/^run\b/i.test(args.trim()) ? "review" : "none"),
		"verify",
		"已启用 zee-verify run 只读保护锁：仅允许执行冷启动实机验证与写证据到运行总线，禁止修改仓库源码。",
	);
	registerSkillCommand(
		"zee-arch",
		"zee-arch",
		"代码库深模块抗熵增巡检（只读扫描热点与浅模块，输出 HTML 报告，无缝衔接 /zee-plan）",
		"plan",
		"arch",
		"已启用 zee-arch 规划保护锁：仅允许输出架构报告与计划文档，禁止直接修改业务代码。",
	);
	registerSkillCommand(
		"zee-retro",
		"zee-retro",
		"会话复盘与 4 级结构化纠错飞轮（将重复错因固化进架构/Lint/Hook/测试）",
		"none",
		"retro",
	);
	registerSkillCommand(
		"zee-night",
		"zee-night",
		"无人值守过夜模式：独立分支、断点日志、预算熔断与中文晨报",
		"none",
		"night",
	);
	registerSkillCommand(
		"zee-setup",
		"zee-setup",
		"配置 zee 模型槽位、执行当前 Pi 宿主全面体检并按需生成项目 verify-<app> 验证技能",
		"none",
		"direct",
	);

	// 4. 内置独立子代理工具 zee_subagent v2.4
	pi.registerTool({
		name: "zee_subagent",
		label: "zee 子代理 v2.4",
		description:
			"在独立隔离的 Pi 子进程中执行单个 zee 角色任务（-ne 挂载轻量 worker-guard.ts + ZEE_WORKER=1、429/5xx 跨会话熔断冷却 0ms 健康切备且建连即败免扣预算、10s 实时心跳、provider/model 自动归一、流式正文优先抢救并自动落盘、并发工具双态看门狗、StagnancyTracker 早停、声明式原子 worktree + 预挂 node_modules/Windows junction + 嵌套分支冲突扁平化、toolCallId 幂等落账、70% 预算截断、G-02 Gate1->Gate2 守卫与 authorFamily 同家族硬拦截）。",
		promptSnippet:
			"Delegate an isolated zee role worker with explicit role, provider, model, thinkingLevel, atomic worktree, authorFamily, and least-privilege tools",
		executionMode: "parallel",
		parameters: ZeeSubagentParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (process.env.ZEE_WORKER === "1") {
				dispatchFsm(
					{
						type: "RECORD_VIOLATION",
						guard: "G-06",
						severity: "block",
						message: "[G-06] 禁止在子代理内递归派发 zee_subagent。",
					},
					ctx,
				);
				throw new Error("禁止递归派发：当前进程已是 zee 子代理（ZEE_WORKER=1），请直接执行任务。");
			}
			if (params.provider && !params.model) {
				throw new Error("参数错误：指定 provider 时必须同时提供 model。");
			}

			const resolvedTarget = resolvePiProviderModel(params.provider, params.model);
			let effectiveProvider = resolvedTarget.provider;
			let effectiveModel = resolvedTarget.model;

			const role = (params.role?.trim() || "worker").toLowerCase();

			// 429/5xx 跨会话熔断冷却检测：命中冷却 0ms 切备至健康备选（遵守 Reviewer 跨家族隔离）；无健康备胎直接拒发免等/免扣预算
			let cooldownNoticeBanner = "";
			let cooldownSwitchedFrom: string | undefined;
			if (!params.bypassCooldown && effectiveModel) {
				const cd = getModelCooldown(effectiveProvider, effectiveModel);
				if (cd.active) {
					const alt = findHealthyPiFallback({
						role,
						failedProvider: effectiveProvider,
						failedModel: effectiveModel,
						authorFamily: params.authorFamily,
					});
					if (alt) {
						cooldownSwitchedFrom = cd.key;
						cooldownNoticeBanner = `[zee_subagent] 命中跨会话 429/5xx 熔断冷却（${cd.key}，剩余 ${cd.remainingSec}s，原因：${cd.entry?.reason || "cooldown"}），已 0ms 自动切备至健康通道 ${alt.provider}/${alt.model} (${alt.slotLabel})。\n`;
						effectiveProvider = alt.provider;
						effectiveModel = alt.model;
					} else {
						throw new Error(
							`[zee_subagent:${role}] 目标通道 "${cd.key}" 处于 429/5xx 熔断冷却期（剩余 ${cd.remainingSec}s，原因：${cd.entry?.reason || "cooldown"}），且暂无可用健康备胎。未扣减预算；可执行 \`zee-tool.mjs provider-health --clear\` 清理冷却或传 \`bypassCooldown: true\` 强行探测。`,
						);
					}
				}
			}

			// G-03: 同家族 Reviewer 静态硬拦截（经 extractModelFamily 归一化 anthropic→claude 等别名）
			if (role === "reviewer" && params.authorFamily && effectiveModel) {
				const authorFam = extractModelFamily(params.authorFamily);
				const reviewerFam = extractModelFamily(effectiveModel);
				if (authorFam && reviewerFam && authorFam === reviewerFam) {
					const reason = `[zee_subagent:reviewer] 跨家族拦截：审查员模型 "${effectiveModel}"（家族 ${reviewerFam}）与作者家族 "${authorFam}" 相同，禁止同源审查！请切换为其他家族审查员（如 gemini / openai / claude / devin）。`;
					dispatchFsm(
						{
							type: "RECORD_VIOLATION",
							guard: "G-03",
							severity: "block",
							message: reason,
							detail: `author=${authorFam} reviewer=${reviewerFam}`,
						},
						ctx,
						true,
						true,
					);
					throw new Error(reason);
				}
			}

			// G-04: CUTOFF_CLOSING 阶段拦截/告警新开 coder/ui 功能切片
			// 注意：strict 阻断在此直接落盘 RECORD_VIOLATION 后抛错；auto 放行由下方 WORKER_PREPARE 统一记录 1 条违规，避免重复双写！
			const cutoffCheck = checkCutoffPrecondition(store.getSnapshot(), role);
			let preflightWarningBanner = "";
			let hasPreflightWarn = false;
			if (cutoffCheck.violation) {
				if (!cutoffCheck.allowed) {
					dispatchFsm(
						{
							type: "RECORD_VIOLATION",
							guard: "G-04",
							severity: cutoffCheck.violation.severity,
							message: cutoffCheck.violation.message,
							detail: cutoffCheck.violation.detail,
						},
						ctx,
						true,
						true,
					);
					throw new Error(cutoffCheck.reason);
				}
				hasPreflightWarn = true;
				if (!isSilentSession(ctx)) ctx.ui.notify(cutoffCheck.reason || cutoffCheck.violation.message, "warning");
				preflightWarningBanner += `${cutoffCheck.violation.message}\n`;
			}

			// G-02: L2/L3/night 派发 reviewer 前检查 Gate 1 PASS on matching pinnedSha
			const rawBaseRef = params.worktree?.baseRef?.trim() || "";
			const targetShaForG2 = /^[0-9a-f]{7,40}$/i.test(rawBaseRef)
				? rawBaseRef
				: store.getSnapshot().pinnedSha || undefined;
			if (role === "reviewer") {
				const g2Check = checkGate2Precondition(store.getSnapshot(), targetShaForG2);
				if (g2Check.violation) {
					if (!g2Check.allowed) {
						dispatchFsm(
							{
								type: "RECORD_VIOLATION",
								guard: "G-02",
								severity: g2Check.violation.severity,
								message: g2Check.violation.message,
								detail: g2Check.violation.detail,
							},
							ctx,
							true,
							true,
						);
						throw new Error(g2Check.reason);
					}
					hasPreflightWarn = true;
					if (!isSilentSession(ctx)) ctx.ui.notify(g2Check.reason || g2Check.violation.message, "warning");
					preflightWarningBanner += `${g2Check.violation.message}\n`;
				}
			}

			if (signal?.aborted) {
				throw new Error(`[zee_subagent:${role}] 启动前已被取消。`);
			}

			if (role === "reviewer" && activeStrictReview) {
				activeStrictReview.dispatchedReviewer = true;
			}

			const workerId = toolCallId?.trim() || `w-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			const workerLane = params.worktree?.lane || role;
			const workerFamily = effectiveModel ? extractModelFamily(effectiveModel) : undefined;
			let workerPrepared = false;
			let workerFinalized = false;

			const safeFinalizeError = (msg: string) => {
				if (workerPrepared && !workerFinalized) {
					workerFinalized = true;
					dispatchFsm(
						{
							type: "WORKER_FINISH",
							id: workerId,
							outcome: "failed",
							errorMessage: msg,
						},
						ctx,
						false,
						true,
					);
				}
			};

			dispatchFsm(
				{
					type: "WORKER_PREPARE",
					worker: {
						id: workerId,
						lane: workerLane,
						role,
						provider: effectiveProvider,
						model: effectiveModel,
						family: workerFamily,
						pinnedSha: targetShaForG2 ?? (rawBaseRef || undefined),
					},
				},
				ctx,
				hasPreflightWarn,
				true,
			);
			workerPrepared = true;

			let createdWorktreePath: string | undefined;
			let resolvedWorktreeBranch: string | undefined;
			let mountedNodeModules = false;
			let activeLockPath: string | undefined;
			let effectiveCwd = path.resolve(ctx.cwd, params.cwd ?? ".");
			const effectiveBusDir =
				params.busDir?.trim() ||
				(params.worktree
					? path.join(RUNS_ROOT, repoKeyFor(params.worktree.repoRoot), sanitizeSlug(params.worktree.slug))
					: "");

			try {
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
			} catch (err) {
				safeFinalizeError(err instanceof Error ? err.message : String(err));
				throw err;
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

			const effectiveTools = enforcePiRoleTools(role, params.tools);

			const cliArgs: string[] = ["--mode", "json", "-p", "--no-session", "-ne"];
			if (fs.existsSync(WORKER_GUARD_PATH)) {
				cliArgs.push("-e", WORKER_GUARD_PATH);
			}
			cliArgs.push("--no-mcp");
			if (!params.includeSkills) {
				cliArgs.push("-ns");
			}
			if (effectiveModel) {
				if (effectiveProvider) cliArgs.push("--provider", effectiveProvider);
				cliArgs.push("--model", effectiveModel);
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

			dispatchFsm(
				{
					type: "WORKER_START",
					id: workerId,
					worktreePath: createdWorktreePath,
					branch: resolvedWorktreeBranch,
					provider: effectiveProvider,
					model: effectiveModel,
					family: workerFamily,
					pinnedSha: params.worktree?.baseRef,
				},
				ctx,
				false,
				true,
			);

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
					: thinkingStreamStartedAt > 0
						? ` | thinking=${Math.round((Date.now() - thinkingStreamStartedAt) / 1000)}s`
						: "";
				const streamPart = streamingAssistantText.length > 0 ? ` | streamChars=${streamingAssistantText.length}` : "";
				const header = `[zee_subagent:${role}] model=${modelLabel} | ${elapsedSec}s | turns=${details.usage.turns} | cost=$${details.usage.cost.toFixed(4)} | last=${lastToolLabel}${inFlightPart}${streamPart}`;
				const previewSource = streamingAssistantText.trim() || latestAssistantText.trim();
				const body = previewSource ? `\n${truncateSubagentOutput(previewSource.slice(0, 600))}` : "";
				onUpdate?.({
					content: [{ type: "text", text: `${header}${body}` }],
					details: { ...details, lastActions: [...details.lastActions], usage: { ...details.usage } },
				});
				dispatchFsm(
					{
						type: "WORKER_PROGRESS",
						id: workerId,
						turns: details.usage.turns,
						cost: details.usage.cost,
						inputTokens: details.usage.input,
						outputTokens: details.usage.output,
						streamChars: streamingAssistantText.length,
						inFlightTool: oldest?.name,
						inFlightSince: oldest?.startedAt,
						lastActions: details.lastActions,
					},
					ctx,
					false,
					false,
				);
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
					let stallWarnTimer: ReturnType<typeof setTimeout> | undefined;
					let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
					let proc: ReturnType<typeof spawn>;

					const resetIdleTimer = (customWindowMs?: number, reasonHint?: string) => {
						if (idleTimer) clearTimeout(idleTimer);
						if (stallWarnTimer) clearTimeout(stallWarnTimer);
						const oldest = getOldestInFlight();
						const windowMs = customWindowMs ?? (oldest ? toolIdleTimeoutMs : idleTimeoutMs);
						const warnMs = Math.max(1000, Math.round(windowMs * 0.6));
						stallWarnTimer = setTimeout(() => {
							if (settled) return;
							const curOldest = getOldestInFlight();
							const stallMsg = curOldest
								? `工具 ${curOldest.name} 空转 >${Math.round(warnMs / 1000)}s`
								: `空闲 >${Math.round(warnMs / 1000)}s (60% 阈值)`;
							dispatchFsm(
								{
									type: "WORKER_STALL_WARN",
									id: workerId,
									stallReason: stallMsg,
								},
								ctx,
								false,
								true,
							);
						}, warnMs);
						stallWarnTimer.unref?.();

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
						if (stallWarnTimer) clearTimeout(stallWarnTimer);
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
								...(effectiveBusDir ? { ZEE_BUS_DIR: effectiveBusDir } : {}),
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

			let violationBanner = "";
			const postSnapshot = readGitSnapshot(effectiveCwd);
			if (preSnapshot?.isGit && postSnapshot.isGit) {
				const preSet = new Set(preSnapshot.statusLines);
				const isBenignNodeModulesSymlink = (line: string): boolean => {
					const trimmedLine = line.trim();
					if (trimmedLine !== "?? node_modules" && trimmedLine !== "?? node_modules/") return false;
					try {
						return fs.lstatSync(path.join(effectiveCwd, "node_modules")).isSymbolicLink();
					} catch {
						return false;
					}
				};
				const newDirty = postSnapshot.statusLines.filter((line) => !preSet.has(line) && !isBenignNodeModulesSymlink(line));
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
							try {
								execFileSync("git", ["-C", effectiveCwd, "reset", "HEAD", "--", ...relList], { stdio: "ignore" });
							} catch {}
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

			if (createdWorktreePath && params.worktree) {
				const shouldCleanup = params.worktree.autoCleanup ?? !params.worktree.branch;
				if (shouldCleanup) {
					const nmLink = path.join(createdWorktreePath, "node_modules");
					try {
						if (fs.lstatSync(nmLink).isSymbolicLink()) {
							try {
								fs.unlinkSync(nmLink);
							} catch {
								fs.rmdirSync(nmLink);
							}
						}
					} catch {}
				}
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
				const spawnErrMsg = `[zee_subagent:${role}] 启动 Pi 子进程失败：${outcome.spawnError.message}`;
				safeFinalizeError(spawnErrMsg);
				throw new Error(spawnErrMsg);
			}

			const isPartialOutcome = aborted || timedOut || idleTimedOut || stagnancyTripped;
			const hasProducedText = Boolean(latestAssistantText.trim() || streamingAssistantText.trim());
			const isRunError =
				!isPartialOutcome && (outcome.code !== 0 || details.stopReason === "error" || Boolean(outcome.termSignal));
			const transientInfo = isRunError
				? classifyTransientProviderFailure({
						errorMessage: details.errorMessage || "",
						stderrText,
						exitCode: outcome.code,
						turns: details.usage.turns,
						hasOutput: hasProducedText,
					})
				: { transient: false, kind: null, ttlMs: 0, reason: "" };

			if (isRunError) {
				details.status = "failed";
				if (transientInfo.transient) {
					let cooldownNote = "";
					if (effectiveModel || effectiveProvider) {
						recordModelCooldown(effectiveProvider, effectiveModel, {
							kind: transientInfo.kind ?? "rate_limit",
							reason: transientInfo.reason,
							ttlMs: transientInfo.ttlMs,
							errorSnippet: details.errorMessage || stderrText,
						});
						store.update((p) => ({ ...p, providerCooldowns: readActiveCooldownSummaries() }), true);
						cooldownNote = `已写入 ${Math.round(transientInfo.ttlMs / 60000)}m 熔断冷却，`;
					}
					const reasonParts = [
						`[BUDGET_EXEMPT: ${transientInfo.reason} 未扣减预算，${cooldownNote}下次将自动 0ms 切备]`,
						details.errorMessage,
						outcome.code !== null && outcome.code !== 0 ? `退出码 ${outcome.code}` : "",
						stderrText.trim() ? `stderr: ${stderrText.trim().slice(0, 600)}` : "",
					].filter(Boolean);
					const failMsg = `[zee_subagent:${role}] 上游故障未执行：${reasonParts.join(" | ")}`;
					safeFinalizeError(failMsg);
					throw new Error(failMsg);
				}

				const nonTransientBudgetTick = recordSubagentBudgetAndCutoff(effectiveBusDir, false, toolCallId);
				if (nonTransientBudgetTick) {
					dispatchFsm(
						{
							type: "BUDGET_TICK",
							dispatched: nonTransientBudgetTick.dispatched,
							maxDelegates: nonTransientBudgetTick.maxDelegates,
							cutoffTriggered: nonTransientBudgetTick.cutoffTriggered,
						},
						ctx,
						false,
						true,
					);
				}
				const reasonParts = [
					details.errorMessage,
					outcome.termSignal ? `信号 ${outcome.termSignal}` : "",
					outcome.code !== null && outcome.code !== 0 ? `退出码 ${outcome.code}` : "",
					stderrText.trim() ? `stderr: ${stderrText.trim().slice(0, 800)}` : "",
					latestAssistantText ? `最后输出: ${latestAssistantText.slice(0, 800)}` : "",
				].filter(Boolean);
				const failMsg = `[zee_subagent:${role}] 执行失败：${reasonParts.join(" | ") || "未知错误"}`;
				safeFinalizeError(failMsg);
				throw new Error(failMsg);
			}

			if (!isPartialOutcome && (effectiveModel || effectiveProvider)) {
				const hk = makeModelHealthKey(effectiveProvider, effectiveModel);
				if (hk) {
					const clr = clearModelCooldown(hk);
					if (clr.clearedCount > 0) {
						store.update((p) => ({ ...p, providerCooldowns: readActiveCooldownSummaries() }), true);
					}
				}
			}

			const budgetTick = recordSubagentBudgetAndCutoff(effectiveBusDir, isPartialOutcome, toolCallId);
			let budgetCutoffBanner = "";
			if (budgetTick) {
				dispatchFsm(
					{
						type: "BUDGET_TICK",
						dispatched: budgetTick.dispatched,
						maxDelegates: budgetTick.maxDelegates,
						cutoffTriggered: budgetTick.cutoffTriggered,
					},
					ctx,
					false,
					true,
				);
			}
			if (budgetTick?.cutoffTriggered) {
				details.budgetCutoffTriggered = true;
				budgetCutoffBanner = `\n[ZEE_BUDGET_CUTOFF] 已派发子代理 ${budgetTick.dispatched}/${budgetTick.maxDelegates}（达到 70% 截断线 ${budgetTick.cutoffAt}）：请立即停止新开功能切片，完成当前已验证提交的合流、清理 worktree、更新 state.json 并输出最终中文交付报告/晨报！\n`;
			}

			const normNoticeBanner = resolvedTarget.notice ? `[zee_subagent] ${resolvedTarget.notice}\n` : "";
			const branchNote =
				resolvedWorktreeBranch && params.worktree?.branch && resolvedWorktreeBranch !== params.worktree.branch.trim()
					? `[zee_subagent] 检测到 Git 嵌套分支 ref 冲突，已自动将 "${params.worktree.branch.trim()}" 扁平化为 "${resolvedWorktreeBranch}"。\n`
					: "";

			const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
			const shortHead = postSnapshot.head ? postSnapshot.head.slice(0, 8) : "none";
			const gitSummary = postSnapshot.isGit
				? `HEAD=${shortHead} dirty=${postSnapshot.statusLines.length}`
				: "non-git";
			const metaLine = `\n\n---\n[zee_subagent] role=${role} status=${details.status} model=${details.model ?? "default"} elapsed=${elapsedSec}s turns=${details.usage.turns} in=${details.usage.input} out=${details.usage.output} cost=$${details.usage.cost.toFixed(4)} ${gitSummary}${resolvedWorktreeBranch ? ` branch=${resolvedWorktreeBranch}` : ""}${createdWorktreePath ? ` worktree=${createdWorktreePath}(cleaned=${Boolean(details.worktreeCleaned)})` : ""}`;

			if (isPartialOutcome) {
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
				const partialArtifactPath = persistPartialSalvage(effectiveBusDir, role, rescuedText);
				if (partialArtifactPath) details.partialArtifactPath = partialArtifactPath;

				workerFinalized = true;
				dispatchFsm(
					{
						type: "WORKER_FINISH",
						id: workerId,
						outcome: details.roleViolation
							? "role_violation"
							: partialArtifactPath || details.status !== "aborted"
								? "partial_salvaged"
								: "aborted",
						status: details.status,
						turns: details.usage.turns,
						cost: details.usage.cost,
						inputTokens: details.usage.input,
						outputTokens: details.usage.output,
						lastActions: details.lastActions,
						partialArtifactPath,
						roleViolation: details.roleViolation,
						budgetCutoffTriggered: details.budgetCutoffTriggered,
					},
					ctx,
					true,
					true,
				);
				if (effectiveBusDir) hydrateFromDisk(ctx, effectiveBusDir);

				const partialParts = [
					cooldownNoticeBanner.trim(),
					preflightWarningBanner.trim(),
					normNoticeBanner.trim(),
					branchNote.trim(),
					`[STATUS: ${tag}] ${reasonLine}`,
					`[进度快照] elapsed=${elapsedSec}s | turns=${details.usage.turns} | cost=$${details.usage.cost.toFixed(4)} | ${gitSummary}`,
					details.lastActions.length > 0 ? `[最近动作] ${details.lastActions.join(" -> ")}` : "",
					partialArtifactPath ? `[已落盘完整抢救稿] ${partialArtifactPath}（续跑可直接增量补完，无需重写）` : "",
					violationBanner.trim(),
					budgetCutoffBanner.trim(),
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

			details.status = "completed";
			workerFinalized = true;
			const bodyRaw = latestAssistantText.trim() || streamingAssistantText.trim();
			const verdictMatch = bodyRaw.match(/\bVERDICT:\s*(PASS|FAIL|REVISE|INCONCLUSIVE)\b/i);
			const willRecordGate = Boolean(
				verdictMatch && !details.roleViolation && (role === "verifier" || role === "reviewer" || role === "judge"),
			);

			dispatchFsm(
				{
					type: "WORKER_FINISH",
					id: workerId,
					outcome: details.roleViolation ? "role_violation" : "completed",
					status: details.status,
					turns: details.usage.turns,
					cost: details.usage.cost,
					inputTokens: details.usage.input,
					outputTokens: details.usage.output,
					lastActions: details.lastActions,
					roleViolation: details.roleViolation,
					budgetCutoffTriggered: details.budgetCutoffTriggered,
				},
				ctx,
				!willRecordGate,
				true,
			);

			if (willRecordGate && verdictMatch) {
				const vNorm = verdictMatch[1].toUpperCase() as "PASS" | "FAIL" | "REVISE" | "INCONCLUSIVE";
				const isFullHexSha = /^[0-9a-f]{40}$/i.test(rawBaseRef);
				const targetSha = isFullHexSha
					? rawBaseRef
					: postSnapshot.head || store.getSnapshot().pinnedSha || rawBaseRef;
				if (targetSha) {
					dispatchFsm(
						{
							type: "RECORD_GATE_RESULT",
							gate: role === "verifier" ? 1 : 2,
							role: role as "verifier" | "reviewer" | "judge",
							verdict: vNorm,
							pinnedSha: targetSha,
							family: workerFamily,
						},
						ctx,
						true,
						true,
					);
				} else {
					pi.appendEntry("zee-fsm", toPersistedFsmEntry(store.getSnapshot()));
					store.update((p) => ({ ...p, branchEntryTs: Date.now() }), false);
				}
			}
			if (effectiveBusDir) hydrateFromDisk(ctx, effectiveBusDir);

			const body = truncateSubagentOutput(bodyRaw || "(子代理未返回文本输出)");
			const finalMeta = metaLine.replace("status=running", "status=completed");
			return {
				content: [
					{
						type: "text",
						text: `${cooldownNoticeBanner}${preflightWarningBanner}${normNoticeBanner}${branchNote}${violationBanner}${budgetCutoffBanner}${body}${finalMeta}`,
					},
				],
				details,
			};
		},
	});
}
