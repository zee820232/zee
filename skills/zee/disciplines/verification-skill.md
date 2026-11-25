# Discipline: Project-Local Verification Skill (`verify-<app>`) Lifecycle

Loaded during `/zee-setup` (optional verification bootstrap/audit), `/zee-init` Stage 3 (M0/M1), and `Verifier` execution.

## 1. Purpose
Static `testCmds` prove unit tests, not real user journeys. Every serious UI, CLI/TUI, game, desktop, or service project benefits from a committed, repo-local verification skill:
`<projectSkillsDir>/verify-<app>/SKILL.md` + `features/README.md` + `features/<feature>.md`
(default `<projectSkillsDir>` = `.agents/skills/`, or reuse `.pi/skills/` / `.claude/skills/` / `.cursor/skills/` if the repo already keeps skills there). Write it for a **cold-start Verifier agent** that has never seen the app.

## 2. Generate (`create` flow — Interview the Repo, Not the User)
1. **Inspect 5 Dimensions from Source**:
   - **Surface**: Web UI, CLI/TUI, Desktop, Game, API, Mobile.
   - **Launch**: exact cold-start command from an empty data dir (including migrations/seed) + **true usability readiness signal** (not just open port!). For short-lived CLIs, build once and run isolated PTY/temp-dir drives.
   - **Doctor**: 1 read-only health check confirming process up, right build/version, port owned by us, auth valid.
   - **Drive**: concrete recipes using stable repo handles (ARIA labels, `data-testid`, route paths, CLI flags/prompts — never brittle screen coordinates).
   - **Isolate & Cleanup**: parallel-instance safety (free port, isolated data dir), PID-only teardown (never `killall`), and **cleanup NEVER deletes proof artifacts**.
2. **Write `verify-<app>/SKILL.md`** with YAML frontmatter (`name: verify-<app>`, concrete `description`) and 6 grounded sections: `Launch`, `Doctor`, `Drive`, `Evidence`, `Cleanup`, `Helpers` (every shipped helper script must be executable and shown with exact invocation).
3. **Seed `features/` Map**: `features/README.md` index + 3–5 top user-facing `features/<name>.md` files, each with 4 H2s:
   `Sub-features` · `How to get to it (user POV)` · `Driving it with <harness>` · `Gotchas`.
4. **Hard Live Proof Gate (Non-Negotiable)**:
   > *A generated verification skill that was never executed end-to-end is a draft, not a deliverable.*
   Execute its exact instructions once live: `Launch -> Doctor -> Drive 1 mapped feature -> Capture evidence -> Cleanup -> Verify evidence STILL exists at the named path`. Run cleanup after any failed attempt too.

## 3. Maintain (`maintain` flow — Anti-Rot Loop)
When the app evolves and the feature map may have drifted (edits allowed ONLY inside `verify-<app>/`, NEVER product code):
1. **Index Hygiene**: reconcile `features/README.md` against actual files.
2. **Parallel Source Wave**: 1 read-only `Scout` per feature file checking source entry points, likely doc drift, and returning a concise live recipe.
3. **Mandatory Live Pass**: drive every mapped feature live, holding 3 invariants: (a) run `Doctor` before first drive and after any failure; (b) confirm captured evidence survives every cleanup; (c) clean up residue from failed drives.
4. **Strict Triage**:
   - Wrong user-POV description -> **doc drift** (fix `features/`).
   - Working app the harness can't drive -> **harness gap** (fix recipe/helper & re-drive live).
   - App behavior actually broken -> **product regression** (report to human; **never** weaken the map to hide a bug).
5. **Outcome**: report `clean`, `changed` (proven corrections), or `blocked` honestly.
