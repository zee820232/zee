/**
 * zee Out-of-Tree Bus Read-Only Synchronizer & Async Worktree Inventory (v4.2.0)
 *
 * 设计铁律：
 * 1. 严格只读（NEVER overwrite disk state.json / decisions.tsv），使用 mtimeMs + size 缓存零轮询读取。
 * 2. /tree 回滚漂移保护：若 Date.parse(diskState.updatedAt) > branchEntryTs + 5000，置 busAheadOfBranch=true 并拒绝回写磁盘。
 * 3. 读取 .agents/zee.project.json 的 trustLevel 与 verify-* 技能存在性检查。
 * 4. fetchWorktreeInventoryAsync 使用异步 execFile 调用 zee-tool.mjs，绝不阻塞 TUI render(width)。
 */

import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { RUNS_ROOT } from "../skills/zee/scripts/lib/guard-core.mjs";
import { isValidTrustLevel, type TrustLevel } from "./fsm.ts";

const execFileAsync = promisify(execFile);

export interface BusUnitState {
	id: string;
	status?: string;
	sha?: string;
	branch?: string;
	owner?: string;
	role?: string;
	updatedAt?: string;
	[key: string]: unknown;
}

export interface BusBudgetState {
	maxUnits?: number;
	maxDelegates?: number;
	maxHeavyEscalations?: number;
	maxConsecutiveParked?: number;
	cutoffRatio?: number;
}

export interface BusStateDisk {
	version?: number;
	repoRoot?: string;
	slug?: string;
	busDir?: string;
	activeHarness?: string;
	conversationId?: string | null;
	createdAt?: string;
	updatedAt?: string;
	mode?: string;
	level?: string | null;
	predicate?: string | null;
	resumeNext?: string | null;
	units?: BusUnitState[];
	delegatesDispatched?: number;
	abortedDelegates?: number;
	countedDelegateIds?: string[];
	fallbacksUsed?: string[];
	status?: string;
	budget?: BusBudgetState;
}

export interface DecisionRow {
	ts: string;
	unit: string;
	phase: string;
	decision: string;
	why: string;
	evidence: string;
	result: string;
}

export interface ProjectConfigSnapshot {
	exists: boolean;
	trustLevel: TrustLevel;
	hasVerifySkill: boolean;
	verifySkillPath?: string;
	riskPaths: string[];
	uiGlobs: string[];
	denyCommands: string[];
	testCmds: string[];
	lintCmd?: string;
	buildCmd?: string;
}

export type WorktreeBucket =
	| "primary"
	| "active_hold"
	| "keep_dirty"
	| "safe_to_prune"
	| "safe_to_prune_detached"
	| "review_unmerged";

export const WORKTREE_BUCKETS: readonly WorktreeBucket[] = [
	"primary",
	"active_hold",
	"keep_dirty",
	"safe_to_prune",
	"safe_to_prune_detached",
	"review_unmerged",
];

export interface WorktreeEntry {
	path: string;
	branch: string;
	head: string | null;
	dirtyFiles: number;
	wipFiles: number;
	scratchFiles: number;
	mergedIntoBase: boolean;
	mergeMethod: string | null;
	activeLocked: boolean;
	bucket: WorktreeBucket;
	pruned: boolean;
	pruneHint: string | null;
}

export interface WorktreeInventory {
	ok: boolean;
	repoRoot: string;
	baseRef?: string;
	worktrees: WorktreeEntry[];
	bucketCounts: Record<WorktreeBucket, number>;
	fetchedAt: number;
	error?: string;
}

export interface BusHydrationResult {
	busDir: string;
	state: BusStateDisk | null;
	decisionsTail: DecisionRow[];
	busAheadOfBranch: boolean;
	diskUpdatedAtMs: number;
	branchEntryTs: number;
	cachedStateHit: boolean;
	cachedDecisionsHit: boolean;
	error?: string;
}

export const BRANCH_ROLLBACK_TOLERANCE_MS = 5000;
const DECISIONS_TAIL_LIMIT = 15;
const PROJECT_SKILLS_DIRS = [".agents/skills", ".pi/skills", ".claude/skills", ".cursor/skills"];

function sanitizeSlug(s: string): string {
	return String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "task";
}

export function repoKeyForBus(repoPath: string): string {
	const absRepo = path.resolve(repoPath);
	const hash = crypto.createHash("sha256").update(absRepo).digest("hex").slice(0, 8);
	return `${sanitizeSlug(path.basename(absRepo))}-${hash}`;
}

export function emptyBucketCounts(): Record<WorktreeBucket, number> {
	return {
		primary: 0,
		active_hold: 0,
		keep_dirty: 0,
		safe_to_prune: 0,
		safe_to_prune_detached: 0,
		review_unmerged: 0,
	};
}

function parseDecisionsTsvTail(raw: string, limit = DECISIONS_TAIL_LIMIT): DecisionRow[] {
	const lines = raw
		.split(/\r?\n/)
		.map((l) => l.trimEnd())
		.filter(Boolean);
	if (lines.length === 0) return [];
	const startIdx = /^ts\tunit\tphase\tdecision\b/i.test(lines[0]) ? 1 : 0;
	const dataLines = lines.slice(startIdx).slice(-limit);
	return dataLines.map((line) => {
		const cols = line.split("\t");
		return {
			ts: cols[0] ?? "",
			unit: cols[1] ?? "",
			phase: cols[2] ?? "",
			decision: cols[3] ?? "",
			why: cols[4] ?? "",
			evidence: cols[5] ?? "",
			result: cols[6] ?? "",
		};
	});
}

function findVerifySkill(cwd: string): { hasVerifySkill: boolean; verifySkillPath?: string } {
	for (const relDir of PROJECT_SKILLS_DIRS) {
		const skillsDir = path.join(cwd, relDir);
		if (!fs.existsSync(skillsDir)) continue;
		try {
			for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
				if (!entry.isDirectory() || !entry.name.startsWith("verify-")) continue;
				const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
				if (fs.existsSync(skillMd)) {
					return { hasVerifySkill: true, verifySkillPath: skillMd };
				}
			}
		} catch {}
	}
	return { hasVerifySkill: false };
}

export class BusSyncReader {
	private stateCache = new Map<string, { mtimeMs: number; size: number; data: BusStateDisk }>();
	private tsvCache = new Map<string, { mtimeMs: number; size: number; rows: DecisionRow[] }>();
	private projectCache = new Map<string, { mtimeMs: number; exists: boolean; data: ProjectConfigSnapshot }>();

	hydrateBus(busDir: string, branchEntryTs = 0): BusHydrationResult {
		const absBus = path.resolve(busDir);
		const statePath = path.join(absBus, "state.json");
		const tsvPath = path.join(absBus, "decisions.tsv");

		let state: BusStateDisk | null = null;
		let cachedStateHit = false;
		let error: string | undefined;

		if (fs.existsSync(statePath)) {
			try {
				const st = fs.statSync(statePath);
				const cached = this.stateCache.get(statePath);
				if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
					state = cached.data;
					cachedStateHit = true;
				} else {
					const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as BusStateDisk;
					this.stateCache.set(statePath, { mtimeMs: st.mtimeMs, size: st.size, data: parsed });
					state = parsed;
				}
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			}
		}

		let decisionsTail: DecisionRow[] = [];
		let cachedDecisionsHit = false;
		if (fs.existsSync(tsvPath)) {
			try {
				const st = fs.statSync(tsvPath);
				const cached = this.tsvCache.get(tsvPath);
				if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
					decisionsTail = cached.rows;
					cachedDecisionsHit = true;
				} else {
					const rows = parseDecisionsTsvTail(fs.readFileSync(tsvPath, "utf8"), DECISIONS_TAIL_LIMIT);
					this.tsvCache.set(tsvPath, { mtimeMs: st.mtimeMs, size: st.size, rows });
					decisionsTail = rows;
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				error = error ? `${error}; ${msg}` : msg;
			}
		}

		const diskUpdatedAtMs = state?.updatedAt ? Date.parse(String(state.updatedAt)) : Number.NaN;
		const busAheadOfBranch =
			Number.isFinite(diskUpdatedAtMs) && diskUpdatedAtMs > branchEntryTs + BRANCH_ROLLBACK_TOLERANCE_MS;

		return {
			busDir: absBus,
			state,
			decisionsTail,
			busAheadOfBranch,
			diskUpdatedAtMs: Number.isFinite(diskUpdatedAtMs) ? diskUpdatedAtMs : 0,
			branchEntryTs,
			cachedStateHit,
			cachedDecisionsHit,
			...(error ? { error } : {}),
		};
	}

	readProjectConfig(cwd: string): ProjectConfigSnapshot {
		const absCwd = path.resolve(cwd || process.cwd());
		const cfgPath = path.join(absCwd, ".agents", "zee.project.json");
		const exists = fs.existsSync(cfgPath);
		const verifyInfo = findVerifySkill(absCwd);

		if (!exists) {
			const snap: ProjectConfigSnapshot = {
				exists: false,
				trustLevel: "T1",
				hasVerifySkill: verifyInfo.hasVerifySkill,
				verifySkillPath: verifyInfo.verifySkillPath,
				riskPaths: [],
				uiGlobs: [],
				denyCommands: [],
				testCmds: [],
			};
			return snap;
		}

		try {
			const st = fs.statSync(cfgPath);
			const cached = this.projectCache.get(cfgPath);
			if (cached && cached.exists && cached.mtimeMs === st.mtimeMs) {
				return {
					...cached.data,
					hasVerifySkill: verifyInfo.hasVerifySkill,
					verifySkillPath: verifyInfo.verifySkillPath,
				};
			}
			const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
			const snap: ProjectConfigSnapshot = {
				exists: true,
				trustLevel: isValidTrustLevel(raw.trustLevel) ? raw.trustLevel : "T1",
				hasVerifySkill: verifyInfo.hasVerifySkill,
				verifySkillPath: verifyInfo.verifySkillPath,
				riskPaths: Array.isArray(raw.riskPaths) ? raw.riskPaths.map(String) : [],
				uiGlobs: Array.isArray(raw.uiGlobs) ? raw.uiGlobs.map(String) : [],
				denyCommands: Array.isArray(raw.denyCommands) ? raw.denyCommands.map(String) : [],
				testCmds: Array.isArray(raw.testCmds) ? raw.testCmds.map(String) : [],
				lintCmd: typeof raw.lintCmd === "string" ? raw.lintCmd : undefined,
				buildCmd: typeof raw.buildCmd === "string" ? raw.buildCmd : undefined,
			};
			this.projectCache.set(cfgPath, { mtimeMs: st.mtimeMs, exists: true, data: snap });
			return snap;
		} catch {
			return {
				exists: true,
				trustLevel: "T1",
				hasVerifySkill: verifyInfo.hasVerifySkill,
				verifySkillPath: verifyInfo.verifySkillPath,
				riskPaths: [],
				uiGlobs: [],
				denyCommands: [],
				testCmds: [],
			};
		}
	}

	findLatestRepoBus(repoRoot: string): string | undefined {
		const repoRunDir = path.join(RUNS_ROOT, repoKeyForBus(repoRoot));
		if (!fs.existsSync(repoRunDir)) return undefined;
		try {
			let bestDir: string | undefined;
			let bestTs = -1;
			for (const entry of fs.readdirSync(repoRunDir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const busDir = path.join(repoRunDir, entry.name);
				const statePath = path.join(busDir, "state.json");
				if (!fs.existsSync(statePath)) continue;
				try {
					const st = fs.statSync(statePath);
					if (st.mtimeMs > bestTs) {
						bestTs = st.mtimeMs;
						bestDir = busDir;
					}
				} catch {}
			}
			return bestDir;
		} catch {
			return undefined;
		}
	}

	clearCache(): void {
		this.stateCache.clear();
		this.tsvCache.clear();
		this.projectCache.clear();
	}
}

export function parseWorktreeInventoryJson(rawJson: string, fallbackRepoRoot: string): WorktreeInventory {
	const counts = emptyBucketCounts();
	try {
		const parsed = JSON.parse(rawJson) as {
			ok?: boolean;
			repoRoot?: string;
			baseRef?: string;
			worktrees?: WorktreeEntry[];
		};
		const worktrees = Array.isArray(parsed.worktrees) ? parsed.worktrees : [];
		for (const wt of worktrees) {
			if (wt && wt.bucket in counts) {
				counts[wt.bucket] += 1;
			}
		}
		return {
			ok: Boolean(parsed.ok),
			repoRoot: parsed.repoRoot || fallbackRepoRoot,
			baseRef: parsed.baseRef,
			worktrees,
			bucketCounts: counts,
			fetchedAt: Date.now(),
		};
	} catch (e) {
		return {
			ok: false,
			repoRoot: fallbackRepoRoot,
			worktrees: [],
			bucketCounts: counts,
			fetchedAt: Date.now(),
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

/**
 * 异步执行 zee-tool.mjs cleanup-worktrees 获取 6 桶盘点结果，绝不阻塞 UI render(width)。
 */
export async function fetchWorktreeInventoryAsync(
	cwd: string,
	zeeToolPath: string,
	timeoutMs = 5000,
): Promise<WorktreeInventory> {
	const absCwd = path.resolve(cwd || process.cwd());
	try {
		const { stdout } = await execFileAsync(process.execPath, [zeeToolPath, "cleanup-worktrees", absCwd], {
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: 4 * 1024 * 1024,
		});
		return parseWorktreeInventoryJson(stdout, absCwd);
	} catch (e) {
		const errObj = e as { stdout?: string; stderr?: string; message?: string };
		if (typeof errObj?.stdout === "string" && errObj.stdout.trim().startsWith("{")) {
			return parseWorktreeInventoryJson(errObj.stdout, absCwd);
		}
		return {
			ok: false,
			repoRoot: absCwd,
			worktrees: [],
			bucketCounts: emptyBucketCounts(),
			fetchedAt: Date.now(),
			error: errObj?.stderr?.trim() || errObj?.message || String(e),
		};
	}
}

export async function pruneSafeWorktreesAsync(
	cwd: string,
	zeeToolPath: string,
	timeoutMs = 10000,
): Promise<{ ok: boolean; prunedCount: number; inventory: WorktreeInventory; error?: string }> {
	const absCwd = path.resolve(cwd || process.cwd());
	try {
		const { stdout } = await execFileAsync(
			process.execPath,
			[zeeToolPath, "cleanup-worktrees", absCwd, "--prune-safe"],
			{
				encoding: "utf8",
				timeout: timeoutMs,
				maxBuffer: 4 * 1024 * 1024,
			},
		);
		const parsed = JSON.parse(stdout) as { prunedCount?: number };
		const inventory = parseWorktreeInventoryJson(stdout, absCwd);
		return {
			ok: inventory.ok,
			prunedCount: Number(parsed.prunedCount) || 0,
			inventory,
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			ok: false,
			prunedCount: 0,
			inventory: {
				ok: false,
				repoRoot: absCwd,
				worktrees: [],
				bucketCounts: emptyBucketCounts(),
				fetchedAt: Date.now(),
				error: msg,
			},
			error: msg,
		};
	}
}

export function readPartialArtifactPreview(filePath: string, maxChars = 16384): { ok: boolean; content: string } {
	try {
		if (!filePath || !fs.existsSync(filePath)) {
			return { ok: false, content: `(未找到抢救文件：${filePath || "<empty>"})` };
		}
		const raw = fs.readFileSync(filePath, "utf8");
		if (raw.length <= maxChars) {
			return { ok: true, content: raw };
		}
		return {
			ok: true,
			content: `${raw.slice(0, maxChars)}\n\n... [已截断，仅展示前 ${maxChars} 字符，完整文件：${filePath}]`,
		};
	} catch (e) {
		return { ok: false, content: `(读取抢救文件失败：${e instanceof Error ? e.message : String(e)})` };
	}
}
