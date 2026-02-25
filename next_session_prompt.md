# pi-server: Next Session Prompt

**Context:** Continue pi-server development. This document captures crystallized learnings and the intervention path.

---

## TRUE INTENT

pi-server is a **session multiplexer for pi-coding-agent**. Not a competitor to Codex app-server. Not a rewrite. A thin layer that:

1. Exposes N independent AgentSessions through dual transports (WebSocket:3141 + stdio)
2. Demultiplexes inbound commands by sessionId
3. Fans out outbound events to all subscribers with sessionId prepended
4. **The protocol IS the architecture**

The server does ONE thing. Everything else is someone else's job.

---

## CURRENT STATE

```
src/
├── server.ts            (352 lines) — transports, routing, broadcast, graceful shutdown
├── session-manager.ts   (634 lines) — lifecycle, command execution, shutdown, in-flight tracking
├── command-router.ts    (453 lines) — session command handlers (extensible map)
├── extension-ui.ts      (234 lines) — pending UI request tracking + type guards
├── server-ui-context.ts (315 lines) — ExtensionUIContext for remote clients
├── validation.ts        (207 lines) — input validation for commands
├── resource-governor.ts (394 lines) — session/message/rate limits, heartbeat tracking
├── types.ts             (276 lines) — protocol types
└── test.ts              (655 lines) — 46 tests

Total: ~3520 lines, 9 files
Commits: 8
Repo: https://github.com/tryingET/pi-server
```

**Completed:**
- ✅ Phase 1: Command handlers extracted to handler map
- ✅ Phase 2: Discovery commands (models, commands, skills, tools, files)
- ✅ Phase 3: Extension UI wiring via `bindExtensions`
- ✅ Phase 3.5: Validation, timeout, tests (22 passing)
- ✅ Deep Review: Broadcast safety, error handling, race condition fixes
- ✅ Phase 5: ResourceGovernor (message size, session limit, rate limiting, heartbeat)
- ✅ Phase 5.5: Deep review fixes (atomic reservation, global rate limit, cleanup on delete)
- ✅ Phase 6: Graceful shutdown (in-flight tracking, drain, client notification)

**Working:**
- Session lifecycle (create/delete/list/switch)
- Command passthrough (prompt/steer/abort/follow_up)
- Event broadcast with sessionId
- WebSocket + stdio dual transport
- Extension UI round-trip (select, confirm, input, editor, notify)
- Input validation for all 31 session commands
- Command timeout (30s quick / 5min LLM)
- Safe broadcast (snapshot, JSON error handling, logging)
- Message size limit (10MB default)
- Session limit (100 default, atomic reservation)
- Rate limiting (100 cmd/min per session, 1000 cmd/min global)
- Heartbeat tracking for zombie detection
- Automatic cleanup on session delete
- **NEW:** Graceful shutdown with in-flight command drain
- **NEW:** Client notification on shutdown (server_shutdown event)
- **NEW:** Configurable shutdown timeout (30s default)

**Deferred with Contract:**
| Gap | Trigger | Blast Radius |
|-----|---------|--------------|
| Zombie cleanup automation | When needed | Memory leak |
| Protocol versioning | Before v1.0 | Breaking changes |

---

## THE NEXUS INTERVENTION (Next Phase)

**The ONE intervention for next session:**

### Protocol Versioning

Add a protocol version field to `server_ready` and all responses. This is the nexus because:
- Enables future backwards-compatible changes
- Allows clients to negotiate capabilities
- Makes breaking changes detectable
- Provides migration path for older clients

```typescript
// Update types.ts
export interface ServerEvent {
  type: "server_ready";
  data: { 
    version: string; 
    protocolVersion: string;
    transports: string[];
  };
}

// Add to all responses
export interface RpcResponseBase {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  error?: string;
  protocolVersion?: string; // NEW: "1.0"
}
```

**Cascade Effects:**
1. Clients can detect incompatible protocol changes
2. Server can evolve without breaking existing clients
3. Future: capability negotiation
4. Future: deprecation warnings

---

## RANKED ISSUES

| Rank | Issue | Severity | Status |
|------|-------|----------|--------|
| 1 | ~~Extension UI not wired~~ | ~~CRITICAL~~ | ✅ FIXED |
| 2 | ~~No tests~~ | ~~CRITICAL~~ | ✅ FIXED (46 tests) |
| 3 | ~~No input validation~~ | ~~HIGH~~ | ✅ FIXED |
| 4 | ~~No command timeout~~ | ~~HIGH~~ | ✅ FIXED |
| 5 | ~~Set mutation during iteration~~ | ~~HIGH~~ | ✅ FIXED |
| 6 | ~~WebSocket state race~~ | ~~HIGH~~ | ✅ FIXED |
| 7 | ~~Silent message loss~~ | ~~MEDIUM~~ | ✅ FIXED |
| 8 | ~~No message size limit~~ | ~~CRITICAL~~ | ✅ FIXED |
| 9 | ~~No session limit~~ | ~~HIGH~~ | ✅ FIXED |
| 10 | ~~No rate limiting~~ | ~~HIGH~~ | ✅ FIXED |
| 11 | ~~No graceful shutdown~~ | ~~MEDIUM~~ | ✅ FIXED |
| 12 | ~~cleanupStaleTimestamps never called~~ | ~~HIGH~~ | ✅ FIXED (auto-cleanup) |
| 13 | ~~Sessions not disposed on shutdown~~ | ~~HIGH~~ | ✅ FIXED |
| 14 | ~~process.exit not called after shutdown~~ | ~~MEDIUM~~ | ✅ FIXED |
| 15 | ~~PI_SERVER_PORT NaN crash~~ | ~~MEDIUM~~ | ✅ FIXED |
| 16 | ~~No stdin cleanup on shutdown~~ | ~~MEDIUM~~ | ✅ FIXED |
| 17 | ~~Negative/NaN message size accepted~~ | ~~MEDIUM~~ | ✅ FIXED |
| 18 | ~~sessionId shadowed in create_session~~ | ~~LOW~~ | ✅ FIXED |
| 19 | ~~stdinSubscribers dead code~~ | ~~LOW~~ | ✅ FIXED |
| 20 | ~~Magic number 30000 duplicated~~ | ~~LOW~~ | ✅ FIXED |
| 21 | `(command as any).*` | MEDIUM | Pending |
| 22 | No heartbeat cleanup automation | LOW | Deferred |
| 23 | Protocol versioning | LOW | Next |

---

## CRYSTALLIZED LEARNINGS

### PATTERNS (use these)

| Pattern | Description | Example |
|---------|-------------|---------|
| **Handler map** | `Record<string, CommandHandler>` for O(1) dispatch | `command-router.ts` |
| **Pass-through** | Session commands are thin wrappers around AgentSession | All handlers |
| **Broadcast** | Events flow: session → subscribers with sessionId | `session-manager.ts` |
| **Pending promise** | Extension UI creates promise, response resolves it | `extension-ui.ts` |
| **Snapshot iteration** | `[...collection]` before iterating mutable collections | `session-manager.ts:189` |
| **Atomic check-and-reserve** | Single method that checks AND increments (prevents races) | `tryReserveSessionSlot()` |
| **Rate limit after validation** | Invalid commands shouldn't count against limits | `executeCommand()` |
| **Global + per-session limits** | Defense in depth against multi-session abuse | `ResourceGovernor` |
| **Cleanup on delete** | Call cleanup immediately when resource is removed | `deleteSession → cleanupStaleData` |
| **In-flight tracking with Set** | Use Set for O(1) add/remove of promise references | `inFlightCommands` |
| **Shutdown notification** | Broadcast before draining so clients can prepare | `server_shutdown` event |
| **Reject-then-drain pattern** | First reject new work, then drain existing | `initiateShutdown()` |
| **Single shutdown flag** | One source of truth for shutdown state (in sessionManager) | `isInShutdown()` |
| **Idempotent shutdown** | Multiple calls to shutdown return same result | Check flag at start |
| **Promise cleanup with then/catch** | Use same handler for both resolve and reject | `promise.then(cleanup, cleanup)` |
| **Threshold-based cleanup** | Cleanup when data exceeds size instead of periodic timer | `if (length > THRESHOLD) cleanup()` |
| **disposeAllSessions** | Clean up all sessions at once during shutdown | Returns `{ disposed, failed }` |
| **Env var validation** | Check for NaN and range before using parseInt result | `if (isNaN(port) || port < 1)` |

### ANTI-PATTERNS (avoid these)

| Anti-pattern | Why It's Wrong | Fix |
|--------------|----------------|-----|
| Silent catch | Hides bugs, prevents observability | Always log |
| Non-null assertion | Timebomb that explodes when called directly | Handle undefined |
| Set iteration without snapshot | Works 99.9% of time, fails under load | Snapshot first |
| `(command as any)` | Type safety escape hatch | Typed accessor |
| WebSocket send without try/catch | State can change between check and send | Always wrap |
| Check-then-act without atomicity | Race window between check and action | Atomic check-and-reserve |
| Rate limit before validation | Invalid commands exhaust quota | Validate first, rate limit after |
| Cleanup method never called | Memory leak hiding in plain sight | Call on delete, or periodic timer |
| Per-session rate limit only | Attacker creates N sessions, gets N×limit | Add global rate limit |
| Accepting commands during shutdown | New work during drain extends shutdown time | Check shutdown flag first |
| Not notifying clients of shutdown | Clients don't know to reconnect elsewhere | Broadcast `server_shutdown` |
| Promise tracking with array | O(n) removal, memory leak if promise never settles | Use `Set<Promise>` |
| **Double shutdown flags** | Two `isShuttingDown` flags can diverge | Single source of truth |
| **Unsafe Promise<T> to Promise<void> cast** | Loses type info, can cause subtle bugs | Use `Promise<unknown>` or generics |
| **Promise self-reference in then chain** | Complex promise graph can cause leaks | Add to Set first, then cleanup on settle |
| **Log message arithmetic errors** | `drained + remaining` != `original` if counting wrong | Track original snapshot separately |
| **Methods that exist but never called** | Dead code hiding in plain sight, often cleanup | Call from related operation or add threshold |
| **Sessions not disposed on shutdown** | AgentSession holds file handles, timers | Call disposeAllSessions in stop() |
| **stdin not closed on shutdown** | Readline keeps event loop alive | Store reference and close in stop() |
| **Unvalidated env vars** | parseInt("abc") → NaN → port crash | Validate isNaN and range |
| **Negative size accepted** | `canAcceptMessage(-1)` returns true | Check `!Number.isFinite() || size < 0` |

### HEURISTICS (rules of thumb)

1. **Snapshot before iteration** — Never iterate a mutable collection directly
2. **Log every catch** — Silent catches are lies we tell ourselves
3. **Type everything** — `as any` is technical debt with interest
4. **Limit everything** — No limits = DoS vector
5. **Timeout everything async** — No timeout = hang
6. **If pi has it, expose it** — Don't reimplement, pass through
7. **Server should be thin** — AgentSession does the work

### SURPRISES (non-obvious findings)

1. **`extension_ui_request` is NOT an AgentSessionEvent** — comes through ExtensionUIContext
2. **Session creation is slow** — loads extensions, skills, prompts (seconds)
3. **`bindExtensions` is required** — extension UI hangs without it
4. **`modelRegistry.getModel()` is internal** — use `find()` instead
5. **WebSocket state is inherently racy** — always wrap send in try/catch
6. **Check-then-register race** — concurrent creates at limit can exceed limit; fix with atomic reserve
7. **Per-session rate limit is insufficient** — multi-session attack bypasses; need global limit too
8. **cleanupStaleData doesn't call itself** — methods that exist but are never called are hidden bugs
9. **Shutdown must reject new work BEFORE draining** — otherwise drain never completes
10. **Promise self-removal from Set** — promise removes itself from tracking Set on settle, avoids leaks
11. **Double shutdown flags are a bug** — two classes tracking same state can diverge; use single source of truth
12. **wss.close() doesn't close existing connections** — only stops new connections; must iterate and close clients separately
13. **Idempotent shutdown is essential** — orchestrators may send multiple SIGTERM; shutdown must handle this gracefully
14. **Threshold-based auto-cleanup** — instead of periodic timer, cleanup when data exceeds threshold
15. **Dispose sessions on shutdown** — otherwise AgentSession resources leak
16. **Validate env vars before use** — parseInt can return NaN, must validate port range
17. **Close stdin during shutdown** — otherwise readline keeps process alive
18. **Number.isFinite() for size validation** — catches NaN, Infinity, -Infinity in one check

### CAVEATS (doesn't generalize)

1. Extension UI requires `bindExtensions` with custom UIContext
2. Some pi features require TUI (themes can't be remote)
3. Multiple clients, one UI response — only one should respond
4. Session file paths are platform-specific
5. pi API is not versioned — internal usage risks breakage

---

## DEBT INVENTORY

| Debt | Status |
|------|--------|
| Handler map | ✅ PAID |
| Extension UI wiring | ✅ PAID |
| No tests | ✅ PAID |
| No validation | ✅ PAID |
| No timeout | ✅ PAID |
| Silent broadcast failures | ✅ PAID |
| Set mutation during iteration | ✅ PAID |
| WebSocket state race | ✅ PAID |
| Non-null assertion | ✅ PAID |
| Double-dispose race | ✅ PAID |
| No message size limit | ✅ PAID |
| No session limit | ✅ PAID |
| No rate limiting | ✅ PAID |
| No graceful shutdown | ✅ PAID |
| cleanupStaleTimestamps never called | ✅ PAID |
| Sessions not disposed on shutdown | ✅ PAID |
| PI_SERVER_PORT NaN crash | ✅ PAID |
| Negative/NaN message size accepted | ✅ PAID |
| stdinSubscribers dead code | ✅ PAID |
| sessionId shadowed | ✅ PAID |
| Magic number duplication | ✅ PAID |
| `(command as any).*` | Pending (medium interest) |
| Protocol versioning | Pending (low interest) |

---

## IMPLEMENTATION ORDER

### Phase 5: ResourceGovernor ✅ COMPLETE

- ✅ Created `src/resource-governor.ts` with configurable limits
- ✅ Wired into `server.ts` message handling (size check)
- ✅ Wired into `session-manager.ts` (session count, rate limiting)
- ✅ Added heartbeat tracking
- ✅ Added 12 governor tests + 1 integration test

### Phase 5.5: Deep Review Fixes ✅ COMPLETE

- ✅ Atomic session reservation (`tryReserveSessionSlot`)
- ✅ Global rate limiting (prevents multi-session abuse)
- ✅ Rate limit after validation (invalid commands don't count)
- ✅ Cleanup on session delete

### Phase 6: Graceful Shutdown ✅ COMPLETE

- ✅ Track in-flight commands with `Set<Promise>`
- ✅ On SIGTERM: stop accepting, drain existing, broadcast notification
- ✅ Configurable timeout (30s default)
- ✅ Client notification via `server_shutdown` event
- ✅ 3 shutdown tests

### Phase 7: Protocol Versioning (Next)

```json
{ "type": "server_ready", "data": { "version": "0.2.0", "protocolVersion": "1" } }
```

Add protocol version to enable future backwards-compatible changes.

---

## USAGE GUIDE

**Run tests:**
```bash
npm test
```

**Start server:**
```bash
node dist/server.js
# WebSocket: ws://localhost:3141
# Stdio: JSON lines on stdin/stdout
```

**Debug:**
```bash
# Pretty output
node dist/server.js 2>&1 | jq .

# Quick test
echo '{"type":"create_session","sessionId":"t"}' | timeout 5 node dist/server.js | jq .
```

**Add a command:**
1. Add type to `types.ts` → `SessionCommand`
2. Add response type → `SessionResponse`
3. Add handler to `command-router.ts`
4. Add to `sessionCommandHandlers` map
5. Add validation to `validation.ts`
6. Add test

---

## REFERENCE

- pi-coding-agent: `~/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/`
- pi AgentSession: `dist/core/agent-session.d.ts`
- pi ExtensionUIContext: `dist/core/extensions/types.d.ts`
- pi ModelRegistry: `dist/core/model-registry.d.ts`

---

**Start here:** Phase 7 — Add protocol versioning to `server_ready` and responses.
