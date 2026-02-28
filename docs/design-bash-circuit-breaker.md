# Design: Circuit Breaker for Bash Commands

**Status:** Draft
**Created:** 2026-02-28
**Context:** Deferred contract from pi-server deep review

---

## Problem Statement

Bash commands can hang indefinitely. Unlike LLM commands (which have circuit breaker protection), bash commands use a different execution path with no protection.

**Current State:**
- LLM commands: Protected by `CircuitBreaker` in `command-execution-engine.ts`
- Bash commands: No circuit breaker, no timeout enforcement at execution level

**Blast Radius if Not Resolved:**
- Hung bash processes consume system resources
- No protection against fork bombs
- Single runaway command can degrade entire server

---

## Design Questions

### 1. What counts as "failure" for bash?

| Option | Definition | Pros | Cons |
|--------|------------|------|------|
| A | Exit code != 0 | Simple | Many legitimate non-zero exits |
| B | Timeout only | Clear failure mode | Doesn't catch fast-failing loops |
| C | Timeout + exit code != 0 combined | More protection | More complex |
| D | Timeout + configurable exit codes | Flexible | Requires configuration |

**Recommendation:** Option B (timeout only) for initial implementation. Exit code != 0 is often legitimate (e.g., `grep` returns 1 when no match).

### 2. Per-session or global circuit breaker?

| Option | Scope | Pros | Cons |
|--------|-------|------|------|
| A | Per-session | Isolates bad actors | Doesn't protect against distributed abuse |
| B | Global | Protects server as whole | Single user can affect everyone |
| C | Both (hybrid) | Best protection | More complex |

**Recommendation:** Option C (hybrid). Global circuit breaker as backstop, per-session as first line.

### 3. Same thresholds as LLM circuit breaker?

Current LLM circuit breaker thresholds:
- `failureThreshold`: 5 failures in window
- `successThreshold`: 1 success to close
- `timeout`: 60000ms (1 minute)
- `windowMs`: 60000ms (1 minute)

**Analysis:**
- Bash commands are more variable in duration (milliseconds to minutes)
- Bash failures are often transient (file locked, network timeout)
- Should be more lenient than LLM

**Recommendation:**
- `failureThreshold`: 10 (higher than LLM)
- `successThreshold`: 2 (require 2 successes to close)
- `timeout`: Command-specific (respect `command.timeout` field)
- `windowMs`: 120000ms (2 minutes, longer window)

### 4. Integration point?

**Option A:** In `CommandExecutionEngine.executeBash()`
- Pros: Centralized, consistent with LLM pattern
- Cons: Requires modifying command execution

**Option B:** In `ResourceGovernor`
- Pros: Already handles rate limiting, connection limits
- Cons: Governor is about "can I do this?" not "did this fail?"

**Option C:** New `BashCircuitBreaker` class, wired into `CommandExecutionEngine`
- Pros: Clean separation, testable
- Cons: More code

**Recommendation:** Option C. Follow existing `CircuitBreaker` pattern but with bash-specific defaults.

---

## Proposed Design

### Architecture

```
CommandExecutionEngine
    ├── llmCircuitBreaker: CircuitBreaker (existing)
    └── bashCircuitBreaker: BashCircuitBreaker (new)
            ├── globalBreaker: CircuitBreaker
            └── sessionBreakers: Map<sessionId, CircuitBreaker>
```

### New Types

```typescript
interface BashCircuitBreakerConfig {
  /** Per-session failure threshold (default: 10) */
  sessionFailureThreshold: number;
  /** Global failure threshold (default: 50) */
  globalFailureThreshold: number;
  /** Successes needed to close (default: 2) */
  successThreshold: number;
  /** Window for counting failures (default: 120000ms) */
  windowMs: number;
  /** Time circuit stays open before half-open (default: 30000ms) */
  openToHalfOpenMs: number;
}

interface BashExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  signal?: string;
}
```

### Flow

```
executeBash(sessionId, command, timeout)
    │
    ├─► Check session circuit breaker
    │       └─► If OPEN: reject with "bash circuit breaker open for session"
    │
    ├─► Check global circuit breaker
    │       └─► If OPEN: reject with "bash circuit breaker open globally"
    │
    ├─► Execute with timeout
    │       ├─► SUCCESS (exit 0, no timeout)
    │       │       └─► Record success on both breakers
    │       │
    │       ├─► TIMEOUT
    │       │       └─► Record failure on both breakers
    │       │
    │       └─► FAILURE (exit != 0)
    │               └─► DO NOT record failure (legitimate non-zero exit)
    │
    └─► Return result
```

### Key Decisions

1. **Only timeout counts as failure** - Non-zero exit codes are often legitimate
2. **Hybrid breakers** - Both per-session and global protection
3. **Bash-specific defaults** - More lenient than LLM circuit breaker
4. **Reuse existing CircuitBreaker** - Don't reinvent, just configure differently

---

## Implementation Plan

### Phase 1: Core Implementation
1. Create `BashCircuitBreaker` class in `src/bash-circuit-breaker.ts`
2. Add to `CommandExecutionEngine` constructor
3. Wire into `executeBash()` method
4. Add tests

### Phase 2: Integration
1. Add configuration options to `PiServerOptions`
2. Wire through `PiSessionManager`
3. Add metrics for circuit state transitions

### Phase 3: Observability
1. Add `bash_circuit_breaker_state` metric
2. Add to `get_metrics` response
3. Document in ADR

---

## Open Questions

1. **Should process spawn failures count?** (e.g., ENOENT, EACCES)
   - Tentative: Yes, these indicate system stress

2. **Should we track different commands separately?**
   - Tentative: No, too much complexity for v1

3. **What about commands that timeout but succeed partially?**
   - Tentative: Timeout is timeout, count as failure

---

## Rollback

If this causes issues:
```bash
# Disable bash circuit breaker (add to config)
bashCircuitBreaker: { enabled: false }

# Or increase thresholds to effectively disable
bashCircuitBreaker: { sessionFailureThreshold: 10000, globalFailureThreshold: 100000 }
```

---

## Next Steps

1. Review this design
2. Create `src/bash-circuit-breaker.ts`
3. Add tests
4. Wire into `CommandExecutionEngine`
5. Add ADR
