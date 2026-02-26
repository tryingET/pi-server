# pi-server Protocol Specification

**Version:** `1.0.0`  
**Status:** Active  
**Audience:** client implementers, integrators, maintainers

### Quick navigation

- [1. Scope](#1-scope)
- [4. Command envelope](#4-command-envelope)
- [5. Response envelope](#5-response-envelope)
- [7. Lifecycle and ordering](#7-lifecycle-and-ordering)
- [8. Replay and idempotency](#8-replay-and-idempotency)
- [9. Dependency semantics (`dependsOn`)](#9-dependency-semantics-dependson)
- [10. Session version semantics](#10-session-version-semantics)
- [13. Client obligations](#13-client-obligations)
- [15. Residual limitations](#15-residual-limitations)

---

## 1. Scope

This specification defines the wire contract for `pi-server`:

- transport framing
- command/response/event envelopes
- lifecycle ordering
- replay/idempotency behavior
- dependency and concurrency semantics

If code and spec diverge, this document describes intended behavior.

---

## 2. Conformance language

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

---

## 3. Transport and framing

`pi-server` supports:

1. **WebSocket**
2. **stdio** (newline-delimited JSON)

### 3.1 Message shape

- Every frame MUST contain exactly one JSON object.
- Commands are client → server.
- Responses and events are server → client.

### 3.2 Admission limits

- Server MAY reject messages exceeding configured size limits.
- Server MAY reject malformed JSON with a failure response.

---

## 4. Command envelope

All commands MUST include:

- `type: string`

Commands MAY include:

- `id: string`
- `dependsOn: string[]`
- `ifSessionVersion: number`
- `idempotencyKey: string`

### 4.1 Field semantics

- `id` identifies command intent for correlation and duplicate replay.
- `dependsOn` declares command IDs that MUST complete successfully first.
- `ifSessionVersion` enforces optimistic concurrency for session-targeted writes.
- `idempotencyKey` enables retry replay bounded by command fingerprint.

### 4.2 Validation behavior

- Invalid commands MUST return `success: false`.
- Commands rejected before admission MUST NOT emit lifecycle events.

---

## 5. Response envelope

Every response includes:

- `type: "response"`
- `command: string`
- `success: boolean`

Optional fields:

- `id?: string`
- `error?: string` (when `success: false`)
- `sessionVersion?: number`
- `replayed?: true`

### 5.1 Response identity rules

- If request includes `id`, response SHOULD include matching `id`.
- Replay without request `id` MUST NOT leak stale historical `id`.

---

## 6. Event taxonomy

Server emits these event families:

1. `server_ready`
2. `server_shutdown`
3. `session_created`
4. `session_deleted`
5. `event` (session-scoped AgentSession event)
6. `command_accepted`
7. `command_started`
8. `command_finished`

### 6.1 Session-scoped AgentSession events

- Include `sessionId` + event payload.
- Delivered only to subscribers of that session.

### 6.2 Global lifecycle events

- Broadcast globally for admitted commands.
- Carry command metadata and terminal outcome fields.

---

## 7. Lifecycle and ordering

### 7.1 Admission gate

A command is **admitted** only after validation and shutdown checks succeed.

- Admitted commands MUST emit `command_accepted`.
- Non-admitted commands MUST NOT emit lifecycle events.

### 7.2 Per-command phase order

For each admitted command:

1. `command_accepted`
2. `command_started` (if execution begins)
3. `command_finished` (exactly once)

### 7.3 Lane execution model

Execution is serialized by lane:

- `session:<sessionId>` for session-targeted commands
- `server` for server-level commands

Guarantees:

- Within a lane, execution order is deterministic.
- Across lanes, no global total ordering is guaranteed.

### 7.4 Replay lifecycle shape

Replay hits MUST emit:

- `command_accepted`
- `command_finished` with `replayed: true`

Replay hits MUST NOT emit `command_started`.

---

## 8. Replay and idempotency

### 8.1 Duplicate command `id`

- Same `id` + same fingerprint → MUST replay prior outcome.
- Same `id` + different fingerprint → MUST fail with conflict error.

### 8.2 `idempotencyKey`

- Scope is per session (server commands use server scope).
- Same key + same fingerprint inside TTL → MUST replay prior outcome.
- Same key + different fingerprint → MUST fail with conflict error.
- Expired key entry → command executes normally.

### 8.3 Fingerprint

A fingerprint is semantic payload equivalence used to detect intent drift.
Changing semantic payload under the same identity token is a protocol conflict.

---

## 9. Dependency semantics (`dependsOn`)

For command `C` with dependencies `[d1, d2, ...]`:

- Each dependency MUST be known (in-flight or completed).
- Each dependency MUST end in success.
- Unknown or failed dependency MUST fail `C`.

### 9.1 Dependency timeout

- Waiting MAY timeout using configured dependency wait limit.
- Timeout MUST fail the dependent command.

### 9.2 Same-lane inversion guard

If a dependency is queued/in-flight in the same lane and cannot be awaited safely,
the server MUST fail fast instead of deadlocking that lane.

---

## 10. Session version semantics

`sessionVersion` is monotonic per session and supports optimistic concurrency.

- Successful `create_session` initializes version to `0`.
- Read-only commands MUST NOT increment version.
- Mutating successful session commands increment version by `1`.
- `delete_session` removes version state.

### 10.1 `ifSessionVersion`

When present:

- Missing session MUST fail.
- Version mismatch MUST fail.
- Exact match MAY proceed.

---

## 11. Timeout semantics

Timeout is a **terminal stored outcome**.

Implications:

- A timeout response is returned with `timedOut: true`.
- The timeout response is stored as the command outcome before return.
- Later duplicate-id replay MUST return the same timeout response.
- Late underlying completion MUST NOT overwrite the stored timeout outcome.

Clients SHOULD treat timeout as a deterministic failed outcome for that command identity and issue a new command identity if they want a fresh execution attempt.

---

## 12. Error model

Failure responses use:

- `success: false`
- human-readable `error`

Common categories:

- validation failure
- unknown command
- dependency unknown/failed/timed out
- optimistic concurrency mismatch
- replay identity conflict
- rate/size/limit rejection
- shutdown rejection

---

## 13. Client obligations

Conformant clients:

1. **MUST** use unique `id` per logical command intent.
2. **MUST NOT** reuse `id` for semantically different payloads.
3. **SHOULD** include both `id` and `idempotencyKey` on retries.
4. **MUST** handle replay (`replayed: true`) and conflict errors.
5. **MUST** treat `sessionVersion` as authoritative concurrency state.
6. **SHOULD** use `ifSessionVersion` for mutating writes.
7. **MUST NOT** assume total order across lanes.
8. **MUST** treat timeout outcomes as terminal for that command identity.

---

## 14. Compatibility

- Protocol version is announced in `server_ready`.
- Additive fields/events are backward-compatible by default.
- Clients SHOULD ignore unknown fields/events unless strict mode is required.

---

## 15. Residual limitations

1. No global total ordering (lane determinism only).
2. Timeout does not prove cancellation completed.
3. Durable journal/replay is future work (Level 4).

---

## 16. Companion documents

- `README.md` — architecture-level overview
- `docs/quickstart.md` — operator quickstart
- `docs/client-guide.md` — integration best practices
- `ROADMAP.md` — execution plan and decision gates
