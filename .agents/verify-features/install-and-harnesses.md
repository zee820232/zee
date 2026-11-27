# 多宿主安装器与清单契约

覆盖 `scripts/install.mjs` 的多宿主自动探测、`--dry-run`、Windows `.cmd` 特殊字符安全传递及全部 7 项技能/9 份剧本/7 份角色卡体积与元数据契约。

## Sub-features

- `install-targets`：`--target auto|pi|agy|skills|both|all` 与 `--strict` 参数校验
- `win-cmd-escape`：含空格、括号、`&`、`%VAR%` 与尾反斜杠参数的零损传递
- `manifest-budget`：`skills/zee/SKILL.md <= 4096B`、`principles.md <= 12` 行、角色卡 `<= 35` 行

## 用户入口（全路径）

- `node scripts/install.mjs --target auto --dry-run`
- `node scripts/install.mjs --target skills --dry-run`
- `node --test tests/manifest-and-skills.test.mjs`

## 驱动与可观测验收

- **清单与预算验真**：运行 `node --test tests/manifest-and-skills.test.mjs`；期望退出码 `0` 且全部测试通过。
- **安装预览验真**：运行 `node scripts/install.mjs --target skills --dry-run`；期望输出含 `-g -s * -y` 且不修改本机目录。

## Gotchas

- 拼错参数（如 `--dryrun`）必须非 0 退出并报“参数错误”，严禁静默落盘。
- 修改版本号时须同步 `package.json`、`.antigravity-plugin/plugin.json`、`install.mjs` 及测试断言。
