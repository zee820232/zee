---
name: zee-setup
description: Zee 单宿主模型探活与 3 槽位配置器：严格按当前运行宿主枚举可用模型，确认 fast / workhorse / adversary 后仅写入 ~/.agents/zee-config.json 的 harnesses.<activeHarness> 分区
disable-model-invocation: true
---

# `/zee-setup` — 单宿主模型分配与 3 槽位配置

本命令只做当前宿主的模型枚举与 `~/.agents/zee-config.json` 合并写入，**严禁改动业务仓库源码**。

## 核心红线：单宿主严格隔离

1. **先识别当前宿主**：首先运行与本 Skill 相邻的脚本（或 `<skill>` 头部注入的 `Zee Tool CLI`）：
   ```bash
   node <skillDir>/../zee/scripts/zee-tool.mjs doctor
   ```
   以 JSON 返回的 `activeHarness` 为唯一操作目标（`t3` / `antigravity` / `pi` / `codex` / `claude`）。
2. **严禁跨宿主嗅探或修改**：
   - **当 `activeHarness !== "pi"` 时**：**严禁**执行 `pi --list-models`、`pi.cmd`、`pi --print`，也**严禁**读取或修改 `~/.pi/agent/settings.json`、`~/.omp/` 或插件 `tests/` 目录。
   - **当 `activeHarness === "pi"` 时**：**严禁**调用 `orchestrator_capabilities` 或 `swarm`。

## 执行步骤

1. **按 `activeHarness` 枚举可用模型**：
   - **`t3`（T3 Code）**：仅调用 `orchestrator_capabilities` **一次**（**0 条 shell 探活命令**，也不要拉起测试用 `delegate_task` 子线程），筛选 `canRunChildTask === true` 的已启用渠道，严格遵守全局 `AGENTS.md` 约束（如 Gemini 4 代际锁）。**优先选择当前父级或原生已启用渠道**（如 `antigravity` / `codex` / `claudeAgent`），不优先把 T3 的 `pi` provider 当主选；枚举后直接出推荐表。
   - **`antigravity`（独立 AGY CLI，无 T3 Code）**：不跑 `pi` CLI，严格遵守全局 `AGENTS.md`（`invoke_subagent` 统一记 `model: "inherit"`，严禁填 `pro`/`flash`/`flash_lite`）。0 条 shell 探活；记录 `model: "inherit"` + Gemini 4 `swarmModel`，标记 `singleFamily: true`（仅当前已在 `/swarm` 中时才调 `swarm(action="models")`）。
   - **`pi`（Pi CLI）**：运行 `pi --list-models`（Windows 受 `.ps1` 策略限制改用 `pi.cmd --list-models`）。跨家族挑选 **4–6 个**头部候选并发跑一轮 30s 轻量探活（`pi --print --no-session --no-extensions --no-skills --provider <p> --model <m> "reply ok"`），剔除超时或报错通道，禁止反复重试循环。
   - **`codex` / `claude` / `cursor` / `local`**：仅读取当前宿主的模型目录，或提示用户指定模型 ID / 使用 `--allow-standalone` 单兵模式。
2. **一次确认 3 槽位分配**（先输出简体中文推荐表，用户可直接回“按推荐”或微调）：
   - `fast`（`scout` 侦察）：选最快低成本模型（低思考）。
   - `workhorse`（`architect` / `coder` / `ui` / `verifier`）：选最稳主力编码模型（中思考）。
   - `adversary`（`reviewer` / `judge`）：优先选与 `workhorse` **不同模型家族**的审查模型；各槽位均配健康 `backup`（如当前宿主仅启用单一家族，设为 `singleFamily: true` 并用不同型号/档位互备）。
3. **按宿主分区合并写盘与验证**：
   - 读取现有 `~/.agents/zee-config.json`（若不存在则新建），**完整保留其他宿主的 `harnesses.<other>` 与旧版顶层 `slots` 不变**，仅更新 `version: 3`、`authorizedFallback: true` 与 `harnesses.<activeHarness>`（写入 `slots: { fast, workhorse, adversary }`；T3 渠道按 `{ providerInstanceId, model, options }` 落盘，AGY 渠道记 `{ model: "inherit", swarmModel }`）。
   - **仅当 `activeHarness === "pi"` 且发现 `~/.pi/agent/settings.json` 的 `defaultModel` 失效时**，征得同意同步更新为健康 `workhorse` 模型。
   - 最后运行 `node <zee-tool.mjs> doctor`、`resolve-model --role verifier`、`resolve-model --role reviewer`（不手写其他 `--harness`）验证全绿后汇报。
