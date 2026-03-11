# pi-server: Next Session Prompt

**Operating mode:** Reliability-first, adversarially reviewed  
**Current phase:** NEXUS hardening + atomic-completion pass landed and verified  
**Version:** 2.1.0 (working tree)  
**Formalization Level:** 2 (Bounded Run)

---

## SESSION STATUS (2026-03-11)

The codebase now includes **three stacked reliability passes** in effect:

1. **Trust-boundary hardening pass**
   - transport auth parity
   - anchored session-file capability validation
   - pre-execution admission refund fixes
   - SessionStore multi-writer serialization
   - discovery/access alignment for project-local sessions

2. **Failure-atomic lifecycle + canonical replay pass**
   - failure-atomic `create_session` / `load_session` / `delete_session`
   - copy-on-write SessionStore mutation semantics
   - canonical key-stable replay fingerprints
   - in-flight idempotency-key dedupe
   - newest-first durable command history
   - async stdout error hardening for stdio transport
   - `load_session` persists source session cwd

3. **NEXUS + atomic-completion pass**
   - control-plane vs data-plane command policy
   - dedicated rate-limit buckets for control-plane commands
   - `command_accepted` semantics moved to true post-admission behavior
   - `load_session` runtime cwd now uses the source session cwd
   - `disposeAllSessions()` now clears governor accounting correctly
   - durable journal init failure releases writer lock
   - session discovery sanitizes malformed header fields
   - authenticated principal now propagates into command execution context
   - per-connection pending-command caps added for websocket + stdio
   - critical send failures now fail-stop instead of being silently ignored
   - `validateCwd()` now requires absolute, existing directories
   - `delete_session` now surfaces runtime cleanup failure instead of returning false success
   - `get_command_history` now reverse-scans the journal instead of full-file reading
   - fail-closed `command_finished` append failures now remain deterministic across restart
   - shutdown escalation now aborts active sessions and blocks late state mutation
   - SessionStore cache freshness now uses `mtimeMs + ctimeMs + size`

---

## RESOLVED THIS PASS

- **Control-plane starvation:** `delete_session` / `switch_session` no longer share session data-plane rate-limit buckets.
- **Admission semantics drift:** replay hits and pre-admission rejections no longer emit misleading `command_accepted` / `command_started` events.
- **`load_session` cwd drift:** runtime session creation now uses the source session header cwd when valid.
- **Governor slot leak on disposal:** `disposeAllSessions()` now unregisters sessions correctly.
- **Journal init lock leak:** failed durable init now releases the single-writer lock.
- **Malformed discovery header poisoning:** non-string `cwd` / `sessionName` values now sanitize to safe defaults.
- **Dropped auth principal:** authenticated identity now flows from transport admission into command execution context.
- **Per-connection concurrency amplification:** websocket and stdio now reject overflow beyond a configured pending-command cap.
- **Best-effort critical send lie:** critical websocket/stdio send failures are now observable and fail-stop.
- **Weak cwd validation:** `validateCwd()` now rejects relative, missing, and non-directory paths.
- **False-success delete:** runtime cleanup failures during `delete_session` now surface as command failure.
- **Unbounded history read:** `get_command_history` now reverse-scans in chunks instead of `readFile()`ing the full journal.
- **Fail-closed replay drift across restart:** fallback terminal persistence preserves explicit-ID determinism after restart.
- **Late mutation after shutdown timeout:** shutdown now aborts active sessions and blocks late state mutation after final teardown.
- **Cross-instance SessionStore stale-cache race:** cache freshness now detects same-size/same-mtime file replacement using `ctimeMs` too.

---

## VERIFICATION SNAPSHOT (CURRENT)

| Check | Status |
|---|---|
| `npm run build` | ✅ |
| `npm test` | ✅ 185 passed, 0 failed |
| `npm run test:integration` | ✅ 32 passed, 0 failed |
| `npm run test:fuzz` | ✅ 17 passed, 0 failed |
| `npm run check` | ✅ typecheck + lint clean |

Notable regression coverage now includes:
- rate-limited commands do not emit `command_accepted`
- `delete_session` uses control-plane rate-limit bucket
- `load_session` uses source cwd for runtime creation
- journal init failure releases lock
- malformed discovery headers are sanitized
- `disposeAllSessions()` resets governor accounting
- fail-closed terminal failure remains deterministic across restart
- auth identity reaches command execution context
- per-connection pending-command cap rejects overflow
- SessionStore cross-instance metadata mutations remain serialized

---

## FILES TO READ FIRST NEXT SESSION

### Core implementation
- `src/session-manager.ts`
- `src/server.ts`
- `src/command-journal.ts`
- `src/session-store.ts`
- `src/command-classification.ts`
- `src/resource-governor.ts`
- `src/server-command-handlers.ts`
- `src/types.ts`

### Regression coverage
- `src/test.ts`
- `src/test-command-classification.ts`
- `src/test-integration.ts`
- `src/test-fuzz.ts`

### Documentation
- `PROTOCOL.md`
- `docs/client-guide.md`
- `docs/adr/0020-failure-atomic-lifecycle-and-canonical-replay.md`
- `docs/adr/0019-durable-command-journal-foundation.md`
- `docs/adr/0007-session-persistence.md`
- `AGENTS.md`

---

## WORKING TREE STATE

The repo is **not clean**.

This pass directly updated:
- `src/command-classification.ts`
- `src/command-journal.ts`
- `src/resource-governor.ts`
- `src/server-command-handlers.ts`
- `src/server.ts`
- `src/session-manager.ts`
- `src/session-store.ts`
- `src/types.ts`
- `src/test-command-classification.ts`
- `src/test-integration.ts`
- `src/test.ts`
- `PROTOCOL.md`
- `docs/client-guide.md`
- `next_session_prompt.md`

Other files are also already dirty in the working tree and should be treated carefully unless explicitly continuing them:
- `AGENTS.md`
- `docs/adr/0014-pluggable-authentication.md`
- `src/auth.ts`
- `src/command-router.ts`
- `src/server-ui-context.ts`
- `src/validation.ts`

Do **not** assume the tree is ready to commit as one blob without reviewing file-by-file intent.

---

## OPERATIONAL GUARDRAILS (CURRENT)

- **Control-plane isolation:** cleanup/inspection commands are no longer throttled by hot session traffic.
- **Admission truthfulness:** `command_accepted` means actual post-replay/post-rate-limit admission.
- **Replay determinism:** explicit IDs remain stable, including fail-closed terminal failures across restart.
- **Durable history bounded work:** history queries now scan tail-first in chunks instead of full-file materialization.
- **Critical transport honesty:** broken critical sends are surfaced and stop the transport instead of silently pretending delivery.
- **Principal propagation:** authenticated identity now reaches command execution context.
- **Shutdown hardening:** timeout escalation aborts active session work and blocks late store mutation after teardown.
- **Session discovery resilience:** malformed session headers degrade safely to `/unknown` rather than poisoning grouping logic.
- **SessionStore freshness:** cross-instance metadata updates no longer rely only on `mtimeMs + size`.

---

## DEFERRED WITH CONTRACT

| Finding | Rationale | Owner | Trigger | Deadline | Blast Radius |
|---|---|---|---|---|---|
| Exact guaranteed terminal response delivery over broken transports | This pass made critical send failures fail-stop and observable, but true guaranteed delivery needs protocol-level ack/resume or a durable outbound queue. That is a wire-contract change, not a safe local patch. | pi-server maintainer + protocol owner | ADR approving response-ack / resumable delivery semantics | Before the next release that claims reliable terminal delivery | Clients can still miss a terminal response on transport break and must rely on explicit IDs + replay/retry |
| Two-phase durable lifecycle intents for create/load/delete crash windows | Closing the remaining crash window between durable mutation and runtime publication/teardown requires persisted lifecycle intents plus boot recovery semantics. Too invasive for a same-pass safe landing. | pi-server maintainer | Lifecycle-intent ADR / state-machine design approval | Before clustering, multi-process orchestration, or supervisor-driven recovery work | A crash at the wrong point can still leave runtime/durable state transiently divergent until restart recovery |
| Shrinking session-ID lock scope without reintroducing races/slot leaks | Current lock scope is correct but wide. Reducing it safely needs a reserved-session state model so slow upstream creation/switch work can move outside the critical section. | pi-server maintainer | Performance/scalability workstream or lock-timeout telemetry | Before the next performance-focused release | Same-session create/load/delete can still time out under slow upstream session operations |
| Hard cancellation of upstream work after shutdown timeout | This pass added best-effort abort escalation and server-side mutation gating, but true hard-stop semantics need upstream `AgentSession` support for stronger cancellation guarantees. | upstream `@mariozechner/pi-coding-agent` owner + pi-server maintainer | Upstream exposes hard cancellation / shutdown-safe abort contract | Before advertising strict bounded shutdown guarantees | Upstream work may continue after timeout, though server-side state is now protected from late mutation |

---

## RECOMMENDED NEXT STEP ORDER

If continuing immediately, use this order:

1. **Protocol/ADR work for reliable terminal delivery**
   - define ack/resume or durable outbound semantics
2. **Lifecycle-intent ADR**
   - add persisted `creating` / `deleting` / `loading` intent model
3. **Lock-scope reduction design**
   - reduce session-ID lock hold times without reopening slot leaks/races
4. **Upstream cancellation contract**
   - align with upstream on hard-stop semantics after shutdown timeout

If not doing design work next, the safest tactical task is:
- finish reviewing the remaining unrelated dirty files and split them into intentional commits or reverts.

---

## ROLLBACK (CURRENT PASS ONLY)

If the current uncommitted hardening pass needs to be abandoned:

```bash
git restore --source=HEAD -- \
  src/command-classification.ts \
  src/command-journal.ts \
  src/resource-governor.ts \
  src/server-command-handlers.ts \
  src/server.ts \
  src/session-manager.ts \
  src/session-store.ts \
  src/types.ts \
  src/test-command-classification.ts \
  src/test-integration.ts \
  src/test.ts \
  PROTOCOL.md \
  docs/client-guide.md \
  next_session_prompt.md

npm run build
npm test
npm run test:integration
npm run test:fuzz
npm run check
```

---

## ADR INDEX FOR THIS AREA

- `docs/adr/0001-atomic-outcome-storage.md`
- `docs/adr/0007-session-persistence.md`
- `docs/adr/0014-pluggable-authentication.md`
- `docs/adr/0019-durable-command-journal-foundation.md`
- `docs/adr/0020-failure-atomic-lifecycle-and-canonical-replay.md`
