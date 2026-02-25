# AGENTS.md — Crystallized Learnings for pi-server

This document captures patterns, anti-patterns, and gotchas discovered during development. Read this before working on pi-server.

---

## Architecture Principles

1. **The protocol IS the architecture** — `types.ts` is the single source of truth
2. **Server should be thin** — AgentSession does the work, we just multiplex
3. **Pass-through pattern** — Session commands are thin wrappers around AgentSession methods
4. **Handler map > switch** — `Record<string, CommandHandler>` for O(1) dispatch, easy extension

---

## File Responsibilities

| File | Responsibility | Don't Put Here |
|------|----------------|----------------|
| `server.ts` | Transports (WebSocket, stdio) only | Command logic, session lifecycle |
| `session-manager.ts` | Session lifecycle, subscribers, server commands | Transport details, individual command implementations |
| `command-router.ts` | Session command handlers, routing | Session lifecycle, broadcast |
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

| Issue | Location | Workaround |
|-------|----------|------------|
| `set_model` uses internal API | command-router.ts:67 | Document risk, investigate public API |
| Windows path handling | command-router.ts:175 | Use `path.basename()` |
| No input validation | All entry points | Add validation layer |
| No command timeout | executeCommand | Add timeout wrapper |
| Extension UI not wired | session-manager.ts | Phase 3 pending |

---

## Testing

No tests exist yet. When adding tests:

1. Test each handler in isolation (mock AgentSession)
2. Test session lifecycle (create/delete/list)
3. Test subscriber management
4. Test broadcast routing
5. Test extension UI round-trip

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
