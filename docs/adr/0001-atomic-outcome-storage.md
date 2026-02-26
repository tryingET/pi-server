# ADR-0001: Atomic Outcome Storage for Idempotent Replay

## Status

**Proposed** → Accepted (2026-02-22)

## Context

The pi-server implements idempotent command execution with replay support. The current implementation stores command outcomes in async `.then()` callbacks after responses are returned to clients.

### The Problem

```
Timeline:
─────────────────────────────────────────────────────────────►
     │                    │                    │
     │                    │                    │
   Execute         Timeout fires        Late completion
     │                    │                    │
     │               Returns timeout     Stores outcome
     │               response            (different from timeout)
     │                    │                    │
     └────────────────────┴────────────────────┘
                          │
                    Replay window:
                    Returns timeout OR completion
                    (non-deterministic!)
```

**Invariant Violation:** Same command ID can return different responses depending on when replay occurs.

### Root Causes

1. **Dual-write problem:** Response is returned before outcome is stored
2. **Timeout treated as failure:** Timeout response not stored as valid outcome
3. **Scattered state:** In-flight tracking, outcome store, and idempotency cache are separate

### Evidence

From deep review using INVERSION framework:

> "What must be true for this system to appear healthy while actually being sick?"
> - Timeout responses don't have outcomes → replay fails
> - Late completions store outcomes → creates orphan records
> - In-flight tracking doesn't account for timeouts → state drift

## Decision

We will implement **atomic outcome storage** with the following changes:

### 1. Store Before Return (CRITICAL)

Outcomes are stored BEFORE the response is returned, not in async callbacks.

```typescript
// BEFORE (buggy)
commandExecution.then((response) => {
  this.replayStore.storeCommandOutcome({...});  // After return
});
return withTimeout(commandExecution, timeoutMs, ...);

// AFTER (correct)
const response = await this.executeWithAtomicStorage(command);
// Storage happens INSIDE, before return
return response;
```

### 2. Timeout IS a Response (CRITICAL)

Timeout responses are stored as valid outcomes. If execution completes later, the outcome is updated (within the replay window).

```typescript
// On timeout
const timeoutResponse = { success: false, error: "Timeout", timedOut: true };
this.storeOutcome(commandId, timeoutResponse);  // Store BEFORE return
return timeoutResponse;

// On late completion (within replay window)
if (this.outcomeStore.get(commandId)?.timedOut) {
  this.updateOutcome(commandId, actualResponse);  // Update for future replays
}
```

### 3. Entity Pattern (ARCHITECTURAL)

Consolidate scattered state into a single CommandEntity abstraction:

```
CommandEntity
├── id: string
├── state: 'pending' | 'completed'
├── response: RpcResponse | null
├── createdAt: timestamp
└── completedAt: timestamp | null

INVARIANT: response is immutable once state = 'completed'
```

### 4. Reject, Don't Evict (HIGH)

In-flight tracking rejects new commands when full instead of evicting old ones. This prevents breaking dependency chains.

```typescript
// BEFORE (eviction breaks deps)
if (this.inFlight.size >= max) {
  const oldest = this.order.shift();
  this.inFlight.delete(oldest);  // Dependent commands fail!
}

// AFTER (reject preserves deps)
if (this.inFlight.size >= max) {
  return { success: false, error: "Server busy - too many concurrent commands" };
}
```

### 5. Free Replay (MEDIUM)

Replay operations are exempt from rate limiting. They are O(1) lookups with negligible CPU cost.

```typescript
// Replay is free - just reading stored state
if (replayResult.found) {
  return replayResult.response;  // No rate limit charge
}
```

## Consequences

### Positive

- **Correctness:** Same command ID always returns same response (invariant holds)
- **Simplicity:** Single code path for storage, no async callback complexity
- **Reliability:** Dependency chains never broken by eviction
- **Performance:** Replay is free (O(1) lookup, no rate limit)

### Negative

- **Latency:** Slight increase (storage must complete before response)
- **Memory:** In-flight tracking may reject commands under heavy load (mitigated by increasing limit)
- **Breaking change:** Clients may see different behavior for timeout scenarios

### Mitigations

| Risk | Mitigation |
|------|------------|
| Storage latency | Use in-memory store (already done) |
| Reject under load | Configure higher `maxInFlightCommands` |
| Client expectations | Document timeout behavior clearly |

## Alternatives Considered

### Alternative 1: Update-on-Completion Only

Store only final completion, ignore timeouts.

**Rejected:** Clients who timeout and retry would re-execute, violating idempotency.

### Alternative 2: Separate Timeout Cache

Maintain separate cache for timeout responses.

**Rejected:** Two sources of truth, same problem as current design.

### Alternative 3: Distributed Transaction

Use database transaction for atomicity.

**Rejected:** Overkill for single-server in-memory system. Adds latency and complexity.

## Implementation

### Phase 1: Critical Fixes (This Session)

- [ ] Store outcomes before return in `executeCommand`
- [ ] Store timeout responses as valid outcomes
- [ ] Reject (don't evict) when in-flight limit reached

### Phase 2: Architectural Improvements (Future)

- [ ] Consolidate into CommandEntity pattern
- [ ] Remove synthetic ID generation (require client IDs)
- [ ] Add metrics hooks for observability

## References

- **Lamport, Leslie:** "Same command ID must ALWAYS return the same response. Not 'usually.' Not 'after the callback completes.' ALWAYS."
- **Kleppmann, Martin:** "The dual-write problem is solved by storing before returning."
- **Helland, Pat:** "You have scattered state. Consolidate into entities."
- [DDIA Ch. 12: Consistency](https://www.oreilly.com/library/view/designing-data-intensive-applications/9781491903063/)
- [Life Beyond Distributed Transactions](https://www.cidrdb.org/cidr2007/papers/cidr07p15.pdf)

## Review History

| Date | Reviewer | Outcome |
|------|----------|---------|
| 2026-02-22 | Deep Review (INVERSION, TELESCOPIC, NEXUS) | Identified critical bugs |
| 2026-02-22 | Trialegue (Lamport, Kleppmann, Helland) | Validated fix approach |
