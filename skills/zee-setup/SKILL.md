---
name: zee-setup
description: Zee 单宿主模型配置器：对齐 pstack 能力梯队与预算阶梯（large/medium/small），严格按当前宿主推荐并写入 harnesses.<activeHarness>
disable-model-invocation: true
---

# `/zee-setup` — 单宿主能力梯队与预算分配（对齐 pstack）

本命令采用 **能力优先 + 预算仅调思考档位**（参考 `pstack` 阶梯：`large` / `medium` / `small`），将选定方案合并写入 `~/.agents/zee-config.json` 的 `harnesses.<activeHarness>` 分区，**严禁改动业务仓库源码**。

## 核心红线：单宿主隔离 + 禁止低智降级 / 测速竞速

1. **先识别当前宿主**：首先执行：
   ```bash
   node <skillDir>/../zee/scripts/zee-tool.mjs doctor
   ```
   以 `activeHarness` 为唯一操作目标（`t3` / `antigravity` / `pi` / `codex` / `claude`）。
2. **严禁跨宿主嗅探或修改**：
   - **`activeHarness !== "pi"` 时**：**严禁**执行 `pi --list-models`、`pi.cmd`、`pi --print`，也**严禁**读写 `~/.pi/agent/settings.json`、`~/.omp/` 或插件 `tests/`。
   - **`activeHarness === "pi"` 时**：**严禁**调用 `orchestrator_capabilities` 或 `swarm`。
3. **禁止“低智模型 / `low` 思考档位 / 延迟测速”误配**：
   - **禁止**把 `deepseek`、`gemini-3.8`、`mini`/`lite`/`nano` 等轻量或非主力模型自动放进 `fast`/`workhorse`/`adversary`（仅作为 `optInModels` 列出，除非宿主无其他旗舰可选或用户点名指定）；
   - **最低思考档位为 `medium`，所有模型与所有槽位均禁止设置为 `low`**（阶梯仅使用 `medium < high < xhigh`）；
   - **禁止**发 `"reply ok"` 测速竞赛或因模型未回复精确 `"ok"` 字样而剔除旗舰（必须按 `skills/zee/models.json` 能力梯队打分，预算档位：`large`=`xhigh`/`high`，`medium`=`high`/`medium` 推荐，`small`=`medium`/`medium`）。

## 执行步骤

1. **按 `activeHarness` 获取候选清单并调用 `recommend-models`**：
   - **`pi`（Pi CLI）**：执行 `pi --list-models`（Windows 受 `.ps1` 策略限制改用 `pi.cmd --list-models`），直接通过管道传给确定性推荐引擎（**秒出，无需跑一轮 `pi --print` 探活**）：
     ```bash
     pi --list-models | node <skillDir>/../zee/scripts/zee-tool.mjs recommend-models --harness pi --budget medium
     ```
     仅当用户明确要求验证连通性时才跑最小探活：且只需判 `exitCode === 0` 且 stdout 非空（**绝不要求正文严格等于 `"ok"`**，也不允许以响应快慢推翻能力梯队）。
   - **`t3`（T3 Code）**：仅调用 `orchestrator_capabilities` **一次**（**0 条 shell 探活、不拉测试子线程**），将完整 JSON 喂给：
     `recommend-models --harness t3 --budget medium`（会自动过滤 `canRunChildTask !== true`、`gemini-pro-orchestrator` 与多渠道重复 slug，并优先原生 `antigravity`/`codex`/`claudeAgent`）。
   - **`antigravity`（独立 AGY CLI，无 T3 Code）**：0 条 shell 探活，严格遵守 `AGENTS.md`（`invoke_subagent` 固定 `model: "inherit"`，配 Gemini 4 `swarmModel`，标记 `singleFamily: true`；仅已在 `/swarm` 中时可调 `swarm(action="models")`）。
   - **`codex` / `claude` / `cursor` / `local`**：收集当前宿主可用 slug 传给 `recommend-models --harness <activeHarness> --budget medium`，或引导用 `inherit-parent` / `--allow-standalone`。
2. **展示简体中文推荐表并一次确认**：
   - 列出推荐的 **预算档位**（默认 `medium`：`workhorse`/`adversary` 用 `high`、`fast` 用 `medium`；可切 `large` 满血 `xhigh`/`high` 或 `small` 日常全 `medium`）、**3 槽位**（`fast` / `workhorse` / `adversary` 主+备）及支持开关 `inherit-parent` / `auto`（跟随当前父会话模型）。
   - 若结果含 `optInModels`（如 `deepseek-v4.1-flash`、`gemini-3.8-flash`），仅单独附注一行“以下轻量渠道已按策略隔离未自动入选，如需指定请回复”，等待用户回复“按推荐”（或指定档位/调整槽位）。
3. **合并写盘与验证**：
   - 读取现有 `~/.agents/zee-config.json`（若不存在则新建），**完整保留其他宿主的 `harnesses.<other>` 与旧版顶层 `slots` 不变**，将 `harnessConfig` 写入 `harnesses.<activeHarness>`（保持 `version: 3`, `authorizedFallback: true`）。
   - **仅当 `activeHarness === "pi"` 且 `~/.pi/agent/settings.json` 的 `defaultModel` 已失效时**，征得同意同步更新为健康 `workhorse` 模型。
   - 运行 `node <zee-tool.mjs> doctor`、`resolve-model --role verifier`、`resolve-model --role reviewer` 验证全绿后汇报。
