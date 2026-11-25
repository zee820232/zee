/**
 * zee Pi v1.6.1 Dual-Axis Workflow & Worker Lane FSM (v4.2.0)
 *
 * 纯 TypeScript 状态机核：零 Pi 运行时 / TUI / Node fs 依赖，100% 可单测。
 * - Axis 1 (WorkflowPhase): 14 个工作流阶段状态
 * - Axis 2 (WorkerLanePhase): 9 个子代理车道状态
 * - Guards G-01..G-06: 写锁越权、Gate1->Gate2 前置、同家族拦截、70% 截断收口、风险等级单调递增、只读越权/递归隔离
 * - Ring Buffers: history 与 violations 各保留最近 30 条
 */

export type ZeeMode = "off" | "auto" | "strict";
export type GateMode = "none" | "plan" | "review" | "init-design";
export type ZeeTrack =
	| "direct"
	| "build"
	| "init"
	| "plan"
	| "review"
	| "verify"
	| "arch"
	| "retro"
	| "night"
	| "triage"
	| "recall";
export type RiskLevel = "L0" | "L1" | "L2" | "L3";
export type TrustLevel = "T1" | "T2" | "T3";

export type WorkflowPhase =
	| "IDLE"
	| "PREFLIGHT"
	| "SCOUTING"
	| "PLANNING"
	| "INIT_DESIGN"
	| "AWAITING_APPROVAL"
	| "EXECUTING"
	| "VERIFYING"
	| "REVIEWING"
	| "MERGING"
	| "CUTOFF_CLOSING"
	| "COMPLETED"
	| "PAUSED"
	| "BLOCKED";

export type WorkerLanePhase =
	| "QUEUED"
	| "PREPARING_WT"
	| "RUNNING"
	| "STALLED_WARN"
	| "COMPLETED"
	| "PARTIAL_SALVAGED"
	| "ROLE_VIOLATION"
	| "FAILED"
	| "ABORTED";

export type GuardId = "G-01" | "G-02" | "G-03" | "G-04" | "G-05" | "G-06";

export interface WorkerLaneState {
	id: string;
	lane: string;
	role: string;
	phase: WorkerLanePhase;
	provider?: string;
	model?: string;
	family?: string;
	pinnedSha?: string;
	branch?: string;
	worktreePath?: string;
	startedAt: number;
	updatedAt: number;
	finishedAt?: number;
	lastEventAt?: number;
	turns: number;
	cost: number;
	inputTokens?: number;
	outputTokens?: number;
	streamChars?: number;
	inFlightTool?: string;
	inFlightSince?: number;
	stallReason?: string;
	lastActions: string[];
	partialArtifactPath?: string;
	roleViolation?: boolean;
	budgetCutoffTriggered?: boolean;
	errorMessage?: string;
}

export interface GateRecord {
	gate: 1 | 2;
	role: "verifier" | "reviewer" | "judge";
	verdict: "PASS" | "FAIL" | "REVISE" | "INCONCLUSIVE";
	pinnedSha: string;
	family?: string;
	ts: number;
	summary?: string;
}

export interface FsmTransition {
	ts: number;
	fromPhase: WorkflowPhase;
	toPhase: WorkflowPhase;
	eventType: string;
	reason?: string;
}

export interface ViolationRecord {
	ts: number;
	guard: GuardId;
	severity: "block" | "warn";
	message: string;
	detail?: string;
}

export interface ZeeFsmPersistedSnapshot {
	version: 1;
	routingMode: ZeeMode;
	writeGate: GateMode;
	track: ZeeTrack;
	phase: WorkflowPhase;
	riskLevel: RiskLevel;
	trustLevel: TrustLevel;
	slug?: string;
	busDir?: string;
	integrationBranch?: string;
	pinnedSha?: string;
	budgetDispatched: number;
	budgetMaxDelegates: number;
	budgetCutoffRatio: number;
	budgetCutoffActive: boolean;
	abortedDelegates: number;
	totalCost: number;
	gate1?: GateRecord;
	gate2?: GateRecord;
	activeWorkers: WorkerLaneState[];
	completedWorkers: WorkerLaneState[];
	history: FsmTransition[];
	violations: ViolationRecord[];
	updatedAt: number;
	lastError?: string;
}

export interface Gate2CheckOptions {
	samplingAllowed?: boolean;
	isRiskSlice?: boolean;
	now?: number;
}

export interface PreconditionResult {
	allowed: boolean;
	severity: "ok" | "warn" | "block";
	reason?: string;
	violation?: ViolationRecord;
}

export type FsmEvent =
	| { type: "SET_ROUTING_MODE"; mode: ZeeMode }
	| { type: "SET_WRITE_GATE"; gate: GateMode; nextPhase?: WorkflowPhase; reason?: string }
	| {
			type: "START_RUN";
			track: ZeeTrack;
			riskLevel?: RiskLevel;
			trustLevel?: TrustLevel;
			slug?: string;
			busDir?: string;
			integrationBranch?: string;
			pinnedSha?: string;
			phase?: WorkflowPhase;
			budgetMaxDelegates?: number;
			budgetCutoffRatio?: number;
	  }
	| { type: "SET_RISK_LEVEL"; riskLevel: RiskLevel; reason?: string }
	| { type: "SET_TRUST_LEVEL"; trustLevel: TrustLevel }
	| { type: "SET_PHASE"; phase: WorkflowPhase; reason?: string; pinnedSha?: string }
	| { type: "SET_PINNED_SHA"; pinnedSha: string }
	| {
			type: "RECORD_GATE_RESULT";
			gate: 1 | 2;
			role: "verifier" | "reviewer" | "judge";
			verdict: "PASS" | "FAIL" | "REVISE" | "INCONCLUSIVE";
			pinnedSha: string;
			family?: string;
			summary?: string;
	  }
	| {
			type: "RECORD_VIOLATION";
			guard: GuardId;
			severity: "block" | "warn";
			message: string;
			detail?: string;
	  }
	| {
			type: "BUDGET_TICK";
			dispatched: number;
			maxDelegates?: number;
			cutoffRatio?: number;
			cutoffTriggered?: boolean;
			abortedDelta?: number;
	  }
	| {
			type: "WORKER_QUEUE";
			worker: {
				id: string;
				lane: string;
				role: string;
				provider?: string;
				model?: string;
				family?: string;
				pinnedSha?: string;
			};
	  }
	| {
			type: "WORKER_PREPARE";
			worker: {
				id: string;
				lane: string;
				role: string;
				provider?: string;
				model?: string;
				family?: string;
				pinnedSha?: string;
			};
			samplingAllowed?: boolean;
			isRiskSlice?: boolean;
	  }
	| {
			type: "WORKER_START";
			id: string;
			worktreePath?: string;
			branch?: string;
			provider?: string;
			model?: string;
			family?: string;
			pinnedSha?: string;
	  }
	| {
			type: "WORKER_PROGRESS";
			id: string;
			turns?: number;
			cost?: number;
			inputTokens?: number;
			outputTokens?: number;
			streamChars?: number;
			inFlightTool?: string;
			inFlightSince?: number;
			lastActions?: string[];
	  }
	| {
			type: "WORKER_STALL_WARN";
			id: string;
			stallReason: string;
	  }
	| {
			type: "WORKER_FINISH";
			id: string;
			outcome?: "completed" | "partial_salvaged" | "role_violation" | "failed" | "aborted";
			status?: string;
			turns?: number;
			cost?: number;
			inputTokens?: number;
			outputTokens?: number;
			lastActions?: string[];
			partialArtifactPath?: string;
			roleViolation?: boolean;
			budgetCutoffTriggered?: boolean;
			errorMessage?: string;
	  }
	| {
			type: "HYDRATE_FROM_BUS";
			slug?: string;
			busDir?: string;
			riskLevel?: RiskLevel;
			dispatched?: number;
			maxDelegates?: number;
			cutoffRatio?: number;
			abortedDelegates?: number;
			status?: string;
	  };

export interface BranchEntryLike {
	type?: string;
	customType?: string;
	timestamp?: string | number;
	data?: unknown;
}

export interface RestoreFsmResult {
	snapshot: ZeeFsmPersistedSnapshot;
	branchEntryTs: number;
	source: "zee-fsm" | "legacy" | "default";
}

export const MAX_HISTORY_LEN = 30;
export const MAX_VIOLATIONS_LEN = 30;
export const MAX_COMPLETED_WORKERS_LEN = 30;

export const WORKFLOW_PHASES: readonly WorkflowPhase[] = [
	"IDLE",
	"PREFLIGHT",
	"SCOUTING",
	"PLANNING",
	"INIT_DESIGN",
	"AWAITING_APPROVAL",
	"EXECUTING",
	"VERIFYING",
	"REVIEWING",
	"MERGING",
	"CUTOFF_CLOSING",
	"COMPLETED",
	"PAUSED",
	"BLOCKED",
];

export const WORKER_LANE_PHASES: readonly WorkerLanePhase[] = [
	"QUEUED",
	"PREPARING_WT",
	"RUNNING",
	"STALLED_WARN",
	"COMPLETED",
	"PARTIAL_SALVAGED",
	"ROLE_VIOLATION",
	"FAILED",
	"ABORTED",
];

export const RISK_ORDER: Record<RiskLevel, number> = {
	L0: 0,
	L1: 1,
	L2: 2,
	L3: 3,
};

const VALID_ZEE_MODES = new Set<ZeeMode>(["off", "auto", "strict"]);
const VALID_GATE_MODES = new Set<GateMode>(["none", "plan", "review", "init-design"]);
const VALID_TRACKS = new Set<ZeeTrack>([
	"direct",
	"build",
	"init",
	"plan",
	"review",
	"verify",
	"arch",
	"retro",
	"night",
	"triage",
	"recall",
]);
const VALID_RISK_LEVELS = new Set<RiskLevel>(["L0", "L1", "L2", "L3"]);
const VALID_TRUST_LEVELS = new Set<TrustLevel>(["T1", "T2", "T3"]);
const VALID_WORKFLOW_PHASES = new Set<WorkflowPhase>(WORKFLOW_PHASES);
const VALID_WORKER_PHASES = new Set<WorkerLanePhase>(WORKER_LANE_PHASES);

const CLOSEOUT_ROLES = new Set(["verifier", "reviewer", "judge"]);
const FEATURE_SLICE_ROLES = new Set(["coder", "ui"]);
const CUTOFF_TRANSITIONABLE_PHASES = new Set<WorkflowPhase>([
	"PREFLIGHT",
	"SCOUTING",
	"PLANNING",
	"INIT_DESIGN",
	"AWAITING_APPROVAL",
	"EXECUTING",
	"VERIFYING",
	"REVIEWING",
	"MERGING",
]);

export function isValidZeeMode(value: unknown): value is ZeeMode {
	return typeof value === "string" && VALID_ZEE_MODES.has(value as ZeeMode);
}

export function isValidGateMode(value: unknown): value is GateMode {
	return typeof value === "string" && VALID_GATE_MODES.has(value as GateMode);
}

export function isValidZeeTrack(value: unknown): value is ZeeTrack {
	return typeof value === "string" && VALID_TRACKS.has(value as ZeeTrack);
}

export function isValidRiskLevel(value: unknown): value is RiskLevel {
	return typeof value === "string" && VALID_RISK_LEVELS.has(value as RiskLevel);
}

export function isValidTrustLevel(value: unknown): value is TrustLevel {
	return typeof value === "string" && VALID_TRUST_LEVELS.has(value as TrustLevel);
}

export function isValidWorkflowPhase(value: unknown): value is WorkflowPhase {
	return typeof value === "string" && VALID_WORKFLOW_PHASES.has(value as WorkflowPhase);
}

export function isValidWorkerLanePhase(value: unknown): value is WorkerLanePhase {
	return typeof value === "string" && VALID_WORKER_PHASES.has(value as WorkerLanePhase);
}

export function compareRiskLevel(a: RiskLevel, b: RiskLevel): number {
	return RISK_ORDER[a] - RISK_ORDER[b];
}

function appendRing<T>(arr: readonly T[], item: T, limit: number): T[] {
	const next = [...arr, item];
	return next.length > limit ? next.slice(next.length - limit) : next;
}

function shaMatches(a: string | undefined, b: string | undefined): boolean {
	const sa = String(a ?? "").trim().toLowerCase();
	const sb = String(b ?? "").trim().toLowerCase();
	if (!sa || !sb) return false;
	if (sa === sb) return true;
	const hexRe = /^[0-9a-f]{7,64}$/;
	if (hexRe.test(sa) && hexRe.test(sb)) {
		return sa.startsWith(sb) || sb.startsWith(sa);
	}
	return false;
}

function phaseForGate(gate: GateMode): WorkflowPhase {
	if (gate === "plan") return "PLANNING";
	if (gate === "init-design") return "INIT_DESIGN";
	if (gate === "review") return "REVIEWING";
	return "IDLE";
}

function withTransition(
	prev: ZeeFsmPersistedSnapshot,
	next: ZeeFsmPersistedSnapshot,
	toPhase: WorkflowPhase,
	eventType: string,
	now: number,
	reason?: string,
): ZeeFsmPersistedSnapshot {
	if (prev.phase === toPhase) {
		return { ...next, phase: toPhase, updatedAt: now };
	}
	return {
		...next,
		phase: toPhase,
		updatedAt: now,
		history: appendRing(
			next.history,
			{
				ts: now,
				fromPhase: prev.phase,
				toPhase,
				eventType,
				...(reason ? { reason } : {}),
			},
			MAX_HISTORY_LEN,
		),
	};
}

export function createInitialFsmSnapshot(flagMode?: unknown, now = 0): ZeeFsmPersistedSnapshot {
	return {
		version: 1,
		routingMode: isValidZeeMode(flagMode) ? flagMode : "off",
		writeGate: "none",
		track: "direct",
		phase: "IDLE",
		riskLevel: "L0",
		trustLevel: "T1",
		budgetDispatched: 0,
		budgetMaxDelegates: 40,
		budgetCutoffRatio: 0.7,
		budgetCutoffActive: false,
		abortedDelegates: 0,
		totalCost: 0,
		activeWorkers: [],
		completedWorkers: [],
		history: [],
		violations: [],
		updatedAt: now,
	};
}

/**
 * G-02 前置检查：在 L2 / L3 / night（且非独立只读 /zee-review 轨道）派发 reviewer 时，
 * 必须先在同 pinnedSha 上取得 Gate 1 (Verifier) PASS；除非处于 T2/T3 且显式允许非高危切片抽检。
 */
export function checkGate2Precondition(
	snap: ZeeFsmPersistedSnapshot,
	targetSha?: string,
	opts?: Gate2CheckOptions,
): PreconditionResult {
	const needsGate1 =
		snap.track !== "review" && (snap.riskLevel === "L2" || snap.riskLevel === "L3" || snap.track === "night");
	if (!needsGate1) {
		return { allowed: true, severity: "ok" };
	}

	if (
		(snap.trustLevel === "T2" || snap.trustLevel === "T3") &&
		opts?.samplingAllowed === true &&
		opts?.isRiskSlice !== true
	) {
		return { allowed: true, severity: "ok" };
	}

	const expectedSha = targetSha?.trim() || snap.pinnedSha?.trim() || "";
	const gate1 = snap.gate1;
	const hasPass = gate1?.verdict === "PASS";
	const shaOk = expectedSha ? shaMatches(gate1?.pinnedSha, expectedSha) : Boolean(gate1?.pinnedSha);

	if (hasPass && shaOk) {
		return { allowed: true, severity: "ok" };
	}

	const shaDesc = expectedSha || "<unset>";
	const detail = !hasPass
		? `gate1=${gate1?.verdict ?? "missing"}`
		: `gate1.sha=${gate1?.pinnedSha ?? "none"} != target=${shaDesc}`;
	const reason = `[G-02] ${snap.riskLevel}/${snap.track} 派发 Gate 2 Reviewer 前必须先在同一 PINNED_SHA (${shaDesc}) 通过 Gate 1 Verifier PASS（当前：${detail}）。`;
	const now = opts?.now ?? Date.now();
	const severity: "block" | "warn" = snap.routingMode === "strict" ? "block" : "warn";
	const violation: ViolationRecord = {
		ts: now,
		guard: "G-02",
		severity,
		message: reason,
		detail,
	};

	if (snap.routingMode === "strict") {
		return { allowed: false, severity: "block", reason, violation };
	}
	return { allowed: true, severity: "warn", reason, violation };
}

/**
 * G-04 预算截断检查：进入 CUTOFF_CLOSING / budgetCutoffActive 后，
 * 拦截/告警新开 coder/ui 功能切片，放行 verifier/reviewer/judge 收口角色。
 */
export function checkCutoffPrecondition(
	snap: ZeeFsmPersistedSnapshot,
	role: string,
	now = Date.now(),
): PreconditionResult {
	const active = snap.budgetCutoffActive || snap.phase === "CUTOFF_CLOSING";
	if (!active) {
		return { allowed: true, severity: "ok" };
	}

	const normRole = role.trim().toLowerCase();
	if (CLOSEOUT_ROLES.has(normRole) || !FEATURE_SLICE_ROLES.has(normRole)) {
		return { allowed: true, severity: "ok" };
	}

	const reason = `[G-04] 已进入 CUTOFF_CLOSING 预算截断收口期（${snap.budgetDispatched}/${snap.budgetMaxDelegates}），禁止再开 "${normRole}" 功能切片，请派发 verifier/reviewer/judge 收口。`;
	const severity: "block" | "warn" = snap.routingMode === "strict" ? "block" : "warn";
	const violation: ViolationRecord = {
		ts: now,
		guard: "G-04",
		severity,
		message: reason,
		detail: `role=${normRole}`,
	};

	if (snap.routingMode === "strict") {
		return { allowed: false, severity: "block", reason, violation };
	}
	return { allowed: true, severity: "warn", reason, violation };
}

function upsertActiveWorker(workers: readonly WorkerLaneState[], entry: WorkerLaneState): WorkerLaneState[] {
	const idx = workers.findIndex((w) => w.id === entry.id);
	if (idx >= 0) {
		const copy = [...workers];
		copy[idx] = entry;
		return copy;
	}
	return [...workers, entry];
}

export function reduceFsm(
	prev: ZeeFsmPersistedSnapshot,
	evt: FsmEvent,
	now = Date.now(),
): ZeeFsmPersistedSnapshot {
	switch (evt.type) {
		case "SET_ROUTING_MODE": {
			if (!isValidZeeMode(evt.mode)) return prev;
			let next: ZeeFsmPersistedSnapshot = {
				...prev,
				routingMode: evt.mode,
				updatedAt: now,
			};
			if (evt.mode === "off" && prev.writeGate !== "none") {
				next = { ...next, writeGate: "none" };
				if (prev.phase === "PLANNING" || prev.phase === "INIT_DESIGN" || prev.phase === "REVIEWING") {
					next = withTransition(prev, next, "IDLE", evt.type, now, "routing mode off");
				}
			}
			return next;
		}

		case "SET_WRITE_GATE": {
			if (!isValidGateMode(evt.gate)) return prev;
			let next: ZeeFsmPersistedSnapshot = {
				...prev,
				writeGate: evt.gate,
				updatedAt: now,
			};
			let targetPhase = prev.phase;
			if (evt.nextPhase && isValidWorkflowPhase(evt.nextPhase)) {
				targetPhase = evt.nextPhase;
			} else if (evt.gate !== "none") {
				targetPhase = phaseForGate(evt.gate);
			} else if (prev.phase === "PLANNING" || prev.phase === "INIT_DESIGN" || prev.phase === "REVIEWING") {
				targetPhase = prev.activeWorkers.length > 0 ? "EXECUTING" : "IDLE";
			}
			return withTransition(prev, next, targetPhase, evt.type, now, evt.reason ?? `gate=${evt.gate}`);
		}

		case "START_RUN": {
			const track = isValidZeeTrack(evt.track) ? evt.track : prev.track;
			const isSameActiveRun =
				prev.phase !== "IDLE" &&
				prev.phase !== "COMPLETED" &&
				(!evt.slug || !prev.slug || evt.slug === prev.slug);

			let nextRisk: RiskLevel = prev.riskLevel === "L0" && !isSameActiveRun ? "L1" : prev.riskLevel;
			let violations = prev.violations;
			if (evt.riskLevel && isValidRiskLevel(evt.riskLevel)) {
				if (isSameActiveRun && compareRiskLevel(evt.riskLevel, prev.riskLevel) < 0) {
					violations = appendRing(
						violations,
						{
							ts: now,
							guard: "G-05",
							severity: "warn",
							message: `[G-05] 风险等级单调递增不变量：拒绝在运行中将 ${prev.riskLevel} 降级为 ${evt.riskLevel}。`,
							detail: `${prev.riskLevel}->${evt.riskLevel}`,
						},
						MAX_VIOLATIONS_LEN,
					);
					nextRisk = prev.riskLevel;
				} else {
					nextRisk = evt.riskLevel;
				}
			}

			const trustLevel = evt.trustLevel && isValidTrustLevel(evt.trustLevel) ? evt.trustLevel : prev.trustLevel;
			const maxDelegates = evt.budgetMaxDelegates ?? (track === "night" ? 12 : isSameActiveRun ? prev.budgetMaxDelegates : 40);
			const cutoffRatio = evt.budgetCutoffRatio ?? prev.budgetCutoffRatio ?? 0.7;
			const targetPhase = evt.phase && isValidWorkflowPhase(evt.phase) ? evt.phase : "PREFLIGHT";

			const next: ZeeFsmPersistedSnapshot = {
				...prev,
				track,
				riskLevel: nextRisk,
				trustLevel,
				slug: evt.slug ?? (isSameActiveRun ? prev.slug : undefined),
				busDir: evt.busDir ?? (isSameActiveRun ? prev.busDir : undefined),
				integrationBranch: evt.integrationBranch ?? (isSameActiveRun ? prev.integrationBranch : undefined),
				pinnedSha: evt.pinnedSha ?? (isSameActiveRun ? prev.pinnedSha : undefined),
				budgetMaxDelegates: Math.max(1, maxDelegates),
				budgetCutoffRatio: Math.min(0.95, Math.max(0.5, cutoffRatio)),
				budgetDispatched: isSameActiveRun ? prev.budgetDispatched : 0,
				budgetCutoffActive: isSameActiveRun ? prev.budgetCutoffActive : false,
				abortedDelegates: isSameActiveRun ? prev.abortedDelegates : 0,
				totalCost: isSameActiveRun ? prev.totalCost : 0,
				gate1: isSameActiveRun ? prev.gate1 : undefined,
				gate2: isSameActiveRun ? prev.gate2 : undefined,
				violations,
				updatedAt: now,
			};
			return withTransition(prev, next, targetPhase, evt.type, now, `track=${track} risk=${nextRisk}`);
		}

		case "SET_RISK_LEVEL": {
			if (!isValidRiskLevel(evt.riskLevel)) return prev;
			const inRun = prev.phase !== "IDLE";
			if (inRun && compareRiskLevel(evt.riskLevel, prev.riskLevel) < 0) {
				return {
					...prev,
					updatedAt: now,
					violations: appendRing(
						prev.violations,
						{
							ts: now,
							guard: "G-05",
							severity: "warn",
							message: `[G-05] 风险等级单调递增不变量：禁止从 ${prev.riskLevel} 降级至 ${evt.riskLevel}。`,
							detail: evt.reason ?? `${prev.riskLevel}->${evt.riskLevel}`,
						},
						MAX_VIOLATIONS_LEN,
					),
				};
			}
			return {
				...prev,
				riskLevel: evt.riskLevel,
				updatedAt: now,
			};
		}

		case "SET_TRUST_LEVEL": {
			if (!isValidTrustLevel(evt.trustLevel)) return prev;
			return {
				...prev,
				trustLevel: evt.trustLevel,
				updatedAt: now,
			};
		}

		case "SET_PHASE": {
			if (!isValidWorkflowPhase(evt.phase)) return prev;
			const next: ZeeFsmPersistedSnapshot = {
				...prev,
				pinnedSha: evt.pinnedSha ?? prev.pinnedSha,
				budgetCutoffActive: evt.phase === "CUTOFF_CLOSING" ? true : prev.budgetCutoffActive,
				updatedAt: now,
			};
			return withTransition(prev, next, evt.phase, evt.type, now, evt.reason);
		}

		case "SET_PINNED_SHA": {
			const sha = evt.pinnedSha.trim();
			if (!sha) return prev;
			return {
				...prev,
				pinnedSha: sha,
				updatedAt: now,
			};
		}

		case "RECORD_GATE_RESULT": {
			const record: GateRecord = {
				gate: evt.gate,
				role: evt.role,
				verdict: evt.verdict,
				pinnedSha: evt.pinnedSha,
				...(evt.family ? { family: evt.family } : {}),
				ts: now,
				...(evt.summary ? { summary: evt.summary } : {}),
			};
			return {
				...prev,
				...(evt.gate === 1 ? { gate1: record } : { gate2: record }),
				pinnedSha: evt.pinnedSha || prev.pinnedSha,
				updatedAt: now,
			};
		}

		case "RECORD_VIOLATION": {
			return {
				...prev,
				violations: appendRing(
					prev.violations,
					{
						ts: now,
						guard: evt.guard,
						severity: evt.severity,
						message: evt.message,
						...(evt.detail ? { detail: evt.detail } : {}),
					},
					MAX_VIOLATIONS_LEN,
				),
				updatedAt: now,
			};
		}

		case "BUDGET_TICK": {
			const maxDelegates = Math.max(1, evt.maxDelegates ?? prev.budgetMaxDelegates);
			const cutoffRatio = Math.min(0.95, Math.max(0.5, evt.cutoffRatio ?? prev.budgetCutoffRatio));
			const cutoffAt = Math.max(1, Math.ceil(maxDelegates * cutoffRatio));
			const dispatched = Math.max(0, evt.dispatched);
			const cutoffActive = prev.budgetCutoffActive || Boolean(evt.cutoffTriggered) || dispatched >= cutoffAt;
			let next: ZeeFsmPersistedSnapshot = {
				...prev,
				budgetDispatched: dispatched,
				budgetMaxDelegates: maxDelegates,
				budgetCutoffRatio: cutoffRatio,
				budgetCutoffActive: cutoffActive,
				abortedDelegates: prev.abortedDelegates + (evt.abortedDelta ?? 0),
				updatedAt: now,
			};
			if (cutoffActive && CUTOFF_TRANSITIONABLE_PHASES.has(prev.phase)) {
				next = withTransition(
					prev,
					next,
					"CUTOFF_CLOSING",
					evt.type,
					now,
					`cutoff ${dispatched}/${maxDelegates} >= ${cutoffAt}`,
				);
			}
			return next;
		}

		case "WORKER_QUEUE": {
			const laneState: WorkerLaneState = {
				id: evt.worker.id,
				lane: evt.worker.lane,
				role: evt.worker.role,
				phase: "QUEUED",
				provider: evt.worker.provider,
				model: evt.worker.model,
				family: evt.worker.family,
				pinnedSha: evt.worker.pinnedSha,
				startedAt: now,
				updatedAt: now,
				lastEventAt: now,
				turns: 0,
				cost: 0,
				lastActions: [],
			};
			return {
				...prev,
				activeWorkers: upsertActiveWorker(prev.activeWorkers, laneState),
				updatedAt: now,
			};
		}

		case "WORKER_PREPARE": {
			const role = evt.worker.role.trim().toLowerCase();
			let violations = prev.violations;
			let lastError = prev.lastError;

			const cutoffRes = checkCutoffPrecondition(prev, role, now);
			if (cutoffRes.violation) {
				violations = appendRing(violations, cutoffRes.violation, MAX_VIOLATIONS_LEN);
				if (!cutoffRes.allowed) lastError = cutoffRes.reason;
			}

			if (role === "reviewer") {
				const g2Res = checkGate2Precondition(prev, evt.worker.pinnedSha, {
					samplingAllowed: evt.samplingAllowed,
					isRiskSlice: evt.isRiskSlice,
					now,
				});
				if (g2Res.violation) {
					violations = appendRing(violations, g2Res.violation, MAX_VIOLATIONS_LEN);
					if (!g2Res.allowed) lastError = g2Res.reason;
				}
			}

			const existing = prev.activeWorkers.find((w) => w.id === evt.worker.id);
			const laneState: WorkerLaneState = {
				id: evt.worker.id,
				lane: evt.worker.lane,
				role: evt.worker.role,
				phase: "PREPARING_WT",
				provider: evt.worker.provider ?? existing?.provider,
				model: evt.worker.model ?? existing?.model,
				family: evt.worker.family ?? existing?.family,
				pinnedSha: evt.worker.pinnedSha ?? existing?.pinnedSha,
				startedAt: existing?.startedAt ?? now,
				updatedAt: now,
				lastEventAt: now,
				turns: existing?.turns ?? 0,
				cost: existing?.cost ?? 0,
				lastActions: existing?.lastActions ?? [],
			};
			return {
				...prev,
				activeWorkers: upsertActiveWorker(prev.activeWorkers, laneState),
				violations,
				lastError,
				updatedAt: now,
			};
		}

		case "WORKER_START": {
			const existing = prev.activeWorkers.find((w) => w.id === evt.id);
			const base: WorkerLaneState = existing ?? {
				id: evt.id,
				lane: evt.id,
				role: "worker",
				phase: "RUNNING",
				startedAt: now,
				updatedAt: now,
				turns: 0,
				cost: 0,
				lastActions: [],
			};
			const updated: WorkerLaneState = {
				...base,
				phase: "RUNNING",
				worktreePath: evt.worktreePath ?? base.worktreePath,
				branch: evt.branch ?? base.branch,
				provider: evt.provider ?? base.provider,
				model: evt.model ?? base.model,
				family: evt.family ?? base.family,
				pinnedSha: evt.pinnedSha ?? base.pinnedSha,
				stallReason: undefined,
				updatedAt: now,
				lastEventAt: now,
			};
			return {
				...prev,
				activeWorkers: upsertActiveWorker(prev.activeWorkers, updated),
				updatedAt: now,
			};
		}

		case "WORKER_PROGRESS": {
			const existing = prev.activeWorkers.find((w) => w.id === evt.id);
			if (!existing) return prev;
			const updated: WorkerLaneState = {
				...existing,
				phase: "RUNNING",
				stallReason: undefined,
				turns: evt.turns ?? existing.turns,
				cost: evt.cost ?? existing.cost,
				inputTokens: evt.inputTokens ?? existing.inputTokens,
				outputTokens: evt.outputTokens ?? existing.outputTokens,
				streamChars: evt.streamChars ?? existing.streamChars,
				inFlightTool: evt.inFlightTool,
				inFlightSince: evt.inFlightSince,
				lastActions: evt.lastActions ? [...evt.lastActions] : existing.lastActions,
				updatedAt: now,
				lastEventAt: now,
			};
			return {
				...prev,
				activeWorkers: upsertActiveWorker(prev.activeWorkers, updated),
				updatedAt: now,
			};
		}

		case "WORKER_STALL_WARN": {
			const existing = prev.activeWorkers.find((w) => w.id === evt.id);
			if (!existing) return prev;
			const updated: WorkerLaneState = {
				...existing,
				phase: "STALLED_WARN",
				stallReason: evt.stallReason,
				updatedAt: now,
			};
			return {
				...prev,
				activeWorkers: upsertActiveWorker(prev.activeWorkers, updated),
				updatedAt: now,
			};
		}

		case "WORKER_FINISH": {
			const existing = prev.activeWorkers.find((w) => w.id === evt.id);
			const remaining = prev.activeWorkers.filter((w) => w.id !== evt.id);
			const base: WorkerLaneState = existing ?? {
				id: evt.id,
				lane: evt.id,
				role: "worker",
				phase: "RUNNING",
				startedAt: now,
				updatedAt: now,
				turns: 0,
				cost: 0,
				lastActions: [],
			};

			let terminalPhase: WorkerLanePhase;
			if (evt.outcome === "role_violation" || evt.roleViolation) {
				terminalPhase = "ROLE_VIOLATION";
			} else if (evt.outcome === "partial_salvaged") {
				terminalPhase = "PARTIAL_SALVAGED";
			} else if (evt.outcome === "aborted") {
				terminalPhase = "ABORTED";
			} else if (evt.outcome === "failed") {
				terminalPhase = "FAILED";
			} else if (evt.outcome === "completed") {
				terminalPhase = "COMPLETED";
			} else if (
				evt.partialArtifactPath ||
				evt.status === "timeout" ||
				evt.status === "idle_timeout" ||
				evt.status === "stagnancy_loop"
			) {
				terminalPhase = "PARTIAL_SALVAGED";
			} else if (evt.status === "aborted") {
				terminalPhase = "ABORTED";
			} else if (evt.status === "failed") {
				terminalPhase = "FAILED";
			} else {
				terminalPhase = "COMPLETED";
			}

			const finalCost = evt.cost ?? base.cost;
			const costDelta = Math.max(0, finalCost);

			const finished: WorkerLaneState = {
				...base,
				phase: terminalPhase,
				turns: evt.turns ?? base.turns,
				cost: finalCost,
				inputTokens: evt.inputTokens ?? base.inputTokens,
				outputTokens: evt.outputTokens ?? base.outputTokens,
				lastActions: evt.lastActions ? [...evt.lastActions] : base.lastActions,
				partialArtifactPath: evt.partialArtifactPath ?? base.partialArtifactPath,
				roleViolation: evt.roleViolation ?? base.roleViolation,
				budgetCutoffTriggered: evt.budgetCutoffTriggered ?? base.budgetCutoffTriggered,
				errorMessage: evt.errorMessage ?? base.errorMessage,
				inFlightTool: undefined,
				inFlightSince: undefined,
				stallReason: undefined,
				finishedAt: now,
				updatedAt: now,
			};

			let violations = prev.violations;
			if (terminalPhase === "ROLE_VIOLATION") {
				violations = appendRing(
					violations,
					{
						ts: now,
						guard: "G-06",
						severity: "warn",
						message: `[G-06] 只读/门禁子代理 (${base.role}) 越权修改工作区，已触发脏区回滚与 ROLE_VIOLATION。`,
						detail: `lane=${base.lane}`,
					},
					MAX_VIOLATIONS_LEN,
				);
			}

			return {
				...prev,
				activeWorkers: remaining,
				completedWorkers: appendRing(prev.completedWorkers, finished, MAX_COMPLETED_WORKERS_LEN),
				totalCost: prev.totalCost + costDelta,
				violations,
				updatedAt: now,
			};
		}

		case "HYDRATE_FROM_BUS": {
			let nextRisk = prev.riskLevel;
			let violations = prev.violations;
			if (evt.riskLevel && isValidRiskLevel(evt.riskLevel)) {
				if (prev.phase !== "IDLE" && compareRiskLevel(evt.riskLevel, prev.riskLevel) < 0) {
					violations = appendRing(
						violations,
						{
							ts: now,
							guard: "G-05",
							severity: "warn",
							message: `[G-05] 总线状态风险等级 ${evt.riskLevel} 低于当前 ${prev.riskLevel}，已保留较高风险等级。`,
						},
						MAX_VIOLATIONS_LEN,
					);
				} else {
					nextRisk = evt.riskLevel;
				}
			}

			const maxDelegates = Math.max(1, evt.maxDelegates ?? prev.budgetMaxDelegates);
			const cutoffRatio = Math.min(0.95, Math.max(0.5, evt.cutoffRatio ?? prev.budgetCutoffRatio));
			const dispatched = evt.dispatched ?? prev.budgetDispatched;
			const cutoffAt = Math.max(1, Math.ceil(maxDelegates * cutoffRatio));
			const cutoffActive = prev.budgetCutoffActive || dispatched >= cutoffAt;

			let next: ZeeFsmPersistedSnapshot = {
				...prev,
				slug: evt.slug ?? prev.slug,
				busDir: evt.busDir ?? prev.busDir,
				riskLevel: nextRisk,
				budgetDispatched: dispatched,
				budgetMaxDelegates: maxDelegates,
				budgetCutoffRatio: cutoffRatio,
				budgetCutoffActive: cutoffActive,
				abortedDelegates: evt.abortedDelegates ?? prev.abortedDelegates,
				violations,
				updatedAt: now,
			};

			if (evt.status === "completed" && prev.phase !== "COMPLETED" && prev.activeWorkers.length === 0) {
				next = withTransition(prev, next, "COMPLETED", evt.type, now, "bus status=completed");
			} else if (evt.status === "paused" && prev.phase !== "PAUSED" && prev.activeWorkers.length === 0) {
				next = withTransition(prev, next, "PAUSED", evt.type, now, "bus status=paused");
			} else if (cutoffActive && CUTOFF_TRANSITIONABLE_PHASES.has(prev.phase)) {
				next = withTransition(prev, next, "CUTOFF_CLOSING", evt.type, now, "bus budget cutoff");
			}
			return next;
		}
	}
}

function parseEntryTimestamp(entry: BranchEntryLike, dataObj?: Record<string, unknown>): number {
	const dataTs = dataObj?.updatedAt;
	if (typeof dataTs === "number" && Number.isFinite(dataTs) && dataTs > 0) {
		return dataTs;
	}
	if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) {
		return entry.timestamp;
	}
	if (typeof entry.timestamp === "string" && entry.timestamp.trim()) {
		const parsed = Date.parse(entry.timestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}

function sanitizePersistedSnapshot(
	raw: Record<string, unknown>,
	flagMode?: unknown,
): ZeeFsmPersistedSnapshot {
	const base = createInitialFsmSnapshot(flagMode);
	return {
		version: 1,
		routingMode: isValidZeeMode(raw.routingMode) ? raw.routingMode : base.routingMode,
		writeGate: isValidGateMode(raw.writeGate) ? raw.writeGate : base.writeGate,
		track: isValidZeeTrack(raw.track) ? raw.track : base.track,
		phase: isValidWorkflowPhase(raw.phase) ? raw.phase : base.phase,
		riskLevel: isValidRiskLevel(raw.riskLevel) ? raw.riskLevel : base.riskLevel,
		trustLevel: isValidTrustLevel(raw.trustLevel) ? raw.trustLevel : base.trustLevel,
		slug: typeof raw.slug === "string" ? raw.slug : undefined,
		busDir: typeof raw.busDir === "string" ? raw.busDir : undefined,
		integrationBranch: typeof raw.integrationBranch === "string" ? raw.integrationBranch : undefined,
		pinnedSha: typeof raw.pinnedSha === "string" ? raw.pinnedSha : undefined,
		budgetDispatched: Number.isFinite(Number(raw.budgetDispatched)) ? Number(raw.budgetDispatched) : 0,
		budgetMaxDelegates:
			Number.isFinite(Number(raw.budgetMaxDelegates)) && Number(raw.budgetMaxDelegates) > 0
				? Number(raw.budgetMaxDelegates)
				: 40,
		budgetCutoffRatio:
			Number.isFinite(Number(raw.budgetCutoffRatio)) && Number(raw.budgetCutoffRatio) > 0
				? Number(raw.budgetCutoffRatio)
				: 0.7,
		budgetCutoffActive: Boolean(raw.budgetCutoffActive),
		abortedDelegates: Number.isFinite(Number(raw.abortedDelegates)) ? Number(raw.abortedDelegates) : 0,
		totalCost: Number.isFinite(Number(raw.totalCost)) ? Number(raw.totalCost) : 0,
		gate1:
			raw.gate1 && typeof raw.gate1 === "object"
				? (raw.gate1 as GateRecord)
				: undefined,
		gate2:
			raw.gate2 && typeof raw.gate2 === "object"
				? (raw.gate2 as GateRecord)
				: undefined,
		activeWorkers: Array.isArray(raw.activeWorkers)
			? (raw.activeWorkers as WorkerLaneState[])
			: [],
		completedWorkers: Array.isArray(raw.completedWorkers)
			? (raw.completedWorkers as WorkerLaneState[]).slice(-MAX_COMPLETED_WORKERS_LEN)
			: [],
		history: Array.isArray(raw.history)
			? (raw.history as FsmTransition[]).slice(-MAX_HISTORY_LEN)
			: [],
		violations: Array.isArray(raw.violations)
			? (raw.violations as ViolationRecord[]).slice(-MAX_VIOLATIONS_LEN)
			: [],
		updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
		lastError: typeof raw.lastError === "string" ? raw.lastError : undefined,
	};
}

/**
 * 仅从当前活动分支（ctx.sessionManager.getBranch()）逆序恢复 FSM：
 * - 优先恢复最新 `"zee-fsm"` custom entry
 * - 向后兼容旧会话中的 `"zee-mode"` 与 `"zee-gate"` legacy entries
 */
export function restoreFsmFromBranch(
	branch: readonly BranchEntryLike[],
	flagMode?: unknown,
): RestoreFsmResult {
	let fsmIdx = -1;
	let fsmEntry: BranchEntryLike | null = null;
	let legacyModeIdx = -1;
	let legacyMode: ZeeMode | null = null;
	let legacyModeTs = 0;
	let legacyGateIdx = -1;
	let legacyGate: GateMode | null = null;
	let legacyGateTs = 0;

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry || entry.type !== "custom") continue;

		if (fsmIdx < 0 && entry.customType === "zee-fsm" && entry.data && typeof entry.data === "object") {
			fsmIdx = i;
			fsmEntry = entry;
		} else if (legacyModeIdx < 0 && entry.customType === "zee-mode" && entry.data && typeof entry.data === "object") {
			const data = entry.data as { mode?: unknown };
			if (isValidZeeMode(data.mode)) {
				legacyModeIdx = i;
				legacyMode = data.mode;
				legacyModeTs = parseEntryTimestamp(entry, entry.data as Record<string, unknown>);
			}
		} else if (legacyGateIdx < 0 && entry.customType === "zee-gate" && entry.data && typeof entry.data === "object") {
			const data = entry.data as { gate?: unknown };
			if (isValidGateMode(data.gate)) {
				legacyGateIdx = i;
				legacyGate = data.gate;
				legacyGateTs = parseEntryTimestamp(entry, entry.data as Record<string, unknown>);
			}
		}

		if (fsmIdx >= 0 && legacyModeIdx >= 0 && legacyGateIdx >= 0) break;
	}

	if (fsmEntry && fsmEntry.data && typeof fsmEntry.data === "object") {
		const rawData = fsmEntry.data as Record<string, unknown>;
		let snap = sanitizePersistedSnapshot(rawData, flagMode);
		let entryTs = parseEntryTimestamp(fsmEntry, rawData);

		if (legacyMode && legacyModeIdx > fsmIdx) {
			snap = { ...snap, routingMode: legacyMode };
			entryTs = Math.max(entryTs, legacyModeTs);
		}
		if (legacyGate && legacyGateIdx > fsmIdx) {
			snap = {
				...snap,
				writeGate: legacyGate,
				phase: legacyGate === "none" && snap.phase !== "PLANNING" && snap.phase !== "INIT_DESIGN" && snap.phase !== "REVIEWING"
					? snap.phase
					: phaseForGate(legacyGate),
			};
			entryTs = Math.max(entryTs, legacyGateTs);
		}
		return { snapshot: snap, branchEntryTs: entryTs, source: "zee-fsm" };
	}

	if (legacyMode !== null || legacyGate !== null) {
		const snap = createInitialFsmSnapshot(flagMode);
		const resolvedMode = legacyMode ?? snap.routingMode;
		const resolvedGate = legacyGate ?? "none";
		return {
			snapshot: {
				...snap,
				routingMode: resolvedMode,
				writeGate: resolvedGate,
				phase: phaseForGate(resolvedGate),
				track:
					resolvedGate === "plan"
						? "plan"
						: resolvedGate === "init-design"
							? "init"
							: resolvedGate === "review"
								? "review"
								: "direct",
			},
			branchEntryTs: Math.max(legacyModeTs, legacyGateTs),
			source: "legacy",
		};
	}

	return {
		snapshot: createInitialFsmSnapshot(flagMode),
		branchEntryTs: 0,
		source: "default",
	};
}

export function toPersistedFsmEntry(snap: ZeeFsmPersistedSnapshot): ZeeFsmPersistedSnapshot {
	return {
		...snap,
		activeWorkers: snap.activeWorkers.slice(0, 16),
		completedWorkers: snap.completedWorkers.slice(-MAX_COMPLETED_WORKERS_LEN),
		history: snap.history.slice(-MAX_HISTORY_LEN),
		violations: snap.violations.slice(-MAX_VIOLATIONS_LEN),
	};
}
