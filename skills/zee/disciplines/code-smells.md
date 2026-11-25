# Discipline: Review Standards & Fowler 12 Code Smells Baseline (`code-smells.md`)

Loaded by `Reviewer` (Axis 2) during `/zee-review` and Gate 2 audits.

## 1. Precedence Order (Strict)
1. **Repository Standards First**: auto-check `CODING_STANDARDS.md`, `CONTRIBUTING.md`, `GLOSSARY.md`, `docs/adr/`, and linter/typecheck configs. Repository conventions ALWAYS override generic baselines.
2. **Fowler 12 Code Smells Baseline** (below): advisory judgment prompts for structural health — **NEVER inflate style preferences or minor smells into P0/P1 merge blockers** unless paired with concrete defect/maintenance risk.
3. **Strict Axis Separation**: present Axis 1 (Spec/Plan Fidelity), Axis 2 (Standards & Structural Smells), and Axis 3 (Break & Blast-Radius) as separate sections. Never merge or re-rank across axes so a noisy list in one axis never obscures a critical omission in another.

## 2. Fowler 12 Structural Smells Reference
Check touched code (not untouched legacy files) for newly introduced smells:
1. **Long Function**: one routine juggling orchestration + parsing + I/O + formatting.
2. **Large Class / God Module**: single file accumulating unrelated responsibilities.
3. **Primitive Obsession**: raw strings/numbers passed around where a typed domain object or union prevents invalid states.
4. **Long Parameter List**: 5+ positional args that belong in a cohesive options/request object.
5. **Divergent Change**: one module edited for multiple unrelated reasons.
6. **Shotgun Surgery**: one small domain change requiring synchronized edits across many scattered files.
7. **Feature Envy**: a function reaching deeply into another module's internals instead of living where the data lives.
8. **Data Clumps**: the same 3–4 fields traveling together across signatures without a named type.
9. **Speculative Generality**: unused abstractions, dead flags, or plugin hooks added "just in case".
10. **Message Chains**: `a.getB().getC().getD()` coupling callers to internal object graphs.
11. **Middle Man**: shallow wrapper delegating every call with zero added invariant or hiding.
12. **Comments Explaining Bad Code**: prose apologizing for or narrating convoluted logic that should be simplified or turned into types/tests.

## 3. Clean Exit Principle
**`No findings` is a valid, high-value outcome.** Do not invent nitpicks to look thorough.
