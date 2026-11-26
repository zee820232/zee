---
name: zee-review
description: Zee 只读跨家族实证对抗审查与爆炸半径校验（支持 --strict 隔离沙盒对抗与 --quick 聚焦 diff 快审）
disable-model-invocation: true
---

# `/zee-review` — 跨家族实证对抗审查

遵循 `skills/zee/roles/reviewer.md`，按档位执行只读审查（绝不修改业务源码）：

- **共有前置**：必跑 `<ZEE_TOOL> gate-tamper-diff --repo <repoRoot> --working-tree`（或指定 `--base`/`--head`），核对门禁改动、`suppressionsAdded`、`secretsAdded` 与 `\uFFFD` 乱码；若 `requiresCountersign: true`，必须校验是否存在合法 `GATE_CHANGE_RATIONALE:` 及其理由真实性，否则判 `CHANGES_REQUESTED`。
- **`--quick`（小 diff 单轮快审）**：
  1. 不建外部沙盒，直接聚焦本次 `git diff` 与变更文件，检查真实逻辑边界、安全红线与 `gate-tamper-diff` 异常。
  2. 输出精简 `VERDICT`、“使其安全的唯一关键事实”与经核实的 `P0/P1` 清单（零缺陷直接 `APPROVE`）。
- **`--strict`（默认，跨家族隔离对抗审查）**：
  1. 执行 `<ZEE_TOOL> sandbox-export --repo <repoRoot> --working-tree --prefix rev` 拿到只读隔离 `sandboxDir`。
  2. 调用 `<ZEE_TOOL> resolve-model --role reviewer --author-family <作者家族> --allow-standalone` 解析异构 `adversary` 模型；派发 `reviewer` 子代理时聚焦本次 diff、Pi 下显式传入 `authorFamily` 并**省略 `timeoutMs`**（`standalone: true` 或单家族宿主须首行标 `[单家族降级]`）。
  3. **实证准入**：未附可复现命令/输出或精确调用链的臆测与纯风格挑刺一律剔除；必须点名并验证“使其安全的唯一关键事实”及证据等级（`L1–L5`）；非阻断 P2 坏味道用 `finding add` 写入园艺队列。
  4. 若首模型 429/超时切备，复用同一 `sandboxDir`；全部结束后统一 `<ZEE_TOOL> sandbox-clean <sandboxDir>`，输出 `VERDICT`、分级实证清单与 `Attention` 风险点名（≤3 条）。
