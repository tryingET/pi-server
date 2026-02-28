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
| `session-lock-manager.ts` | Per-session-ID mutual exclusion for create/delete | Long-running locks |
| `extension-ui.ts` | Pending UI request tracking | Command handling, transport |
| `types.ts` | Protocol definitions | Implementation |
| `validation.ts` | Command validation, reserved ID enforcement | Execution logic |

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

## ADR-0002: Session ID Locking

**Status:** Accepted (2026-02-22)

### The Problem

Concurrent `createSession("same-id")` calls could both pass the duplicate check, reserve slots, then race to insert. The first wins, the second throws "already exists" - but BOTH slots are consumed. This is a permanent slot leak until server restart.

### The Solution

`SessionLockManager` provides per-session-ID mutual exclusion:

```typescript
const lock = await lockManager.acquire(sessionId, "createSession");
try {
  // Critical section - only one caller per sessionId
  if (this.sessions.has(sessionId)) {
    throw new Error(`Session ${sessionId} already exists`);
  }
  // ... create session ...
} finally {
  lock.release();
}
```

### Key Properties

1. **Lock is per-session-ID** - Different sessions can be created concurrently
2. **5 second timeout** - Prevents indefinite waiting on deadlocks
3. **30 second hold warning** - Logs if lock held too long
4. **Lock manager stats** - Exposed via `get_metrics.stores.lock`

---

## ADR-0003: WebSocket Backpressure

**Status:** Accepted (2026-02-22)

### The Problem

`ws.send()` buffers in memory when client is slow. A malicious or slow client can cause OOM on the server.

### The Solution

`sendWithBackpressure()` helper checks `ws.bufferedAmount` before sending:

- **< 64KB**: Send normally
- **64KB - 1MB**: Drop non-critical messages (events, broadcasts)
- **> 1MB**: Close connection to prevent OOM

```typescript
// Critical messages (responses, errors) - attempt send even under mild backpressure
sendWithBackpressure(ws, JSON.stringify(response), { isCritical: true });

// Non-critical messages (events, broadcasts) - dropped under backpressure
sendWithBackpressure(ws, data, { isCritical: false });
```

### Key Properties

1. **Command responses are critical** - Clients are waiting for them
2. **Events are non-critical** - Dropped under pressure, client catches up
3. **Connection closed at 1MB** - Prevents OOM, client must reconnect

---

## ADR-0004: Bounded Pending UI Requests

**Status:** Accepted (2026-02-22)

### The Problem

`ExtensionUIManager.pendingRequests` is unbounded. A misbehaving extension creating infinite UI requests can fill memory.

### The Solution

`createPendingRequest()` returns `null` when limit (default: 1000) is reached:

```typescript
const request = extensionUI.createPendingRequest(sessionId, "select", { ... });
if (!request) {
  // Limit reached - return default value
  return undefined;
}
```

### Key Properties

1. **Default limit: 1000** - Configurable via constructor
2. **Graceful degradation** - UI requests return default values
3. **Stats exposed** - `get_metrics.stores.extensionUI.{pendingCount, rejectedCount}`

---

## ADR-0005: WebSocket Heartbeat

**Status:** Accepted (2026-02-22)

### The Problem

Silent network disconnects leave zombie WebSocket connections. The server believes the connection is open, but messages are never received by the client.

### The Solution

Periodic ping/pong heartbeat with timeout:

- **30 second interval** - Server sends ping every 30 seconds
- **10 second timeout** - If no pong within 10 seconds, close connection
- **Pong handler** - Resets timeout timer on pong receipt

```typescript
// Heartbeat state per connection
const heartbeatState = {
  waitingForPong: false,
  lastPongAt: Date.now(),
  heartbeatTimer: null,
  pongTimeoutTimer: null,
};

// Start heartbeat on connection
startHeartbeat(ws, heartbeatState);

// Handle pong
ws.on("pong", () => {
  heartbeatState.waitingForPong = false;
  heartbeatState.lastPongAt = Date.now();
});
```

### Key Properties

1. **Detects silent disconnects** - Dead connections cleaned up within 40 seconds
2. **No client changes required** - WebSocket ping/pong is automatic in browsers
3. **Low overhead** - 2 bytes per ping, minimal bandwidth

---

## ADR-0006: RequestId Validation

**Status:** Accepted (2026-02-22)

### The Problem

`requestId` in `extension_ui_response` was not validated, allowing injection attacks or malformed data.

### The Solution

Validate requestId length and character set:

- **Max length: 256 characters** - Prevents memory exhaustion
- **Allowed characters: `[a-zA-Z0-9:_-]+`** - Alphanumeric, colon, underscore, dash
- **Matches server format** - Server generates `sessionId:timestamp:random`

```typescript
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9:_-]+$/;
const MAX_REQUEST_ID_LENGTH = 256;

if (requestId.length > MAX_REQUEST_ID_LENGTH) {
  return { success: false, error: "requestId too long" };
}
if (!REQUEST_ID_PATTERN.test(requestId)) {
  return { success: false, error: "requestId contains invalid characters" };
}
```

### Key Properties

1. **Prevents injection** - Special characters like `'`, `"`, `;`, `<`, `>` rejected
2. **Matches server format** - Server-generated IDs always pass validation
3. **Clear error messages** - Client knows exactly what's wrong

---

## ADR-0008: Synthetic ID Semantics

**Status:** Accepted (2026-02-22)

### The Problem

When clients omit command IDs, the server generates synthetic IDs (`anon:timestamp:seq`). These were being stored in the outcome cache, leading to unbounded memory growth for high-traffic scenarios where clients don't need replay semantics.

### The Solution

Only store outcomes for **explicit client-provided IDs**. Synthetic IDs are ephemeral and never stored:

```typescript
const isExplicitId = id && !id.startsWith(SYNTHETIC_ID_PREFIX);
if (isExplicitId) {
  this.replayStore.storeCommandOutcome({...});
}
```

### Key Properties

1. **Explicit IDs enable replay** - Clients must provide IDs for replay semantics
2. **Synthetic IDs are ephemeral** - Generated for tracking only, not stored
3. **Bounded memory** - Outcome storage limited to explicit IDs (max 2000 by default)
4. **Clear semantics** - Only explicit IDs can be used in `dependsOn` chains

### Protocol Implication

Clients that want replay/deduplication MUST provide explicit `id` fields:

```typescript
// Will be stored and replayable
{ "id": "my-command-1", "type": "prompt", "sessionId": "s1", "message": "hello" }

// Will NOT be stored - ephemeral
{ "type": "prompt", "sessionId": "s1", "message": "hello" }
```

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
{ type: "event", "sessionId": "s1", "event": { type: "agent_start", ... } }
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

When clients omit `id`, the server generates synthetic IDs: `anon:<timestamp>:<sequence>`

**Why timestamp + sequence?**
1. Timestamp distinguishes IDs across server restarts
2. Sequence guarantees uniqueness within a process lifetime
3. Clear() doesn't reset sequence — timestamp prevents collisions

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
| ~~Unbounded in-flight commands~~ | command-replay-store.ts | **FIXED** - bounded with rejection |
| ~~Lane tail memory leak~~ | command-execution-engine.ts | **FIXED** - correct promise comparison |
| ~~No reserved ID validation~~ | validation.ts | **FIXED** - `anon:` prefix rejected |
| ~~No store metrics~~ | All stores | **FIXED** - `getStats()` added + wired to `get_metrics` |
| ~~Session slot leak on race~~ | session-manager.ts | **FIXED** - SessionLockManager (ADR-0002) |
| ~~No WebSocket backpressure~~ | server.ts | **FIXED** - sendWithBackpressure (ADR-0003) |
| ~~Unbounded pending UI requests~~ | extension-ui.ts | **FIXED** - bounded with rejection (ADR-0004) |
| ~~No WebSocket heartbeat~~ | server.ts | **FIXED** - ping/pong with timeout (ADR-0005) |
| ~~No requestId validation~~ | validation.ts | **FIXED** - length and character validation (ADR-0006) |
| ~~No path validation for load_session~~ | validation.ts | **FIXED** - traversal detection (deep-review) |
| ~~Synthetic IDs stored in outcomes~~ | session-manager.ts | **FIXED** - only explicit IDs stored (ADR-0008) |
| ~~Pong timeout race condition~~ | server.ts | **FIXED** - `cleanedUp` flag prevents use-after-free |
| ~~SessionStore temp file collision~~ | session-store.ts | **FIXED** - PID + UUID suffix for temp files |
| ~~ReadStream leak on parse error~~ | session-store.ts | **FIXED** - try/finally ensures stream destruction |
| ~~No max session lifetime~~ | resource-governor.ts | **FIXED** - `maxSessionLifetimeMs` config + periodic enforcement |
| ~~Readline interface leak on stream error~~ | session-store.ts | **FIXED** - `rl?.close()` in finally block |
| ~~Type guards in types.ts~~ | types.ts | **FIXED** - extracted to type-guards.ts with re-exports |

---

## Deferred Items (Explicit Contracts)

| Finding | Rationale | Owner | Trigger | Deadline | Blast Radius |
|---------|-----------|-------|---------|----------|--------------|
| Connection authentication | Requires API design decision (token-based? mTLS?) + client changes | @tryingET | When multi-user deployment needed | When feature requested | Any client can connect |
| Metrics export (Prometheus) | Requires format decision + endpoint design | @tryingET | When ops team needs monitoring | When deployed to production | No observability |
| Circuit breaker for LLM | Requires per-provider tuning + fallback design | @tryingET | When latency spikes cause cascades | After production incident | Slow LLM blocks all sessions |
| Structured logging | Requires logger selection (pino? winston?) + format standard | @tryingET | When log aggregation needed | When deployed at scale | Logs not aggregatable |
| Refactor session-manager.ts | God object (700+ lines) - high risk of breaking changes | @tryingET | When adding major new feature | Before v2.0.0 | Technical debt compounds |
| BoundedMap utility | Multiple maps need same cleanup pattern | @tryingET | When third map with same pattern added | Low priority | Code duplication |
| Dependency cycle detection | Cross-lane cycles could deadlock but extremely unlikely (requires explicit IDs + simultaneous in-flight + mutual reference) | @tryingET | If deadlock observed in production | Low priority | Theoretical deadlock |
| Stdio backpressure | stdout.write can block but rare in practice | @tryingET | If server freezes on output | Low priority | Server freeze on fast events |

---

## Resource Bounds

All stores have bounded memory:

| Store | Bound | Config |
|-------|-------|--------|
| `commandInFlightById` | 10,000 entries | `maxInFlightCommands` |
| `commandOutcomes` | 2,000 entries | `maxCommandOutcomes` |
| `idempotencyCache` | TTL-based | `idempotencyTtlMs` (10 min) |
| `laneTails` | Auto-cleanup | Tasks delete on completion |
| `dependsOn` array | 32 entries | `MAX_DEPENDENCIES` in validation.ts |
| `pendingUIRequests` | 1,000 entries | `maxPendingRequests` in ExtensionUIManager |
| `sessionLocks` | Auto-cleanup | Released on operation completion |

### Validation Order (Critical)

Validation happens in this order to prevent abuse:

1. **Structural validation** — Field types, required fields, bounds (validation.ts)
2. **Replay check** — Free O(1) lookup, no rate limit charged
3. **Rate limiting** — Only for NEW executions
4. **Semantic validation** — Dependency existence, version checks (inside lane)

**Why failed commands consume rate limit:** This prevents gaming the system by sending commands that will fail (e.g., with typos in `dependsOn`). The command WAS executed — it just failed.

### Observability

Store stats are available via `get_metrics`:

```typescript
const response = await executeCommand({ type: "get_metrics" });
// response.data.stores.replay.{inFlightCount, outcomeCount, ...}
// response.data.stores.version.{sessionCount}
// response.data.stores.execution.{laneCount}
```

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
| `test-fuzz.ts` | Concurrent stress tests, race condition detection |
| `test-integration.ts` | Full server tests with real WebSocket/stdio |

### Fuzz Tests

Run fuzz tests to surface race conditions that only appear under concurrent load:

```bash
npm run test:fuzz
```

Fuzz test coverage:
- Lane serialization under stress (100+ concurrent commands)
- In-flight tracking races
- Outcome storage concurrent writes
- Fingerprint uniqueness
- Synthetic ID generation uniqueness
- Dependency chain timeout handling
- Replay semantics under concurrent access

### Running All Tests

```bash
npm test                    # 83 unit tests
npm run test:integration   # 26 integration tests
npm run test:fuzz          # 17 fuzz tests
# Module tests (141 total)
node --experimental-vm-modules dist/test-command-classification.js
node --experimental-vm-modules dist/test-session-version-store.js
node --experimental-vm-modules dist/test-command-replay-store.js
node --experimental-vm-modules dist/test-command-execution-engine.js
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

## Release Process

pi-server uses [release-please](https://github.com/googleapis/release-please) for automated versioning and [npm trusted publishing](https://docs.npmjs.com/generating-provenance-statements) for secure releases.

### Automated Release Flow

```
Push to main → release-please creates/updates release PR
Merge release PR → Creates GitHub release + tag (vX.Y.Z)
Release published → publish.yml triggers → npm publish --provenance
```

### Release Commands

```bash
# Pre-release validation
npm run release:check

# Manual publish (if needed)
npm publish --provenance --access public
```

### What `release:check` Validates

1. `package.json` has required fields (`repository`, `files`)
2. `dist/` exists with compiled files
3. Entry point has correct shebang (`#!/usr/bin/env node`)
4. `npm pack --dry-run` produces expected file list
5. `npm publish --dry-run` succeeds
6. Full CI passes (typecheck, lint, build, test)

### GitHub Workflows

| Workflow | Trigger | Purpose |
|----------|--------|---------|
| `ci.yml` | Push/PR to main | Full CI (typecheck, lint, build, test) |
| `release-please.yml` | Push to main | Creates/updates release PR |
| `publish.yml` | Release published | Publishes to npm with provenance |

### First-time Setup

1. Configure OIDC trusted publishing in npm:
   - Go to npm package settings → Trusted Publishing
   - Add GitHub repository: `tryingET/pi-server`
2. (Optional) Create `npm-publish` environment in GitHub for deployment protection

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

---

## Bug Fix Patterns (Deep Review 2026-02-22)

### Pattern: `cleanedUp` Flag for Async Callback Safety

**Problem:** Async callbacks (timers, event handlers) can fire after cleanup, causing use-after-free.

**Solution:** Add a `cleanedUp` boolean to state objects, check it at the start of every callback.

```typescript
// WRONG: Callback fires after cleanup
state.pongTimeoutTimer = setTimeout(() => {
  if (state.waitingForPong) { /* can reference freed state */ }
}, timeout);

// RIGHT: Check cleanup flag first
state.pongTimeoutTimer = setTimeout(() => {
  if (state.cleanedUp) return; // Guard against use-after-free
  if (state.waitingForPong) { /* safe */ }
}, timeout);
```

**Applied to:** WebSocket heartbeat (server.ts)

### Pattern: Unique Temp File Names

**Problem:** Constant temp file path causes collision with concurrent writes.

**Solution:** Include PID and random suffix in temp file name.

```typescript
// WRONG: Constant temp path
const tempPath = `${metadataPath}.tmp`;

// RIGHT: Unique per-write
const tempPath = `${metadataPath}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
```

**Applied to:** SessionStore.saveMetadata (session-store.ts)

### Pattern: try/finally for Resource Cleanup

**Problem:** Early return or exception skips resource cleanup.

**Solution:** Always use try/finally for cleanup, not just try/catch.

```typescript
// WRONG: Stream not destroyed on JSON.parse error
try {
  const meta = JSON.parse(firstLine);
  fileStream.destroy();
  return meta;
} catch {
  return defaultValue; // Stream leaked!
}

// RIGHT: finally always runs
try {
  const meta = JSON.parse(firstLine);
  return meta;
} catch {
  return defaultValue;
} finally {
  fileStream.destroy(); // Always runs
}
```

**Applied to:** readSessionFileMetadata (session-store.ts)

### Pattern: wouldExceedLimit() for Pre-Check

**Problem:** Returning `null` for limit reached is indistinguishable from other failures.

**Solution:** Add a pre-check method so callers can distinguish limit from other error modes.

```typescript
// Extension can now check before creating request
if (extensionUI.wouldExceedLimit()) {
  // Known: limit reached, can log appropriately
  return undefined;
}
const request = extensionUI.createPendingRequest(...);
```

**Applied to:** ExtensionUIManager (extension-ui.ts)

### Pattern: Readline Interface Cleanup Before Stream Destruction

**Problem:** If a `for await` loop over a readline interface throws, the interface is never closed, leaking resources.

**Solution:** Track the readline interface in a variable and close it in the finally block before destroying the stream.

```typescript
// WRONG: rl.close() skipped on stream error
try {
  const rl = readline.createInterface({ input: fileStream });
  for await (const line of rl) {
    // If this throws, rl.close() is never called
    break;
  }
  rl.close();
} finally {
  fileStream.destroy();
}

// RIGHT: Always close readline in finally
let rl: ReturnType<typeof readline.createInterface> | undefined;
try {
  rl = readline.createInterface({ input: fileStream });
  for await (const line of rl) {
    break;
  }
} finally {
  rl?.close();  // Safe even if rl was never created
  fileStream.destroy();
}
```

**Applied to:** readSessionFileMetadata (session-store.ts) - Deep Review 2026-02-22
