# Knowledge Crystallization — 2026-02-22 Session

> What did we LEARN that we didn't know before?

---

## Patterns Discovered

### 1. Generation Markers for Rate Limit Entries
**Where it appeared**: `resource-governor.ts` - rate limit refund logic
**Pattern**: Monotonically incrementing counter stamped on each rate limit entry
**How to apply elsewhere**:
- Any time-windowed accounting where entries might be cleaned up
- Any scenario where you need to refund/remove a specific entry from a collection
- Prevents "wrong entry" bugs when cleanup runs between allocation and refund

```typescript
// Instead of: entries.pop() // Removes most recent, not necessarily YOUR entry
// Do: entries.find(e => e.generation === myGeneration)
```

### 2. `timer.unref()` Prevents Event Loop Blocking
**Where it appeared**: `resource-governor.ts` - periodic cleanup timer
**Pattern**: Node.js keeps process alive while timers exist. `unref()` tells Node "don't wait for this"
**How to apply elsewhere**:
- ALL periodic cleanup timers in servers
- Health check intervals
- Metrics emission timers

```typescript
// Always do this for background timers:
this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
this.cleanupTimer.unref(); // <-- Critical for clean shutdown
```

### 3. Bounded Queues as Explicit Backpressure
**Where it appeared**: `session-lock-manager.ts` - session lock wait queue
**Pattern**: Instead of unbounded queue (implicit OOM risk), use `maxQueueSize` and reject when full
**How to apply elsewhere**:
- Any queue that can grow unbounded
- WebSocket message queues
- Command execution queues

```typescript
// Before: this.queue.push(item); // Unbounded, OOM risk
// After:
if (this.queue.length >= this.maxQueueSize) {
  throw new Error("Queue full, apply backpressure");
}
this.queue.push(item);
```

### 4. ThresholdAlertSink Pattern
**Where it appeared**: NEW - `threshold-alert-sink.ts`
**Pattern**: Alerting is just another MetricsSink - users bring their own handler
**How to apply elsewhere**:
- Any cross-cutting concern (logging, tracing, alerting)
- Follow the AuthProvider pattern: core emits, sink decides

---

## Anti-Patterns Found

### 1. God Object Command Handlers
**Where**: `session-manager.ts` had 20+ command handlers inline
**Why it looked right**: "Centralization = organization"
**Why it was wrong**: Single file knew too much; hard to test; hard to find things
**Fix**: Extracted to `server-command-handlers.ts`

### 2. Rate Limit Refund by Assumption
**Where**: `resource-governor.ts` - refunding rate limit entries
**Why it looked right**: "Just remove the entry I added"
**Why it was wrong**: Cleanup might have already removed it, or removed a different one
**Fix**: Generation markers ensure correct entry is refunded

### 3. Timer Without `unref()`
**Where**: Extension UI timer blocked server shutdown
**Why it looked right**: "Node handles this automatically"
**Why it was wrong**: Node keeps process alive for ANY active timer
**Fix**: Always `unref()` background timers

---

## Surprises

| Expectation | What Actually Happened | Lesson |
|-------------|------------------------|--------|
| Timer cleanup "just works" | Extension UI timer blocked shutdown | Always `unref()` periodic timers |
| Rate limit refund removes "my" entry | Cleanup might have removed it already | Generation markers for identity |
| LLM output needs backpressure | WebSocket is way faster than LLM (~200-1000 bytes/sec) | YAGNI - backpressure only at scale |
| AbortController needs full implementation | pi-coding-agent ALREADY has internal abort plumbing | Just missing external `signal` input |

---

## Heuristics Validated

1. **"Pluggable sinks win over built-in backends"** - AuthProvider, MetricsSink, now ThresholdAlertSink all follow this pattern. It works.

2. **"Every timer in a server needs `unref()`"** - Confirmed again. This should be a lint rule.

3. **"Generation counters solve identity problems in concurrent systems"** - Used for rate limits, could be used elsewhere.

4. **"YAGNI applies to backpressure"** - Removed backpressure API from upstream proposal. LLM output rate is tiny compared to WebSocket capacity.

---

## Caveats

### Generation Counter Overflow
- **What doesn't generalize**: Generation counter will overflow at ~9 quadrillion commands
- **Why**: 53-bit integer limit
- **Mitigation**: Added telemetry alert at 1e12 threshold. At 1M commands/sec, would take 285 years.

### ThresholdAlertSink is Async
- **What doesn't generalize**: Alert handlers are async, but metrics recording is sync
- **Why**: Don't block metrics on Slack/PagerDuty network calls
- **Mitigation**: Fire-and-forget with try/catch

---

## Codification Actions

### Add to Documentation
- [x] ADR-0012: Periodic Rate Limit Cleanup
- [x] ADR-0013: Generation-Based Rate Limit Refund
- [ ] Add `unref()` pattern to Node.js server checklist
- [ ] Document ThresholdAlertSink usage

### Add to Linting/Validation
- [ ] Consider lint rule: `setInterval` without `unref()` in server code
- [ ] Consider lint rule: unbounded `push()` to arrays in hot paths

### Add to AGENTS.md (for future AI sessions)
- [ ] Always `unref()` periodic timers in servers
- [ ] Use generation markers when entries need identity across async boundaries
- [ ] Alerting = MetricsSink, not special infrastructure

---

## Files Created/Modified This Session

| File | Purpose |
|------|---------|
| `src/threshold-alert-sink.ts` | NEW - Pluggable alerting via MetricsSink |
| `src/test-threshold-alert-sink.ts` | NEW - 24 tests for ThresholdAlertSink |
| `src/metrics-types.ts` | Added `RATE_LIMIT_GENERATION_COUNTER` metric name |
| `src/metrics-index.ts` | Export ThresholdAlertSink types |
| `src/resource-governor.ts` | Added metrics emission for generation counter |
| `docs/KNOWLEDGE-CRYSTALLIZATION-2026-02-22.md` | This document |
| `package.json` | Added test file to build |

---

## Next Steps

1. **Wire up ThresholdAlertSink in server.ts** - Add to CompositeSink with console handler for dev
2. **Create example alert configuration** - Show how to use Slack/PagerDuty handlers
3. **Submit upstream proposal** - AbortController integration for pi-coding-agent (ready at `upstream-proposal-abortcontroller.md`)
4. **Add `unref()` lint rule** - Prevent future timer blocking issues
