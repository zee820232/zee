# Discipline: Deep Modules & Codebase Design (`deep-modules.md`)

Loaded during `/zee-arch`, `Architect` design, and major refactors to combat codebase entropy and shallow wrappers.

## 1. Shared Architectural Vocabulary
- **Module**: cohesive unit owning a real responsibility and hiding its internal representation.
- **Interface**: the small, stable surface callers depend on (function signatures, events, CLI contract, HTTP schema).
- **Depth**: high capability behind a simple interface; **Shallow** = interface nearly as complex as the implementation.
- **Seam**: the highest clean boundary where behavior can be observed and tested without reaching into private internals.
- **Adapter**: thin translation layer isolating an external/volatile dependency behind our own domain interface.
- **Leverage & Locality**: a change to one business rule should touch 1 module, not ripple across 8 files.

## 2. The Deletion Test (Spotting Shallow Modules)
Ask of any candidate helper, service layer, or pass-through wrapper:
> *"If we deleted this module and inlined or folded it into its caller/neighbor, would caller complexity actually increase?"*
- If **no** (or complexity drops): it is a **shallow pass-through** adding indirection tax without hiding complexity — merge or deepen it.
- Prioritize **`git log` churn hotspots** (YAGNI): ignore untouched cold code; deepen modules where frequent edits cause Shotgun Surgery or repeated regressions.

## 3. Four Dependency Classes & Seam Testing
Classify every dependency crossing a module boundary:
1. **Pure Logic**: zero I/O -> test directly, zero mocks.
2. **In-Process Shared State**: isolate behind explicit state container -> pass fresh instance per test.
3. **Local System Boundary** (filesystem, SQLite, local HTTP port, subprocess): test against real temp dir / ephemeral port whenever fast (<2s).
4. **External / Paid / Non-Deterministic System** (third-party API, clock, payment gateway): isolate behind a narrow **SDK-style Adapter** injected at the Seam.

**Replace, Don't Stack Tests**: when deepening several shallow helpers into one deep module, write thorough behavioral tests at the new public Seam and **delete obsolete white-box unit tests** pinned to dissolved internal helpers (with explicit `GATE_CHANGE_RATIONALE`).

## 4. Design-It-Twice (Orthogonal Interface Exploration)
Before locking a non-trivial interface, sketch **2–3 genuinely distinct interface shapes** (varying who owns state, pull vs push, batch vs stream, or error representation — never cosmetic renames), compare caller ergonomics + test seam clarity, and keep the deepest, simplest winner.
