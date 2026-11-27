# AGY Stop 过夜守夜与安全词法拦截

覆盖 `scripts/agy-guard.mjs` 的会话严格隔离、外部副作用进展指纹止损与 `guard-core.mjs` 跨平台高危命令拦截。

## Sub-features

- `stop-isolation`：严格按 `conversationId` 隔离，禁止 `null` 跨会话劫持普通窗口
- `side-effect-stagnation`：连续 2 次唤醒无真实 Git/决策/单元状态变化即熔断放行（防空刷 `updatedAt`）
- `destructive-guard`：拦截 POSIX 与 Windows 盘符根删除、嵌套 Shell 与主干 `git push --force`

## 用户入口（全路径）

- Antigravity `hooks.json` 的 `Stop` 生命周期钩子（通过 stdin 传入 JSON）
- `node --test tests/agy-hook.test.mjs tests/guard-core.test.mjs`

## 驱动与可观测验收

- **Hook 契约验真**：运行 `node --test tests/agy-hook.test.mjs`；期望退出码 `0`，覆盖正常续命、空刷状态止损与 24h 陈旧总线放行。
- **词法安全核验真**：运行 `node --test tests/guard-core.test.mjs`；期望退出码 `0`，覆盖破坏性拦截与只读命令防误拦。

## Gotchas

- Antigravity `PreToolUse` 不支持 `{}` 透传，因此 `hooks.json` 仅挂载 `Stop`，严禁擅自恢复 `PreToolUse`。
