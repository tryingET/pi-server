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
├── server.ts            (8.8kb) — transports, connection limits, graceful shutdown
├── session-manager.ts   (15.6kb) — lifecycle, validation, metrics, shutdown
├── command-router.ts    (10.4kb) — session command handlers (extensible map)
├── resource-governor.ts (12.7kb) — all limits, validation, health, metrics
├── extension-ui.ts      (4.0kb) — pending UI request tracking + type guards
├── server-ui-context.ts (5.8kb) — ExtensionUIContext for remote clients
├── validation.ts        (5.1kb) — input validation for commands
├── types.ts             (8.5kb) — protocol types + accessors
├── test.ts              (25.3kb) — 52 unit tests
└── test-integration.ts  (17.5kb) — 16 integration tests

Total: ~4100 lines, 10 files
Commits: 19
Repo: https://github.com/tryingET/pi-server
```

**Completed:**
- ✅ Phase 1: Command handlers extracted to handler map
- ✅ Phase 2: Discovery commands (models, commands, skills, tools, files)
- ✅ Phase 3: Extension UI wiring via `bindExtensions`
- ✅ Phase 3.5: Validation, timeout, tests
- ✅ Phase 5: ResourceGovernor (message size, session limit, rate limiting)
- ✅ Phase 5.5: Deep review fixes (atomic reservation, global rate limit)
- ✅ Phase 6: Graceful shutdown (in-flight tracking, drain, client notification)
- ✅ Phase 6.5: Security hardening (session ID validation, CWD validation, connection limits)
- ✅ Phase 7: Protocol versioning (serverVersion + protocolVersion in server_ready)
- ✅ Phase 8: Integration tests (16 WebSocket protocol tests)

**Working:**
- Session lifecycle (create/delete/list/switch)
- Command passthrough (prompt/steer/abort/follow_up)
- Event broadcast with sessionId
- WebSocket + stdio dual transport
- Extension UI round-trip
- Input validation for all commands
- Command timeout (30s quick / 5min LLM)
- Message size limit (10MB default)
- Session limit (100 default, atomic reservation)
- Rate limiting (100 cmd/min per session, 1000 cmd/min global)
- Connection limit (1000 default)
- Graceful shutdown with drain
- Session ID validation (alphanumeric, dash, underscore, dot)
- CWD validation (blocks path traversal)
- Health check + metrics commands
- Protocol versioning (clients can detect incompatibility)

---

## REMAINING ISSUES

| Rank | Issue | Severity | Notes |
|------|-------|----------|-------|
| 1 | No biome rule for redundant dynamic imports | LOW | Found `await import()` when static import exists |

---

## OPEN QUESTIONS

### 1. Import discipline: static vs dynamic

Found in test.ts:
```typescript
// At top of file:
import { ResourceGovernor, DEFAULT_CONFIG } from "./resource-governor.js";

// Later, inside ONE test function:
const { ResourceGovernor } = await import("./resource-governor.js"); // WRONG
```

**The real question:** Why was it imported at the top if it should be imported inside a function?

**Answer:** It SHOULD be imported at the top. The static import is used by 20+ tests. The dynamic import was accidental cruft (debugging leftover or copy-paste).

**Rule:**
- Static import = module is a file-level dependency
- Dynamic import = module is conditionally/optionally needed
- **Both for same module = one is wrong**

In this case: static was correct, dynamic was dead code.

---

## PATTERNS (use these)

| Pattern | Description | Example |
|---------|-------------|---------|
| **Handler map** | `Record<string, CommandHandler>` for O(1) dispatch | `command-router.ts` |
| **Pass-through** | Session commands are thin wrappers around AgentSession | All handlers |
| **Broadcast** | Events flow: session → subscribers with sessionId | `session-manager.ts` |
| **Pending promise** | Extension UI creates promise, response resolves it | `extension-ui.ts` |
| **Snapshot iteration** | `[...collection]` before iterating mutable collections | `session-manager.ts` |
| **Atomic check-and-reserve** | Single method that checks AND increments | `tryReserveSessionSlot()` |
| **Rate limit after validation** | Invalid commands shouldn't count against limits | `executeCommand()` |
| **Global + per-session limits** | Defense in depth against multi-session abuse | `ResourceGovernor` |
| **Single shutdown flag** | One source of truth for shutdown state | `isInShutdown()` |
| **Threshold-based cleanup** | Cleanup when data exceeds size instead of timer | `if (length > THRESHOLD)` |
| **Validate all inputs** | Session IDs, CWD paths, message sizes | `validateSessionId()` |
| **Typed accessors** | Eliminate `as any` with type-safe property access | `getSessionId()`, `isCreateSessionResponse()` |
| **Protocol versioning** | Separate software version from wire format | `serverVersion` vs `protocolVersion` |
| **Track errors, don't mask** | Count negative-count errors instead of silent reset | `doubleUnregisterErrors` |
| **Subscribe after success** | Subscribe to session only after command succeeds | `switch_session` handler |
| **Server ready on connect** | Send server_ready to each new WebSocket connection | `setupWebSocket()` |
| **Test isolation via withFreshServer** | Each test suite gets fresh server instance | `test-integration.ts` |
| **Safe port allocation via get-port** | Avoid port collisions in tests | `test-integration.ts` |
| **Event-based server readiness** | Wait for actual connection, not sleep | `waitForServerReady()` |

---

## ANTI-PATTERNS (avoid these)

| Anti-pattern | Why It's Wrong | Fix |
|--------------|----------------|-----|
| Silent catch | Hides bugs, prevents observability | Always log |
| Set iteration without snapshot | Works 99.9% of time, fails under load | Snapshot first |
| `(command as any)` | Type safety escape hatch | Typed accessor functions |
| WebSocket send without try/catch | State can change between check and send | Always wrap |
| Check-then-act without atomicity | Race window between check and action | Atomic check-and-reserve |
| Rate limit before validation | Invalid commands exhaust quota | Validate first |
| Methods that exist but never called | Dead code hiding in plain sight | Call from related operation |
| **Redundant dynamic import** | `await import()` when static import exists | Use static import |
| **Defensive Math.max(0, ...)** | Masks bugs (double-unregister) | Track error metric, then reset |
| **No input validation** | Path traversal, injection attacks | Validate session IDs, CWD |

---

## SURPRISES (non-obvious findings)

1. **`extension_ui_request` is NOT an AgentSessionEvent** — comes through ExtensionUIContext
2. **Session creation is slow** — loads extensions, skills, prompts (seconds)
3. **`bindExtensions` is required** — extension UI hangs without it
4. **WebSocket state is inherently racy** — always wrap send in try/catch
5. **wss.close() doesn't close existing connections** — must iterate and close clients
6. **Idempotent shutdown is essential** — orchestrators may send multiple SIGTERM
7. **Threshold-based auto-cleanup** — better than periodic timers
8. **Number.isFinite() for size validation** — catches NaN, Infinity, -Infinity
9. **Subscribe before success = zombie subscription** — only subscribe after command succeeds
10. **Zombie detection ≠ zombie cleanup** — must explicitly call `cleanupZombieSessions()`
11. **server_ready must be sent per-connection** — new clients need version info, not just startup broadcast

---

## DEBT INVENTORY

| Debt | Status |
|------|--------|
| Handler map | ✅ PAID |
| Extension UI wiring | ✅ PAID |
| No tests | ✅ PAID (52 tests) |
| No validation | ✅ PAID |
| No timeout | ✅ PAID |
| No message size limit | ✅ PAID |
| No session limit | ✅ PAID |
| No rate limiting | ✅ PAID |
| No graceful shutdown | ✅ PAID |
| No connection limit | ✅ PAID |
| No session ID validation | ✅ PAID |
| No CWD validation | ✅ PAID |
| No health check | ✅ PAID |
| No metrics command | ✅ PAID |
| Redundant dynamic import | ✅ PAID |
| `(command as any).*` typed accessors | ✅ PAID |
| Protocol versioning | ✅ PAID |

---

## NEXT STEPS

**All planned phases complete.** pi-server is feature-complete for its stated purpose.

Optional future enhancements:
1. Add biome rule for redundant dynamic imports
2. Add integration tests for WebSocket transport
3. Add client library for common languages

---

## USAGE GUIDE

**Run tests:**
```bash
npm test                    # 52 unit tests
npm run test:integration    # 16 integration tests (WebSocket protocol)
```

**Start server:**
```bash
node dist/server.js
# WebSocket: ws://localhost:3141
# Stdio: JSON lines on stdin/stdout
```

**Add a command:**
1. Add type to `types.ts` → `SessionCommand`
2. Add response type → `SessionResponse`
3. Add handler to `command-router.ts`
4. Add to `sessionCommandHandlers` map
5. Add validation to `validation.ts`
6. Add test to `test.ts` + `test-integration.ts`

---

**Status:** Feature-complete. All debt paid. Ready for production use.

The protocol versioning enables clients to detect incompatibility:
```typescript
// server_ready event now includes:
{
  type: "server_ready",
  data: {
    serverVersion: "0.1.0",      // Software version
    protocolVersion: "1.0.0",    // Wire protocol version
    transports: ["websocket", "stdio"]
  }
}
```

Clients should check `protocolVersion` before sending commands.
