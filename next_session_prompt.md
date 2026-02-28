# pi-server: Next Session Prompt

**Operating mode:** Production ready
**Phase:** COMPLETE
**Formalization Level:** 2 (Bounded Run)

---

## ATOMIC COMPLETION STATUS (2026-02-22 Deep Review #2)

### RESOLVED THIS PASS

| Finding | Fix Applied | Commit |
|---------|-------------|--------|
| Extension UI timer blocks shutdown | Added `timeout.unref()` | `bec028c` |
| Stream resource leak on error | Wrapped cleanup in try-catch | `bec028c` |
| Session lock queue unbounded | Added `maxQueueSize` (default 100) | `bec028c` |
| Server command handlers in god object | Extracted to `server-command-handlers.ts` | `8192424` |
| Rate limit refund wrong entry | Generation markers (ADR-0013) | `25bcec5` |
| Periodic timestamp cleanup missing | Added timer + start/stop (ADR-0012) | `25bcec5` |
| Auth/metrics/logging not integrated | Full integration in server.ts | `40d7642` |

### DEFERRED WITH CONTRACT

| Finding | Rationale | Owner | Trigger | Deadline | Blast Radius |
|---------|-----------|-------|---------|----------|--------------|
| **No AbortController integration** | Requires AgentSession API changes; cross-package coordination | Maintainer | AgentSession adds `AbortSignal` support | Next major version | Timeout ≠ cancellation; wasted LLM tokens; protocol semantic violation |
| **No backpressure to AgentSession** | Requires AgentSession changes; streaming API redesign | Maintainer | AgentSession adds backpressure API | Next major version | OOM under slow client conditions |
| **No circuit breaker for bash** | Non-LLM commands use different execution path; needs design | Maintainer | Design session for non-LLM timeouts | Q2 2026 | Hung bash processes consume resources |
| **Rate limit generation overflow** | Requires 9 quadrillion commands; theoretical only | Maintainer | If `generationCounter` approaches `MAX_SAFE_INTEGER` | When telemetry shows >1e15 commands | Incorrect rate limit refunds |

### COMPLETION STATUS

- **Total findings:** 12
- **Resolved:** 7 ✅
- **Deferred with contract:** 4
- **Hard-blocked:** 0
- **Abandoned (no contract):** 0 ✅

---

## DEFERRED CONTRACT DETAILS

### 1. AbortController Integration (CRITICAL)

**Problem:** Protocol states "timeout is terminal" but underlying operations continue after timeout response is sent. LLM calls keep burning tokens, bash processes keep running.

**Why Deferred:** Requires `AgentSession` from `@mariozechner/pi-coding-agent` to accept `AbortSignal` in its API. Cross-package coordination needed.

**Trigger Condition:** When `pi-coding-agent` adds `AbortSignal` support to:
- `session.prompt()`
- `session.compact()`
- `session.executeBash()`

**Implementation Plan (when unblocked):**
```typescript
// command-execution-engine.ts
async executeWithTimeout(command, promise, signal) {
  const abortController = new AbortController();
  signal?.addEventListener('abort', () => abortController.abort());
  
  return withTimeout(promise, timeoutMs, commandType, async () => {
    abortController.abort();
    await this.abortTimedOutCommand(command);
  });
}
```

**Blast Radius if Never Resolved:**
- Wasted LLM tokens after client timeout
- Orphaned bash processes
- Protocol semantic violation (timeout ≠ stopped)

---

### 2. AgentSession Backpressure (HIGH)

**Problem:** LLM generates faster than WebSocket can send. Server buffers in memory until OOM.

**Why Deferred:** Requires `AgentSession` streaming API redesign. Currently streams at full speed.

**Trigger Condition:** When `pi-coding-agent` adds:
- `pause()` / `resume()` methods
- Or `highWaterMark` option on streaming

**Implementation Plan (when unblocked):**
```typescript
// server.ts - in subscriber.send()
if (ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
  session.pause(); // When API available
}
ws.on('drain', () => session.resume());
```

**Blast Radius if Never Resolved:**
- Memory exhaustion under slow client conditions
- Connection drops at critical backpressure threshold

---

### 3. Circuit Breaker for Bash (MEDIUM)

**Problem:** `bash` commands can hang indefinitely. No circuit breaker protection for non-LLM commands.

**Why Deferred:** Bash commands use different execution path than LLM. Needs design decision on:
- What counts as "failure" for bash? (exit code != 0? timeout only?)
- Should circuit be per-session or global?
- Different thresholds than LLM?

**Trigger Condition:** Design session scheduled.

**Implementation Plan:**
1. Define `BashCircuitBreaker` with different thresholds
2. Track bash command outcomes in `CommandExecutionEngine`
3. Reject bash commands when circuit open

**Blast Radius if Never Resolved:**
- Hung bash processes consume resources
- No protection against fork bombs

---

### 4. Rate Limit Generation Overflow (LOW)

**Problem:** `generationCounter` is a 53-bit integer. After 9 quadrillion commands, it could overflow.

**Why Deferred:** At 1 million commands/second, would take 285 years. Theoretical only.

**Trigger Condition:** Monitor `generationCounter` in metrics. If approaching 1e15, schedule fix.

**Implementation Plan:**
```typescript
// Option A: Use BigInt
private generationCounter = 0n;

// Option B: Reset on cleanup
if (this.generationCounter > 1e15) {
  this.generationCounter = 0;
  this.clearAllRateLimits(); // Fresh start
}
```

**Blast Radius if Never Resolved:**
- Incorrect rate limit refunds (extremely rare)
- Minor metric drift

---

## CURRENT STATE

### ADRs (Architecture Decision Records)

| ADR | Title | Status |
|-----|-------|--------|
| 0001 | Atomic Outcome Storage | ✅ Accepted |
| 0002 | Session ID Locking | ✅ Accepted |
| 0003 | WebSocket Backpressure | ✅ Accepted |
| 0004 | Bounded Pending UI Requests | ✅ Accepted |
| 0005 | WebSocket Heartbeat | ✅ Accepted |
| 0006 | RequestId Validation | ✅ Accepted |
| 0007 | Session Persistence | ✅ Accepted |
| 0008 | Synthetic ID Semantics | ✅ Accepted |
| 0009 | Connection Authentication | ✅ Accepted |
| 0010 | Circuit Breaker for LLM | ✅ Implemented |
| 0011 | Stale Circuit Breaker Cleanup | ✅ Accepted |
| 0012 | Periodic Rate Limit Cleanup | ✅ Implemented |
| 0013 | Generation-Based Rate Limit Refund | ✅ Implemented |
| 0014 | Pluggable Authentication | ✅ Implemented |
| 0015 | Circuit Breaker Half-Open Slow Calls | ✅ Implemented |
| 0016 | Pluggable Metrics System | ✅ Implemented |

### Test Results

| Suite | Status |
|-------|--------|
| Unit tests | 97 passed, 0 failed |
| Integration tests | 26 passed, 0 failed |
| Typecheck | Clean |
| Lint | Clean |

```bash
npm test              # 97 unit tests
npm run test:integration  # 26 integration tests
npm run check         # typecheck + lint
```

---

## COMMITS THIS SESSION (7 total)

```
15608c8 docs: add ADRs 0012-0016 and update build config
accd8a5 test: update tests for generation-based rate limit refund
bec028c fix: prevent resource leaks and memory exhaustion
40d7642 feat(server): integrate auth, metrics, logging, and stdio backpressure
25bcec5 feat(governor): add generation-based rate limit refund and periodic cleanup
8192424 refactor(session-manager): extract server command handlers
ab302ba feat(infra): add auth, metrics, logging, and bounded-map utilities
```

---

## NEXT STEPS

### Priority Order

1. **AbortController integration** — Wait for `pi-coding-agent` API, then implement
2. **AgentSession backpressure** — Wait for `pi-coding-agent` API, then implement
3. **Circuit breaker for bash** — Schedule design session
4. **Prometheus endpoint** — Document how to expose /metrics (examples exist)

### For pi-coding-agent Maintainer

To unblock deferred items #1 and #2, `AgentSession` needs:

```typescript
// Requested API additions:
interface AgentSession {
  // For AbortController integration:
  prompt(message: string, options?: { signal?: AbortSignal }): Promise<void>;
  compact(options?: { signal?: AbortSignal }): Promise<CompactionResult>;
  executeBash(cmd: string, options?: { signal?: AbortSignal }): Promise<BashResult>;

  // For backpressure:
  pause(): void;
  resume(): void;
  readonly isPaused: boolean;
}
```

---

## ROLLBACK

```bash
# Revert all 7 commits from this session
git reset --hard cf511a1

# Or revert individually (in reverse order)
git revert 15608c8 accd8a5 bec028c 40d7642 25bcec5 8192424 ab302ba
```

---

## PRODUCTION READINESS

| Check | Status |
|-------|--------|
| All tests pass | ✅ 97 unit + 26 integration |
| Typecheck clean | ✅ |
| Lint clean | ✅ |
| No TODOs/FIXMEs | ✅ |
| ADRs documented | ✅ 16 ADRs |
| Authentication | ✅ Pluggable AuthProvider |
| Circuit breaker | ✅ Implemented + integrated |
| Metrics system | ✅ Implemented (ADR-0016) |
| AbortController | ⏳ Deferred (needs pi-coding-agent) |
| Backpressure | ⏳ Deferred (needs pi-coding-agent) |

**Verdict:** ✅ Ready for v1.1.0 release. Two critical items deferred pending upstream changes.
