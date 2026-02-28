# pi-server

Session multiplexer for [pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent). Exposes N independent `AgentSession` instances through WebSocket and stdio transports.

[![CI](https://github.com/tryingET/pi-server/actions/workflows/ci.yml/badge.svg)](https://github.com/tryingET/pi-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-app-server.svg)](https://www.npmjs.com/package/pi-app-server)

> Note: This is a standalone pi server package, not an extension/skills/themes bundle.

## Features

- **Dual transport**: WebSocket (port 3141) + stdio (JSON lines)
- **Session lifecycle**: Create, delete, list, switch sessions
- **Command execution**: Deterministic lane serialization per session
- **Idempotent replay**: Atomic outcome storage with free replay lookups
- **Optimistic concurrency**: Session versioning for conflict detection
- **Extension UI**: Full round-trip support for `select`, `confirm`, `input`, `editor`, `interview`
- **Resource governance**: Rate limiting, session limits, message size limits
- **Graceful shutdown**: Drain in-flight commands, notify clients
- **Protocol versioning**: `serverVersion` + `protocolVersion` for compatibility checks

## Installation

```bash
npm install pi-app-server
```

## Quick Start

### WebSocket

```bash
# Start server
npx pi-server

# Connect with wscat
wscat -c ws://localhost:3141
```

```js
// Create and use a session
ws> {"type":"create_session","sessionId":"my-session"}
ws> {"type":"switch_session","sessionId":"my-session"}
ws> {"id":"cmd-1","type":"prompt","sessionId":"my-session","message":"Hello!"}
```

### stdio

```bash
echo '{"type":"create_session","sessionId":"test"}
{"type":"switch_session","sessionId":"test"}
{"id":"cmd-1","type":"prompt","sessionId":"test","message":"Hello!"}' | npx pi-server
```

## Architecture

```
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
├── server-ui-context.ts    # ExtensionUIContext for remote clients
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

## Protocol

See [PROTOCOL.md](./PROTOCOL.md) for the normative wire contract.

### Command → Response

Every command receives exactly one response:

```json
{"id": "cmd-1", "type": "prompt", "sessionId": "s1", "message": "hello"}
{"id": "cmd-1", "type": "response", "command": "prompt", "success": true}
```

### Event Broadcast

Events flow session → subscribers:

```json
{"type": "event", "sessionId": "s1", "event": {"type": "agent_start", ...}}
```

### Extension UI Round-Trip

1. Extension calls `ui.select()` → server creates pending request
2. Server broadcasts `extension_ui_request` event with `requestId`
3. Client sends `extension_ui_response` command with same `requestId`
4. Server resolves pending promise → extension continues

### Idempotency & Replay

```json
// First request with idempotency key
{"id": "cmd-1", "type": "list_sessions", "idempotencyKey": "key-1"}
{"id": "cmd-1", "type": "response", "command": "list_sessions", "success": true, ...}

// Retry with same key → replayed (free, no rate limit charge)
{"id": "cmd-2", "type": "list_sessions", "idempotencyKey": "key-1"}
{"id": "cmd-2", "type": "response", "command": "list_sessions", "success": true, "replayed": true, ...}
```

### Timeout semantics (ADR-0001)

- Timeout is a **terminal stored outcome** (`timedOut: true`), not an indeterminate placeholder.
- Replay of the same command identity returns the **same timeout response**.
- Late underlying completion does **not** overwrite the stored timeout outcome.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test                    # Unit tests (83)
npm run test:integration    # Integration tests (26)
npm run test:fuzz           # Fuzz tests (17)

# Module tests (141)
node --experimental-vm-modules dist/test-command-classification.js
node --experimental-vm-modules dist/test-session-version-store.js
node --experimental-vm-modules dist/test-command-replay-store.js
node --experimental-vm-modules dist/test-command-execution-engine.js

# Type check + lint
npm run check

# Full CI
npm run ci
```

## Release Process

This project uses [release-please](https://github.com/googleapis/release-please) for automated versioning.

### Automated Flow

1. Push to `main` → release-please creates/updates a release PR
2. Merge the release PR → Creates GitHub release + git tag
3. Release published → GitHub Action publishes to npm with provenance

### Manual Release Check

```bash
npm run release:check
```

This validates:
- `package.json` has required fields
- `dist/` exists with compiled files
- Entry point has correct shebang
- `npm pack` produces expected files
- Full CI passes

## Documentation

| Document | Purpose |
|----------|---------|
| [AGENTS.md](./AGENTS.md) | Crystallized learnings, patterns, anti-patterns |
| [PROTOCOL.md](./PROTOCOL.md) | Normative wire contract |
| [ADR-0001](./docs/adr/0001-atomic-outcome-storage.md) | Atomic outcome storage decision |
| [ROADMAP.md](./ROADMAP.md) | Phase tracking and milestones |

## License

MIT
