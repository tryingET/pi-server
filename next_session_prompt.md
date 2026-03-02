# pi-server: Next Session Prompt

**Operating mode:** Production-ready, reliability-first  
**Current phase:** Level 4 (Durable command journal + replay) — active execution  
**Version:** 2.0.1 (current)  
**Formalization Level:** 2 (Bounded Run)

---

## SESSION STATUS (2026-03-02)

### LATEST ADDITIONS

| Feature | Description | Files |
|---|---|---|
| Durable command journal foundation | Added append-only JSONL journal with per-lane sequence numbers and lifecycle persistence (`accepted`/`started`/`finished`) behind `durableJournal.enabled` | `src/command-journal.ts`, `src/session-manager.ts`, `src/server.ts` |
| Deterministic startup rehydration | On startup, completed explicit outcomes are rehydrated; pre-crash in-flight explicit commands are deterministically marked failed and journaled | `src/command-journal.ts`, `src/session-manager.ts` |
| Journal observability surface | `get_metrics.stores.journal` now exposes journal stats and recovery counters | `src/session-manager.ts`, `src/types.ts` |
| Level 4 architecture decision | Documented backend choice (JSONL), schema v1, migration guardrails, and recovery policy | `docs/adr/0019-durable-command-journal-foundation.md` |
| Test coverage for restart semantics | Added tests for durable replay across restart and in-flight recovery classification | `src/test.ts` |
| Packaging/build updates | Added `command-journal` to build entries and published artifact list | `package.json` |
| Docs updates | Added ADR index + README references; protocol limitation updated to feature-flagged durable status | `docs/README.md`, `README.md`, `PROTOCOL.md` |

---

## RESOLVED IN THIS SESSION (Horizon B kickoff)

| Finding | Fix Applied | Files |
|---|---|---|
| L4 backend decision unresolved | Chosen append-only JSONL for foundation, documented as ADR-0019 | `docs/adr/0019-durable-command-journal-foundation.md` |
| No durable command lifecycle substrate | Added journal store with schema-versioned lifecycle records and per-lane monotonic sequencing | `src/command-journal.ts` |
| No startup recovery rehydration | Added one-time startup initialization path in session manager/server startup | `src/session-manager.ts`, `src/server.ts` |
| Crash leaves in-flight commands indeterminate after restart | Recovery pass now classifies pre-crash in-flight explicit commands as deterministic failed outcomes | `src/command-journal.ts` |
| No runtime visibility into journal health | Added journal metrics fields to `get_metrics` response contract | `src/session-manager.ts`, `src/types.ts` |

---

## TEST / VERIFICATION SNAPSHOT (CURRENT)

Executed after Horizon B foundation changes:

| Check | Status |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run lint` | ✅ |
| `npm run format:check` | ✅ |
| `npm run build` | ✅ |
| `npm test` | ✅ 119 passed, 0 failed |
| `npm run check:consistency` | ✅ |

Notable functional verification:
- Explicit command outcomes now replay across manager restart when durable journal is enabled.
- Pre-crash in-flight explicit command IDs are replayed as deterministic recovery failures.

---

## ACTIVE DEFERRED CONTRACTS (CARRIED FORWARD)

| Finding | Rationale | Owner | Trigger | Deadline | Blast Radius |
|---|---|---|---|---|---|
| **Level 4 completion: history API + replay extraction** | Durable substrate exists; external query/export APIs still missing | Maintainer | L4.3 execution | Current phase | Auditability / incident tooling |
| **Retention + compaction policy** | JSONL growth is unbounded without retention/compaction controls | Maintainer | L4.4 execution | Current phase | Disk pressure / long-term ops |
| **AbortController integration upstream** | Requires `@mariozechner/pi-coding-agent` API support for caller-provided `AbortSignal` | Maintainer | Upstream accepts proposal (`upstream-proposal-abortcontroller.md`) | Next major version | Timeout semantic mismatch + wasted LLM tokens |
| **AgentSession backpressure API** | Deferred as YAGNI at current throughput; revisit with telemetry evidence | Maintainer | Sustained high `ws.bufferedAmount` / memory pressure metrics | When needed | Potential OOM under pathological slow consumers |

---

## NEXT STEPS (PRIORITIZED)

1. **L4.2 recovery surface completion**
   - Expose startup recovery summary via protocol event or dedicated command
   - Add deterministic fixture tests for repeated boot equivalence

2. **L4.3 replay/history API**
   - Define `get_command_history` contract (filters: session, commandId, time window)
   - Implement server handler backed by durable journal scan/index

3. **L4.4 retention + compaction**
   - Add time/size retention policy
   - Add compaction pass with replay-equivalence tests

4. **Durability mode hardening**
   - Decide strict write-failure behavior (fail-open vs fail-closed) for journal append errors
   - Add chaos tests for partial writes/corrupt lines and schema-version mismatch behavior

5. **Validation + CI expansion**
   - Re-run full extended gates (`npm run test:integration`, `npm run test:fuzz`) after next L4 increments
   - Consider adding journal schema checks to `check:consistency`

---

## ROLLBACK (THIS SESSION)

```bash
# Revert latest durable-journal foundation commit(s)
# Replace <new-commit-sha> with actual SHA(s)

git revert <new-commit-sha>

# Re-validate
npm run build
npm test
npm run check:consistency
```

---

## PRODUCTION READINESS (POST-HORIZON-B FOUNDATION)

| Check | Status |
|---|---|
| Runtime/package version alignment | ✅ enforced by check script |
| Auth docs/source-of-truth alignment | ✅ ADR-0014 canonicalized |
| Durable journal foundation | ✅ implemented behind feature flag |
| Startup deterministic rehydration | ✅ implemented for explicit command IDs |
| Full local quality gates run this session | ✅ green |

**Verdict:** ✅ Level 4 foundation is in place; proceed with history/replay API and retention/compaction completion.

---

## UPSTREAM PROPOSALS

See `~/programming/pi-extensions/issue-tracker/pi-mono-upstream/` for pending upstream change requests:
- `extension-ui-wouldexceedlimit.md` — ExtensionUIContext.wouldExceedLimit() method
- `shared-protocol-package.md` — Shared @mariozechner/pi-protocol package extraction

Historical proposals archived in this repo:
- `upstream-proposal-abortcontroller.md` — AbortSignal integration
