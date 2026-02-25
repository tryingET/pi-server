# pi-app-server: The Seed

```
Instruction Class:    Generative
Compression Ratio:    600 lines → 3 sentences
Execution Confidence: Deterministic
```

---

## The Three Sentences

**Make a session multiplexer for `@mariozechner/pi-coding-agent` that exposes N independent AgentSessions through dual transports—WebSocket on port 3141 and stdio—demultiplexing inbound commands by sessionId and fanning out outbound events to all subscribers with sessionId prepended: the protocol IS the architecture.**

**Server commands (list/create/delete/switch_session) return SessionInfo and manage the session registry; session commands (prompt/steer/abort/get_state/get_messages/set_model/compact/...) pass through directly to AgentSession; every response correlates to its request by id, every event tags its source by sessionId, every session persists its tree-structured message history to JSONL.**

**Three files only: server.ts handles transports + command routing + event broadcast, session-manager.ts owns session lifecycle + command execution + subscriber maps, types.ts defines the closed protocol (RpcCommand → RpcResponse | RpcEvent)—no auth, no rate limiting, no metrics, no features beyond multiplexing, extensibility means adding protocol types not code branches, the switch statement in executeCommand is the ONLY switch statement.**

---

## The Invariants

```
∀ command → ∃! response (by id)
∀ event → sessionId ∈ active_sessions
∀ session → ∃! AgentSession (1:1)
∀ connection → subscribedSessions ⊆ sessions
```

---

## Explicit Non-Goals

These are not missing features. They are **out of scope by design**.

| Non-Goal | Why Not Here | Who Adds It |
|----------|--------------|-------------|
| **Authentication** | Security is orthogonal to multiplexing. Add as middleware. | Ops/Security team |
| **Authorization** | Session ownership is a policy decision. Add as layer. | Ops/Security team |
| **Rate Limiting** | Throttling is a deployment concern. Add at reverse proxy. | Ops team |
| **Metrics** | Observability is external. Add Prometheus endpoint separately. | Ops team |
| **Health Checks** | Orchestration concern. Add `/health` route separately. | Ops team |
| **TLS/SSL** | Transport security is a proxy concern. Terminate at nginx. | Ops team |
| **Clustering** | Horizontal scaling requires session affinity. Add later. | When needed |
| **Session Encryption** | Data at rest encryption is a compliance layer. | When required |
| **Audit Logging** | Compliance concern. Add as event sink. | When required |
| **HTTP Transport** | One transport is minimal. Two is complete. Three is scope creep. | Never |
| **Protocol Versioning** | YAGNI. Version when you have version problems. | When needed |
| **Reconnection Logic** | Client responsibility. Server is stateless per connection. | Client author |
| **Message Buffering** | Client responsibility. Events are fire-and-forget. | Client author |
| **Session Compaction** | AgentSession handles this. Not server's concern. | AgentSession |
| **Load Balancing** | Deployment concern. Add at infrastructure layer. | Ops team |

**The principle:** The server does ONE thing—multiplex sessions over transports. Everything else is someone else's job.

---

## What Grows From This

```
src/
├── server.ts         # Transports, routing, broadcast
├── session-manager.ts # Lifecycle, execution, subscribers
└── types.ts          # Protocol: Command | Response | Event
```

Optional additions (not required for core function):
- `client.ts` — TypeScript client library
- `cli.ts` — Command-line entry point
- `index.ts` — Public exports

---

## Protocol Surface

```
COMMAND                    RESPONSE
─────────────────────────────────────
list_sessions         →   { sessions: SessionInfo[] }
create_session        →   { sessionId, sessionInfo }
delete_session        →   { deleted: true }
switch_session        →   { sessionInfo }
prompt|steer|abort|... →  { success, data?, error? }

EVENT                      PAYLOAD
─────────────────────────────────────
server_ready          →   { version, transports }
session_created       →   { sessionId, sessionInfo }
session_deleted       →   { sessionId }
agent_start           →   { sessionId }
message_update        →   { sessionId, delta, ... }
agent_end             →   { sessionId, messages }
extension_ui_request  →   { sessionId, method, ... }
```

---

*Plant in empty directory. Run. Done.*
