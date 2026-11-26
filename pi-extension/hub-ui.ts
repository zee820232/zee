/**
 * zee Zero-Conflict Pi v1.6.1 HUD & 5-Tab Interactive Hub (v4.2.0)
 *
 * 兼容性硬不变量：
 * 1. NEVER call ctx.ui.setFooter()（pi-cometix-footer 独占 footerContainer）。
 * 2. NEVER bind ctrl+g（由 Pi app.editor.external 保留）。
 * 3. NEVER 发明 session_switch / session_fork 事件。
 * 4. 严格仅在 ctx.mode === "tui" 时挂载 TUI Component / ctx.ui.custom Overlay；
 *    RPC 模式降级为 string[] widget + notify；Print / JSON / ZEE_WORKER=1 100% 静默。
 */

import { copyToClipboard, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type OverlayOptions,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	WORKTREE_BUCKETS,
	readPartialArtifactPreview,
	type BusStateDisk,
	type DecisionRow,
	type ProjectConfigSnapshot,
	type WorktreeInventory,
} from "./bus-sync.ts";
import {
	WORKFLOW_PHASES,
	createInitialFsmSnapshot,
	type WorkerLaneState,
	type WorkflowPhase,
	type ZeeFsmPersistedSnapshot,
} from "./fsm.ts";

export type HudDensity = "full" | "compact" | "hidden";

export interface HubStateSnapshot extends ZeeFsmPersistedSnapshot {
	cwd: string;
	hudDensity: HudDensity;
	busAheadOfBranch: boolean;
	branchEntryTs: number;
	busState: BusStateDisk | null;
	decisionsTail: DecisionRow[];
	projectConfig: ProjectConfigSnapshot | null;
	worktreeInventory: WorktreeInventory | null;
	providerCooldowns: Array<{ key: string; reason: string; remainingSec: number }>;
	costByRole: Record<string, number>;
	costByModel: Record<string, number>;
	lastSyncAt: number;
}

export interface HubActions {
	onRefresh?: () => Promise<void> | void;
	onCycleMode?: () => Promise<void> | void;
	onUnlockGate?: () => Promise<void> | void;
	onPruneWorktrees?: () => Promise<string | void> | string | void;
	onCycleHudDensity?: () => Promise<void> | void;
	onPauseRun?: () => Promise<void> | void;
	onCopyResume?: (cmd: string) => Promise<void> | void;
	onClearCooldowns?: () => Promise<string | void> | string | void;
}

export const HUB_OVERLAY_OPTIONS: OverlayOptions = {
	width: "92%",
	minWidth: 68,
	maxHeight: "86%",
	anchor: "center",
	margin: { top: 1, bottom: 1, left: 2, right: 2 },
};

const PHASE_BADGE_SHORT: Record<WorkflowPhase, string> = {
	IDLE: "IDLE",
	PREFLIGHT: "PRE",
	SCOUTING: "SCT",
	PLANNING: "PLAN",
	INIT_DESIGN: "INIT",
	AWAITING_APPROVAL: "WAIT",
	EXECUTING: "EXEC",
	VERIFYING: "VER",
	REVIEWING: "REV",
	MERGING: "MRG",
	CUTOFF_CLOSING: "CUT",
	COMPLETED: "DONE",
	PAUSED: "PAUS",
	BLOCKED: "BLK",
};

const STEPPER_STAGES: readonly WorkflowPhase[] = [
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
];

export function getCtxMode(ctx: ExtensionContext): string | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	if ("mode" in ctx) {
		const m = (ctx as { mode?: unknown }).mode;
		return typeof m === "string" ? m : undefined;
	}
	return undefined;
}

export function isTuiContext(ctx: ExtensionContext): boolean {
	return Boolean(ctx?.hasUI) && getCtxMode(ctx) === "tui";
}

export function isRpcContext(ctx: ExtensionContext): boolean {
	return Boolean(ctx?.hasUI) && getCtxMode(ctx) === "rpc";
}

function fg(theme: Theme | undefined, color: string, text: string): string {
	if (theme && typeof theme.fg === "function") {
		try {
			return theme.fg(color as Parameters<Theme["fg"]>[0], text);
		} catch {
			return text;
		}
	}
	return text;
}

function bold(theme: Theme | undefined, text: string): string {
	if (theme && typeof theme.bold === "function") {
		try {
			return theme.bold(text);
		} catch {
			return text;
		}
	}
	return text;
}

export function computeCostBreakdowns(snap: ZeeFsmPersistedSnapshot): {
	costByRole: Record<string, number>;
	costByModel: Record<string, number>;
} {
	const costByRole: Record<string, number> = {};
	const costByModel: Record<string, number> = {};
	for (const w of [...snap.completedWorkers, ...snap.activeWorkers]) {
		const c = Number(w.cost) || 0;
		if (c <= 0) continue;
		const roleKey = w.role || "worker";
		const modelKey = w.model || "default";
		costByRole[roleKey] = (costByRole[roleKey] || 0) + c;
		costByModel[modelKey] = (costByModel[modelKey] || 0) + c;
	}
	return { costByRole, costByModel };
}

export function createInitialHubSnapshot(cwd: string, fsm?: ZeeFsmPersistedSnapshot): HubStateSnapshot {
	const base = fsm ?? createInitialFsmSnapshot("off");
	const { costByRole, costByModel } = computeCostBreakdowns(base);
	return {
		...base,
		cwd,
		hudDensity: "full",
		busAheadOfBranch: false,
		branchEntryTs: 0,
		busState: null,
		decisionsTail: [],
		projectConfig: null,
		worktreeInventory: null,
		providerCooldowns: [],
		costByRole,
		costByModel,
		lastSyncAt: 0,
	};
}

export class HubStore {
	private snapshot: HubStateSnapshot;
	private listeners = new Set<(snap: HubStateSnapshot) => void>();
	private liveTimer: ReturnType<typeof setInterval> | undefined;
	private throttleTimer: ReturnType<typeof setTimeout> | undefined;
	private lastNotifyAt = 0;
	private revision = 0;
	private disposed = false;

	constructor(initial: HubStateSnapshot) {
		this.snapshot = initial;
		this.syncLiveTimer();
	}

	getSnapshot(): HubStateSnapshot {
		return this.snapshot;
	}

	getRevision(): number {
		return this.revision;
	}

	getHudDensity(): HudDensity {
		return this.snapshot.hudDensity;
	}

	setHudDensity(density: HudDensity, immediate = true): void {
		this.update((prev) => ({ ...prev, hudDensity: density }), immediate);
	}

	setSnapshot(next: HubStateSnapshot, immediate = false): void {
		if (this.disposed) return;
		const { costByRole, costByModel } = computeCostBreakdowns(next);
		this.snapshot = {
			...next,
			costByRole,
			costByModel,
		};
		this.revision += 1;
		this.syncLiveTimer();
		this.notify(immediate);
	}

	update(updater: (prev: HubStateSnapshot) => HubStateSnapshot, immediate = false): void {
		if (this.disposed) return;
		this.setSnapshot(updater(this.snapshot), immediate);
	}

	subscribe(fn: (snap: HubStateSnapshot) => void): () => void {
		if (this.disposed) return () => {};
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	notify(immediate = false): void {
		if (this.disposed) return;
		const emitNow = () => {
			this.lastNotifyAt = Date.now();
			for (const fn of this.listeners) {
				try {
					fn(this.snapshot);
				} catch {}
			}
		};

		if (immediate) {
			if (this.throttleTimer) {
				clearTimeout(this.throttleTimer);
				this.throttleTimer = undefined;
			}
			emitNow();
			return;
		}

		const elapsed = Date.now() - this.lastNotifyAt;
		if (elapsed >= 200) {
			if (this.throttleTimer) {
				clearTimeout(this.throttleTimer);
				this.throttleTimer = undefined;
			}
			emitNow();
			return;
		}

		if (!this.throttleTimer) {
			this.throttleTimer = setTimeout(() => {
				this.throttleTimer = undefined;
				if (!this.disposed) emitNow();
			}, Math.max(1, 200 - elapsed));
			this.throttleTimer.unref?.();
		}
	}

	private syncLiveTimer(): void {
		if (this.disposed) return;
		const hasActive = this.snapshot.activeWorkers.length > 0;
		if (hasActive && !this.liveTimer) {
			this.liveTimer = setInterval(() => {
				if (!this.disposed && this.snapshot.activeWorkers.length > 0) {
					this.revision += 1;
					this.notify(true);
				}
			}, 1000);
			this.liveTimer.unref?.();
		} else if (!hasActive && this.liveTimer) {
			clearInterval(this.liveTimer);
			this.liveTimer = undefined;
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.liveTimer) {
			clearInterval(this.liveTimer);
			this.liveTimer = undefined;
		}
		if (this.throttleTimer) {
			clearTimeout(this.throttleTimer);
			this.throttleTimer = undefined;
		}
		this.listeners.clear();
	}

	rearm(next?: HubStateSnapshot): void {
		this.disposed = false;
		if (next) {
			this.setSnapshot(next, true);
		} else {
			this.syncLiveTimer();
		}
	}
}

function fitToWidth(line: string, width: number): string {
	if (width <= 0) return "";
	const singleLine = String(line ?? "").replace(/[\r\n]+/g, " ");
	return visibleWidth(singleLine) <= width ? singleLine : truncateToWidth(singleLine, width, "…");
}

function padToWidth(line: string, width: number): string {
	const clamped = fitToWidth(line, width);
	const w = visibleWidth(clamped);
	return w < width ? clamped + " ".repeat(width - w) : clamped;
}

function renderProgressBar(ratio: number, cells = 6): string {
	const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
	const filled = Math.round(clamped * cells);
	return "█".repeat(filled) + "░".repeat(Math.max(0, cells - filled));
}

function formatGateShort(gate: ZeeFsmPersistedSnapshot["writeGate"]): string {
	if (gate === "plan") return "plan🔒";
	if (gate === "init-design") return "init🔒";
	if (gate === "review") return "rev🔒";
	return "none";
}

function formatWorkerLine(w: WorkerLaneState, now: number): string {
	const elapsed = Math.max(0, Math.round((now - (w.startedAt || now)) / 1000));
	const modelLabel = w.model ? w.model.split("/").pop() || w.model : "default";
	const activity = w.stallReason
		? `⚠ ${w.stallReason}`
		: w.inFlightTool
			? `${w.inFlightTool}${w.inFlightSince ? `(${Math.max(0, Math.round((now - w.inFlightSince) / 1000))}s)` : ""}`
			: w.lastActions.length > 0
				? w.lastActions[w.lastActions.length - 1]
				: w.phase;
	const turnsPart = w.turns > 0 ? ` · t${w.turns}` : "";
	const costPart = w.cost > 0 ? ` · $${w.cost.toFixed(2)}` : "";
	const streamPart = w.streamChars && w.streamChars > 0 ? ` · ${w.streamChars}ch` : "";
	const warnTag = w.phase === "STALLED_WARN" ? " [STALL]" : w.phase === "PREPARING_WT" ? " [WT]" : "";
	return `▸ ${w.role}${warnTag} · ${modelLabel} · ${elapsed}s${turnsPart}${costPart} · ${activity}${streamPart}`;
}

/**
 * Layer 0: 极紧凑状态栏徽章（严格 <= 18 列）
 */
export function formatCompactStatusBadge(snap: ZeeFsmPersistedSnapshot & { busAheadOfBranch?: boolean }): string | undefined {
	if (
		snap.routingMode === "off" &&
		snap.writeGate === "none" &&
		snap.phase === "IDLE" &&
		!snap.budgetCutoffActive &&
		snap.activeWorkers.length === 0
	) {
		return undefined;
	}

	let raw = "";
	if (snap.budgetCutoffActive) {
		raw = `cut:${snap.budgetDispatched}/${snap.budgetMaxDelegates}`;
	} else if (snap.writeGate !== "none") {
		const lock = snap.writeGate === "plan" ? "plan🔒" : snap.writeGate === "init-design" ? "init🔒" : "review🔒";
		raw = snap.routingMode === "off" ? lock : `${snap.routingMode}·${lock}`;
	} else {
		const phaseShort = PHASE_BADGE_SHORT[snap.phase] ?? snap.phase.slice(0, 4);
		raw = `zee:${snap.routingMode}·${phaseShort}`;
	}

	if (snap.busAheadOfBranch && visibleWidth(raw) <= 16) {
		raw = `${raw}!`;
	}

	return truncateToWidth(raw, 18, "");
}

function shouldHideHud(snap: HubStateSnapshot): boolean {
	if (snap.hudDensity === "hidden") return true;
	return snap.phase === "IDLE" && snap.writeGate === "none" && snap.activeWorkers.length === 0;
}

function buildBorderLine(leftChar: string, rightChar: string, content: string, fillChar: string, width: number): string {
	if (width <= 2) return fitToWidth(leftChar + rightChar, width);
	const innerMax = width - 2;
	const clipped = fitToWidth(content, innerMax);
	const w = visibleWidth(clipped);
	const fillLen = Math.max(0, innerMax - w);
	return `${leftChar}${clipped}${fillChar.repeat(fillLen)}${rightChar}`;
}

function buildInteriorLine(content: string, width: number): string {
	if (width <= 2) return fitToWidth(`│${content}`, width);
	const innerMax = width - 3; // "│ " + "│"
	const clipped = fitToWidth(content, innerMax);
	const w = visibleWidth(clipped);
	return `│ ${clipped}${" ".repeat(Math.max(0, innerMax - w))}│`;
}

/**
 * Layer 1 HUD 纯渲染函数：
 * - hidden 或 (IDLE && writeGate==="none" && activeWorkers===0) 返回 []
 * - width >= 90 && rows >= 24 && full: 2-4 行有边框卡片 (╭─ ... ╰─)
 * - compact / width < 90 / rows < 24: 无边框 1-2 行 ▌zee[...]，width < 60 或 rows < 22 折叠为 1 行
 * - 严格保证每行 visibleWidth(line) <= width
 */
export function renderZeeHudLines(
	snap: HubStateSnapshot,
	width: number,
	rows = 40,
	theme?: Theme,
	now = Date.now(),
): string[] {
	if (width <= 0 || shouldHideHud(snap)) return [];

	const ratio = snap.budgetMaxDelegates > 0 ? snap.budgetDispatched / snap.budgetMaxDelegates : 0;
	const bar = renderProgressBar(ratio, 4);
	const gateStr = formatGateShort(snap.writeGate);
	const costStr = `$${snap.totalCost.toFixed(2)}`;
	const driftTag = snap.busAheadOfBranch ? " ⚠DRIFT" : "";
	const shortSha = snap.pinnedSha ? snap.pinnedSha.slice(0, 7) : "none";

	const isFullCard = snap.hudDensity === "full" && width >= 90 && rows >= 24;
	if (!isFullCard) {
		const wCount = snap.activeWorkers.length > 0 ? ` (${snap.activeWorkers.length}w)` : "";
		const line1Raw = `▌zee[${snap.riskLevel}·${snap.routingMode}·${snap.trustLevel}] ${snap.phase}${driftTag} ${bar} ${snap.budgetDispatched}/${snap.budgetMaxDelegates} gate:${gateStr} ${costStr}${wCount}`;
		const lines = [fitToWidth(fg(theme, snap.busAheadOfBranch ? "warning" : "accent", line1Raw), width)];
		if (width >= 60 && rows >= 22 && snap.activeWorkers.length > 0) {
			const w0 = formatWorkerLine(snap.activeWorkers[0], now);
			const more = snap.activeWorkers.length > 1 ? ` (+${snap.activeWorkers.length - 1} more)` : "";
			lines.push(fitToWidth(`  ${w0}${more}`, width));
		}
		return lines.map((l) => fitToWidth(l, width));
	}

	const headerLeft = `─ zee[${snap.riskLevel}·${snap.routingMode}·${snap.trustLevel}] · ${snap.phase}${driftTag} · ${bar} ${snap.budgetDispatched}/${snap.budgetMaxDelegates} · gate:${gateStr} · ${costStr} `;
	const hubHint = " [Ctrl+Alt+H / F2 Hub] ─";
	const innerAvail = Math.max(0, width - 2);
	const hintW = visibleWidth(hubHint);
	const leftMax = Math.max(10, innerAvail - hintW - 1);
	const clippedLeft = fitToWidth(headerLeft, leftMax);
	const dashPad = Math.max(0, innerAvail - visibleWidth(clippedLeft) - hintW);
	const topLine = fitToWidth(
		`${fg(theme, "border", "╭")}${fg(theme, "accent", clippedLeft)}${fg(theme, "border", "─".repeat(dashPad))}${fg(theme, "dim", hubHint)}${fg(theme, "border", "╮")}`,
		width,
	);

	const out: string[] = [topLine];
	const visibleWorkers = snap.activeWorkers.slice(0, 2);
	for (const w of visibleWorkers) {
		const wText = formatWorkerLine(w, now);
		const color = w.phase === "STALLED_WARN" ? "warning" : "text";
		out.push(fitToWidth(fg(theme, color, buildInteriorLine(wText, width)), width));
	}

	const overflow = snap.activeWorkers.length > 2 ? ` · +${snap.activeWorkers.length - 2} more` : "";
	const gate1Tag = snap.gate1 ? ` · G1:${snap.gate1.verdict}` : "";
	const gate2Tag = snap.gate2 ? ` G2:${snap.gate2.verdict}` : "";
	const cutoffTag = snap.budgetCutoffActive ? " · CUTOFF_CLOSING" : "";
	const footerContent = `─ track:${snap.track} · sha:${shortSha}${gate1Tag}${gate2Tag}${cutoffTag}${overflow} `;
	const bottomLine = fitToWidth(fg(theme, "border", buildBorderLine("╰", "╯", footerContent, "─", width)), width);
	out.push(bottomLine);

	return out;
}

export function createZeeHudComponent(
	store: HubStore,
	tui: TUI,
	theme: Theme,
	getRows?: () => number,
): Component & { dispose: () => void } {
	let cachedWidth = -1;
	let cachedRows = -1;
	let cachedRev = -1;
	let cachedLines: string[] = [];

	const unsub = store.subscribe(() => {
		cachedRev = -1;
		tui.requestRender();
	});

	const readRows = (): number => {
		if (getRows) return getRows();
		const termRows = (tui as unknown as { terminal?: { rows?: number } })?.terminal?.rows;
		if (typeof termRows === "number" && termRows > 0) return termRows;
		return typeof process.stdout?.rows === "number" && process.stdout.rows > 0 ? process.stdout.rows : 40;
	};

	return {
		render(width: number): string[] {
			const rows = readRows();
			const rev = store.getRevision();
			if (cachedRev === rev && cachedWidth === width && cachedRows === rows) {
				return cachedLines;
			}
			cachedWidth = width;
			cachedRows = rows;
			cachedRev = rev;
			cachedLines = renderZeeHudLines(store.getSnapshot(), width, rows, theme);
			return cachedLines;
		},
		invalidate(): void {
			cachedRev = -1;
			cachedLines = [];
		},
		dispose(): void {
			unsub();
		},
	};
}

export function createZeeHudWidget(store: HubStore) {
	return (tui: TUI, theme: Theme): Component & { dispose: () => void } => createZeeHudComponent(store, tui, theme);
}

/**
 * RPC 降级 HUD（<= 3 行纯文本字符串）
 */
export function renderRpcHudLines(snap: HubStateSnapshot, now = Date.now()): string[] {
	if (shouldHideHud(snap)) return [];
	const lines: string[] = [
		`zee[${snap.riskLevel}·${snap.routingMode}·${snap.trustLevel}] ${snap.phase} | gate:${formatGateShort(snap.writeGate)} | ${snap.budgetDispatched}/${snap.budgetMaxDelegates} | $${snap.totalCost.toFixed(2)}`,
	];
	if (snap.activeWorkers.length > 0) {
		const first = formatWorkerLine(snap.activeWorkers[0], now);
		const overflow = snap.activeWorkers.length > 1 ? ` (+${snap.activeWorkers.length - 1} more)` : "";
		lines.push(`${first}${overflow}`);
	}
	if (snap.busAheadOfBranch || snap.violations.length > 0) {
		const warn = snap.busAheadOfBranch
			? "⚠ /tree rollback drift: bus state.json ahead of branch"
			: `⚠ violations=${snap.violations.length} latest=${snap.violations[snap.violations.length - 1]?.guard}`;
		lines.push(warn);
	}
	return lines.slice(0, 3);
}

export function formatRpcHubSummary(snap: HubStateSnapshot): string {
	const parts = [
		`[zee Hub] mode=${snap.routingMode} gate=${snap.writeGate} phase=${snap.phase} risk=${snap.riskLevel} trust=${snap.trustLevel}`,
		`budget=${snap.budgetDispatched}/${snap.budgetMaxDelegates}${snap.budgetCutoffActive ? "(CUTOFF)" : ""} cost=$${snap.totalCost.toFixed(4)}`,
		`workers(active=${snap.activeWorkers.length},done=${snap.completedWorkers.length}) violations=${snap.violations.length}`,
	];
	if (snap.busAheadOfBranch) parts.push("WARNING: busAheadOfBranch (/tree drift)");
	return parts.join(" | ");
}

interface PendingConfirm {
	action: "unlock" | "prune" | "pause";
	prompt: string;
}

const TAB_TITLES = [
	"1 Overview & FSM",
	"2 Workers",
	"3 Gates & Trail",
	"4 Worktrees & Cost",
	"5 Controls",
] as const;

const TAB_TITLES_COMPACT = [
	"1总览",
	"2车道",
	"3门禁",
	"4树/费",
	"5控制",
] as const;

export class ZeeHubOverlayComponent implements Component {
	private store: HubStore;
	private tui: TUI;
	private theme: Theme;
	private actions: HubActions;
	private onClose: () => void;

	private activeTab = 0;
	private scrollOffset = 0;
	private workerCursor = 0;
	private controlCursor = 0;
	private previewArtifactPath: string | null = null;
	private previewLines: string[] = [];
	private previewScroll = 0;
	private pendingConfirm: PendingConfirm | null = null;
	private toastMessage = "";
	private unsub: () => void;

	constructor(store: HubStore, tui: TUI, theme: Theme, actions: HubActions, onClose: () => void) {
		this.store = store;
		this.tui = tui;
		this.theme = theme;
		this.actions = actions;
		this.onClose = onClose;
		this.unsub = store.subscribe(() => {
			this.tui.requestRender();
		});
	}

	getActiveTab(): number {
		return this.activeTab;
	}

	isPreviewOpen(): boolean {
		return Boolean(this.previewArtifactPath);
	}

	getPendingConfirm(): PendingConfirm | null {
		return this.pendingConfirm;
	}

	private setToast(msg: string): void {
		this.toastMessage = msg;
		this.tui.requestRender();
	}

	private switchTab(idx: number): void {
		const next = ((idx % 5) + 5) % 5;
		this.activeTab = next;
		this.scrollOffset = 0;
		this.pendingConfirm = null;
		this.previewArtifactPath = null;
		this.previewLines = [];
		this.previewScroll = 0;
		this.tui.requestRender();
	}

	private getAllWorkers(snap: HubStateSnapshot): WorkerLaneState[] {
		return [...snap.activeWorkers, ...[...snap.completedWorkers].reverse()];
	}

	private openSelectedWorkerPreview(snap: HubStateSnapshot): void {
		const workers = this.getAllWorkers(snap);
		if (workers.length === 0) {
			this.setToast("暂无 Worker 记录可预览。");
			return;
		}
		const idx = Math.max(0, Math.min(this.workerCursor, workers.length - 1));
		const w = workers[idx];
		if (!w?.partialArtifactPath) {
			this.setToast(`Worker "${w?.lane || w?.role}" 无 partial-*.md 抢救文件。`);
			return;
		}
		const preview = readPartialArtifactPreview(w.partialArtifactPath);
		this.previewArtifactPath = w.partialArtifactPath;
		this.previewLines = preview.content.split(/\r?\n/);
		this.previewScroll = 0;
		this.tui.requestRender();
	}

	private triggerControlKey(key: "m" | "l" | "w" | "c" | "d" | "p" | "h", snap: HubStateSnapshot): void {
		if (key === "m") {
			void Promise.resolve(this.actions.onCycleMode?.()).then(() => {
				this.setToast(`已切换路由模式 -> ${this.store.getSnapshot().routingMode}`);
			});
			return;
		}
		if (key === "d") {
			void Promise.resolve(this.actions.onCycleHudDensity?.()).then(() => {
				this.setToast(`HUD 密度 -> ${this.store.getSnapshot().hudDensity}`);
			});
			return;
		}
		if (key === "c") {
			const cmd = snap.slug ? `/zee resume ${snap.slug}` : "/zee resume";
			try {
				copyToClipboard(cmd);
			} catch {}
			void Promise.resolve(this.actions.onCopyResume?.(cmd));
			this.setToast(`已复制续跑命令：${cmd}`);
			return;
		}
		if (key === "h") {
			this.setToast("正在清除 429/5xx 模型冷却缓存...");
			void Promise.resolve(this.actions.onClearCooldowns?.()).then((msg) => {
				this.setToast(typeof msg === "string" && msg ? msg : "已清除模型冷却缓存。");
			});
			return;
		}
		if (key === "l") {
			if (snap.writeGate === "none") {
				this.setToast("当前未激活 writeGate 保护锁。");
				return;
			}
			this.pendingConfirm = {
				action: "unlock",
				prompt: `确认解除当前 "${snap.writeGate}" 写保护锁？[y/Enter 确认, n/Esc 取消]`,
			};
			this.tui.requestRender();
			return;
		}
		if (key === "w") {
			this.pendingConfirm = {
				action: "prune",
				prompt: "确认执行异步 cleanup-worktrees --prune-safe 安全清理？[y/Enter 确认, n/Esc 取消]",
			};
			this.tui.requestRender();
			return;
		}
		if (key === "p") {
			this.pendingConfirm = {
				action: "pause",
				prompt: "确认将当前运行状态切换为 PAUSED（不强制删文件）？[y/Enter 确认, n/Esc 取消]",
			};
			this.tui.requestRender();
		}
	}

	private executeConfirmed(confirm: PendingConfirm): void {
		this.pendingConfirm = null;
		if (confirm.action === "unlock") {
			void Promise.resolve(this.actions.onUnlockGate?.()).then(() => {
				this.setToast("已解除 writeGate 保护锁。");
			});
		} else if (confirm.action === "prune") {
			this.setToast("正在异步执行 worktree 清理...");
			void Promise.resolve(this.actions.onPruneWorktrees?.()).then((msg) => {
				this.setToast(typeof msg === "string" && msg ? msg : "worktree 清理完成。");
			});
		} else if (confirm.action === "pause") {
			void Promise.resolve(this.actions.onPauseRun?.()).then(() => {
				this.setToast("当前运行已置为 PAUSED。");
			});
		}
	}

	handleInput(data: string): void {
		const snap = this.store.getSnapshot();

		// 1. 确认弹窗优先拦截 y/n/Enter/Esc
		if (this.pendingConfirm) {
			if (matchesKey(data, "y") || matchesKey(data, "Y") || matchesKey(data, Key.enter) || data === "y" || data === "Y") {
				this.executeConfirmed(this.pendingConfirm);
				return;
			}
			if (matchesKey(data, "n") || matchesKey(data, "N") || matchesKey(data, Key.escape) || data === "n" || data === "N") {
				this.pendingConfirm = null;
				this.setToast("已取消操作。");
				return;
			}
		}

		// 2. partial-*.md 预览模式下的 Esc/Backspace 退出预览
		if (this.previewArtifactPath && (matchesKey(data, Key.escape) || matchesKey(data, Key.backspace) || data === "\x1b")) {
			this.previewArtifactPath = null;
			this.previewLines = [];
			this.previewScroll = 0;
			this.tui.requestRender();
			return;
		}

		// 3. 全局关闭键
		if (
			matchesKey(data, Key.ctrlAlt("h")) ||
			matchesKey(data, Key.f2) ||
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c")) ||
			matchesKey(data, "q") ||
			data === "q"
		) {
			this.dispose();
			this.onClose();
			return;
		}

		// 4. 数字键 1-5 切页
		for (let i = 0; i < 5; i++) {
			const digit = String(i + 1);
			if (matchesKey(data, digit) || data === digit) {
				this.switchTab(i);
				return;
			}
		}

		// 5. Tab / Shift+Tab / ← / → 切页
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || data === "\t") {
			this.switchTab(this.activeTab + 1);
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.switchTab(this.activeTab - 1);
			return;
		}

		// 6. r 异步刷新
		if (matchesKey(data, "r") || data === "r") {
			this.setToast("正在刷新总线与 worktree 状态...");
			void Promise.resolve(this.actions.onRefresh?.()).then(() => {
				this.setToast("状态已刷新。");
			});
			return;
		}

		// 7. ↑ / ↓ / j / k 滚动与列表游标
		const isUp = matchesKey(data, Key.up) || matchesKey(data, "k") || data === "k";
		const isDown = matchesKey(data, Key.down) || matchesKey(data, "j") || data === "j";
		if (isUp || isDown) {
			const delta = isUp ? -1 : 1;
			if (this.previewArtifactPath) {
				this.previewScroll = Math.max(0, Math.min(Math.max(0, this.previewLines.length - 5), this.previewScroll + delta));
			} else if (this.activeTab === 1) {
				const workers = this.getAllWorkers(snap);
				if (workers.length > 0) {
					this.workerCursor = Math.max(0, Math.min(workers.length - 1, this.workerCursor + delta));
				}
			} else if (this.activeTab === 4) {
				this.controlCursor = Math.max(0, Math.min(6, this.controlCursor + delta));
			} else {
				this.scrollOffset = Math.max(0, this.scrollOffset + delta);
			}
			this.tui.requestRender();
			return;
		}

		// 8. Enter / Space 触发上下文动作
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || data === "\r" || data === " ") {
			if (this.activeTab === 1 && !this.previewArtifactPath) {
				this.openSelectedWorkerPreview(snap);
				return;
			}
			if (this.activeTab === 4) {
				const keys: Array<"m" | "l" | "w" | "c" | "d" | "p" | "h"> = ["m", "l", "w", "c", "d", "p", "h"];
				this.triggerControlKey(keys[this.controlCursor] ?? "m", snap);
				return;
			}
		}

		// 9. Tab 5 单键快捷键
		if (this.activeTab === 4) {
			for (const k of ["m", "l", "w", "c", "d", "p", "h"] as const) {
				if (matchesKey(data, k) || data === k) {
					this.triggerControlKey(k, snap);
					return;
				}
			}
		}
	}

	private renderTab1Overview(snap: HubStateSnapshot, innerWidth: number): string[] {
		const lines: string[] = [];
		if (snap.busAheadOfBranch) {
			lines.push(
				fg(
					this.theme,
					"error",
					`⚠ /tree 回滚漂移告警：磁盘 state.json (${new Date(snap.lastSyncAt || Date.now()).toISOString().slice(11, 19)}) 比当前分支条目更新，已锁定只读绝不覆盖！`,
				),
			);
			lines.push("");
		}

		// 14-phase FSM Stepper
		const stepperParts = STEPPER_STAGES.map((p) => {
			const short = PHASE_BADGE_SHORT[p];
			if (p === snap.phase) return fg(this.theme, "accent", bold(this.theme, `[● ${short}]`));
			return fg(this.theme, "dim", short);
		});
		if (snap.phase === "PAUSED" || snap.phase === "BLOCKED") {
			stepperParts.push(fg(this.theme, "warning", bold(this.theme, `[● ${snap.phase}]`)));
		}
		lines.push(bold(this.theme, "FSM 阶段步进 (14 States):"));
		lines.push(`  ${stepperParts.slice(0, 6).join(" → ")}`);
		lines.push(`  ${stepperParts.slice(6).join(" → ")}`);
		lines.push("");

		const budgetAt = Math.max(1, Math.ceil(snap.budgetMaxDelegates * snap.budgetCutoffRatio));
		lines.push(
			`运行轨道: track=${snap.track} | risk=${snap.riskLevel} | trust=${snap.trustLevel} | writeGate=${snap.writeGate} | branch=${snap.integrationBranch || "(default)"}`,
		);
		lines.push(
			`预算进度: ${renderProgressBar(snap.budgetDispatched / Math.max(1, snap.budgetMaxDelegates), 10)} ${snap.budgetDispatched}/${snap.budgetMaxDelegates} (cutoff@${budgetAt}${snap.budgetCutoffActive ? " ACTIVE" : ""}) | aborted=${snap.abortedDelegates} | cost=$${snap.totalCost.toFixed(4)}`,
		);
		lines.push(`Pinned SHA: ${snap.pinnedSha || "(unset)"} | Bus: ${snap.busDir || "(none)"}`);

		if (snap.busState) {
			lines.push("");
			lines.push(bold(this.theme, "state.json 总线状态:"));
			lines.push(
				`  slug=${snap.busState.slug || snap.slug || "-"} | status=${snap.busState.status || "-"} | resumeNext=${snap.busState.resumeNext || "-"}`,
			);
			lines.push(`  predicate=${snap.busState.predicate || "(unset)"}`);
			const units = Array.isArray(snap.busState.units) ? snap.busState.units : [];
			lines.push(`  units (${units.length}):`);
			for (const u of units) {
				lines.push(`    - ${u.id}: status=${u.status || "?"}${u.sha ? ` sha=${String(u.sha).slice(0, 8)}` : ""}`);
			}
		}

		lines.push("");
		lines.push(bold(this.theme, `状态迁移历史 (${snap.history.length}/${WORKFLOW_PHASES.length} phases):`));
		if (snap.history.length === 0) {
			lines.push(fg(this.theme, "dim", "  (暂无迁移记录)"));
		} else {
			for (const h of [...snap.history].reverse()) {
				const t = h.ts ? new Date(h.ts).toISOString().slice(11, 19) : "--:--:--";
				lines.push(`  ${t}  ${h.fromPhase} → ${h.toPhase}  [${h.eventType}]${h.reason ? ` ${h.reason}` : ""}`);
			}
		}
		return lines.map((l) => fitToWidth(l, innerWidth));
	}

	private renderTab2Workers(snap: HubStateSnapshot, innerWidth: number): string[] {
		if (this.previewArtifactPath) {
			const header = [
				bold(this.theme, `partial-*.md 预览: ${this.previewArtifactPath}`),
				fg(this.theme, "dim", "↑↓/jk 滚动 | Esc/Backspace 返回 Workers 列表"),
				"─".repeat(Math.min(innerWidth, 60)),
			];
			const body = this.previewLines.slice(this.previewScroll);
			return [...header, ...body].map((l) => fitToWidth(l, innerWidth));
		}

		const workers = this.getAllWorkers(snap);
		const lines: string[] = [
			bold(this.theme, `Worker 车道表 (活跃 ${snap.activeWorkers.length} / 已结束 ${snap.completedWorkers.length})`),
			fg(this.theme, "dim", "↑↓/jk 选择车道 | Enter 预览 partial-*.md 抢救正文"),
			"",
		];
		if (workers.length === 0) {
			lines.push(fg(this.theme, "dim", "  (当前无 Worker 记录)"));
			return lines.map((l) => fitToWidth(l, innerWidth));
		}

		const now = Date.now();
		workers.forEach((w, idx) => {
			const cursor = idx === this.workerCursor ? fg(this.theme, "accent", "▸ ") : "  ";
			const endMs = w.finishedAt ?? now;
			const elapsed = Math.max(0, Math.round((endMs - (w.startedAt || endMs)) / 1000));
			const model = w.model ? w.model.split("/").pop() || w.model : "default";
			const partTag = w.partialArtifactPath ? " [partial📄]" : "";
			const violTag = w.roleViolation ? " [ROLE_VIOLATION]" : "";
			lines.push(`${cursor}${w.role}/${w.lane} | ${w.phase} | ${model} | ${elapsed}s | turns=${w.turns} | $${w.cost.toFixed(4)}${partTag}${violTag}`);
			const detail = w.stallReason
				? `    stall: ${w.stallReason}`
				: w.inFlightTool
					? `    inFlight: ${w.inFlightTool}`
					: w.lastActions.length > 0
						? `    actions: ${w.lastActions.slice(-2).join(" -> ")}`
						: "";
			if (detail) lines.push(fg(this.theme, "dim", detail));
		});
		return lines.map((l) => fitToWidth(l, innerWidth));
	}

	private renderTab3Gates(snap: HubStateSnapshot, innerWidth: number): string[] {
		const lines: string[] = [
			bold(this.theme, `门禁链状态 (Gate 1 → Gate 2 @ ${snap.pinnedSha || "unset"})`),
			snap.gate1
				? `  Gate 1 (${snap.gate1.role}): ${snap.gate1.verdict} | sha=${snap.gate1.pinnedSha.slice(0, 8)} | ${snap.gate1.summary || ""}`
				: "  Gate 1 (Verifier): (尚未运行)",
			snap.gate2
				? `  Gate 2 (${snap.gate2.role}): ${snap.gate2.verdict} | family=${snap.gate2.family || "?"} | sha=${snap.gate2.pinnedSha.slice(0, 8)}`
				: "  Gate 2 (Reviewer): (尚未运行)",
			"",
			bold(this.theme, `守卫告警/拦截记录 G-01..G-06 (${snap.violations.length}):`),
		];

		if (snap.violations.length === 0) {
			lines.push(fg(this.theme, "dim", "  (零违规记录)"));
		} else {
			for (const v of [...snap.violations].reverse()) {
				const t = v.ts ? new Date(v.ts).toISOString().slice(11, 19) : "--:--:--";
				lines.push(fg(this.theme, v.severity === "block" ? "error" : "warning", `  ${t} [${v.guard}/${v.severity}] ${v.message}`));
			}
		}

		lines.push("");
		lines.push(bold(this.theme, `decisions.tsv 审计尾行 (${snap.decisionsTail.length} rows):`));
		if (snap.decisionsTail.length === 0) {
			lines.push(fg(this.theme, "dim", "  (无 decisions.tsv 记录)"));
		} else {
			for (const r of [...snap.decisionsTail].reverse()) {
				lines.push(`  [${r.unit}/${r.phase}] ${r.decision} -> ${r.result} (${r.why})`);
			}
		}
		return lines.map((l) => fitToWidth(l, innerWidth));
	}

	private renderTab4WorktreesAndCost(snap: HubStateSnapshot, innerWidth: number): string[] {
		const lines: string[] = [bold(this.theme, "6 桶 Worktree 盘点 (cleanup-worktrees):")];
		const inv = snap.worktreeInventory;
		if (!inv) {
			lines.push(fg(this.theme, "dim", "  (尚未加载，按 'r' 异步刷新盘点)"));
		} else if (!inv.ok) {
			const cleanErr = String(inv.error || "非 Git 仓库").replace(/[\r\n]+/g, " ").trim();
			lines.push(fg(this.theme, "warning", `  盘点失败: ${cleanErr}`));
		} else {
			const bucketSummary = WORKTREE_BUCKETS.map((b) => `${b}:${inv.bucketCounts[b] ?? 0}`).join(" | ");
			lines.push(`  ${bucketSummary}`);
			lines.push("");
			for (const wt of inv.worktrees) {
				lines.push(`  [${wt.bucket}] ${wt.branch} | dirty=${wt.dirtyFiles} | merged=${wt.mergedIntoBase} | ${wt.path}`);
			}
		}

		lines.push("");
		lines.push(bold(this.theme, `成本分布 ASCII 条 (总计 $${snap.totalCost.toFixed(4)}):`));
		const renderBars = (title: string, rec: Record<string, number>) => {
			lines.push(`  ${title}:`);
			const entries = Object.entries(rec).sort((a, b) => b[1] - a[1]);
			if (entries.length === 0) {
				lines.push(fg(this.theme, "dim", "    (暂无成本数据)"));
				return;
			}
			const maxVal = Math.max(0.0001, ...entries.map(([, v]) => v));
			for (const [k, v] of entries) {
				const bar = renderProgressBar(v / maxVal, 12);
				lines.push(`    ${k.padEnd(18).slice(0, 18)} $${v.toFixed(4)} ${bar}`);
			}
		};
		renderBars("按角色 (Role)", snap.costByRole);
		renderBars("按模型 (Model)", snap.costByModel);

		lines.push("");
		lines.push(bold(this.theme, `429/5xx 熔断冷却通道 (${snap.providerCooldowns.length}):`));
		if (snap.providerCooldowns.length === 0) {
			lines.push(fg(this.theme, "dim", "  (当前无冷却通道)"));
		} else {
			for (const cd of snap.providerCooldowns) {
				lines.push(fg(this.theme, "warning", `  [COOLDOWN] ${cd.key} · ${cd.reason} · 剩余 ${cd.remainingSec}s`));
			}
		}

		return lines.map((l) => fitToWidth(l, innerWidth));
	}

	private renderTab5Controls(snap: HubStateSnapshot, innerWidth: number): string[] {
		const controls = [
			{ key: "m", label: `切换路由模式 (当前: ${snap.routingMode} -> off/auto/strict)` },
			{ key: "l", label: `解锁当前写保护锁 (当前: ${snap.writeGate}) [需确认]` },
			{ key: "w", label: "异步清理安全 worktree (cleanup-worktrees --prune-safe) [需确认]" },
			{ key: "c", label: `复制续跑命令 (/zee resume ${snap.slug || ""})` },
			{ key: "d", label: `切换 HUD 密度 (当前: ${snap.hudDensity} -> full/compact/hidden)` },
			{ key: "p", label: `暂停当前运行 (当前: ${snap.phase} -> PAUSED) [需确认]` },
			{ key: "h", label: `清除 429/5xx 模型冷却缓存 (当前活跃: ${snap.providerCooldowns.length}, provider-health --clear)` },
		];

		const lines: string[] = [
			bold(this.theme, "控制台单键操作 (Controls):"),
			fg(this.theme, "dim", "直接按对应字母键，或 ↑↓ 选择后按 Enter 触发；破坏性操作需二次确认。"),
			"",
		];
		controls.forEach((item, idx) => {
			const cursor = idx === this.controlCursor ? fg(this.theme, "accent", "▸ ") : "  ";
			lines.push(`${cursor}[${item.key}] ${item.label}`);
		});
		if (this.pendingConfirm) {
			lines.push("");
			lines.push(fg(this.theme, "warning", bold(this.theme, `⚠ ${this.pendingConfirm.prompt}`)));
		}
		return lines.map((l) => fitToWidth(l, innerWidth));
	}

	render(width: number): string[] {
		if (width <= 4) return [];
		const snap = this.store.getSnapshot();
		const termRows = (this.tui as unknown as { terminal?: { rows?: number } })?.terminal?.rows ?? process.stdout?.rows ?? 34;
		const maxBodyLines = Math.max(8, Math.min(24, Math.floor(termRows * 0.8) - 7));
		const innerWidth = Math.max(10, width - 4);

		// Header
		const title = ` zee Hub v4.2.2 · ${snap.riskLevel}·${snap.routingMode}·${snap.trustLevel} · ${snap.phase} `;
		const topBorder = fitToWidth(buildBorderLine("╭", "╮", `─${title}`, "─", width), width);

		// Tab Bar（窄屏 <94 列自动切换中文短标签，防止 80 列截断 [5 Controls]）
		const tabLabels = width < 94 ? TAB_TITLES_COMPACT : TAB_TITLES;
		const tabs = tabLabels
			.map((t, idx) =>
				idx === this.activeTab ? fg(this.theme, "accent", bold(this.theme, `[${t}]`)) : fg(this.theme, "dim", ` ${t} `),
			)
			.join(" ");
		const tabLine = fitToWidth(buildInteriorLine(tabs, width), width);
		const sepLine = fitToWidth(buildBorderLine("├", "┤", "", "─", width), width);

		// Body
		let allBody: string[];
		if (this.activeTab === 0) allBody = this.renderTab1Overview(snap, innerWidth);
		else if (this.activeTab === 1) allBody = this.renderTab2Workers(snap, innerWidth);
		else if (this.activeTab === 2) allBody = this.renderTab3Gates(snap, innerWidth);
		else if (this.activeTab === 3) allBody = this.renderTab4WorktreesAndCost(snap, innerWidth);
		else allBody = this.renderTab5Controls(snap, innerWidth);

		const isPreview = Boolean(this.previewArtifactPath);
		const offset = isPreview ? 0 : Math.min(this.scrollOffset, Math.max(0, allBody.length - maxBodyLines));
		const visibleBody = allBody.slice(offset, offset + maxBodyLines);
		while (visibleBody.length < Math.min(maxBodyLines, 8)) {
			visibleBody.push("");
		}

		const bodyLines = visibleBody.map((l) => fitToWidth(buildInteriorLine(padToWidth(l, innerWidth), width), width));

		// Footer
		const toast = this.toastMessage ? ` | ${this.toastMessage}` : "";
		const navHint = `1-5/Tab 切页 · ↑↓/jk 滚动 · r 刷新 · q/Esc/F2 关闭${toast}`;
		const footerLine = fitToWidth(buildInteriorLine(fg(this.theme, "dim", navHint), width), width);
		const bottomBorder = fitToWidth(buildBorderLine("╰", "╯", "", "─", width), width);

		return [topBorder, tabLine, sepLine, ...bodyLines, sepLine, footerLine, bottomBorder];
	}

	invalidate(): void {
		// Recomputed dynamically from store snapshot on render
	}

	dispose(): void {
		this.unsub();
	}
}

export async function openZeeHubOverlay(
	ctx: ExtensionContext,
	store: HubStore,
	actions: HubActions,
): Promise<void> {
	if (!ctx.hasUI) return;
	if (getCtxMode(ctx) !== "tui") {
		ctx.ui.notify(formatRpcHubSummary(store.getSnapshot()), "info");
		return;
	}

	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) =>
			new ZeeHubOverlayComponent(store, tui, theme, actions, () => {
				done(undefined);
			}),
		{
			overlay: true,
			overlayOptions: HUB_OVERLAY_OPTIONS,
		},
	);
}
