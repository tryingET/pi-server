# AGENTS.md — Crystallized Learnings for pi-server

This document captures patterns, anti-patterns, and gotchas discovered during development. Read this before working on pi-server.

---

## Architecture Principles

1. **The protocol IS the architecture** — `types.ts` is the single source of truth
2. **Server should be thin** — AgentSession does the work, we just multiplex
3. **Pass-through pattern** — Session commands are thin wrappers around AgentSession methods
4. **Handler map > switch** — `Record<string, CommandHandler>` for O(1) dispatch, easy extension
5. **Extract to stores** — State with independent lifecycle gets its own module
6. **SessionResolver is the NEXUS seam** — Interface for session access enables test doubles

---

## ADR-0001: Atomic Outcome Storage

**Status:** Accepted (2026-02-22)

Full ADR: `docs/adr/0001-atomic-outcome-storage.md`

### The Invariant

> Same command ID must ALWAYS return the same response. Not "usually." Not "after the callback completes." ALWAYS.

### Three Critical Rules

1. **Store BEFORE return** — Outcomes are stored before the response is returned, not in async callbacks
2. **Timeout IS a response** — Timeout responses are stored as valid outcomes (with `timedOut: true`)
3. **Replay is FREE** — Replay operations are O(1) lookups, exempt from rate limiting

### Code Pattern

```typescript
// WRONG: Async callback creates race condition
commandExecution.then((response) => {
  this.storeOutcome(commandId, response);  // After return
});
return withTimeout(commandExecution, ...);

// CORRECT: Atomic storage before return
let response: RpcResponse;
try {
  response = await executeWithTimeout(commandExecution, ...);
} catch (error) {
  response = { success: false, error: error.message, timedOut: true };
}
this.storeOutcome(commandId, response);  // BEFORE return
return response;
```

### Reject, Don't Evict

When in-flight command limit is reached, **reject new commands** instead of evicting old ones. Eviction breaks dependency chains.

```typescript
// WRONG: Eviction breaks dependencies
if (this.inFlight.size >= max) {
  const oldest = this.order.shift();
  this.inFlight.delete(oldest);  // Dependent commands fail!
}

// CORRECT: Reject preserves dependencies
if (this.inFlight.size >= max) {
  return { success: false, error: "Server busy - please retry" };
}
```

### Free Replay

Replay reads from stored outcomes — no execution cost. Rate limiting applies only to NEW executions.

```typescript
// Check replay FIRST (free)
const replayResult = this.replayStore.checkReplay(command, fingerprint);
if (replayResult.found) {
  return replayResult.response;  // No rate limit charge
}

// THEN rate limit (only for new executions)
if (!this.governor.canExecuteCommand(sessionId)) {
  return { success: false, error: "Rate limit exceeded" };
}
```

---

## File Responsibilities

| File | Responsibility | Don't Put Here |
|------|----------------|----------------|
| `server.ts` | Transports (WebSocket, stdio) only | Command logic, session lifecycle |
| `session-manager.ts` | Orchestration: coordinates stores, engines, sessions | Direct state mutation (delegate to stores) |
| `command-router.ts` | Session command handlers, routing | Session lifecycle, broadcast |
| `command-classification.ts` | Pure command classification (timeout, mutation) | State, side effects |
| `command-replay-store.ts` | Idempotency, duplicate detection, outcome history | Execution logic |
| `session-version-store.ts` | Monotonic version counters per session | Replay semantics |
| `command-execution-engine.ts` | Lane serialization, dependency waits, timeouts | Storage |
| `extension-ui.ts` | Pending UI request tracking | Command handling, transport |
| `types.ts` | Protocol definitions | Implementation |

---

## pi Integration Gotchas

### Extension UI is NOT an AgentSessionEvent

`extension_ui_request` comes through `ExtensionUIContext`, not the event stream. To receive extension UI requests:

```typescript
// WRONG: Waiting for AgentSessionEvent with type "extension_ui_request"
session.subscribe((event) => {
  if (event.type === "extension_ui_request") { /* NEVER FIRES */ }
});

// RIGHT: Provide custom ExtensionUIContext to bindExtensions
await session.bindExtensions({
  uiContext: {
    async select(title, options, opts) {
      // This is called when extension needs user input
      // Broadcast to client, await response
    }
  }
});
```

### Session Creation is Slow

`createAgentSession()` loads extensions, skills, and prompts. Can take several seconds. Don't assume it's fast.

### modelRegistry.getModel() is Internal API

```typescript
// WRONG: Internal API, will break
session.setModel((session.modelRegistry as any).getModel(provider, modelId));

// RIGHT: Use public API (if available) or document the risk
// Currently no clean public API for this — needs investigation
```

### bindExtensions Required for Extension UI

Without calling `session.bindExtensions({ uiContext: ... })`, extensions that need user input will hang forever.

---

## Protocol Patterns

### Command → Response Correlation

Every response must include the `id` from the command:

```typescript
// Command
{ "id": "abc123", "type": "prompt", "sessionId": "s1", "message": "hello" }

// Response
{ "id": "abc123", "type": "response", "command": "prompt", "success": true }
```

### Event Broadcast

Events flow one direction: session → subscribers with sessionId prepended:

```typescript
// Internal event from AgentSession
{ type: "agent_start", ... }

// Broadcast to subscribers
{ type: "event", sessionId: "s1", event: { type: "agent_start", ... } }
```

### Extension UI Round-Trip

1. Extension calls `ui.select()` → server creates pending request
2. Server broadcasts `extension_ui_request` event with `requestId`
3. Client sends `extension_ui_response` command with same `requestId`
4. Server resolves pending promise → extension continues

### Fingerprint Semantics (Critical)

The fingerprint determines semantic equivalence for replay. **Exclude ALL retry identity fields:**

```typescript
// CORRECT: Excludes both id and idempotencyKey
getCommandFingerprint(command: RpcCommand): string {
  const { id: _id, idempotencyKey: _key, ...rest } = command;
  return JSON.stringify(rest);
}
```

**Why:** Two commands with identical semantic content but different retry identity should replay, not conflict:

```typescript
// These are SEMANTICALLY IDENTICAL (same fingerprint)
{ id: "cmd-1", type: "get_state", sessionId: "s1" }
{ id: "cmd-2", type: "get_state", sessionId: "s1", idempotencyKey: "retry-1" }

// Both should replay the same cached outcome for the same command ID
```

**Gotcha:** If you only exclude `id` but not `idempotencyKey`, commands with different idempotency keys will have different fingerprints → conflict instead of replay.

### Custom Abort Handlers

The `CommandExecutionEngine` accepts custom abort handlers via options:

```typescript
const engine = new CommandExecutionEngine(replayStore, versionStore, resolver, {
  abortHandlers: {
    // Override default handler for prompt
    prompt: (session) => session.abort(),
    // Add handler for custom command type
    custom_command: (session) => session.someAbortMethod(),
  },
});
```

Custom handlers override defaults for the same command type. This enables:
- Test doubles without real AgentSession methods
- Custom command types with specific abort behavior
- Future extensibility for plugin commands

### Synthetic Command IDs

When clients omit `id`, the server generates synthetic IDs: `anon:<sequence>`

**Why no timestamp?**
1. Sequence alone guarantees uniqueness within process lifetime
2. Timestamps are misleading — they don't provide ordering across restarts
3. Simpler format is easier to debug and log

---

## Common Anti-Patterns

### Type Casting sessionId

```typescript
// BAD: Loses type safety
const sessionId = (command as any).sessionId;

// GOOD: Create typed accessor or use discriminated unions
function getSessionId(command: SessionCommand): string {
  return command.sessionId; // TypeScript knows it exists
}
```

### Silent Error Swallowing

```typescript
// BAD: Silent message loss
try {
  subscriber.send(data);
} catch {
  // Subscriber may have disconnected
}

// GOOD: Log failures
try {
  subscriber.send(data);
} catch (error) {
  logger.warn(`Failed to send to subscriber`, { error });
}
```

### Server Knowing Session Semantics

```typescript
// BAD: server.ts knows about switch_session subscription logic
if (command.type === "switch_session") {
  this.sessionManager.subscribeToSession(subscriber, command.sessionId);
}

// GOOD: Session manager handles subscription internally
// (Refactor pending)
```

---

## Adding a New Command

1. **Add type to `types.ts`:**
```typescript
| { id?: string; sessionId: string; type: "my_command"; param: string }
```

2. **Add response type to `types.ts`:**
```typescript
| RpcResponseBase & { command: "my_command"; success: true; data: { result: string } }
```

3. **Add handler to `command-router.ts`:**
```typescript
const handleMyCommand: CommandHandler = async (session, command) => {
  const result = await session.someMethod(command.param);
  return {
    id: command.id,
    type: "response",
    command: "my_command",
    success: true,
    data: { result }
  };
};
```

4. **Add to handler map:**
```typescript
export const sessionCommandHandlers = {
  // ...
  my_command: handleMyCommand,
};
```

5. **Test:**
```bash
echo '{"type":"create_session","sessionId":"t"}' > /tmp/test.jsonl
echo '{"sessionId":"t","type":"my_command","param":"test"}' >> /tmp/test.jsonl
cat /tmp/test.jsonl | timeout 5 node dist/server.js | jq .
```

---

## Known Issues

| Issue | Location | Status |
|-------|----------|--------|
| `set_model` uses internal API | command-router.ts:67 | Document risk, investigate public API |
| Windows path handling | command-router.ts:175 | Use `path.basename()` |
| ~~No input validation~~ | validation.ts | **FIXED** |
| ~~No command timeout~~ | command-execution-engine.ts | **FIXED** |
| ~~Extension UI not wired~~ | session-manager.ts | **FIXED** |
| ~~Unbounded in-flight commands~~ | command-replay-store.ts | **FIXED** - bounded with eviction |
| ~~Lane tail memory leak~~ | command-execution-engine.ts | **FIXED** - correct promise comparison |
| ~~No reserved ID validation~~ | validation.ts | **FIXED** - `anon:` prefix rejected |
| ~~No store metrics~~ | All stores | **FIXED** - `getStats()` added |

---

## Resource Bounds

All stores have bounded memory:

| Store | Bound | Config |
|-------|-------|--------|
| `commandInFlightById` | 10,000 entries | `maxInFlightCommands` |
| `commandOutcomes` | 2,000 entries | `maxCommandOutcomes` |
| `idempotencyCache` | TTL-based | `idempotencyTtlMs` (10 min) |
| `laneTails` | Auto-cleanup | Tasks delete on completion |

---

## Testing

Comprehensive test suite exists. Run with `npm test`.

### Test Structure

| File | What it tests |
|------|---------------|
| `test.ts` | Main test runner, validation, governor, session-manager integration |
| `test-command-classification.ts` | Timeout/mutation classification logic |
| `test-command-replay-store.ts` | Idempotency, fingerprinting, replay semantics |
| `test-session-version-store.ts` | Version counters, mutation detection |
| `test-command-execution-engine.ts` | Lane serialization, dependency waits, timeouts |
| `test-integration.ts` | Full server tests with real WebSocket/stdio |

### Key Test Patterns

1. **Mock SessionResolver for unit tests:**
```typescript
function createMockSessionResolver(sessions: Map<string, Partial<AgentSession>>): SessionResolver {
  return {
    getSession(sessionId: string) {
      return sessions.get(sessionId) as AgentSession | undefined;
    },
  };
}
```

2. **Test replay semantics with fingerprint edge cases:**
```typescript
// Same semantic command, different retry identity → should replay, not conflict
const cmd1 = { id: "cmd-1", type: "get_state", sessionId: "s1" };
const cmd2 = { id: "cmd-1", type: "get_state", sessionId: "s1", idempotencyKey: "retry" };
assert.strictEqual(store.getCommandFingerprint(cmd1), store.getCommandFingerprint(cmd2));
```

3. **Test lane serialization:**
```typescript
// Commands in same lane execute sequentially
// Commands in different lanes execute concurrently
```

---

## Debugging

```bash
# Stdio with pretty output
node dist/server.js 2>&1 | jq .

# WebSocket with wscat
wscat -c ws://localhost:3141

# Check specific command
echo '{"type":"list_sessions"}' | node dist/server.js 2>/dev/null | jq .

# See all events
echo '{"type":"create_session","sessionId":"test"}' | timeout 5 node dist/server.js 2>&1 | jq .
```

---

## Dependencies

| Dependency | Purpose | Risk |
|------------|---------|------|
| `@mariozechner/pi-coding-agent` | AgentSession, createAgentSession | API changes break handlers |
| `@mariozechner/pi-agent-core` | AgentMessage, ThinkingLevel | Type changes |
| `@mariozechner/pi-ai` | ImageContent, Model | Type changes |
| `ws` | WebSocket server | Stable |

---

## Rollback

```bash
# Full rollback to last commit
git checkout -- .
git clean -fd

# Selective rollback
git checkout HEAD -- src/specific-file.ts
```
