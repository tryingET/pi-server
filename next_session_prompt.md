# pi-server: Next Session Prompt

**Operating mode:** Production ready  
**Phase:** COMPLETE  
**Version:** 2.0.0 (current)  
**Formalization Level:** 2 (Bounded Run)

---

## SESSION STATUS (2026-03-02)

### LATEST ADDITIONS

| Feature | Description | Files |
|---|---|---|
| Validation hardening pass | Added `navigate_tree` validation, canonical `sessionPath` checks (symlink-safe), and validator/router parity guard | `src/validation.ts`, `src/test.ts` |
| Debug diagnostics for npm env sanitization | Added one-time debug-level diagnostic when npm prefix env keys are sanitized during `createAgentSession()` | `src/session-manager.ts`, `src/server.ts`, `src/test.ts` |
| Navigate-tree acceptance guard | Added explicit router assertion + WebSocket integration probe to ensure `navigate_tree` is treated as a known command (not unknown-command drift) | `src/test.ts`, `src/test-integration.ts` |

### RESOLVED (Deep Review + Follow-up Stabilization)

| Finding | Fix Applied | Files |
|---|---|---|
| Busy rejection still executed command side effects | Added pre-admission in-flight capacity gate so `Server busy` rejects before execution starts | `src/session-manager.ts`, `src/command-replay-store.ts` |
| Timeout replay drift for idempotency keys | Moved idempotency caching to terminal response path (includes timeout outcomes) | `src/session-manager.ts` |
| `command_accepted` without `command_finished` on early rejects | Introduced unified `finalizeResponse()` and routed replay/rate-limit/busy exits through it | `src/session-manager.ts` |
| `load_session` sessionVersion inconsistent/missing | Added explicit `load_session` handling to initialize and return `sessionVersion: 0` | `src/session-version-store.ts` |
| Shutdown uptime metric dropped | Emit uptime gauge before final `metrics.flush()` | `src/server.ts` |
| `create_session`/`load_session` flaky under `npm test` due to env leakage | Sanitized `npm_config_prefix`/`NPM_CONFIG_PREFIX` around `createAgentSession()` to prevent project-local global installs (`./lib/node_modules`) | `src/session-manager.ts` |
| **Path traversal vulnerability in load_session** | Added `validateSessionPath()` to reject `..`, relative paths, null bytes, and paths outside allowed directories | `src/validation.ts`, `src/session-manager.ts` |
| `navigate_tree` rejected as unknown command | Added `navigate_tree` to validation command set | `src/validation.ts` |
| `navigate_tree` payload not runtime-validated | Added validation for `targetId` and typed `options` fields | `src/validation.ts` |
| `sessionPath` symlink escape under allowed directory | Switched to canonical path checks (`realpath`) for both target path and allowlisted roots | `src/validation.ts` |
| Validation/router drift risk for session commands | Added parity test ensuring all router commands are recognized by validator | `src/test.ts` |
| npm prefix sanitization was not observable | Added debug logger hook + one-time sanitization diagnostic and test | `src/session-manager.ts`, `src/server.ts`, `src/test.ts` |

### TESTS ADDED/UPDATED

- `src/test.ts`
  - server busy rejection must not mutate state
  - idempotency replay preserves timeout terminal outcome
  - admitted rate-limited commands emit `command_finished`
  - `load_session` initializes version to `0` (auto + explicit session id)
  - shutdown flush includes uptime metric
  - `create_session` ignores leaked `npm_config_prefix`
  - `navigate_tree` validation (valid command, missing `targetId`, invalid `options`)
  - `sessionPath` symlink escape rejection
  - router/validator parity guard for all session commands
  - router expected command list now explicitly requires `navigate_tree`
  - one-time npm sanitization debug diagnostic assertion
- `src/test-integration.ts`
  - `navigate_tree` must be accepted as a known command over WebSocket (guards against unknown-command regression)
- `src/test-session-version-store.ts`
  - `load_session` initializes version to `0`

---

## COMMITS (LATEST)

1. `22162d4` — `feat(session-manager): emit debug diagnostics for npm env sanitization`
   - Added optional debug logger hook to `PiSessionManager`
   - Emits one-time diagnostic when npm env keys are sanitized
   - Wired to server structured logger at debug level
2. `13c3e36` — `fix(validation): harden session path and navigate_tree checks`
   - Added `navigate_tree` to validator command set + payload checks
   - Hardened `validateSessionPath()` with canonical path checks against symlink escapes
   - Added regression tests including router/validator parity
3. `7a0f604` — `feat(protocol): add navigate_tree RPC command for session tree navigation`
   - New command: `navigate_tree` with `targetId` and optional `options`
   - Response includes `editorText`, `cancelled`, `aborted`
   - Protocol docs: §17.3 with request/response examples
4. `5ab6870` — `fix(ci): add explicit build step to publish workflow`
   - Ensures publish workflow has built artifacts
5. `0638f05` — `chore(main): release 2.0.0`
   - release-please managed release commit
6. `29024d0` — `fix(security)!: add path validation to load_session + protocol docs`
   - Initial path traversal prevention + protocol documentation update

---

## DEFERRED WITH CONTRACT (CARRIED FORWARD)

| Finding | Rationale | Owner | Trigger | Deadline | Blast Radius |
|---|---|---|---|---|---|
| **AbortController integration upstream** | Requires `@mariozechner/pi-coding-agent` API support for caller-provided `AbortSignal` | Maintainer | Upstream accepts proposal (`upstream-proposal-abortcontroller.md`) | Next major version | Timeout semantic mismatch + wasted LLM tokens |
| **AgentSession backpressure API** | Deferred as YAGNI at current throughput; revisit with telemetry evidence | Maintainer | Sustained high `ws.bufferedAmount` / memory pressure metrics | When needed | Potential OOM under pathological slow consumers |

---

## VALIDATION SNAPSHOT (CURRENT)

| Check | Status |
|---|---|
| Version | **2.0.0** |
| `npm run check` | ✅ |
| `npm run build` | ✅ |
| `npm test` | ✅ 117 passed, 0 failed |
| `npm run test:integration` | ✅ 27 passed, 0 failed |
| `npm run test:fuzz` | ✅ 17 passed, 0 failed |
| `npm run ci` | ✅ |

---

## NEXT STEPS

1. Continue development on `main` — release-please will create subsequent release PRs.
2. For pi-web hard enforcement, point harness to this built checkout (`PI_SERVER_DIR=...`) and require `navigate_tree` support unconditionally.
3. Keep upstream AbortSignal proposal as top external unblocker.
4. Submit `shared-protocol-package.md` to pi-mono maintainers for shared protocol types.
5. Optional: document new debug sanitization diagnostic behavior in operator-facing docs.

---

## ROLLBACK (LATEST CHANGES)

```bash
# revert latest diagnostics + validation hardening commits
git revert 22162d4
git revert 13c3e36

# re-validate
npm run ci
npm run test:integration
npm run test:fuzz
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
| npm env leakage resilience in session creation | ✅ Fixed + regression-tested |
| `navigate_tree` validator compatibility + payload validation | ✅ Fixed + regression-tested |
| `sessionPath` symlink escape prevention | ✅ Fixed + regression-tested |
| npm sanitization observability | ✅ Added debug diagnostic + test |
| Upstream AbortSignal gap | 🔵 Deferred upstream |
| Backpressure API gap | 🟡 Deferred/YAGNI |

**Verdict:** ✅ Release-candidate ready; no known open local correctness defects in current gate suite.

---

## UPSTREAM PROPOSALS

See `~/programming/pi-extensions/issue-tracker/pi-mono-upstream/` for pending upstream change requests:
- `extension-ui-wouldexceedlimit.md` — ExtensionUIContext.wouldExceedLimit() method
- `shared-protocol-package.md` — Shared @mariozechner/pi-protocol package extraction

Historical proposals archived in this repo:
- `upstream-proposal-abortcontroller.md` — AbortSignal integration
