# pi-app-server

A session multiplexer for [@mariozechner/pi-coding-agent](https://github.com/badlogic/pi-mono) that exposes N independent AgentSessions through dual transports—WebSocket on port 3141 and stdio.

**The protocol IS the architecture.**

## Acknowledgments

Born from a conversation between [@SIGKITTEN](https://x.com/SIGKITTEN) and [@badlogicgames](https://x.com/badlogicgames) on [X/Twitter](https://x.com/SIGKITTEN/status/2026755645592961160).

## Installation

```bash
npm install
npm run build
```

## Usage

### Start the server

```bash
node dist/server.js
```

The server listens on:
- **WebSocket**: `ws://localhost:3141`
- **Stdio**: JSON lines on stdin/stdout

Port can be changed via `PI_SERVER_PORT` environment variable.

### Protocol

All commands are JSON objects. Responses and events are JSON lines.

#### Server Commands (manage session registry)

| Command | Description |
|---------|-------------|
| `{"type": "list_sessions"}` | List all active sessions |
| `{"type": "create_session", "sessionId": "..."}` | Create a new session |
| `{"type": "delete_session", "sessionId": "..."}` | Delete a session |
| `{"type": "switch_session", "sessionId": "..."}` | Subscribe to a session's events |

#### Session Commands (pass through to AgentSession)

| Command | Description |
|---------|-------------|
| `{"type": "prompt", "sessionId": "...", "message": "..."}` | Send a prompt |
| `{"type": "steer", "sessionId": "...", "message": "..."}` | Queue steering message |
| `{"type": "abort", "sessionId": "..."}` | Abort current operation |
| `{"type": "get_state", "sessionId": "..."}` | Get session state |
| `{"type": "get_messages", "sessionId": "..."}` | Get all messages |
| `{"type": "set_model", "sessionId": "...", "provider": "...", "modelId": "..."}` | Set model |
| `{"type": "compact", "sessionId": "..."}` | Compact session context |
| ... | (see `types.ts` for full list) |

### Events

All events are broadcast to subscribers with `sessionId` prepended:

```json
{"type": "event", "sessionId": "my-session", "event": {"type": "agent_start"}}
{"type": "event", "sessionId": "my-session", "event": {"type": "message_update", ...}}
{"type": "event", "sessionId": "my-session", "event": {"type": "agent_end", ...}}
```

### Example: WebSocket

```javascript
const ws = new WebSocket('ws://localhost:3141');

ws.on('open', () => {
  ws.send(JSON.stringify({type: 'create_session', sessionId: 'test'}));
  ws.send(JSON.stringify({type: 'switch_session', sessionId: 'test'}));
  ws.send(JSON.stringify({sessionId: 'test', type: 'prompt', message: 'Hello!'}));
});

ws.on('message', (data) => {
  console.log(JSON.parse(data.toString()));
});
```

### Example: Stdio

```bash
echo '{"type":"create_session","sessionId":"test"}
{"type":"switch_session","sessionId":"test"}
{"sessionId":"test","type":"prompt","message":"Hello!"}' | node dist/server.js
```

## Architecture

```
src/
├── server.ts         # Transports, routing, broadcast
├── session-manager.ts # Lifecycle, execution, subscribers
└── types.ts          # Protocol: Command | Response | Event
```

**Invariants:**
- ∀ command → ∃! response (by id)
- ∀ event → sessionId ∈ active_sessions
- ∀ session → ∃! AgentSession (1:1)
- ∀ connection → subscribedSessions ⊆ sessions

## Non-Goals

These are out of scope by design:

| Non-Goal | Why Not Here |
|----------|--------------|
| Authentication | Security is orthogonal to multiplexing |
| Rate Limiting | Throttling is a deployment concern |
| Metrics | Observability is external |
| TLS/SSL | Transport security is a proxy concern |
| Clustering | Horizontal scaling requires session affinity |
| HTTP Transport | Two transports is complete, three is scope creep |

The server does ONE thing—multiplex sessions over transports. Everything else is someone else's job.

## License

MIT
