/**
 * zee Worker Guard Extension (v5.2.0)
 *
 * 供 zee_subagent 启动的 Pi 子进程通过 `-ne -e worker-guard.ts` 挂载：
 * 1. 对所有角色执行项目 denyCommands（token 边界匹配）与跨平台破坏性命令拦截
 * 2. 对只读/门禁角色（scout / architect / judge / verifier / reviewer）拦截 write/edit 写入仓库源码
 */

import * as path from "node:path";
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
	checkProjectDenyCommands,
	evaluateDestructiveCommand,
	isReadOnlyRoleWriteAllowed,
	isWithinDir,
} from "../skills/zee/scripts/lib/guard-core.mjs";

const WRITE_LOCKED_ROLES = new Set(["scout", "architect", "judge", "verifier", "reviewer"]);

function resolveExtraBusDir(cwd: string): string[] {
	const raw = String(process.env.ZEE_BUS_DIR || "").trim();
	if (!raw || !path.isAbsolute(raw)) return [];
	if (isWithinDir(raw, cwd || process.cwd())) return [];
	return [raw];
}

export default function zeeWorkerGuard(pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		const role = String(process.env.ZEE_ROLE || "").trim().toLowerCase();
		const extraAllowedDirs = resolveExtraBusDir(ctx.cwd);

		if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
			const command = String((event.input as { command?: unknown } | undefined)?.command ?? "");
			const denyReason = checkProjectDenyCommands(command, ctx.cwd);
			if (denyReason) {
				return { block: true, reason: `[zee-worker:${role || "worker"}] ${denyReason}` };
			}
			const destructive = evaluateDestructiveCommand(command, ctx.cwd);
			if (destructive) {
				return {
					block: true,
					reason: `[zee-worker:${role || "worker"} 安全护栏] ${destructive.reason}，子代理严禁自动执行。`,
				};
			}
			return undefined;
		}

		if (WRITE_LOCKED_ROLES.has(role) && (isToolCallEventType("write", event) || isToolCallEventType("edit", event))) {
			const rawPath = String((event.input as { path?: unknown } | undefined)?.path ?? "");
			if (isToolCallEventType("edit", event)) {
				return {
					block: true,
					reason: `[zee-worker:${role}] 只读/门禁角色禁止使用 edit 工具修改 "${rawPath}"。`,
				};
			}
			if (!isReadOnlyRoleWriteAllowed(rawPath, ctx.cwd, extraAllowedDirs)) {
				return {
					block: true,
					reason: `[zee-worker:${role}] 只读/门禁角色禁止写入仓库路径 "${rawPath}"（仅允许写入 ~/.local/state/zee/runs/ 或 /tmp/zee-*）。`,
				};
			}
		}

		return undefined;
	});
}
