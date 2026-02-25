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
├── server.ts            (250 lines) — transports, routing, broadcast, error handling
├── session-manager.ts   (370 lines) — lifecycle, command execution, timeout, safe broadcast
├── command-router.ts    (420 lines) — session command handlers (extensible map)
├── extension-ui.ts      (230 lines) — pending UI request tracking + type guards
├── server-ui-context.ts (260 lines) — ExtensionUIContext for remote clients
├── validation.ts        (170 lines) — input validation for commands
├── types.ts             (174 lines) — protocol types
└── test.ts              (340 lines) — 22 tests

Total: ~2214 lines, 8 files
Commits: 8
Repo: https://github.com/tryingET/pi-server
```

**Completed:**
- ✅ Phase 1: Command handlers extracted to handler map
- ✅ Phase 2: Discovery commands (models, commands, skills, tools, files)
- ✅ Phase 3: Extension UI wiring via `bindExtensions`
- ✅ Phase 3.5: Validation, timeout, tests (22 passing)
- ✅ Deep Review: Broadcast safety, error handling, race condition fixes

**Working:**
- Session lifecycle (create/delete/list/switch)
- Command passthrough (prompt/steer/abort/follow_up)
- Event broadcast with sessionId
- WebSocket + stdio dual transport
- Extension UI round-trip (select, confirm, input, editor, notify)
- Input validation for all 31 session commands
- Command timeout (30s quick / 5min LLM)
- Safe broadcast (snapshot, JSON error handling, logging)

**Deferred with Contract:**
| Gap | Trigger | Blast Radius |
|-----|---------|--------------|
| Message size limit | Before production | OOM crash |
| Session limit | Before production | Memory exhaustion |
| Rate limiting | Before production | API ban / DoS |
| Heartbeat | Before production | Zombie connections |
| Graceful shutdown | Before v1.0 | Data loss |

---

## THE NEXUS INTERVENTION

**The ONE intervention for next session:**

### ResourceGovernor

A single class that enforces all resource limits. This is the nexus because:
- Prevents OOM (message size limit)
- Prevents resource exhaustion (session limit)
- Prevents abuse (rate limiting)
- Enables cleanup (zombie detection via heartbeat)
- Single place for metrics
- Makes testing trivial (mock governor)

```typescript
// src/resource-governor.ts
export class ResourceGovernor {
  private sessionCount = 0;
  private commandTimestamps = new Map<string, number[]>();

  constructor(private config: {
    maxSessions: number;           // default: 100
    maxMessageSizeBytes: number;   // default: 10 * 1024 * 1024
    maxCommandsPerMinute: number;  // default: 100
    heartbeatIntervalMs: number;   // default: 30000
  }) {}

  canCreateSession(): boolean;
  canAcceptMessage(size: number): boolean;
  canExecuteCommand(sessionId: string): boolean;
  recordHeartbeat(sessionId: string): void;
  getZombieSessions(): string[];
}
```

**Cascade Effects:**
1. Server becomes production-ready
2. DoS attacks become manageable
3. Memory usage becomes bounded
4. Observability becomes trivial (governor tracks everything)

---

## RANKED ISSUES

| Rank | Issue | Severity | Status |
|------|-------|----------|--------|
| 1 | ~~Extension UI not wired~~ | ~~CRITICAL~~ | ✅ FIXED |
| 2 | ~~No tests~~ | ~~CRITICAL~~ | ✅ FIXED (22 tests) |
| 3 | ~~No input validation~~ | ~~HIGH~~ | ✅ FIXED |
| 4 | ~~No command timeout~~ | ~~HIGH~~ | ✅ FIXED |
| 5 | ~~Set mutation during iteration~~ | ~~HIGH~~ | ✅ FIXED |
| 6 | ~~WebSocket state race~~ | ~~HIGH~~ | ✅ FIXED |
| 7 | ~~Silent message loss~~ | ~~MEDIUM~~ | ✅ FIXED |
| 8 | **No message size limit** | CRITICAL | Next |
| 9 | **No session limit** | HIGH | Next |
| 10 | **No rate limiting** | HIGH | Next |
| 11 | `(command as any).*` | MEDIUM | Pending |
| 12 | No heartbeat | MEDIUM | Deferred |
| 13 | Graceful shutdown | MEDIUM | Deferred |

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

### ANTI-PATTERNS (avoid these)

| Anti-pattern | Why It's Wrong | Fix |
|--------------|----------------|-----|
| Silent catch | Hides bugs, prevents observability | Always log |
| Non-null assertion | Timebomb that explodes when called directly | Handle undefined |
| Set iteration without snapshot | Works 99.9% of time, fails under load | Snapshot first |
| `(command as any)` | Type safety escape hatch | Typed accessor |
| WebSocket send without try/catch | State can change between check and send | Always wrap |

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
| `(command as any).*` | Pending (medium interest) |
| No message size limit | Deferred (high interest) |
| No session limit | Deferred (high interest) |
| No rate limiting | Deferred (high interest) |

---

## IMPLEMENTATION ORDER

### Phase 5: ResourceGovernor (Next)

1. Create `src/resource-governor.ts` with configurable limits
2. Wire into `server.ts` message handling (size check)
3. Wire into `session-manager.ts` (session count, rate limiting)
4. Add heartbeat tracking
5. Add tests for governor

### Phase 6: Graceful Shutdown

1. Track in-flight commands per session
2. On SIGTERM: stop accepting, drain existing
3. Timeout after 30s, force exit if needed

### Phase 7: Protocol Versioning

```json
{ "type": "server_ready", "data": { "version": "0.2.0", "protocolVersion": "1" } }
```

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

**Start here:** Phase 5 — Implement `ResourceGovernor` in `src/resource-governor.ts`.
