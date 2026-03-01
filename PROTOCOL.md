# pi-server Protocol Specification

**Version:** `1.0.0`  
**Status:** Active  
**Audience:** client implementers, integrators, maintainers

### Quick navigation

**Core protocol:**
- [1. Scope](#1-scope)
- [2.1 Protocol versioning](#21-protocol-versioning)
- [4. Command envelope](#4-command-envelope)
- [5. Response envelope](#5-response-envelope)
- [7. Lifecycle and ordering](#7-lifecycle-and-ordering)
- [8. Replay and idempotency](#8-replay-and-idempotency)
- [9. Dependency semantics (`dependsOn`)](#9-dependency-semantics-dependson)
- [10. Session version semantics](#10-session-version-semantics)
- [13. Client obligations](#13-client-obligations)
- [15. Residual limitations](#15-residual-limitations)

**Reference:**
- [16. Server events](#16-server-events)
- [17. Command reference](#17-command-reference)
- [18. Extension UI protocol](#18-extension-ui-protocol)
- [19. AgentSession event types](#19-agentsession-event-types)
- [20. Session persistence](#20-session-persistence-adr-0007)
- [21. Circuit breaker](#21-circuit-breaker-adr-0010)
- [22. Error responses](#22-error-responses)

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

## 2.1 Protocol versioning

The protocol uses semantic versioning (`MAJOR.MINOR.PATCH`):

- **MAJOR** — Breaking changes (incompatible with existing clients)
- **MINOR** — Additions (new commands, new fields, new events)
- **PATCH** — Bug fixes, clarifications, no functional changes

### Version compatibility

| Client Version | Server Version | Compatibility |
|----------------|----------------|---------------|
| 1.0.x | 1.0.x | ✅ Full |
| 1.0.x | 1.1.x | ✅ Client may ignore new features |
| 1.1.x | 1.0.x | ⚠️ Client must not use new features |
| 2.0.x | 1.x.x | ❌ Incompatible |

### Version negotiation

1. Server sends `server_ready` with `protocolVersion` on connection
2. Client checks `protocolVersion` against its supported range
3. If incompatible, client SHOULD disconnect with appropriate error
4. If compatible, client MAY use features from its maximum version

### Current version

**Protocol version:** `1.0.0`  
**Server version:** See `server_ready.serverVersion`

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

## 16. Server events

### 16.1 `server_ready`

Emitted on connection before any other messages. Announces server capabilities.

```json
{
  "type": "server_ready",
  "data": {
    "serverVersion": "1.0.0",
    "protocolVersion": "1.0.0",
    "transports": ["websocket", "stdio"]
  }
}
```

Clients SHOULD check `protocolVersion` for compatibility.

### 16.2 `server_shutdown`

Emitted before server closes. Clients should expect connection termination.

```json
{
  "type": "server_shutdown",
  "data": {
    "reason": "graceful_shutdown",
    "timeoutMs": 30000
  }
}
```

---

## 17. Command reference

### 17.1 Server commands (no session required)

| Command | Purpose | Response |
|---------|---------|----------|
| `list_sessions` | List active sessions | `{ sessions: SessionInfo[] }` |
| `create_session` | Create new session | `{ sessionId, sessionInfo }` |
| `delete_session` | Unload session from memory | `{ deleted: true }` |
| `switch_session` | Subscribe to session | `{ sessionInfo }` |
| `get_metrics` | Server metrics | See `get_metrics` response |
| `health_check` | Health status | `{ healthy, issues, hasOpenCircuit, hasOpenBashCircuit }` |
| `list_stored_sessions` | List persisted sessions (ADR-0007) | `{ sessions: StoredSessionInfo[] }` |
| `load_session` | Load session from disk (ADR-0007) | `{ sessionId, sessionInfo }` |

> **Note:** `delete_session` unloads the session from server memory but does NOT delete the session file from disk. The session can be reloaded later via `load_session` or discovered via `list_stored_sessions`.

### 17.2 Session commands (require `sessionId`)

**Discovery:**
| Command | Purpose |
|---------|---------|
| `get_available_models` | List usable models |
| `get_commands` | List slash commands |
| `get_skills` | List available skills |
| `get_tools` | List active tools |
| `list_session_files` | List session files |

**Interaction:**
| Command | Purpose |
|---------|---------|
| `prompt` | Send user message (with optional `streamingBehavior`) |
| `steer` | Interrupt running agent with message |
| `follow_up` | Queue message for after agent finishes |
| `abort` | Cancel current agent turn |

**Session management:**
| Command | Purpose |
|---------|---------|
| `get_state` | Get SessionInfo |
| `get_messages` | Get AgentMessage[] |
| `set_model` | Change model (provider, modelId) |
| `cycle_model` | Next/previous model |
| `set_thinking_level` | Set thinking level |
| `cycle_thinking_level` | Toggle thinking level |
| `set_session_name` | Rename session |

**Compaction:**
| Command | Purpose |
|---------|---------|
| `compact` | Run context compaction |
| `abort_compaction` | Cancel compaction |
| `set_auto_compaction` | Enable/disable auto-compaction |

**Retry:**
| Command | Purpose |
|---------|---------|
| `set_auto_retry` | Enable/disable auto-retry |
| `abort_retry` | Cancel retry countdown |

**Bash:**
| Command | Purpose |
|---------|---------|
| `bash` | Execute bash command |
| `abort_bash` | Cancel bash execution |

**Other:**
| Command | Purpose |
|---------|---------|
| `get_session_stats` | Token/cost statistics |
| `export_html` | Export session as HTML |
| `new_session` | Create child session |
| `switch_session_file` | Switch to different file |
| `fork` | Fork from message |
| `get_fork_messages` | Get fork preview |
| `get_last_assistant_text` | Get last response |
| `get_context_usage` | Get token usage info |

### 17.3 Extension UI commands

See [Section 18](#18-extension-ui-protocol).

---

## 18. Extension UI protocol

Extensions can request user interaction through the server. The server broadcasts requests to subscribed clients, which respond with `extension_ui_response`.

### 18.1 Request event (`extension_ui_request`)

Server broadcasts to all subscribed clients:

```json
{
  "type": "event",
  "sessionId": "session-123",
  "event": {
    "type": "extension_ui_request",
    "requestId": "req-456",
    "method": "select",
    "title": "Choose an option",
    "options": ["Option A", "Option B"]
  }
}
```

Methods:
- `select` — Choose from options
- `confirm` — Yes/no confirmation
- `input` — Free-form text input
- `editor` — Multi-line text editor
- `interview` — Structured form with questions

### 18.2 Response command (`extension_ui_response`)

Client sends response to resolve the pending request:

```json
{
  "type": "extension_ui_response",
  "sessionId": "session-123",
  "requestId": "req-456",
  "response": {
    "method": "select",
    "value": "Option A"
  }
}
```

Response payloads by method:
- `select`: `{ method: "select", value: string }`
- `confirm`: `{ method: "confirm", confirmed: boolean }`
- `input`: `{ method: "input", value: string }`
- `editor`: `{ method: "editor", value: string }`
- `interview`: `{ method: "interview", responses: Record<string, any> }`
- `cancelled`: `{ method: "cancelled" }` — User dismissed the request

### 18.3 Timeout behavior

UI requests have a configurable timeout. If no client responds within the timeout, the request fails and the extension receives an error.

---

## 19. AgentSession event types

Session-scoped events are wrapped in the `event` envelope:

```json
{
  "type": "event",
  "sessionId": "session-123",
  "event": { /* event payload */ }
}
```

### 19.1 Agent lifecycle events

| Event | Purpose |
|-------|---------|
| `agent_start` | Agent begins processing |
| `agent_end` | Agent finished, includes messages |
| `turn_start` | New turn begins |
| `turn_end` | Turn finished |

### 19.2 Message events

| Event | Purpose |
|-------|---------|
| `message_start` | New message added |
| `message_update` | Streaming update (partial content) |
| `message_end` | Message complete |

### 19.3 Tool execution events

| Event | Purpose |
|-------|---------|
| `tool_execution_start` | Tool begins execution |
| `tool_execution_update` | Partial result available |
| `tool_execution_end` | Tool finished |

### 19.4 Auto-compaction events

| Event | Purpose |
|-------|---------|
| `auto_compaction_start` | Auto-compaction triggered |
| `auto_compaction_end` | Compaction finished |

### 19.5 Auto-retry events

| Event | Purpose |
|-------|---------|
| `auto_retry_start` | Retry countdown started |
| `auto_retry_end` | Retry finished |

---

## 20. Session persistence (ADR-0007)

Sessions can be persisted to disk and loaded later.

### 20.1 Listing stored sessions

```json
// Request
{ "type": "list_stored_sessions" }

// Response
{
  "command": "list_stored_sessions",
  "success": true,
  "data": {
    "sessions": [
      {
        "sessionId": "abc123",
        "sessionName": "My Session",
        "sessionFile": "/path/to/.pi/sessions/abc123.json",
        "sessionPath": "/path/to/.pi/sessions/abc123.json",
        "cwd": "/home/user/project",
        "createdAt": "2026-02-28T10:00:00Z",
        "fileExists": true,
        "messageCount": 42
      }
    ]
  }
}
```

> **Note:** `sessionPath` is an alias for `sessionFile` for consistency with the `load_session` command's `sessionPath` parameter. Either field can be passed to `load_session`.

### 20.2 Loading a session

```json
// Request
{ "type": "load_session", "sessionPath": "/path/to/.pi/sessions/abc123.json" }

// Response
{
  "command": "load_session",
  "success": true,
  "data": { "sessionId": "abc123", "sessionInfo": { ... } }
}
```

> **Security:** `sessionPath` must be an absolute path under an allowed session directory:
> - `~/.pi/agent/sessions/` (default session storage)
> - Any `.pi/sessions/` directory (project-local)
>
> Paths with `..`, relative paths, or paths outside these directories are rejected with an error.

---

## 21. Circuit breaker (ADR-0010)

The server implements circuit breakers for LLM providers and bash commands.

### 21.1 States

- `closed` — Normal operation
- `open` — Failing, rejecting requests
- `half_open` — Testing recovery

### 21.2 Health check

Use `health_check` to check circuit states:

```json
{
  "command": "health_check",
  "success": true,
  "data": {
    "healthy": true,
    "issues": [],
    "hasOpenCircuit": false,
    "hasOpenBashCircuit": false
  }
}
```

### 21.3 Metrics

Circuit breaker state is available in `get_metrics` response under `circuitBreakers` and `bashCircuitBreaker`.

---

## 22. Error responses

All commands can return error responses in this format:

```json
{
  "type": "response",
  "command": "load_session",
  "success": false,
  "error": "sessionPath must be under an allowed session directory"
}
```

### 22.1 Common error conditions

| Command | Error | Cause |
|---------|-------|-------|
| Any | `"Session <id> not found"` | Invalid sessionId |
| Any | `"Session limit reached"` | Too many active sessions |
| `load_session` | `"sessionPath must be..."` | Path traversal attempt or invalid path |
| `load_session` | `"Session <id> already exists"` | Duplicate sessionId |
| `switch_session` | `"Session <id> not found"` | Unknown session |
| `prompt` | `"Circuit breaker open"` | LLM provider failing (ADR-0010) |
| `bash` | `"Bash circuit breaker open"` | Bash commands timing out |

### 22.2 Handling errors

Clients SHOULD:
- Check `success: false` before processing `data`
- Display `error` to users
- Implement retry logic with exponential backoff for transient errors
- Handle circuit breaker errors gracefully (wait and retry)

---

## 23. Companion documents

- `README.md` — architecture-level overview
- `docs/quickstart.md` — operator quickstart
- `docs/client-guide.md` — integration best practices
- `ROADMAP.md` — execution plan and decision gates
- `docs/adr/0001-atomic-outcome-storage.md` — timeout semantics
- `docs/adr/0009-connection-authentication.md` — authentication (planned)
- `docs/adr/0010-circuit-breaker.md` — circuit breaker design
