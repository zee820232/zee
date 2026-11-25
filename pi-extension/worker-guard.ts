/**
 * zee Worker Guard Extension (v4.1.1)
 *
 * 专供 zee_subagent 启动的 Pi 子进程通过 `-ne -e worker-guard.ts` 挂载：
 * - 零自动路由、零斜杠命令、零 zee_subagent 工具、零系统提示词注入
 * - 仅注册单一 tool_call 守卫，彻底堵死 `-ne` 带来的子进程安全真空：
 *   1. 对所有角色（含 coder / ui）无条件执行项目 denyCommands（token 边界匹配）与破坏性命令拦截（含括号子 shell）
 *   2. 对只读/门禁角色（scout / architect / judge / verifier / reviewer）在事前拦截对仓库源码的 write/edit
 *   3. 对纯只读角色（scout / architect / judge）额外执行只读 review 级 Bash 词法拦截（放行 /tmp/zee-* 沙盒内探针与装包）
 */

import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
	checkBashUnderGate,
	checkProjectDenyCommands,
	evaluateDestructiveCommand,
	isReadOnlyRoleWriteAllowed,
} from "../skills/zee/scripts/lib/guard-core.mjs";

const WRITE_LOCKED_ROLES = new Set(["scout", "architect", "judge", "verifier", "reviewer"]);
const STRICT_BASH_ROLES = new Set(["scout", "architect", "judge"]);

export default function zeeWorkerGuard(pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		const role = String(process.env.ZEE_ROLE || "").trim().toLowerCase();

		if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
			const command = event.input.command;
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
			if (STRICT_BASH_ROLES.has(role)) {
				const violation = checkBashUnderGate(command, ctx.cwd, "review");
				if (violation) {
					return { block: true, reason: `[zee-worker:${role}] ${violation}` };
				}
			}
			return undefined;
		}

		if (WRITE_LOCKED_ROLES.has(role) && (isToolCallEventType("write", event) || isToolCallEventType("edit", event))) {
			const rawPath = event.input.path;
			if (isToolCallEventType("edit", event)) {
				return {
					block: true,
					reason: `[zee-worker:${role}] 只读/门禁角色禁止使用 edit 工具修改 "${rawPath}"。`,
				};
			}
			if (!isReadOnlyRoleWriteAllowed(rawPath, ctx.cwd)) {
				return {
					block: true,
					reason: `[zee-worker:${role}] 只读/门禁角色禁止写入仓库路径 "${rawPath}"（仅允许写入 ~/.local/state/zee/runs/ 或 /tmp/zee-* 沙盒目录）。`,
				};
			}
		}

		return undefined;
	});
}
