# pi-server: Next Session Prompt

**Operating mode:** Production-ready, reliability-first  
**Current phase:** Trust-boundary hardening + failure-atomic lifecycle pass complete  
**Version:** 2.1.0 (current)  
**Formalization Level:** 2 (Bounded Run)

---

## SESSION STATUS (2026-03-11)

## ✅ TWO RELIABILITY PASSES ARE NOW LANDED

This repo now has two recent reliability-oriented change sets landed:

1. **Trust-boundary hardening pass**
   - transport auth parity
   - anchored session-file capability validation
   - pre-execution admission refund fixes
   - SessionStore multi-writer serialization
   - discovery/access alignment for project-local sessions

2. **Failure-atomic lifecycle + canonical replay pass**
   - failure-atomic `create_session` / `load_session` / `delete_session`
   - copy-on-write SessionStore mutation semantics
   - canonical key-stable replay fingerprints
   - in-flight idempotency-key dedupe
   - newest-first durable command history
   - async stdout error hardening for stdio transport
   - `load_session` now persists source session cwd correctly

---

## LATEST COMMITS

- `83135cc` — `Implement failure-atomic lifecycle and canonical replay`
- `d72d748` — `Cross-link ADR-0020 into persistence and journal docs`

New ADR:
- `docs/adr/0020-failure-atomic-lifecycle-and-canonical-replay.md`

Cross-linked ADRs:
- `docs/adr/0007-session-persistence.md`
- `docs/adr/0019-durable-command-journal-foundation.md`

---

## WHAT CHANGED IN THE MOST RECENT PASS

### 1) Session lifecycle is now failure-atomic

`createSession()` and `loadSession()` no longer publish runtime-visible session state before metadata persistence succeeds.

New ordering:
1. reserve capacity
2. create/bind/switch underlying session
3. persist metadata
4. subscribe
5. commit runtime state

Rollback behavior:
- failed create/load disposes the session
- governor reservation is released
- no ghost session remains in runtime maps

`deleteSession()` now removes metadata before runtime teardown.

Net effect:
- if delete fails, the session is still live
- if delete succeeds, runtime and durable metadata agree

### 2) SessionStore is now copy-on-write

`SessionStore` no longer mutates cached metadata in place before disk write completes.

New behavior:
- clone metadata map before mutation
- save durable state first
- swap cache only after save succeeds
- invalidate cache under lock before mutation reads
- use file snapshot checks (`mtimeMs` + `size`) rather than loose clock-only freshness
- stale metadata lock cleanup now checks owner PID liveness before stealing aged locks

Net effect:
- no phantom metadata after failed writes
- better cross-instance mutation correctness

### 3) Replay identity is now canonicalized

`getCommandFingerprint()` no longer depends on raw object insertion order.

New behavior:
- stable key-sorted serialization
- retry identity (`id`, `idempotencyKey`) still excluded

Net effect:
- semantically identical commands no longer conflict because of client/library key ordering drift

### 4) Idempotency now dedupes in-flight retries

Replay now has two layers for idempotency keys:
- terminal cache
- in-flight map

Net effect:
- concurrent requests sharing the same `idempotencyKey` collapse to one execution instead of double-running

### 5) Durable history is now newest-first

`get_command_history` now scans newest-to-oldest.

Net effect:
- bounded history queries surface the freshest incident evidence first
- operational debugging is materially better under journal growth

### 6) Stdio transport now hardens async stream failure

The server now registers a `stdout` error handler while stdio transport is active.

Net effect:
- async stdout failures degrade stdio transport instead of crashing the process through an unhandled stream error event

### 7) `load_session` now persists the source session cwd

Metadata for loaded sessions now reflects the session file’s own header cwd, not just the server process cwd.

Net effect:
- loaded session metadata is more truthful for cross-project loads and future browsing/recovery flows

---

## FILES TO UNDERSTAND FIRST NEXT SESSION

Core implementation:
- `src/session-manager.ts`
- `src/session-store.ts`
- `src/command-replay-store.ts`
- `src/command-journal.ts`
- `src/server.ts`

Regression coverage:
- `src/test.ts`
- `src/test-command-replay-store.ts`
- `src/test-integration.ts`
- `src/test-fuzz.ts`

Documentation:
- `docs/adr/0020-failure-atomic-lifecycle-and-canonical-replay.md`
- `docs/adr/0007-session-persistence.md`
- `docs/adr/0019-durable-command-journal-foundation.md`
- `AGENTS.md`

---

## TEST / VERIFICATION SNAPSHOT (CURRENT)

| Check | Status |
|---|---|
| `npm run build` | ✅ |
| `npm test` | ✅ 177 passed, 0 failed |
| `npm run test:integration` | ✅ 32 passed, 0 failed |
| `npm run test:fuzz` | ✅ 17 passed, 0 failed |

Notable verification added recently:
- create/load rollback on metadata failure
- delete preserves runtime state when metadata delete fails
- SessionStore failed writes do not mutate cached state
- fingerprints are stable across object key order
- concurrent idempotency-key retries replay in-flight execution
- command history returns newest entries first
- stdout error handler is registered/unregistered with stdio transport lifecycle
- `load_session` persists the loaded session’s own cwd

---

## OPERATIONAL GUARDRails (CURRENT)

- **Fail-closed auth:** transport admission errors deny instead of partially admitting
- **Anchored session-file access:** file-bearing session commands require allowed roots + existing session-looking files
- **Replay determinism:** explicit IDs remain replay-stable; timeout responses remain terminal outcomes
- **Canonical replay identity:** semantic equality no longer depends on object construction order
- **In-flight idempotency safety:** concurrent same-key retries do not double-execute
- **Persistence integrity:** SessionStore mutations are failure-atomic and copy-on-write
- **Lifecycle integrity:** create/load/delete now preserve runtime/durable agreement on surfaced failure paths
- **Diagnostic usefulness:** durable history now returns newest evidence first
- **Stdio resilience:** async stdout errors no longer explode the process via unhandled stream error events

---

## REPO STATE TO BE AWARE OF

There are still unrelated unstaged changes in the working tree that were **not** part of the two recent commits.

Current remaining modified files include:
- `AGENTS.md`
- `PROTOCOL.md`
- `docs/adr/0014-pluggable-authentication.md`
- `src/auth.ts`
- `src/command-router.ts`
- `src/resource-governor.ts`
- `src/server-ui-context.ts`
- `src/test-integration.ts`
- `src/types.ts`
- `src/validation.ts`

Treat those as separate work unless explicitly continuing them.

---

## RECOMMENDED NEXT STEPS

1. Finish migrating remaining core `console.*` paths to the structured logger abstraction.
2. Decide whether newest-first history should remain file-read based or move to a reverse-scan strategy if journal size grows materially.
3. Review the remaining unstaged trust-boundary/doc changes and either land or discard them explicitly.
4. If multi-user deployment becomes real, define principal propagation + session authorization before expanding server exposure.
5. If multi-root serving is needed, design an explicit root registry/capability model rather than broadening cwd ancestry implicitly.

---

## ROLLBACK (LATEST PASSES)

```bash
# Revert failure-atomic lifecycle implementation
git revert 83135cc

# Revert ADR cross-links
git revert d72d748

npm run build
npm test
npm run test:integration
npm run test:fuzz
```

---

## ADR INDEX FOR THIS AREA

- `docs/adr/0001-atomic-outcome-storage.md`
- `docs/adr/0007-session-persistence.md`
- `docs/adr/0019-durable-command-journal-foundation.md`
- `docs/adr/0020-failure-atomic-lifecycle-and-canonical-replay.md`
