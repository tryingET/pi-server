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
├── server.ts         (208 lines) — transports, routing, broadcast
├── session-manager.ts (440 lines) — lifecycle, command execution, subscribers
└── types.ts          (157 lines) — protocol types

Total: 805 lines, 3 files
Commits: 4 (seed → implementation → docs → credits)
Repo: https://github.com/tryingET/pi-server
```

**Working:**
- create/delete/list sessions
- prompt/steer/abort passthrough
- event broadcast with sessionId
- WebSocket + stdio transports
- Session persistence (handled by AgentSession internally)

**Broken/Incomplete:**
- Missing discovery commands (models, skills, commands, session files)
- Extension UI events fire but no response path (extensions hang)
- set_model crashes (wrong API usage)
- Protocol drift from pi's RpcCommand

---

## THE NEXUS INTERVENTION

**The ONE intervention that unlocks everything else:**

### Extension UI Round-Trip

Current state: Extension fires `extension_ui_request` event → client receives it → client cannot respond → extension hangs forever

Required state:
```
1. Server emits: { type: "event", sessionId, event: { type: "extension_ui_request", id, method, ... } }
2. Client sends: { type: "extension_ui_response", sessionId, id, value/confirmed/cancelled }
3. Server routes response to waiting extension → extension continues
```

**Why this is the nexus:**
- Unlocks all extension UI: select, confirm, input, editor, notify, setStatus, setWidget, setTitle
- Skills with user input work
- Prompt templates with variables work
- Custom tools that need confirmation work
- Makes the server a true conversation, not a one-way pipe

**Implementation:**
```typescript
// In session-manager.ts or new extension-ui.ts
private pendingUIRequests = new Map<string, {
  sessionId: string;
  resolve: (response: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

// When extension_ui_request event fires:
// 1. Generate unique requestId
// 2. Store promise callbacks in map
// 3. Broadcast event to subscribers
// 4. Await promise (with timeout)

// When extension_ui_response command arrives:
// 1. Look up pending request by id
// 2. Resolve/reject the promise
// 3. Extension continues
```

---

## IMPLEMENTATION ORDER

### Phase 1: Refactor (enables extension)

**1.1 Extract command handlers to map**
```typescript
// command-router.ts
type CommandHandler = (session: AgentSession, command: RpcCommand) => Promise<RpcResponse>;

const handlers: Record<string, CommandHandler> = {
  "prompt": handlePrompt,
  "steer": handleSteer,
  "abort": handleAbort,
  // ... all 30+ commands
};

export async function routeCommand(session: AgentSession, command: RpcCommand): Promise<RpcResponse> {
  const handler = handlers[command.type];
  if (!handler) {
    return { id: command.id, type: "response", command: command.type, success: false, error: `Unknown command: ${command.type}` };
  }
  return handler(session, command);
}
```

**Why:** Enables adding commands without touching giant switch. Each handler testable in isolation.

**1.2 Separate concerns**
- SessionManager: lifecycle + broadcast only
- CommandRouter: command dispatch
- ExtensionUI: pending request tracking
- Server: transports only

### Phase 2: Discovery Commands (expose what pi knows)

Add to types.ts:
```typescript
| { id?: string; sessionId: string; type: "get_available_models" }
| { id?: string; sessionId: string; type: "get_commands" }
| { id?: string; sessionId: string; type: "get_skills" }
| { id?: string; type: "list_session_files"; cwd?: string }
| { id?: string; sessionId: string; type: "get_tools" }
```

Implementation calls existing AgentSession/SessionManager methods:
- `session.modelRegistry.getAvailableModels()`
- `session.resourceLoader.skills`
- `session.resourceLoader.promptTemplates`
- `SessionManager.list(cwd)`

### Phase 3: Extension UI Round-Trip

Add to types.ts:
```typescript
// Command (client → server)
| { id?: string; sessionId: string; type: "extension_ui_response"; requestId: string; response: ExtensionUIResponse }

// Response variants
type ExtensionUIResponse =
  | { method: "select"; value: string }
  | { method: "confirm"; confirmed: boolean }
  | { method: "input"; value: string }
  | { method: "editor"; value: string }
  | { method: "cancelled" };
```

Implementation in extension-ui.ts:
- Track pending requests per session
- Wire event emission to promise creation
- Wire response command to promise resolution
- Handle timeouts (default 60s, configurable)

### Phase 4: Protocol Versioning

Add to server_ready event:
```json
{ "type": "server_ready", "data": { "version": "0.1.0", "protocolVersion": "1", "transports": [...] } }
```

Enables clients to detect incompatible protocol changes.

---

## PATTERNS (use these)

| Pattern | Description |
|---------|-------------|
| **Pass-through** | Session commands are thin wrappers around AgentSession methods — don't reinvent |
| **Broadcast** | Events flow one direction: session → all subscribers with matching sessionId |
| **Correlation** | Request id matches response id — always |
| **Handler map** | Extensible command dispatch without switch statement sprawl |
| **Pending promise** | Extension UI requests create promises, responses resolve them |

---

## ANTI-PATTERNS (avoid these)

| Anti-pattern | Why bad | Fix |
|--------------|---------|-----|
| Giant switch | Hard to extend, hard to test | Handler map |
| Mixed concerns | SessionManager does lifecycle + commands + subscribers | Separate classes |
| Type casting | `(command as any).sessionId` loses safety | Discriminated unions |
| Dual broadcast | Server AND SessionManager both broadcast lifecycle events | Single source of truth |
| Protocol drift | Our types.ts diverges from pi's RpcCommand | Extend, don't duplicate |

---

## SURPRISES (non-obvious findings)

1. **pi's RPC already has `extension_ui_request` events** — but no response mechanism in our server
2. **AgentSession handles persistence** — server doesn't need to, JSONL is automatic
3. **Session creation is async and slow** — loads extensions, skills, prompts; can take seconds
4. **set_model crashes** — we call `session.modelRegistry.getModel()` but that's not the public API
5. **Codex has approvals, pi doesn't** — different model, don't copy Codex blindly

---

## HEURISTICS (rules of thumb)

1. **If pi has it, expose it** — don't reimplement, just pass through
2. **Server should be thin** — AgentSession does the work
3. **Protocol = types.ts** — everything else is implementation detail
4. **One switch is the ONLY switch** — SEED.md invariant, refactor to handler map preserves this
5. **No auth in server** — pi handles via ModelRegistry, not server's job
6. **No approvals** — pi doesn't have them, unlike Codex

---

## CAVEATS (doesn't generalize)

1. **Extension UI requires round-trip** — not just broadcast, must await response
2. **Some pi features require TUI** — themes can't be exposed remotely meaningfully
3. **Dynamic tools would need client execution** — LLM calls tool, client runs code, returns result (future)
4. **Multiple clients, one response** — if two clients subscribe to same session, only one should respond to UI request
5. **Session file paths are platform-specific** — list_session_files returns absolute paths

---

## BUGS TO FIX

| Bug | Location | Fix |
|-----|----------|-----|
| set_model crashes | session-manager.ts L~250 | Use `session.modelRegistry` properly or get model from provider |
| get_context_usage wrong shape | types.ts L~75 | Shape is `{ tokens, contextWindow, percent }` not `{ used, total, percentage }` |
| Missing commands | types.ts | Add discovery commands from Phase 2 |
| Extension UI dead-end | session-manager.ts | Add Phase 3 round-trip |

---

## DEBT TO PAY

| Debt | Interest | Pay by |
|------|----------|--------|
| Giant switch | Hard to add commands | Phase 1.1 handler map |
| Protocol drift | Diverges from pi | Extend pi's RpcCommand types |
| Mixed concerns | SessionManager too big | Phase 1.2 separation |
| Hardcoded version | Must update two places | Read from package.json |

---

## GAPS TO CLOSE

| Gap | Priority | Phase |
|-----|----------|-------|
| Extension UI response | Critical | 3 |
| Discovery commands | High | 2 |
| Session file listing | High | 2 |
| Protocol versioning | Medium | 4 |
| Error recovery | Low | Future |
| Connection lifecycle events | Low | Future |

---

## WHAT WAS REMOVED (from consideration)

| Removed | Why |
|---------|-----|
| Auth | pi handles via ModelRegistry |
| Approvals | pi doesn't have them |
| Metrics | Observability is external |
| Health checks | Orchestration concern |
| TLS | Proxy concern |
| Clustering | Requires session affinity, future |
| HTTP transport | Two transports is complete |
| Themes | TUI concern, not server |

---

## RESIDUAL LIMITATIONS

1. **No clustering** — single process, all sessions in memory
2. **No persistence of subscriber state** — reconnect loses subscriptions
3. **No message buffering** — events are fire-and-forget
4. **No flow control** — fast producer, slow consumer = problems
5. **No request timeout** — hung commands hang forever (except extension UI)

These are acceptable per SEED.md non-goals. Add only if real need arises.

---

## USAGE GUIDE

**To add a new command:**

1. Add type to `types.ts` in `SessionCommand` union
2. Add response type to `SessionResponse` union
3. Add handler to `command-router.ts` handlers map
4. Handler calls `session.someMethod()` and returns response
5. Test via: `echo '{"type":"your_command","sessionId":"x",...}' | node dist/server.js`

**To add extension UI method:**

1. Add method to `ExtensionUIRequest` in types.ts
2. Add response variant to `ExtensionUIResponse`
3. Wire in extension-ui.ts (promise creation on event, resolution on response)

**To debug:**

```bash
# Stdio with pretty output
node dist/server.js 2>&1 | jq .

# WebSocket with wscat
wscat -c ws://localhost:3141

# Check protocol
echo '{"type":"list_sessions"}' | node dist/server.js | jq .
```

---

## EVOLUTION NOTES

**Short-term (this session):**
- Phase 1: Refactor to handler map
- Phase 2: Add discovery commands
- Phase 3: Add extension UI round-trip

**Medium-term:**
- Phase 4: Protocol versioning
- TypeScript client library
- Python client library

**Long-term:**
- Dynamic tools (client-side execution)
- Session clustering with affinity
- Message buffering for reconnect

**Never (per SEED.md):**
- Auth, approvals, metrics, health checks, TLS, HTTP transport

---

## VALIDATION

After implementation, verify:

```bash
# 1. Discovery commands work
echo '{"type":"create_session","sessionId":"test"}' > /tmp/cmds.jsonl
echo '{"sessionId":"test","type":"get_available_models"}' >> /tmp/cmds.jsonl
echo '{"sessionId":"test","type":"get_commands"}' >> /tmp/cmds.jsonl
echo '{"sessionId":"test","type":"get_skills"}' >> /tmp/cmds.jsonl
cat /tmp/cmds.jsonl | timeout 10 node dist/server.js | jq .

# 2. Extension UI round-trip works
# (requires client that responds to extension_ui_request)

# 3. Protocol version in server_ready
timeout 2 node dist/server.js 2>&1 | head -1 | jq '.data.protocolVersion'
```

---

## REFERENCE

- pi-coding-agent: `~/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/`
- pi RPC types: `dist/modes/rpc/rpc-types.d.ts`
- pi AgentSession: `dist/core/agent-session.d.ts`
- Codex app-server (for comparison): `~/programming/upstream/codex/codex-rs/app-server/`
- Litter client: `~/programming/upstream/litter/`
- SEED.md: `/home/tryinget/programming/pi-server/SEED.md`
- prompt-snippets: `~/steve/prompts/prompt-snippets.md`

---

**Start here:** Phase 1.1 — Extract command handlers to map. This enables everything else.
