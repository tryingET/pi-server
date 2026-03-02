# pi-server: Next Session Prompt

**Operating mode:** Production-ready, reliability-first  
**Current phase:** Level 4 (Durable command journal + replay) — active planning  
**Version:** 2.0.1 (current)  
**Formalization Level:** 2 (Bounded Run)

---

## SESSION STATUS (2026-03-02)

### LATEST ADDITIONS

| Feature | Description | Files |
|---|---|---|
| 10,000ft project vision | Added deep-review-based strategic vision doc with Horizon A/B/C plan | `docs/project/vision.md` |
| Runtime version truth unification | Removed hardcoded server version; runtime now reads from `package.json` for `server_ready` and server metadata defaults | `src/server.ts`, `src/session-store.ts` |
| Authentication docs alignment | Marked ADR-0009 as superseded, added ADR-0014 (implemented auth), updated README/PROTOCOL/docs index | `docs/adr/0009-connection-authentication.md`, `docs/adr/0014-pluggable-authentication.md`, `README.md`, `PROTOCOL.md`, `docs/README.md` |
| Program status alignment | Roadmap now reflects Level 4 active planning instead of Level 3 current-phase messaging | `ROADMAP.md` |
| Version/docs drift gate | New consistency checker validates runtime/package/docs alignment; wired into local CI script + GitHub CI workflow | `scripts/check-version-docs.mjs`, `package.json`, `.github/workflows/ci.yml` |

---

## RESOLVED IN THIS SESSION (Horizon A)

| Finding | Fix Applied | Files |
|---|---|---|
| Runtime/server version drift (`0.1.0` vs package version) | Version now loaded from `package.json` at runtime with safe fallback | `src/server.ts`, `src/session-store.ts` |
| Authentication narrative drift | Replaced “planned” messaging with implemented ADR-0014 references | `README.md`, `PROTOCOL.md`, `docs/README.md` |
| Stale ADR status | Rewrote ADR-0009 as historical/superseded; created ADR-0014 as current source of truth | `docs/adr/0009-connection-authentication.md`, `docs/adr/0014-pluggable-authentication.md` |
| No automated drift detection | Added machine-enforced check for version/auth/roadmap doc consistency | `scripts/check-version-docs.mjs`, `package.json`, `.github/workflows/ci.yml` |

---

## TEST / VERIFICATION SNAPSHOT (CURRENT)

All of the following were run after the Horizon A changes:

| Check | Status |
|---|---|
| `npm run check:consistency` | ✅ |
| `npm run ci` | ✅ |
| `npm run test:integration` | ✅ 27 passed, 0 failed |
| `npm run test:fuzz` | ✅ 17 passed, 0 failed |

Notable runtime verification:
- `server_ready.data.serverVersion` now emits **`2.0.1`** (aligned with `package.json`).

---

## ACTIVE DEFERRED CONTRACTS (CARRIED FORWARD)

| Finding | Rationale | Owner | Trigger | Deadline | Blast Radius |
|---|---|---|---|---|---|
| **Durable command journal + recovery model (Level 4)** | Needed for crash survivability, audit/replay beyond process lifetime | Maintainer | Level 4 execution start | Current phase | Global correctness across restarts |
| **AbortController integration upstream** | Requires `@mariozechner/pi-coding-agent` API support for caller-provided `AbortSignal` | Maintainer | Upstream accepts proposal (`upstream-proposal-abortcontroller.md`) | Next major version | Timeout semantic mismatch + wasted LLM tokens |
| **AgentSession backpressure API** | Deferred as YAGNI at current throughput; revisit with telemetry evidence | Maintainer | Sustained high `ws.bufferedAmount` / memory pressure metrics | When needed | Potential OOM under pathological slow consumers |

---

## NEXT STEPS (PRIORITIZED)

1. **Start Horizon B / Level 4 foundation**
   - Decide journal backend (append-only JSONL vs SQLite)
   - Define on-disk schema + migration policy
   - Implement deterministic startup rehydration path

2. **Preserve truth alignment discipline**
   - Keep `check:consistency` green in all PRs
   - Extend checker once Level 4 artifacts land (journal schema version checks)

3. **Optional near-term hardening**
   - Continue reducing `console.*` in core runtime paths in favor of structured `Logger`
   - Add a release-time docs freshness checklist entry (if not automated)

---

## ROLLBACK (THIS SESSION)

```bash
# Revert latest alignment + consistency-gate changes (after commit)
# Replace <new-commit-sha> with actual SHA

git revert <new-commit-sha>

# Re-validate
npm run ci
npm run test:integration
npm run test:fuzz
```

---

## PRODUCTION READINESS (POST-HORIZON-A)

| Check | Status |
|---|---|
| Runtime/package version alignment | ✅ enforced by check script |
| Auth docs/source-of-truth alignment | ✅ ADR-0014 canonicalized |
| Roadmap phase alignment | ✅ Level 4 active planning reflected |
| Deterministic replay/timeouts invariants | ✅ retained |
| Full test gates | ✅ green |

**Verdict:** ✅ Ready to proceed into Level 4 implementation with a cleaner truth surface and automated drift protection.

---

## UPSTREAM PROPOSALS

See `~/programming/pi-extensions/issue-tracker/pi-mono-upstream/` for pending upstream change requests:
- `extension-ui-wouldexceedlimit.md` — ExtensionUIContext.wouldExceedLimit() method
- `shared-protocol-package.md` — Shared @mariozechner/pi-protocol package extraction

Historical proposals archived in this repo:
- `upstream-proposal-abortcontroller.md` — AbortSignal integration
