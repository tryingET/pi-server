# pi-server: Next Session Prompt

**Operating mode:** Production ready  
**Phase:** COMPLETE  
**Formalization Level:** 2 (Bounded Run)

---

## ATOMIC COMPLETION STATUS (2026-02-28)

### RESOLVED THIS PASS (Deep Review + Atomic Completion)

| Finding | Fix Applied | Files |
|---|---|---|
| Busy rejection still executed command side effects | Added pre-admission in-flight capacity gate so `Server busy` rejects before execution starts | `src/session-manager.ts`, `src/command-replay-store.ts` |
| Timeout replay drift for idempotency keys | Moved idempotency caching to terminal response path (includes timeout outcomes) | `src/session-manager.ts` |
| `command_accepted` without `command_finished` on early rejects | Introduced unified `finalizeResponse()` and routed replay/rate-limit/busy exits through it | `src/session-manager.ts` |
| `load_session` sessionVersion inconsistent/missing | Added explicit `load_session` handling to initialize and return `sessionVersion: 0` | `src/session-version-store.ts` |
| Shutdown uptime metric dropped | Emit uptime gauge before final `metrics.flush()` | `src/server.ts` |

### TESTS ADDED/UPDATED THIS PASS

- `src/test.ts`
  - server busy rejection must not mutate state
  - idempotency replay preserves timeout terminal outcome
  - admitted rate-limited commands emit `command_finished`
  - `load_session` initializes version to `0` (auto + explicit session id)
  - shutdown flush includes uptime metric
- `src/test-session-version-store.ts`
  - `load_session` initializes version to `0`

### COMPLETION STATUS (THIS PASS)

- Total findings surfaced: **5**
- Resolved: **5**
- Deferred with contract: **0**
- Hard-blocked: **0**
- Abandoned (no contract): **0 ✅**

---

## DEFERRED WITH CONTRACT (CARRIED FORWARD)

| Finding | Rationale | Owner | Trigger | Deadline | Blast Radius |
|---|---|---|---|---|---|
| **AbortController integration upstream** | Requires `@mariozechner/pi-coding-agent` API support for caller-provided `AbortSignal` | Maintainer | Upstream accepts proposal (`upstream-proposal-abortcontroller.md`) | Next major version | Timeout semantic mismatch + wasted LLM tokens |
| **AgentSession backpressure API** | Deferred as YAGNI at current throughput; revisit with telemetry evidence | Maintainer | Sustained high `ws.bufferedAmount` / memory pressure metrics | When needed | Potential OOM under pathological slow consumers |

---

## VALIDATION SNAPSHOT (post-fix)

| Check | Status |
|---|---|
| `npm run check` | ✅ |
| `npm run build` | ✅ |
| `npm test` | ✅ 103 passed, 0 failed |
| `npm run test:integration` | ✅ 26 passed, 0 failed |
| `node --experimental-vm-modules dist/test-session-version-store.js` | ✅ |

---

## FILES CHANGED IN THIS PASS

- `src/command-replay-store.ts`
- `src/session-manager.ts`
- `src/session-version-store.ts`
- `src/server.ts`
- `src/test.ts`
- `src/test-session-version-store.ts`

(Plus existing unrelated local change: `next_session_prompt.md` itself.)

---

## NEXT STEPS

1. Commit this atomic-completion patch set (runtime fixes + regression tests).
2. Add ADR note (or update existing ADR) documenting unified terminalization path and lifecycle invariant:
   - if `command_accepted` is emitted, `command_finished` must be emitted exactly once.
3. Continue upstream AbortSignal proposal process.

---

## ROLLBACK (this pass only)

```bash
git restore src/command-replay-store.ts src/session-manager.ts src/session-version-store.ts src/server.ts src/test.ts src/test-session-version-store.ts
npm run build
npm test
npm run test:integration
```

---

## PRODUCTION READINESS

| Check | Status |
|---|---|
| Lifecycle consistency (`accepted -> finished`) | ✅ Fixed + regression-tested |
| Replay determinism for timeout terminal outcomes | ✅ Fixed + regression-tested |
| Busy rejection side-effect safety | ✅ Fixed + regression-tested |
| Session version consistency on load | ✅ Fixed + regression-tested |
| Final shutdown metrics flush correctness | ✅ Fixed + regression-tested |
| Upstream AbortSignal gap | 🔵 Deferred upstream |
| Backpressure API gap | 🟡 Deferred/YAGNI |

**Verdict:** ✅ Ready for release candidate with current deferred contracts unchanged.
