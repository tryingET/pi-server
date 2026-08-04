# ADR-0021: Command Contract Registry, Protocol-Pure stdio, and Opaque Replay Identity

## Status

**Accepted** (2026-03-12)

## Context

Deep review exposed a cluster of failures that looked unrelated at the symptom level but shared the same architectural flaw: critical cross-cutting behavior was encoded as scattered conventions instead of one enforceable contract surface.

Concrete failure modes:

1. **Unsafe timeout wrapping**
   - non-cancellable mutations like `delete_session`, `load_session`, and `set_session_name` could time out at the transport layer and still commit later
   - this violated user-visible causality and made retries dangerous

2. **stdio protocol contamination**
   - built-in logging and alerting could write human-readable diagnostics to `stdout`
   - stdio clients expect newline-delimited JSON frames only

3. **Replay identity leaked plaintext payloads**
   - the so-called `fingerprint` was raw stable JSON of the semantic command payload
   - durable history could therefore expose prompt text, session names, or other sensitive inputs

4. **Global environment mutation race**
   - `createAgentSession()` needed temporary `process.env` sanitization to avoid npm prefix leakage
   - because `process.env` is global, concurrent session creation could interleave sanitize/restore sequences

5. **Shutdown incompleteness**
   - metrics were flushed but sinks were not disposed
   - loggers were not disposed
   - custom integrations could leak resources or drop terminal cleanup work

The common root cause was architectural drift across seams:

- command execution semantics
- replay identity semantics
- stdio transport purity
- process-global runtime boundaries
- shutdown lifecycle completeness

## Decision

We establish a new architectural source of truth:

> **Every command must resolve through a canonical command contract before execution, journaling, timeout handling, replay conflict detection, or external history export.**

This ADR introduces six linked rules.

---

## 1. Canonical command contract registry

`src/command-classification.ts` becomes the single source of truth for cross-cutting command behavior.

Each command resolves to a contract with at least:

- `timeoutMode`: `none | short | long`
- `abortability`: `abortable | non_abortable`
- `isReadOnly`
- `isMutation`
- `executionPlane`: `control | data`
- `historySensitivity`

### Why

Before this change, timeout behavior, mutation semantics, and operational priority were spread across multiple modules and hard-coded lists. That allowed drift where a command could be treated as “short timeout” even though it had durable side effects with no safe cancellation path.

### Architectural rule

Timeout behavior is not just about expected duration.
It is also about **effect safety**.

Therefore:

- read-only commands default to bounded short timeout
- abortable long-running work defaults to long timeout
- non-abortable mutations default to **no timeout wrapper**

---

## 2. Protocol-pure stdio channel separation

Built-in diagnostics must never share the stdio protocol channel.

### Rule

- `stdout` is reserved for newline-delimited protocol JSON only
- built-in logs, alerts, and diagnostics go to `stderr` or explicit sinks

### Scope

This ADR guarantees protocol purity for:

- built-in logger implementations
- built-in alert handlers
- built-in metrics console sink
- built-in periodic maintenance logging

### Non-goal

A user-supplied custom logger or sink may still choose to write to `stdout`. That remains an integration responsibility unless a future hard output-channel API is introduced.

---

## 3. Replay identity is a versioned opaque digest

Replay identity remains semantically based on command content excluding retry identity (`id`, `idempotencyKey`), but it must no longer be persisted or exported as plaintext payload.

### Rule

Replay fingerprints are represented as:

- **versioned opaque digests**
- current format: `v2:sha256:<hex>`

### Consequences

- replay/conflict detection remains deterministic
- durable history stops leaking command bodies through `fingerprint`
- future digest migrations can be versioned explicitly

### Compatibility rule

The system must support legacy replay data during transition.
Existing stored raw-JSON fingerprints are normalized on read so upgrades do not break replay continuity or durable history recovery.

---

## 4. Process-global environment mutation requires serialization

Temporary env sanitization around `createAgentSession()` crosses a process-global boundary.
Local `try/finally` correctness is insufficient when multiple async callers run concurrently.

### Rule

Any code path that mutates process-global runtime state for session creation must execute under a **global creation mutex**.

### Immediate application

`createAgentSessionWithSanitizedNpmEnv()` is serialized across concurrent callers so:

- npm prefix leakage stays removed for the full critical section
- restore operations cannot race with another creation already in flight

---

## 5. Shutdown must dispose, not only flush

A flush-only shutdown is incomplete for pluggable infrastructure.

### Rule

If an integration surface exposes `dispose()`, shutdown must invoke it.

### Immediate application

`PiServer.stop()` now:

1. records final uptime metric
2. disposes metrics emitter/sinks
3. emits final shutdown log
4. disposes logger

---

## 6. Terminal outcomes have one first-write-wins boundary

Cross-cutting terminal behavior cannot be left to scattered early returns. Commands can finish through normal execution, timeout, replay, validation, shutdown, rate limiting, capacity rejection, or unexpected failure.

### Rule

Every live-runtime terminal response flows through one terminalization seam that decides:

- whether `command_finished` is appended durably
- whether the terminal lifecycle event is broadcast
- whether an explicit-ID outcome is stored
- whether an idempotency result is cached

The first stored terminal outcome for an explicit command ID is authoritative. Later code paths and late completions cannot replace it.

### Ordering

Retained replay identity is checked before pre-admission failures can overwrite it, then checked again after durable initialization because initialization may rehydrate outcomes. Replay/conflict paths emit terminal visibility without appending new durable lifecycle state.

First-seen validation, shutdown, rate-limit, and capacity failures append standalone `command_finished` records when durability is available. Completed runtime disposal is the hard exception: requests after disposal do not allocate identity, reopen the journal, emit lifecycle callbacks, or mutate replay state.

### Transport and lifecycle application

- failed server startup unwinds acquired transports, timers, and durable writer ownership
- synchronous stdout write failure latches the channel as broken until transport teardown
- deletion broadcast uses an epoch-specific commit receipt, so cleanup warnings do not hide a committed deletion and replay cannot manufacture another event
- replayed successful creation responses do not republish `session_created`

---

## Resulting Architecture

```text
RpcCommand
   │
   ▼
Command Contract Registry  ────────────────┐
   │                                        │
   ├── timeout policy                       │
   ├── abortability                         │
   ├── mutation/read-only                   │
   ├── execution plane                      │
   └── history sensitivity                  │
   │                                        │
   ▼                                        ▼
Execution Engine                       Replay Store
   │                                   │
   ├── timeout wrapping                ├── opaque digest fingerprint
   ├── dependency waits                ├── conflict detection
   └── lane serialization              └── legacy normalization
   │                                        │
   ▼                                        ▼
Session Manager ───────────────► Durable Journal / History Export
   │                                        │
   ├── persist-before-publish              ├── hashed fingerprint export
   ├── runtime visibility                  └── redaction hooks
   └── shutdown/disposal
   │
   ▼
Transport Layer
   ├── WebSocket: protocol + diagnostics may coexist by channel separation
   └── stdio: stdout protocol only, stderr diagnostics only
```

---

## Invariants

### Execution invariants

1. A non-abortable mutation must not return a timeout response and then commit later.
2. Timeout-wrapped commands must have an explicit operationally safe timeout policy.
3. Command classification must be derivable from one module, not reconstructed ad hoc.
4. Every live-runtime terminal response must pass through the canonical terminalization seam.

### Replay invariants

5. Semantically identical commands must produce the same replay identity independent of key order.
6. Replay identity must not expose plaintext semantic payloads in durable history.
7. Legacy replay identities must remain readable during migration.
8. The first stored terminal outcome for an explicit ID must not be overwritten.
9. Replay/conflict must not append duplicate durable lifecycle state.
10. Disposed runtimes must not repopulate replay, idempotency, or journal state.

### Transport invariants

11. Built-in stdio `stdout` output must always be parseable protocol JSON.
12. Human-readable diagnostics must not be emitted on the stdio protocol channel.
13. Partial startup failure must release every acquired transport and durable writer resource.

### Lifecycle invariants

14. Process-global env sanitization must behave as if session creation were serialized.
15. Server shutdown must release pluggable observability resources, not only flush them.
16. Session lifecycle broadcasts must reflect committed epoch transitions, not cleanup-status booleans or replayed responses.

---

## Consequences

### Positive

- removes false-failure / late-commit behavior for key durable mutations
- makes stdio transport safe for strict machine parsers
- eliminates plaintext command leakage from the `fingerprint` field
- improves confidence in replay/history behavior across upgrades
- closes a race around process-global environment state
- makes custom sink/logger shutdown behavior complete

### Trade-offs

- some control-plane mutations can now wait longer instead of timing out early
- session creation paths are slightly more serialized because env sanitization is global
- fingerprint migration now has an explicit version contract to maintain

### Risks

- custom third-party logger/sink implementations can still violate stdout purity if they write directly to `stdout`
- future commands added without consulting the contract registry would reintroduce drift
- in-memory outcome retention remains bounded; indefinite replay after retention eviction needs an explicit durable-retention or admission policy rather than an unbounded map

---

## Verification

Validated with:

```bash
npm run build
npm test
npm run test:integration
npm run test:fuzz
npm run check
```

Key regression coverage includes:

- `set_session_name` does not time out and commit later
- `delete_session` does not time out and delete later
- stdio integration fails on non-JSON stdout pollution
- fingerprints are hashed and no longer expose raw payloads
- legacy raw fingerprints still replay correctly
- logger and metrics sink `dispose()` run during shutdown
- concurrent AgentSession creation keeps npm env sanitization serialized
- explicit-ID validation and shutdown rejections cannot overwrite an earlier outcome
- pre-admission validation outcomes rehydrate through the durable journal
- fail-closed terminal append failures replay the first stored outcome
- disposed late completions cannot reacquire journal ownership
- failed startup releases WebSocket, stdout-listener, timer, and journal resources
- stdout broken state survives drain and is reset only by transport teardown
- committed deletion broadcasts despite cleanup warnings and remains ABA-safe under retained replay
- replayed creation responses do not duplicate `session_created`

---

## Implementation Points

Primary implementation lives in:

- `src/command-classification.ts`
- `src/command-replay-store.ts`
- `src/command-journal.ts`
- `src/session-manager.ts`
- `src/server.ts`
- `src/logger-types.ts`
- `src/metrics-types.ts`
- `src/threshold-alert-sink.ts`

Primary regression coverage lives in:

- `src/test-command-classification.ts`
- `src/test-command-replay-store.ts`
- `src/test-integration.ts`
- `src/test.ts`

---

## Follow-up Work

1. Introduce a hard output-channel abstraction for custom sinks/loggers so stdout purity can be enforced universally, not only for built-ins.
2. Consider exposing `historySensitivity` more explicitly in type-level command metadata so new command additions fail review without classification.
3. If replay history grows beyond current expectations, add an explicit fingerprint schema version field in durable export rather than relying only on prefix naming.
4. Define the long-horizon explicit-ID contract after bounded in-memory outcome eviction, including whether durable lookup is mandatory or new explicit-ID admission must fail closed once retention is exhausted.

## Related ADRs

- `docs/adr/0001-atomic-outcome-storage.md`
- `docs/adr/0019-durable-command-journal-foundation.md`
- `docs/adr/0020-failure-atomic-lifecycle-and-canonical-replay.md`
