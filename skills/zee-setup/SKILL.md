---
name: zee-setup
description: Zee 模型探活与 3 槽位配置器：检测可用模型、30s 轻量探活、确认 fast / workhorse / adversary 并写入 zee-config.json
disable-model-invocation: true
---

# `/zee-setup` — 模型探活与 3 槽位配置

本命令只做模型枚举、健康探活与 `~/.agents/zee-config.json` 写入，**严禁改动业务仓库源码**。

## 执行步骤

1. **枚举当前宿主可用模型**：
   - **Pi CLI**：运行 `pi --list-models`（Windows 下若受 `.ps1` 策略限制改用 `pi.cmd --list-models`）。
   - **AGY / T3 Code**：调用 `orchestrator_capabilities` 或 `swarm(action="models")` 读取可用渠道，并严格遵守全局 `AGENTS.md` 中的模型限制。
   - 若当前宿主无法枚举模型，提示用户提供模型 ID 或直接使用 `--allow-standalone` 单兵模式。
2. **轻量实机探活**：
   - 对候选模型做最小连通性探活（Pi 下用 `--print --no-session --no-extensions --no-skills --provider <p> --model <m> "reply ok"`，超时 30s），自动剔除超时或报错通道。
3. **一次确认 3 槽位分配**（Schema v3，先给推荐表，用户可直接回“按推荐”）：
   - `fast`（`scout` 侦察）：选最快廉模型，`effort: "low"`。
   - `workhorse`（`architect` / `coder` / `ui` / `verifier`）：选最强稳主力编码模型，`effort: "medium"`。
   - `adversary`（`reviewer` / `judge`）：**必须与 `workhorse` 属于不同模型家族**，`effort: "medium"`；各槽位均配同级健康 `backup`。
4. **写盘与体检**：
   - 写入 `~/.agents/zee-config.json`（`version: 3`, `authorizedFallback: true`, `slots: { fast, workhorse, adversary }`）。
   - 若发现 `~/.pi/agent/settings.json` 中的 `defaultModel` 已失效，征得同意或按推荐同步更新为健康 `workhorse` 模型。
   - 最后运行 `<Zee Tool CLI> doctor` 与 `resolve-model --role verifier`、`resolve-model --role reviewer` 验证全绿后汇报。
