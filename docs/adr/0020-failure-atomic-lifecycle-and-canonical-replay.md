# ADR-0020: Failure-Atomic Session Lifecycle and Canonical Replay Identity

## Status

**Accepted** (2026-03-11)

## Context

Deep review surfaced a common failure mode across session lifecycle, replay, and persistence paths:

- runtime state was being mutated before durable state was confirmed
- replay identity depended on raw `JSON.stringify()` field order
- concurrent retries with the same `idempotencyKey` could double-execute
- command history favored oldest entries first, which hid fresh incident evidence
- stdio writes handled synchronous failures but not asynchronous stream errors

The result was a split-brain risk between:

- in-memory session state
- persisted session metadata
- replay/idempotency semantics
- operational diagnostics

This was most visible in three concrete bugs:

1. `create_session` / `load_session` could return failure after leaving a live in-memory session behind
2. failed metadata writes could mutate cached metadata without mutating disk
3. concurrent requests sharing one `idempotencyKey` could both execute before the cache was populated

## Decision

We adopt a single nexus rule for side-effecting flows:

> **prepare → persist → commit → publish**

State must not become externally visible until the durability boundary for that operation has succeeded.

### 1. Persist-before-publish for session create/load

`createSession()` and `loadSession()` now:

1. reserve capacity
2. create/bind/switch the underlying `AgentSession`
3. persist session metadata
4. subscribe to events
5. commit the session into runtime maps

If any step before commit fails, the session is disposed and the governor reservation is released.

### 2. Delete must fail before teardown, not after

`deleteSession()` now removes persisted metadata before tearing down runtime state.

This preserves a strong contract:

- if delete returns failure, the live session is still present
- if delete returns success, both runtime and durable metadata have been removed

### 3. SessionStore uses copy-on-write mutation

`SessionStore` now clones metadata before mutation and only swaps cache state after durable save succeeds.

Additional rules:

- mutation paths invalidate cache under the metadata file lock before reading
- cache freshness is based on file snapshot (`mtimeMs` + `size`), not wall-clock heuristics alone
- stale lock stealing checks owner PID liveness before removing aged lock files

### 4. Replay fingerprints are canonicalized

Command fingerprints now use stable key-sorted serialization instead of raw `JSON.stringify(rest)`.

This ensures semantically identical commands remain identical across:

- client implementations
- object construction order
- serializer drift

### 5. Idempotency dedupe applies to in-flight retries

Replay semantics now have two layers for `idempotencyKey`:

- terminal replay cache
- in-flight replay map

If a second request with the same `idempotencyKey` arrives while the first is still executing, it replays the in-flight promise instead of double-executing.

### 6. Durable history is newest-first

`get_command_history` now scans durable history from newest to oldest.

This keeps bounded history queries useful during incidents, where the latest evidence matters most.

### 7. Stdio transport hardens against async stream failure

The server now installs a `stdout` error handler for stdio mode.

If stdout enters a broken state, the stdio transport degrades instead of crashing the process on an unhandled async stream error event.

## Consequences

### Positive

- no ghost sessions after failed create/load persistence
- no phantom metadata after failed SessionStore writes
- no duplicate execution for concurrent same-key idempotent retries
- stable replay/conflict semantics across object key order
- more useful durable history during incidents
- safer stdio behavior under broken pipe / stream error scenarios

### Trade-offs

- session create/load now delay runtime visibility until metadata persistence completes
- command history query now reads the full file into memory before reverse scan
- failure-atomic behavior is stricter and may surface disk problems earlier

## Implementation Notes

Primary implementation points:

- `src/session-manager.ts`
- `src/session-store.ts`
- `src/command-replay-store.ts`
- `src/command-journal.ts`
- `src/server.ts`

Verification added in:

- `src/test.ts`
- `src/test-command-replay-store.ts`

## Verification

Validated with:

```bash
npm run build
npm test
npm run test:integration
npm run test:fuzz
```

Key regression coverage includes:

- create/load rollback on metadata failure
- delete preserving runtime state on metadata delete failure
- SessionStore copy-on-write correctness
- stable fingerprinting across key-order drift
- concurrent in-flight idempotency replay
- newest-first durable history
- stdout error-handler lifecycle
- `load_session` persisting source session cwd

## Related ADRs

- `docs/adr/0001-atomic-outcome-storage.md`
- `docs/adr/0007-session-persistence.md`
- `docs/adr/0019-durable-command-journal-foundation.md`
