# Zee 盲测 Eval 规范与工具（反观察者效应）

当修改 `skills/zee/SKILL.md`、`principles.md`、`playbooks/*.md` 或 `roles/*.md` 时，单元测试只能验证文件结构和体积，无法证明模型在真实任务中是否仍会按链路执行。本目录提供零依赖的盲测基础设施（吸收 `pstack` `playbooks/eval.md`）。

## 盲测 4 条不可违背红线

1. **全链路致盲**：候选工作区路径、文件名和用户 Prompt 中严禁出现 `eval`、`test`、`judge`、`candidate`、`rubric`、`benchmark`、`arena` 等字样。
2. **自然口语 Prompt**：只写“目标 + 可判真假的验收条件”，严禁诱导模型自报读了哪些 Skill 或原则。
3. **查真实转录，不信自报**：使用 `verifyTranscriptChain()` 读取本次运行的 JSONL 转录，直接统计模型**实际打开的文件与实际执行的命令**（如是否真的读了对应 `playbooks/*.md`、是否真的跑了 `gate-tamper-diff` 与实测）。
4. **跨家族同尺盲评**：对比 `baseline` 与 `variant` 时，隐去版本标签交由单一跨家族裁判按 3–5 条 Rubric 同轮打分。

## 快速运行内置自检

```bash
node tests/eval/blind-eval.mjs --self-check
```
