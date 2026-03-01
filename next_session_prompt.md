# pi-server: Next Session Prompt

**Operating mode:** Production ready  
**Phase:** COMPLETE  
**Version:** 2.0.0 (pending release)  
**Formalization Level:** 2 (Bounded Run)

---

## SESSION STATUS (2026-03-01)

### LATEST ADDITION

| Feature | Description | Files |
|---|---|---|
| `navigate_tree` RPC command | Session tree navigation with optional branch summarization | `src/types.ts`, `src/command-router.ts`, `PROTOCOL.md` |

### RESOLVED (Deep Review + Follow-up Stabilization)

| Finding | Fix Applied | Files |
|---|---|---|
| Busy rejection still executed command side effects | Added pre-admission in-flight capacity gate so `Server busy` rejects before execution starts | `src/session-manager.ts`, `src/command-replay-store.ts` |
| Timeout replay drift for idempotency keys | Moved idempotency caching to terminal response path (includes timeout outcomes) | `src/session-manager.ts` |
| `command_accepted` without `command_finished` on early rejects | Introduced unified `finalizeResponse()` and routed replay/rate-limit/busy exits through it | `src/session-manager.ts` |
| `load_session` sessionVersion inconsistent/missing | Added explicit `load_session` handling to initialize and return `sessionVersion: 0` | `src/session-version-store.ts` |
| Shutdown uptime metric dropped | Emit uptime gauge before final `metrics.flush()` | `src/server.ts` |
| `create_session`/`load_session` flaky under `npm test` due to env leakage | Sanitized `npm_config_prefix`/`NPM_CONFIG_PREFIX` around `createAgentSession()` to prevent project-local global installs (`./lib/node_modules`) | `src/session-manager.ts` |
| CI failed on format gate | Applied Biome normalization across source set | 11 formatting-only files |
| **Path traversal vulnerability in load_session** | Added `validateSessionPath()` to reject `..`, relative paths, null bytes, paths outside allowed directories | `src/validation.ts`, `src/session-manager.ts` |

### TESTS ADDED/UPDATED

- `src/test.ts`
  - server busy rejection must not mutate state
  - idempotency replay preserves timeout terminal outcome
  - admitted rate-limited commands emit `command_finished`
  - `load_session` initializes version to `0` (auto + explicit session id)
  - shutdown flush includes uptime metric
  - `create_session` ignores leaked `npm_config_prefix`
  - **8 path validation tests** (relative, traversal, null byte, extension, allowed dirs)
- `src/test-session-version-store.ts`
  - `load_session` initializes version to `0`

---

## COMMITS (LATEST)

1. `navigate_tree` — `feat: add navigate_tree RPC command for session tree navigation`
   - New command: `navigate_tree` with `targetId` and optional `options` (summarize, customInstructions, replaceInstructions, label)
   - Response includes `editorText`, `cancelled`, `aborted`
   - Protocol docs: §17.3 with full request/response examples
   - Wire: `src/types.ts`, `src/command-router.ts`
2. `62d2d04` — `security: add path validation to load_session + protocol docs`
   - Security fix: path traversal prevention in `load_session`
   - Protocol docs: §2.1, §16-22 (401 lines)
   - ADR-0007: session persistence documentation
   - 8 new tests (112 total)
3. `8ab9eec` — `Merge branch 'main' of https://github.com/tryingET/pi-server`
   - Merged remote release-please PR (v1.0.0 release)
4. `722e25b` — `chore(package): add pi-package keyword for discoverability`
   - Added `pi-package` keyword to package.json for Pi package gallery
5. `f603a9f` — `docs(readme): clarify package is standalone server`
   - Added note clarifying this is not an extension/skills/themes bundle
6. `d9eb6a8` — `style(format): apply biome normalization across source files`
   - Formatting-only commit (11 files)
7. `9f67477` — `fix(session): sanitize npm prefix during agent session creation`
   - Functional fix + regression test (`src/session-manager.ts`, `src/test.ts`)

(Previous deep-review atomic fix commits are already on `main`.)

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
| Version | **2.0.0** (pending release) |
| `npm run check` | ✅ |
| `npm run build` | ✅ |
| `npm test` | ✅ 112 passed, 0 failed |
| `npm run test:integration` | ✅ 26 passed, 0 failed |
| `npm run test:fuzz` | ✅ 17 passed, 0 failed |
| `npm run ci` | ✅ |

---

## NEXT STEPS

1. Continue development on `main` — release-please will create subsequent release PRs.
2. Keep upstream AbortSignal proposal as top external unblocker.
3. Optional: add small startup diagnostic log when npm prefix sanitization is applied (debug-only).
4. Submit `upstream-proposal-pi-protocol.md` to pi-mono maintainers for shared protocol types.

---

## ROLLBACK (LATEST CHANGES)

```bash
# revert latest security commit
git revert 62d2d04

# re-validate
npm run ci
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
| **Path traversal protection in load_session** | ✅ Fixed + regression-tested |
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
