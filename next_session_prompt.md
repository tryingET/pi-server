# pi-server: Next Session Prompt

**Operating mode:** Architecture gap discovered - session persistence bridge needed.

---

## COMPLETED IN PREVIOUS SESSIONS

### ✅ Release preparation

- Package excludes test artifacts
- ADR-0001 timeout semantics consistent across docs
- Release automation validated
- CI workflow runs full test suite

### ✅ pi-web client (NEW)

Created `~/programming/pi-web/` - minimal web client:

- **1,568 lines** TypeScript/CSS/HTML
- Zero runtime dependencies
- Production build: ~22KB (gzipped: ~6KB)
- Session list + switching
- Streaming responses
- Tool execution visualization
- Mobile-responsive

---

## DISCOVERED: Session Persistence Gap

### The Problem

```
pi CLI                    pi-server
    │                         │
    ▼                         ▼
SessionManager          In-memory Map
.create(cwd)            <string, AgentSession>
    │                         │
    ▼                         ▼
~/.pi/agent/sessions/   RAM only (lost on restart)
```

**pi-server creates ephemeral sessions:**
```typescript
// session-manager.ts:311
const { session } = await createAgentSession({
  cwd: cwd ?? process.cwd(),
  // NO sessionManager provided → defaults to in-memory
});
```

**Result:** Existing sessions in `~/.pi/agent/sessions/` are invisible to pi-server and pi-web.

---

## CORE INTENT (UNCHANGED)

`pi-server` is a deterministic protocol boundary around `AgentSession`.

It does only four things:
1. multiplex sessions
2. preserve causal command semantics
3. enforce resource and safety constraints
4. expose a stable, inspectable wire contract

---

## PROPOSED SOLUTIONS

### Phase 1: Immediate UX Fix (Priority H)

| ID | Suggestion | Files |
|----|------------|-------|
| S1 | Add `list_stored_sessions` command | `types.ts`, `session-manager.ts` |
| S2 | Add `load_session <path>` command | `types.ts`, `session-manager.ts` |
| S4 | pi-web: Show "Active" vs "Stored" sections | `pi-web/src/renderer.ts` |
| S7 | pi-web: Add "Load Session" button | `pi-web/src/renderer.ts` |

### Phase 2: Protocol Completeness (Priority M)

| ID | Suggestion |
|----|------------|
| S3 | `create_session` accepts optional `sessionPath` |
| S5 | Document session persistence in PROTOCOL.md |
| S6 | Add `persistence: "ephemeral" | "file"` to SessionInfo |
| S8 | Add `session_loaded` event type |

### Phase 3: Polish (Priority L)

| ID | Suggestion |
|----|------------|
| S9 | `--persist` flag for default persistence |
| S10 | Session search/filter in pi-web |

---

## HOW TO START

```bash
cd ~/programming/pi-server
npm run build
node dist/server.js
```

Server starts on:
- WebSocket: `ws://localhost:3141`
- stdio: newline-delimited JSON on stdin/stdout

---

## TESTING WITH pi-web

```bash
# Terminal 1: Start pi-server
cd ~/programming/pi-server
node dist/server.js

# Terminal 2: Start pi-web
cd ~/programming/pi-web
npm run dev

# Open http://localhost:3000
```

**Current limitation:** Only sessions created via pi-server appear in web UI.

---

## NEXT STEPS (PRIORITY ORDER)

1. **Implement S1 + S2** - `list_stored_sessions` and `load_session` commands
2. **Update pi-web** - Show stored sessions, add load button
3. **Test full flow** - Load existing session, send prompt, verify persistence
4. **Document** - Update PROTOCOL.md with session persistence semantics

---

## VALIDATION GATES

### FAST_GATE (per commit)
```bash
npm run check
npm test
```

### FULL_GATE (final)
```bash
npm run release:check
npm run test:integration
npm run test:fuzz
```

### SMOKE_TEST (pi-web)
```bash
cd ~/programming/pi-web
npx tsc --noEmit
npm run build
# Open in browser and verify connection
```

---

## OPEN QUESTIONS

1. Should persistent sessions be the default or opt-in?
2. How to handle session file conflicts (same sessionId from different paths)?
3. Should pi-web auto-load the most recent session on connect?
