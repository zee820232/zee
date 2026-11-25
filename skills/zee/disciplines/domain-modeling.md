# Discipline: Active Domain Modeling (`GLOSSARY.md` & 3-Condition ADRs)

Loaded during `/zee-plan`, `/zee-init` Stage 1, and `/zee-arch` to prevent semantic drift across agents and sessions.

## 1. Interrogate Language Live During Grill
- Challenge vague, overloaded, or conflicting terms immediately when the user introduces them (e.g., "order" meaning both cart and settled invoice, or "user" meaning both org and seat).
- Probe one concrete boundary scenario per ambiguous term until the canonical name and ownership boundary are unmistakable.
- Do not defer terminology cleanup to the end of planning — resolve terms at the frontier while decisions are fresh.

## 2. Inline `GLOSSARY.md` Maintenance
Maintain a concise repository `GLOSSARY.md` (or `docs/GLOSSARY.md` if the repo keeps docs under `docs/`):
- **Single-Context Repo**: one root `GLOSSARY.md` listing only domain-specific terms, invariants, and **`_Avoid_`** banned synonyms.
  ```markdown
  ### <Canonical Term>
  - **Meaning**: 1-2 crisp lines describing the real domain concept and boundary.
  - **Invariants**: key state/lifecycle rules.
  - **_Avoid_**: legacy/ambiguous synonyms that must not enter new code or docs.
  ```
- **Multi-Context Repo**: add `GLOSSARY-MAP.md` pointing each bounded context to its own glossary file when the same word legitimately means different things in separate subsystems.
- Keep it lean: omit standard framework jargon (`Component`, `Controller`, `REST`).

## 3. Strict 3-Condition ADR Gate (`docs/adr/NNNN-slug.md`)
Propose and write an ADR **ONLY** when ALL three conditions hold:
1. **Hard to reverse** (data model, public protocol, storage boundary, runtime architecture).
2. **Confusing without context** (a future engineer or agent reading the code would wonder "why on earth did they pick this?").
3. **Genuine trade-off** (real competing alternatives were rejected for concrete reasons).

Format each ADR tightly (~15–25 lines): **Status** (`Accepted` / `Superseded by NNNN`) · **Context** (3 lines) · **Decision** (3 lines) · **Rejected Alternatives & Trade-offs** (3–5 bullets). Never overwrite historical decisions silently — supersede with a new numbered ADR.
