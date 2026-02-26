# pi-app-server

A deterministic session multiplexer for [@mariozechner/pi-coding-agent](https://github.com/badlogic/pi-mono).
It exposes many independent `AgentSession`s through two transports:

- **WebSocket** (`ws://localhost:3141` by default)
- **stdio** (JSON Lines on stdin/stdout)

> **Design thesis:** the protocol is the architecture.

### Quick navigation

- [Run](#run)
- [Protocol Overview](#protocol-overview)
- [Supported Commands](#supported-commands)
- [Ordering and Determinism Guarantees](#ordering-and-determinism-guarantees)
- [Normative Client Contract (MUST/SHOULD)](#normative-client-contract-mustshould)
- [Architecture](#architecture)
- [Non-goals](#non-goals)
- [Documentation map](#documentation-map)

---

## Acknowledgments

This project began with a conversation between [@SIGKITTEN](https://x.com/SIGKITTEN) and [@badlogicgames](https://x.com/badlogicgames) on [X/Twitter](https://x.com/SIGKITTEN/status/2026755645592961160).

---

## Installation

```bash
npm install
npm run build
```

---

## Run

```bash
node dist/server.js
```

- Default WebSocket port: `3141`
- Override with `PI_SERVER_PORT`

---

## Protocol Overview

All inbound commands and outbound responses/events are JSON objects sent as JSON Lines.

For the normative wire contract, see **`PROTOCOL.md`**.

### Command Envelope (optional causal fields)

Any command may include:

- `id: string` — command identity (strongly recommended)
- `dependsOn: string[]` — command IDs that must succeed first
- `ifSessionVersion: number` — optimistic concurrency precondition
- `idempotencyKey: string` — replay-safe retry key

Responses may include:

- `sessionVersion: number` — monotonic per-session version after success
- `replayed: true` — response served from replay cache/history

### Replay and conflict semantics

- Same `id`, same fingerprint → replay prior outcome.
- Same `id`, different fingerprint → reject with conflict error.
- Same `idempotencyKey`, different fingerprint → reject with conflict error.

A “fingerprint” is semantic command equivalence (excluding retry identity).

---

## Supported Commands

### Server commands (session registry)

| Command | Description |
|---|---|
| `{"type":"list_sessions"}` | List active sessions |
| `{"type":"create_session","sessionId":"..."}` | Create session |
| `{"type":"delete_session","sessionId":"..."}` | Delete session |
| `{"type":"switch_session","sessionId":"..."}` | Subscribe caller to session events |
| `{"type":"get_metrics"}` | Return governor/system metrics |
| `{"type":"health_check"}` | Return health summary |

### Session commands (AgentSession passthrough)

| Command | Description |
|---|---|
| `{"type":"prompt","sessionId":"...","message":"..."}` | Prompt model |
| `{"type":"steer","sessionId":"...","message":"..."}` | Queue steering input |
| `{"type":"follow_up","sessionId":"...","message":"..."}` | Continue with follow-up |
| `{"type":"abort","sessionId":"..."}` | Abort active operation |
| `{"type":"get_state","sessionId":"..."}` | Session state snapshot |
| `{"type":"get_messages","sessionId":"..."}` | Session transcript |
| `{"type":"set_model","sessionId":"...","provider":"...","modelId":"..."}` | Switch model |
| `{"type":"compact","sessionId":"..."}` | Compact context |
| `...` | See `src/types.ts` for the full command surface |

---

## Events

### Session-scoped agent events

Broadcast only to subscribers of that session:

```json
{"type":"event","sessionId":"my-session","event":{"type":"agent_start"}}
{"type":"event","sessionId":"my-session","event":{"type":"message_update"}}
{"type":"event","sessionId":"my-session","event":{"type":"agent_end"}}
```

### Global lifecycle events

Broadcast for admitted commands:

```json
{"type":"command_accepted","data":{"commandId":"cmd-1","commandType":"prompt","sessionId":"s1"}}
{"type":"command_started","data":{"commandId":"cmd-1","commandType":"prompt","sessionId":"s1"}}
{"type":"command_finished","data":{"commandId":"cmd-1","commandType":"prompt","sessionId":"s1","success":true,"sessionVersion":12}}
```

---

## Ordering and Determinism Guarantees

### 1) Admission gate

`command_accepted` is emitted only after validation and shutdown checks pass.
Commands rejected before admission do not emit lifecycle events.

### 2) Per-request phase order

For each admitted request:

1. `command_accepted`
2. `command_started` (if execution begins)
3. `command_finished` (exactly once)

### 3) Lane serialization

Commands execute in deterministic lanes:

- `session:<sessionId>` for session-targeted commands
- `server` for server-level commands

Within a lane, execution is serialized.
Across lanes, event interleaving is allowed (no global total order).

### 4) Replay shape

Replay hits emit:

- `command_accepted`
- `command_finished` (`replayed: true`)

Replay responses do not emit `command_started`.

### 5) Timeout edge behavior

A caller may receive timeout while underlying execution continues.
A later duplicate-id replay returns the eventual terminal outcome.

---

## Normative Client Contract (MUST/SHOULD)

- Clients **MUST** treat `id` as unique per logical command intent.
- Clients **MUST NOT** reuse an `id` for a semantically different payload.
- Retrying clients **SHOULD** include both `id` and `idempotencyKey`.
- Clients **MUST** handle conflict errors for fingerprint-mismatched `id`/`idempotencyKey` reuse.
- Clients **MUST** treat `sessionVersion` as authoritative for concurrency control.
- Clients issuing mutating session commands **SHOULD** use `ifSessionVersion`.
- Clients **MUST NOT** assume global total ordering of lifecycle events across lanes.
- Timeout responses **SHOULD** be treated as indeterminate completion and reconciled via replay/inspection.

---

## Examples

### WebSocket

```js
const ws = new WebSocket("ws://localhost:3141");

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "create_session", sessionId: "test" }));
  ws.send(JSON.stringify({ type: "switch_session", sessionId: "test" }));
  ws.send(
    JSON.stringify({
      id: "cmd-1",
      type: "prompt",
      sessionId: "test",
      message: "Hello!",
    })
  );
};

ws.onmessage = (event) => {
  console.log(JSON.parse(event.data));
};
```

### stdio

```bash
echo '{"type":"create_session","sessionId":"test"}
{"type":"switch_session","sessionId":"test"}
{"id":"cmd-1","type":"prompt","sessionId":"test","message":"Hello!"}' | node dist/server.js
```

---

## Architecture

```text
src/
├── server.ts               # transports, connection lifecycle, routing glue
├── session-manager.ts      # orchestration: coordinates stores, engines, sessions
├── command-router.ts       # session command handlers, routing
├── command-classification.ts  # pure command classification (timeout, mutation)
├── command-replay-store.ts    # idempotency, duplicate detection, outcome history
├── session-version-store.ts   # monotonic version counters per session
├── command-execution-engine.ts # lane serialization, dependency waits, timeouts
├── resource-governor.ts    # limits, rate controls, health/metrics
├── extension-ui.ts         # pending UI request tracking
├── validation.ts           # command validation
└── types.ts                # wire protocol types + SessionResolver interface
```

### Core invariants

- For each admitted command, there is exactly one terminal response.
- For each session ID, there is at most one live `AgentSession`.
- Subscriber session sets are always a subset of active sessions.
- Session version is monotonic and mutation-sensitive.
- Fingerprint excludes retry identity (`id`, `idempotencyKey`) for semantic equivalence.

### Key abstractions

- **`SessionResolver`** — Interface for session access (enables test doubles, future clustering)
- **`CommandReplayStore`** — Idempotency and duplicate detection
- **`SessionVersionStore`** — Optimistic concurrency via version counters
- **`CommandExecutionEngine`** — Deterministic lane serialization and timeout management

See `ROADMAP.md` for phase tracking and next milestones.

---

## Non-goals

Deliberately out of scope:

| Non-goal | Why |
|---|---|
| Authentication/authorization | Deployment boundary concern |
| TLS termination | Better handled by edge proxy |
| Horizontal clustering | Requires external session affinity design |
| HTTP transport surface | WebSocket + stdio are sufficient for this layer |
| Durable command journal/replay engine | Tracked as a future roadmap phase |

---

## Documentation map

- `docs/quickstart.md` — shortest path from install to verified running server
- `docs/client-guide.md` — practical integration and retry/concurrency guidance
- `PROTOCOL.md` — normative wire contract (MUST/SHOULD semantics)
- `ROADMAP.md` — execution plan, gates, and open decisions

---

## License

MIT
