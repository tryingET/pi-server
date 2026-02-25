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
├── server.ts            (208 lines) — transports, routing, broadcast
├── session-manager.ts   (320 lines) — lifecycle, command execution, subscribers
├── command-router.ts    (399 lines) — session command handlers (extensible map)
├── extension-ui.ts      (220 lines) — pending UI request tracking + type guards
├── server-ui-context.ts (250 lines) — ExtensionUIContext implementation for remote clients
└── types.ts             (174 lines) — protocol types

Total: ~1570 lines, 6 files
Commits: 4 (seed → implementation → docs → credits)
Repo: https://github.com/tryingET/pi-server
```

**Completed This Session:**
- ✅ Phase 1.1: Extract command handlers to map (`command-router.ts`)
- ✅ Phase 1.2: Separate concerns (ExtensionUIManager)
- ✅ Phase 2: Discovery commands (get_available_models, get_commands, get_skills, get_tools, list_session_files)
- ✅ Phase 3: Extension UI wiring via `bindExtensions` with `createServerUIContext()`

**Working:**
- create/delete/list sessions
- prompt/steer/abort passthrough
- event broadcast with sessionId
- WebSocket + stdio transports
- Session persistence (handled by AgentSession internally)
- Discovery commands: models, commands, skills, tools, session files
- Handler map for 31 session commands
- **Extension UI round-trip** (select, confirm, input, editor, notify, setStatus, setWidget, setTitle)

**Broken/Incomplete:**
- ❌ No tests
- ❌ No input validation
- ❌ No command timeout
- ❌ No observability/logging

---

## THE NEXUS INTERVENTION

**The ONE intervention that unlocks everything else:**

### Wire Extension UI via bindExtensions

Current state: Sessions created without custom UI context → extension UI requests fire into void → extensions hang

Required state:
```typescript
// In session-manager.ts createSession():
const { session } = await createAgentSession({ cwd });

// THIS IS MISSING:
await session.bindExtensions({
  uiContext: createServerUIContext(sessionId, this.extensionUI, this.broadcast)
});
```

**Why this is the nexus:**
- Unlocks all extension UI: select, confirm, input, editor, interview, notify, setStatus, setWidget, setTitle
- Skills with user input work
- Prompt templates with variables work
- Custom tools that need confirmation work
- Makes the server a true conversation, not a one-way pipe
- Makes ExtensionUIManager useful (currently dead code)

**Implementation:**
```typescript
// Create UI context factory
function createServerUIContext(
  sessionId: string,
  extensionUI: ExtensionUIManager,
  broadcast: (sessionId: string, event: any) => void
): ExtensionUIContext {
  return {
    async select(title, options, opts) {
      const { requestId, promise } = extensionUI.createPendingRequest(sessionId, "select", { title, options, timeout: opts?.timeout });
      extensionUI.broadcastUIRequest(sessionId, requestId, "select", { title, options });
      const response = await promise;
      return response.method === "cancelled" ? undefined : response.value;
    },
    // ... confirm, input, editor, etc.
  };
}
```

**Cascade Effects:**
1. Extension UI works end-to-end
2. Clients can build interactive UIs
3. Complex workflows (multi-step confirmations) become possible
4. pi-server becomes a true remote control for pi

---

## RANKED ISSUES (from Deep Review)

| Rank | Issue | Severity | Status |
|------|-------|----------|--------|
| 1 | **Extension UI not wired** | ~~CRITICAL~~ | ✅ FIXED (Phase 3) |
| 2 | **No tests** | CRITICAL | Pending |
| 3 | **`set_model` uses internal API** | HIGH | Pending |
| 4 | **No input validation** | HIGH | Pending |
| 5 | **No command timeout** | HIGH | Pending |
| 6 | **`(command as any).sessionId`** | MEDIUM | Pending |
| 7 | **No observability** | HIGH | Pending |
| 8 | **Silent message loss** | MEDIUM | Pending |
| 9 | **No session limit** | MEDIUM | Pending |
| 10 | **Windows path handling** | LOW | Pending |

---

## BUGS FOUND (Deep Review)

### Active Bugs

| Bug | File:Line | Repro |
|-----|-----------|-------|
| `set_model` uses internal API | `command-router.ts:67-72` | Call with invalid provider/model → crash or undefined behavior |
| `handleGetState` non-null assertion | `command-router.ts:48` | Call handler directly (not via executeCommand) → crash |
| Windows path handling | `command-router.ts:175` | `file.path.split('/').pop()` fails on Windows |
| No command.id validation | Everywhere | Send command without `id` → client can't correlate |

### Silent Failures

| Bug | Location | Consequence |
|-----|----------|-------------|
| Subscriber send failures swallowed | `session-manager.ts:147-150` | Message lost, no logging |
| WebSocket state race | `server.ts:72-75` | State changes between check and send |

### Missing Safety

| Missing | Consequence |
|---------|-------------|
| No maximum session count | Memory exhaustion |
| No message size limit | OOM on large JSON |
| No rate limiting | DoS vector |
| No request timeout on session commands | Hung LLM API = hung server |
| No heartbeat | Zombie connections |
| No graceful session drain | In-flight requests die on shutdown |

---

## PATTERNS (use these)

| Pattern | Description | Example |
|---------|-------------|---------|
| **Handler map** | `Record<string, CommandHandler>` for O(1) dispatch | `command-router.ts:228-258` |
| **Pass-through** | Session commands thin wrappers around AgentSession | All handlers in command-router |
| **Broadcast** | Events flow: session → subscribers with sessionId | `session-manager.ts:141-155` |
| **Correlation** | Request id matches response id | All responses include `id` |
| **Pending promise** | Extension UI requests create promises, responses resolve them | `extension-ui.ts:67-85` |

---

## ANTI-PATTERNS (avoid these)

| Anti-pattern | Location | Fix |
|--------------|----------|-----|
| `(command as any).sessionId` | session-manager.ts:193, 247 | Create typed accessor |
| `(session.modelRegistry as any).getModel()` | command-router.ts:68 | Use public API |
| Silent catch in broadcast | session-manager.ts:149, 159 | Log failures |
| Server knows switch_session semantics | server.ts:105-109 | Move to session-manager |

---

## SURPRISES (non-obvious findings)

1. **`extension_ui_request` is NOT an AgentSessionEvent** — comes through ExtensionUIContext, not event stream
2. **Session creation is async and slow** — loads extensions, skills, prompts; takes seconds
3. **`bindExtensions` required for extension UI** — without it, extensions hang
4. **pi's RPC already has extension UI** — but requires custom UIContext to be provided
5. **`modelRegistry.getModel()` is internal API** — will break on pi changes

---

## HEURISTICS (rules of thumb)

1. **If pi has it, expose it** — don't reimplement, just pass through
2. **Server should be thin** — AgentSession does the work
3. **Protocol = types.ts** — everything else is implementation
4. **Extension UI requires round-trip** — not just broadcast, must await response
5. **No auth in server** — pi handles via ModelRegistry
6. **Test everything** — no tests = no confidence

---

## CAVEATS (doesn't generalize)

1. **Extension UI requires bindExtensions** — not automatic, must provide UIContext
2. **Some pi features require TUI** — themes can't be exposed remotely
3. **Multiple clients, one response** — only one should respond to UI request
4. **Session file paths are platform-specific** — returns absolute paths
5. **pi API is not versioned** — internal API usage risks breakage

---

## DEBT INVENTORY

| Debt | Interest | Status |
|------|----------|--------|
| Handler map | ✅ PAID | Phase 1.1 complete |
| ExtensionUIManager skeleton | ✅ PAID | Phase 1.2 complete |
| Discovery commands | ✅ PAID | Phase 2 complete |
| Extension UI wiring | ✅ PAID | Phase 3 complete (server-ui-context.ts) |
| `(command as any).sessionId` | Medium touch | Pending |
| `set_model` internal API | High risk | Pending |
| No tests | Blocks confidence | Pending |
| No validation | Security risk | Pending |

---

## GAPS TO CLOSE

| Gap | Priority | Status |
|-----|----------|--------|
| ~~Extension UI wiring~~ | ~~CRITICAL~~ | ✅ COMPLETE |
| Tests | CRITICAL | Next up |
| Input validation | HIGH | Security |
| Command timeout | HIGH | Reliability |
| Observability | HIGH | Debugging |
| Session limit | MEDIUM | Resource safety |

---

## IMPLEMENTATION ORDER (Next Session)

### Phase 3.5: Critical Fixes

1. Add basic test harness
2. Fix `set_model` to use public API
3. Add input validation layer
4. Add command timeout wrapper

### Phase 4: Protocol Versioning

Add to server_ready event:
```json
{ "type": "server_ready", "data": { "version": "0.1.0", "protocolVersion": "1", "transports": [...] } }
```

### Phase 5: Observability

1. Add structured logging
2. Log failed sends
3. Add session metrics

---

## USAGE GUIDE

**To add a new command:**

1. Add type to `types.ts` in `SessionCommand` union
2. Add response type to `SessionResponse` union
3. Add handler function to `command-router.ts`
4. Add to `sessionCommandHandlers` map
5. Test: `echo '{"type":"your_command","sessionId":"x",...}' | node dist/server.js`

**To debug:**

```bash
# Stdio with pretty output
node dist/server.js 2>&1 | jq .

# WebSocket with wscat
wscat -c ws://localhost:3141

# Test discovery commands
echo '{"type":"create_session","sessionId":"t"}' > /tmp/cmds.jsonl
echo '{"sessionId":"t","type":"get_available_models"}' >> /tmp/cmds.jsonl
echo '{"sessionId":"t","type":"get_commands"}' >> /tmp/cmds.jsonl
cat /tmp/cmds.jsonl | timeout 10 node dist/server.js | jq .
```

**Rollback:**
```bash
# Full rollback to last commit:
git checkout -- .
git clean -fd
```

---

## REFERENCE

- pi-coding-agent: `~/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/`
- pi RPC types: `dist/modes/rpc/rpc-types.d.ts`
- pi AgentSession: `dist/core/agent-session.d.ts`
- pi ExtensionUIContext: `dist/core/extensions/types.d.ts`
- SEED.md: `/home/tryinget/programming/pi-server/SEED.md`
- AGENTS.md: `/home/tryinget/programming/pi-server/AGENTS.md`

---

**Start here:** Phase 3.5 — Add tests, fix `set_model`, add validation and timeout wrappers.
