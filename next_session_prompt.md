# pi-server: Next Session Prompt

**Operating mode:** ruthless correctness + compounding simplicity.

---

## POST-REFACTOR STATUS (COMPLETE)

**Refactoring completed:** All phases + deep review fixes + module tests implemented.

### File sizes

| File | Original | Current | Change |
|------|----------|---------|--------|
| `session-manager.ts` | ~1372 lines | 907 lines | **-465 lines (34%)** |
| **Total modules** | ~4100 lines | 8685 lines | +4585 lines (modules + tests) |

### Module architecture

```
types.js ─────────────────────────────────────────┐
  └── SessionResolver interface (NEXUS)           │
                                                  ▼
command-classification.js ◄────────────── command-replay-store.js
  └── Single source of truth for:                  └── Idempotency + dedup
      - Timeout policy (short/long/none)
      - Mutation classification                      session-version-store.js
                                                        └── Monotonic versions
command-execution-engine.js
  ├── Lane serialization                               │
  ├── Dependency waits ◄───────────────────────────────┘
  ├── Timeout orchestration
  └── Uses SessionResolver (not closure)

session-manager.js
  └── Implements SessionResolver
      Orchestrates all stores
```

### New modules extracted

1. **`command-classification.ts`** (165 lines) — unified classification
   - Timeout policy: short (30s), long (5min), none (uncancellable)
   - Mutation classification: read-only vs mutating
   - Single source of truth prevents drift

2. **`command-replay-store.ts`** (427 lines)
   - Idempotency key replay
   - Command ID deduplication (completed + in-flight)
   - Fingerprint conflict detection
   - Bounded outcome retention

3. **`session-version-store.ts`** (151 lines)
   - Monotonic version counters
   - Uses `command-classification.ts` for mutation checks

4. **`command-execution-engine.ts`** (368 lines)
   - Lane serialization
   - Dependency waits with timeout
   - Uses `SessionResolver` interface (NEXUS)
   - Uses `command-classification.ts` for timeout policy

### Module tests (NEW)

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `test-command-classification.ts` | 34 | All timeout + mutation classifications |
| `test-session-version-store.ts` | 25 | Version lifecycle, applyVersion |
| `test-command-replay-store.ts` | 28 | Idempotency, dedup, replay, bounded retention |
| `test-command-execution-engine.ts` | 39 | Lane serialization, deps, timeouts, aborts |
| **Total** | **126** | |

### Deep review fixes applied

| Issue | Type | Fix |
|-------|------|-----|
| NEXUS: Session access via closure | ARCH | `SessionResolver` interface |
| Duplicate command classification | SMELL | `command-classification.ts` |
| `command: "unknown"` loses context | DEBT | Pass `commandType` param |
| `ReplayCheckResult` undocumented | GAP | JSDoc with examples |
| Long param list in `cacheIdempotencyResult` | SMELL | `IdempotencyCacheInput` interface |
| No module tests | DEBT | 126 new tests |

### Validation gates passed

- ✅ `npm run check` — typecheck + lint clean
- ✅ `npm test` — 77 unit tests pass
- ✅ `npm run test:integration` — 26 integration tests pass
- ✅ Module tests — 126 tests pass

### Wire semantics preserved

No protocol behavior changes. All existing tests remain green.

---

## NEXT LEVERAGE POINTS

1. **Concurrency fuzzing** — `CommandExecutionEngine` isolates lane serialization for property testing
2. **Metrics/observability** — All stores expose clear APIs for instrumentation
3. **Clustering** — `SessionResolver` enables remote session access

---

## CORE INTENT

`pi-server` is a deterministic protocol boundary around `AgentSession`.
It exists to do four things, and only four:

1. multiplex sessions
2. preserve causal command semantics
3. enforce resource and safety constraints
4. expose a stable, inspectable wire contract

Everything else is support structure.

---

## VALIDATION GATES

**FAST_GATE (per change):**

```bash
npm run check
npm test
```

**FULL_GATE (end of session):**

```bash
npm run ci
npm run test:integration
```

**MODULE_TESTS:**

```bash
node --experimental-vm-modules dist/test-command-classification.js
node --experimental-vm-modules dist/test-session-version-store.js
node --experimental-vm-modules dist/test-command-replay-store.js
node --experimental-vm-modules dist/test-command-execution-engine.js
```

---

## KNOWN ENVIRONMENTAL BLOCKER

- **Finding:** `npm run ci` can fail due to external `koffi`/`pi-sub-bar` module resolution.
- **Rationale:** external dependency packaging issue, not code regression.
- **Deadline:** before merging large structural changes.
