---
name: zee-review
description: Zee 跨家族对抗审查：导出隔离沙盒 + 异构 adversary 模型只读审计 + 防篡改校验
disable-model-invocation: true
---

# `/zee-review` — 跨家族对抗审查

遵循 `skills/zee/roles/reviewer.md` 开展独立审查：

1. 运行 `node <scripts>/zee-tool.mjs gate-tamper-diff --repo <repoRoot> --working-tree`（或指定 `--base`/`--head`）获取篡改、抑制注解、密钥与编码检查数据。
2. 如需彻底只读隔离上下文，执行 `node <scripts>/zee-tool.mjs sandbox-export --repo <repoRoot> --working-tree --prefix rev` 拿到 `sandboxDir`。
3. 调用 `resolve-model --role reviewer --allow-standalone` 解析 `adversary` 槽位模型；派发 `reviewer` 子代理时**聚焦审查本次 `git diff` / 变更文件清单**（不漫无目的全仓扫描）、**务必显式传入代码作者的 `authorFamily`**，并**省略 `timeoutMs` 沿用默认角色超时**（勿传过短超时）。
4. 若首选模型超时切换备用模型，复用同一隔离沙盒，全部审查结束后再统一 `sandbox-clean <sandboxDir>`，输出带精准文件行号证据的 `VERDICT` 与 `P0/P1/P2` 清单。
