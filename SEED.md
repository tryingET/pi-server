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

## What Grows From This

```
pi-app-server/
├── src/
│   ├── server.ts         # Transports, routing, broadcast
│   ├── session-manager.ts # Lifecycle, execution, subscribers
│   ├── types.ts          # Protocol: Command | Response | Event
│   ├── client.ts         # Optional: TypeScript client
│   ├── cli.ts            # Optional: CLI entry point
│   └── index.ts          # Optional: Public exports
├── package.json          # ws + @mariozechner/pi-coding-agent
└── tsconfig.json         # ES2022, NodeNext
```

## The Invariants

```
∀ command → ∃! response (by id)
∀ event → sessionId ∈ active_sessions
∀ session → ∃! AgentSession (1:1)
∀ connection → subscribedSessions ⊆ sessions
```

## The Protocol Surface

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

## What's NOT Here (By Design)

- Authentication → add middleware layer
- Rate limiting → add middleware layer
- Metrics → add /metrics endpoint
- Authorization → add session ownership
- Clustering → add session affinity

The seed grows the core. The rest is decoration.

---

*Plant in empty directory. Run. Done.*
