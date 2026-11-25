# Discipline: Project-Local Verification Skill (`verify-<app>`) Lifecycle

Loaded during `/zee-setup` (optional verification bootstrap/audit), `/zee-init` Stage 3 (M0/M1), and `Verifier` execution.

## 1. Purpose
Static `testCmds` prove unit tests, not real user journeys. Every serious UI, CLI/TUI, game, desktop, or service project benefits from a committed, repo-local verification skill:
`<projectSkillsDir>/verify-<app>/SKILL.md` + `scripts/verify-ctl.(mjs|py|sh)` + `features/README.md` + `features/<feature>.md`
(default `<projectSkillsDir>` = `.agents/skills/`, or reuse `.pi/skills/` / `.claude/skills/` / `.cursor/skills/` if the repo already keeps skills there). Write it for a **cold-start Verifier agent** that has never seen the app.

## 2. Mandatory Output Isolation & Deterministic Control Script
- **Zero Repo Scratch Rule (Non-Negotiable)**: ALL test outputs, temp dirs, Playwright reports/traces, and build/test scratch MUST live in `/tmp/zee-verify-*` or `<busDir>`. **NEVER** create or `rm -rf` `test-results`, `playwright-report`, or `dist` inside the repository during `review🔒` locked `/zee-verify run` or Gate 1 `Verifier`.
- **Deterministic CLI Entry (`scripts/verify-ctl.(mjs|py|sh)`)**: ship one executable control script under `<projectSkillsDir>/verify-<app>/scripts/verify-ctl.(mjs|py|sh)` exposing 5 deterministic subcommands so agents never improvise brittle shell glue:
  1. `launch` — cold-start from an empty `/tmp/zee-verify-*` data dir on an isolated free port and wait for true usability readiness (not just open TCP port).
  2. `doctor` — read-only health check confirming process up, expected build/version, port ownership, and valid state/auth.
  3. `snapshot` — capture current DOM/TUI/state snapshot or route status cleanly.
  4. `evidence` — copy screenshots/logs/traces into `<busDir>/screenshots/` or `<busDir>/artifacts/`.
  5. `cleanup` — PID-only teardown + `/tmp/zee-verify-*` scratch cleanup that **NEVER** deletes `<busDir>` proof artifacts.

## 3. Generate (`create` flow — Interview the Repo, Not the User)
1. **Inspect 5 Dimensions from Source**: `Surface`, `Launch`, `Doctor`, `Drive` (stable ARIA/`data-testid`/route/CLI handles — never coordinates), and `Isolate & Cleanup`.
2. **Write `verify-<app>/SKILL.md`** with YAML frontmatter (`name: verify-<app>`, concrete `description`), 6 grounded sections (`Launch`, `Doctor`, `Drive`, `Evidence`, `Cleanup`, `Helpers`), and `scripts/verify-ctl.(mjs|py|sh)`.
3. **Seed `features/` Map**: `features/README.md` index + 3–5 top user-facing `features/<name>.md` files, each with 4 H2s: `Sub-features` · `How to get to it (user POV)` · `Driving it with <harness>` · `Gotchas`.
4. **Hard Live Proof Gate (Non-Negotiable)**:
   > *A generated verification skill that was never executed end-to-end is a draft, not a deliverable.*
   Execute `verify-ctl` / `SKILL.md` end-to-end live: `Launch -> Doctor -> Drive 1 mapped feature -> Evidence -> Cleanup -> Confirm evidence STILL exists at the named path`. Run cleanup after any failed attempt too.

## 4. Maintain (`maintain` flow — Anti-Rot Loop)
When the app evolves and the feature map may have drifted (edits allowed ONLY inside `verify-<app>/`, NEVER product code):
1. **Index Hygiene**: reconcile `features/README.md` against actual files and confirm `verify-ctl.*` works.
2. **Parallel Source Wave**: 1 read-only `Scout` per feature file checking source entry points, likely doc drift, and returning a concise live recipe.
3. **Mandatory Live Pass**: drive every mapped feature live serially (optionally followed by `--fuzz`), holding 3 invariants: (a) run `Doctor` before first drive and after any failure; (b) confirm captured evidence survives every cleanup; (c) clean up residue from failed drives without touching repo dirs.
4. **Strict Triage**:
   - Wrong user-POV description -> **doc drift** (fix `features/`).
   - Working app the harness can't drive -> **harness gap** (fix `verify-ctl.*`/recipe & re-drive live).
   - App behavior actually broken -> **product regression** (report to human; **never** weaken the map to hide a bug).
5. **Outcome**: report `clean`, `changed` (proven corrections), or `blocked` honestly.

## 5. Exploratory `--fuzz` Pass
When invoked with `--fuzz` — **and enabled by default on `L3`, `Stage 5` 0→1 delivery, and `T3` autopilot** — run a time-boxed (e.g. 2–5 min) exploratory real-user interaction & edge-input fuzzing pass AFTER all scripted `features/` pass:
- Exercise rapid navigation/clicks, viewport resizes (`Desktop` / `Mobile`), empty/long/Unicode/malformed payloads, back/forward or out-of-order sequences, and unexpected interrupts.
- Assert zero uncaught console/runtime errors, zero 5xx crashes, and zero horizontal overflow (`scrollWidth <= innerWidth`), keeping all fuzz traces inside `/tmp/zee-verify-*` or `<busDir>`.
