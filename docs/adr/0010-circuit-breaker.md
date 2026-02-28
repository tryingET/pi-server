# ADR-0010: Circuit Breaker for LLM Calls

## Status

**Accepted** — Implementation complete (2026-02-28)

## Context

When LLM providers experience latency spikes or outages, the pi-server can become blocked:
- All sessions share the same LLM connection pool
- A slow LLM call blocks the session's execution lane
- Multiple slow calls can exhaust server resources
- Cascading failures affect all users

### Observed Failure Modes

| Failure | Symptom | Impact |
|---------|---------|--------|
| Latency spike | LLM call exceeds 30s | Session blocked, user frustrated |
| Provider outage | All calls timeout | All sessions blocked |
| Rate limit exceeded | 429 errors | Degraded experience |
| Intermittent errors | Sporadic failures | Unreliable service |

## Decision

Implement the **circuit breaker pattern** for LLM calls with the following design:

### 1. Three States

```
         ┌──────────────────────────────────────┐
         │                                      │
         ▼                                      │
    ┌─────────┐   failures >= threshold    ┌─────────┐
    │ CLOSED  │ ─────────────────────────► │  OPEN   │
    │ (normal)│                            │ (failing)│
    └─────────┘                            └─────────┘
         ▲                                      │
         │                                      │
         │           recovery timeout           │
         │         ◄────────────────────        │
         │                                      ▼
         │                               ┌───────────┐
         │   successes >= threshold      │ HALF_OPEN │
         └───────────────────────────────│ (testing) │
                                         └───────────┘
                                               │
                                               │ any failure
                                               ▼
                                          ┌─────────┐
                                          │  OPEN   │
                                          └─────────┘
```

### 2. Configuration

```typescript
interface CircuitBreakerConfig {
  latencyThresholdMs: number;   // 30s default
  failureThreshold: number;      // 5 failures
  failureWindowMs: number;       // 1 minute window
  recoveryTimeoutMs: number;     // 30s before retry
  successThreshold: number;      // 2 successes to close
  providerName: string;          // For logging/metrics
}
```

### 3. Per-Provider Isolation

Each LLM provider has its own circuit breaker:
- OpenAI failures don't affect Anthropic
- Per-provider tuning (some providers are slower)
- Independent recovery windows

### 4. Integration Points

```typescript
// In session-manager.ts (future)
const breaker = circuitBreakerManager.getBreaker(session.model.provider);

const check = breaker.canExecute();
if (!check.allowed) {
  return { success: false, error: check.reason };
}

try {
  const result = await session.executeCommand(command);
  breaker.recordSuccess(result.latencyMs);
  return result;
} catch (error) {
  if (error instanceof TimeoutError) {
    breaker.recordFailure("timeout");
  } else {
    breaker.recordFailure("error");
  }
  throw error;
}
```

### 5. Observability

Circuit state is exposed via `get_metrics`:

```json
{
  "circuitBreakers": [
    {
      "providerName": "openai",
      "state": "closed",
      "failureCount": 0,
      "totalCalls": 1523,
      "totalRejected": 0,
      "avgLatencyMs": 2340
    },
    {
      "providerName": "anthropic",
      "state": "open",
      "failureCount": 5,
      "totalCalls": 892,
      "totalRejected": 12,
      "avgLatencyMs": 45000
    }
  ]
}
```

## Implementation

- **File:** `src/circuit-breaker.ts`
- **Tests:** `circuit-breaker.test.ts` (21 tests)
- **Classes:**
  - `CircuitBreaker` — Single provider circuit
  - `CircuitBreakerManager` — Multi-provider coordination

## Consequences

### Positive

- **Resilience:** Slow providers don't block all sessions
- **Fast fail:** Immediate rejection when provider is down
- **Auto-recovery:** Half-open state allows gradual restoration
- **Observability:** Metrics expose provider health

### Negative

- **False positives:** Brief spikes may open circuit unnecessarily
- **Complexity:** Additional state to manage
- **Latency:** One extra check per call (negligible)

### Mitigations

| Risk | Mitigation |
|------|------------|
| False positive | Configurable thresholds, grace period |
| Complexity | Well-tested, clear state machine |
| Tuning | Per-provider configuration support |

## Alternatives Considered

### Alternative 1: No Circuit Breaker

Let all calls through, rely on timeouts.

**Rejected:** Doesn't prevent cascade failures; wastes resources on doomed calls.

### Alternative 2: Global Circuit

Single circuit for all providers.

**Rejected:** One bad provider blocks all providers; loses isolation benefit.

### Alternative 3: Client-Side Retries

Let clients handle retries with exponential backoff.

**Rejected:** Shifts complexity to clients; doesn't protect server resources.

## References

- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html) — Martin Fowler
- [Release It!](https://pragprog.com/titles/mnee2/release-it-second-edition/) — Michael Nygard
- Hystrix (Netflix) — Production-hardened circuit breaker

## Changelog

| Date | Change |
|------|--------|
| 2026-02-28 | Initial implementation with 21 passing tests |
