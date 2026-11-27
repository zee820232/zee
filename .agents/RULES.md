# Zee 仓库工程规则与机械拦截表

本文件仅记录无法单靠读源码猜出的仓内硬约束。凡已获机械拦截的规则无需在文档中重复说教。
> 注意：本仓库本身是 Antigravity 插件，仓根严禁放置 `AGENTS.md`（否则 `agy plugin validate --strict` 会因规则须放在 `rules/` 而报错），因此仓内 `Rule -> Enforcer` 表统一维护在本文件 `.agents/RULES.md`。

## Rule -> Enforcer 映射表

| 工程规则 | 机械拦截位置（Enforcer） | 状态 |
| :--- | :--- | :---: |
| 主入口 `skills/zee/SKILL.md` 严控 `<= 4096B` 且允许隐式唤醒 | `tests/manifest-and-skills.test.mjs` | 已强制 |
| 6 把专项单刀禁隐式唤醒，防劫持普通对话 | `tests/manifest-and-skills.test.mjs` | 已强制 |
| `principles.md <= 12` 行、角色卡 `<= 35` 行且必含 `Return:` | `tests/manifest-and-skills.test.mjs` | 已强制 |
| 全部 `.mjs` 与 `.ts` 无语法错误（零外部依赖检查） | `npm run typecheck` / `.agents/verify-ctl.mjs` | 已强制 |
| AGY `hooks.json` 仅挂载 `Stop`（严禁挂 `PreToolUse`） | `tests/manifest-and-skills.test.mjs` | 已强制 |
| AGY 插件根严禁存在 `AGENTS.md`（防 `agy plugin validate --strict` 失败） | `tests/manifest-and-skills.test.mjs` | 已强制 |
| AGY `Stop` 按外部副作用指纹止损，防空刷 `updatedAt` 死循环 | `tests/agy-hook.test.mjs` | 已强制 |
| 只读角色严禁改写仓库源码，跨家族审查硬拦截同家族模型 | `pi-extension/worker-guard.ts` + `tests/pi-extension.test.mjs` | 已强制 |
| 跨平台破坏性命令与 `denyCommands` 词法拦截（含 Windows） | `skills/zee/scripts/lib/guard-core.mjs` + `tests/guard-core.test.mjs` | 已强制 |
| `trustLevel` 升档须过可验证性硬体检，不达标自动降级 | `skills/zee/scripts/zee-tool.mjs` + `tests/zee-tool.test.mjs` | 已强制 |
| 技能与剧本改版须防止观察者效应与链路漂移 | `tests/eval/blind-eval.mjs` + `tests/eval/README.md` | 已强制 |
| 发布白名单排除 `docs/`、`tests/`、`.agents/` 与仓根 `AGENTS.md` | `package.json` (`files`) + `tests/manifest-and-skills.test.mjs` | 已强制 |

## 改版验收命令

```bash
npm run typecheck && npm test && npm run verify
```
