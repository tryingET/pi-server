# ADR-0007: Session Persistence

## Status

**Implemented** (2026-02-26)

## Context

When pi-server restarts, all session state is lost. Users must:
- Manually recreate sessions
- Lose conversation history
- Restart any in-progress work

This is acceptable for development but painful for production use.

### Use Cases

1. **Server restart** — Sessions survive server restarts
2. **Session archival** — Old sessions can be loaded later
3. **Multi-device** — Same session accessible from different clients (future)

## Decision

We will implement **session file persistence** with the following design:

### 1. Session Store

A `SessionStore` class manages session metadata:

```typescript
interface StoredSessionInfo {
  sessionId: string;
  sessionName?: string;
  sessionFile: string;     // Path to session file
  sessionPath: string;     // Alias for sessionFile (for load_session)
  cwd: string;
  fileExists: boolean;
  createdAt: string;
  messageCount: number;
}
```

> **Note:** `sessionPath` is an alias for `sessionFile` for consistency with the `load_session` command's `sessionPath` parameter.

### 2. Discovery

Sessions are discovered by scanning `.pi/sessions/` directories:

```
~/.pi/sessions/           # Global sessions
  abc123.json
  def456.json
  
/project/.pi/sessions/    # Project-local sessions
  xyz789.json
```

### 3. Commands

| Command | Purpose |
|---------|---------|
| `list_stored_sessions` | List all discoverable sessions |
| `load_session` | Load session from file path |

### 4. Auto-load Behavior

When `list_stored_sessions` returns sessions and no active sessions exist, clients MAY auto-load the most recent session.

### 5. Session File Format

Sessions use the standard AgentSession file format (JSON with messages array).

### 6. Path Validation (Security)

The `load_session` command validates the `sessionPath` parameter to prevent path traversal attacks:

**Allowed directories:**
- `~/.pi/agent/sessions/` (default session storage)
- Any `.pi/sessions/` directory (project-local)

**Validation rules:**
- Must be an absolute path
- Must end with `.jsonl` or `.json` extension
- Cannot contain `..`, `~`, or null bytes
- Must be under an allowed directory

**Implementation:** `src/validation.ts` → `validateSessionPath()`

## Implementation

### Files

- `src/session-store.ts` — Session metadata store and discovery
- `src/types.ts` — `StoredSessionInfo` type
- `src/server-command-handlers.ts` — Command handlers

### API

```typescript
class SessionStore {
  constructor(options: { serverVersion?: string });
  
  // List all discoverable sessions
  listStoredSessions(): Promise<StoredSessionInfo[]>;
  
  // Record session metadata reset (for metrics)
  recordMetadataReset(): void;
  
  // Get metadata reset count
  getMetadataResetCount(): number;
}
```

## Consequences

### Positive

- Sessions survive server restarts
- Users can browse and load old sessions
- Works with existing session file format

### Negative

- Directory scanning can be slow with many sessions
- No automatic cleanup of old sessions
- No session ownership/isolation (single-user)

### Mitigations

| Risk | Mitigation |
|------|------------|
| Slow scanning | Cache results, refresh on demand |
| Disk usage | Document manual cleanup, add TTL option |
| Multi-user | Defer to ADR-0009 (authentication) |
| Path traversal | `validateSessionPath()` enforces allowed directories |

## Future Work

- **Auto-save** — Periodically save session state
- **TTL cleanup** — Auto-delete old sessions
- **Multi-user** — Scope sessions to authenticated identity (ADR-0009)

## References

- `src/session-store.ts` — Implementation
- `src/types.ts` — Type definitions
- PROTOCOL.md §20 — Protocol documentation
