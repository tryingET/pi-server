# pi-server: Next Session Prompt

**Operating mode:** Production-ready, reliability-first  
**Current phase:** Level 4 (Durable command journal + replay) — ADR-0019 hardening continuation complete  
**Version:** 2.0.1 (current)  
**Formalization Level:** 2 (Bounded Run)

---

## SESSION STATUS (2026-03-03)

## ✅ ADR-0019 NEXT-STEPS PASS COMPLETE

This pass completed the previously deferred Level 4 hardening items:
1. append write-failure strictness policy
2. redaction hooks for persistence/export surfaces
3. corruption/partial-write chaos coverage around recovery + compaction

---

## WHAT CHANGED THIS PASS

### 1) Append write-failure strictness policy is now explicit

New durable journal option:
- `durableJournal.appendFailurePolicy`
  - `"best_effort"` (default): log append failures and continue command flow
  - `"fail_closed"`: mark durable state failed and fail command flow closed

Fail-closed semantics:
- Append failure during `command_accepted` / `command_started` causes command failure for non-observability commands.
- Durable init state transitions to `failed` with explicit error details.
- `get_startup_recovery` and `get_command_history` remain available for diagnostics.

### 2) Redaction hooks added for persistence/export surfaces

New durable journal hooks:
- `durableJournal.redaction.beforePersist(entry)`
- `durableJournal.redaction.beforeExport(result, { query })`

Behavior:
- `beforePersist` runs before journal append.
- Immutable identity fields are protected (`commandId`, lane/phase/sequence, fingerprint, etc.).
- `beforeExport` can redact history query payloads (entries and/or metadata like `journalPath`).

### 3) Chaos coverage for malformed/partial writes

Added deterministic tests for:
- truncated/malformed tail lines during startup recovery
- compaction behavior with malformed partial lines mixed with valid entries

Guarantees validated:
- malformed lines are skipped safely
- recovery remains deterministic for valid explicit outcomes/in-flight entries
- compaction rewrites to parseable retained entries while preserving replay semantics

### 4) NEXUS hardening closure (deep-review addendum)

Additional reliability fixes completed in the same pass:
- `fail_closed` now enforces terminal failure when `command_finished` append fails.
- Replay/idempotency persistence now stores the **finalized** terminal response to preserve determinism.
- Redaction invariants now block replay-critical terminal corruption (`response` removal / `response.id` drift).
- Stdio backpressure drop accounting increments `droppedCount` on each dropped non-critical write.
- `PiServerOptions.durableInitTimeoutMs` now forwards to `PiSessionManager`.

---

## IMPLEMENTED IN THIS SESSION

| Feature | Description | Files |
|---|---|---|
| Append strictness policy | Codified `best_effort` vs `fail_closed`; fail-closed latches durable state failure and fails non-observability command flow | `src/command-journal.ts`, `src/session-manager.ts`, `src/test.ts` |
| Redaction hooks | Added `beforePersist` and `beforeExport` hooks with invariant checks for persistence safety | `src/command-journal.ts`, `src/test.ts` |
| Journal observability extensions | `get_metrics.stores.journal` now exposes append policy + redaction hook enablement | `src/session-manager.ts`, `src/types.ts`, `src/test.ts` |
| NEXUS hardening fixes | Terminal fail-closed enforcement + finalized outcome storage + replay-critical redaction guards + stdio drop counter + server timeout plumbing | `src/session-manager.ts`, `src/command-journal.ts`, `src/server.ts`, `src/test.ts` |
| Chaos tests | Added partial-write recovery and malformed-compaction tests | `src/test.ts` |

---

## TEST / VERIFICATION SNAPSHOT (THIS PASS)

| Check | Status |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run lint` | ✅ |
| `npm run build` | ✅ |
| `npm test` | ✅ 152 passed, 0 failed |
| `npm run test:integration` | ✅ 31 passed, 0 failed |
| `npm run test:fuzz` | ✅ 17 passed, 0 failed |
| `node --experimental-vm-modules dist/test-command-classification.js` | ✅ 36 passed, 0 failed |
| `npm run ci` | ✅ |

Notable verification:
- Fail-closed append policy rejects command flow deterministically and keeps diagnostics surfaces available.
- Best-effort policy preserves availability under append faults.
- Redaction hooks affect both persisted and exported history payloads as configured.
- Truncated/malformed journal lines do not corrupt deterministic recovery or retained replay behavior.
- Fail-closed terminal append failures now downgrade final response and persist deterministically.
- CI script now includes integration + fuzz gates (not just unit/main suite).

## PRODUCTION READINESS GUARDRAILS (CURRENT)

- **Replay determinism:** explicit command IDs always replay the same stored terminal outcome.
- **Timeout semantics:** timeout remains a terminal response and is replay-stable.
- **Fail-closed durability mode:** append failures can intentionally fail command flow when configured (`appendFailurePolicy: "fail_closed"`).
- **Durability observability continuity:** `get_startup_recovery` and `get_command_history` remain available for diagnostics under durable-init/append failure conditions.
- **Rate-limit + lifecycle ordering:** replay remains free; new executions are still bounded by governor and lifecycle events remain emitted.

---

## DEFERRED CONTRACTS

No new deferred contracts were introduced in this pass.

Remaining broader roadmap items:
- optional SQLite backend decision gate
- deterministic replay engine placement (in-process vs offline tooling)
- schema migration tooling and fixtures

---

## NEXT STEPS

1. Evaluate and codify compliance envelope for redaction policy presets (safe defaults + examples).
2. Add deterministic replay/export tooling contract (CLI/offline path) on top of redacted history surface.
3. Add fault-injection matrix for journal I/O errors beyond malformed-line chaos (ENOSPC/EIO simulation harness).

---

## ROLLBACK (SESSION CHANGES)

```bash
git checkout -- src/command-journal.ts src/session-manager.ts src/server.ts src/types.ts \
  src/test.ts package.json next_session_prompt.md

npm run build
npm test
npm run test:integration
npm run test:fuzz
```

---

## UPSTREAM PROPOSALS

See `~/programming/pi-extensions/issue-tracker/pi-mono-upstream/` for pending upstream requests:
- `extension-ui-wouldexceedlimit.md`
- `shared-protocol-package.md`

Historical proposal in this repo:
- `upstream-proposal-abortcontroller.md`
