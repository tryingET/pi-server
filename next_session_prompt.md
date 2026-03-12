# pi-server: Next Session Prompt

**Operating mode:** Reliability-first, architecture-follow-through  
**Current phase:** ADR-0021 landed in code + docs; follow-through backlog created  
**Version:** 2.2.0  
**Formalization level:** 3 (ADR + implementation plan + tracked backlog)

---

## START HERE

Do **not** assume a clean working tree.

This session produced a substantial uncommitted hardening/design change-set.
At handoff time, the working tree includes code, tests, protocol/docs, and new ADR/plan docs.

### Current working tree state
Modified:
- `PROTOCOL.md`
- `README.md`
- `docs/README.md`
- `src/command-classification.ts`
- `src/command-journal.ts`
- `src/command-replay-store.ts`
- `src/logger-types.ts`
- `src/metrics-types.ts`
- `src/server.ts`
- `src/session-manager.ts`
- `src/session-store.ts`
- `src/test-command-classification.ts`
- `src/test-command-replay-store.ts`
- `src/test-integration.ts`
- `src/test.ts`
- `src/threshold-alert-sink.ts`

Untracked:
- `docs/adr/0021-command-contract-registry-and-protocol-purity.md`
- `docs/implementation-plan-adr-0021-follow-through.md`

### Immediate framing
The right next-session framing is:

> **Start by reviewing the uncommitted ADR-0021 change-set, preserve the verified invariants, and either commit it cleanly or continue with the new backlog in priority order.**

---

## CURRENT AUTHORITATIVE STATUS

### Verified now
This exact change-set was validated successfully with:
- `npm run build` → **PASSED**
- `npm test` → **PASSED**
- `npm run test:integration` → **PASSED**
- `npm run test:fuzz` → **PASSED**
- `npm run check` → **PASSED**

### What landed in code (uncommitted, but implemented + verified)

#### 1. Command contract registry
`src/command-classification.ts` now acts as a more explicit cross-cutting command contract surface for:
- timeout mode
- abortability
- mutation/read-only semantics
- control vs data plane classification
- history sensitivity

#### 2. Non-abortable mutation timeout hardening
Commands that can durably commit after a timeout are now classified as **no-timeout** instead of being transport-timeout-wrapped.
Notably:
- `create_session`
- `delete_session`
- `load_session`
- `set_session_name`
- `export_html`

This closes the reproduced bug where:
- client sees timeout failure
- command commits later anyway

#### 3. Replay identity hardening
Replay fingerprints are now:
- **versioned opaque digests**
- current shape: `v2:sha256:...`

Legacy raw JSON fingerprints remain replay-compatible through normalization.
History export no longer leaks raw payload content through fingerprint values.

#### 4. Protocol-pure stdio for built-ins
Built-in diagnostics were moved off stdout.
Implemented changes include:
- built-in logger writes to `stderr`
- built-in alert handler writes to `stderr`
- built-in console metrics sink defaults to `stderr`
- periodic SessionStore cleanup logging no longer uses `stdout`

Also strengthened stdio integration tests so **non-JSON stdout pollution now fails tests**.

#### 5. Global env sanitization mutex
`createAgentSessionWithSanitizedNpmEnv()` now serializes the temporary `process.env` sanitization critical section.
This closes the race where concurrent session creation could reintroduce `npm_config_prefix` leakage mid-flight.

#### 6. Shutdown disposal correctness
`PiServer.stop()` now disposes:
- metrics emitter/sinks
- logger

This closes the gap where flush happened but resource disposal did not.

---

## NEW ARCHITECTURE DOCS CREATED

### ADR
- `docs/adr/0021-command-contract-registry-and-protocol-purity.md`

This ADR captures the architectural rationale for:
- command contract registry
- protocol-pure stdio
- opaque replay identity
- global env mutation serialization
- dispose-not-just-flush shutdown semantics

### Follow-through implementation plan
- `docs/implementation-plan-adr-0021-follow-through.md`

This plan breaks the next hardening wave into workstreams:
- WS1 — output channel abstraction + enforcement
- WS2 — exhaustive command contract coverage
- WS3 — explicit replay fingerprint schema/export contract
- WS4 — observability and drift detection
- WS5 — architecture regression suite

---

## SOCIETY / AK BACKLOG STATUS

Tasks were created in:
- DB: `~/ai-society/society.v2.db`
- Repo: `/home/tryinget/ai-society/softwareco/owned/pi-server`

### Created tasks
- **#46** P1 — `ADR-0021: output channel abstraction + enforcement`
- **#47** P0 — `ADR-0021: make command contract registry exhaustive + CI-enforced`
- **#48** P1 — `ADR-0021: define explicit replay fingerprint schema + export contract`
- **#49** P2 — `ADR-0021: add observability for contract drift + legacy fingerprint normalization`
- **#50** P1 — `ADR-0021: build architecture regression suite for protocol purity and late-commit safety`
- **#51** P2 — `ADR-0021: publish operator/custom-integration guidance for stdout purity and replay schema`

### Dependencies
- **#49** depends on `46,47,48`
- **#50** depends on `46,47,48`
- **#51** depends on `46,48`

### Ready queue at handoff
Ready first:
1. **#47** — make command contract registry exhaustive + CI-enforced
2. **#46** — output channel abstraction + enforcement
3. **#48** — explicit replay fingerprint schema + export contract

Evidence was recorded for tasks `46-51` linking them to the implementation plan.

---

## PRIMARY NEXT SESSION OBJECTIVE

### First priority
Decide whether to:
1. **commit/split the current verified ADR-0021 change-set**, or
2. continue directly into **task #47** from the new backlog

### Recommended order if continuing implementation
1. **#47** — exhaustive command contract coverage
   - make it mechanically impossible to add a command without contract metadata
2. **#46** — output channel abstraction + enforcement
   - move from “built-ins behave correctly” to “safe output paths are structural”
3. **#48** — explicit replay fingerprint schema/export contract
   - make fingerprint versioning explicit in history/export semantics
4. **#49** — observability/drift counters
5. **#50** — architecture regression suite
6. **#51** — operator/custom integration guidance

---

## FILES TO READ FIRST

### If reviewing / committing the current hardening pass
- `docs/adr/0021-command-contract-registry-and-protocol-purity.md`
- `docs/implementation-plan-adr-0021-follow-through.md`
- `src/command-classification.ts`
- `src/command-replay-store.ts`
- `src/command-journal.ts`
- `src/server.ts`
- `src/session-manager.ts`
- `src/test.ts`
- `src/test-integration.ts`

### If starting task #47 next
- `src/types.ts`
- `src/command-classification.ts`
- `src/test-command-classification.ts`
- `docs/adr/0021-command-contract-registry-and-protocol-purity.md`
- `docs/implementation-plan-adr-0021-follow-through.md`

### If starting task #46 next
- `src/server.ts`
- `src/logger-types.ts`
- `src/metrics-types.ts`
- `src/threshold-alert-sink.ts`
- `src/test-integration.ts`
- `PROTOCOL.md`

---

## VALIDATION COMMANDS

### Standard gate
```bash
npm run build
npm test
npm run test:integration
npm run test:fuzz
npm run check
```

### Useful AK checks
```bash
ak task ready -d ~/ai-society/society.v2.db
ak evidence show -d ~/ai-society/society.v2.db 47
```

---

## KNOWN DEFERRED ITEMS (UPDATED)

| Finding | Rationale | Owner | Trigger | Deadline | Blast Radius |
|---|---|---|---|---|---|
| Custom integrations can still violate stdout purity | Built-ins are fixed, but custom logger/sink code can still write to stdout directly | pi-server maintainer | task #46 | before claiming universal stdio protocol purity | stdio clients can still break under custom integrations |
| Command contracts are not yet mechanically exhaustive | Current registry is stronger but still needs CI/drift-proof exhaustiveness | pi-server maintainer | task #47 | before next new command addition | classification drift can reintroduce unsafe semantics |
| Fingerprint versioning is implicit, not export-explicit | Prefix exists, but exported history/schema contract should say more | pi-server maintainer | task #48 | before broader durable-history/operator rollout | replay/history migration ambiguity |
| Observability for drift/legacy normalization is incomplete | Need counters/metrics for architecture-level migration state | pi-server maintainer | task #49 | before calling the migration operationally mature | silent drift / partial rollout risk |
| Architecture regression suite is not yet named and explicit | Coverage exists but should map cleanly to ADR-0021 invariants | pi-server maintainer | task #50 | before next hardening milestone closeout | future regressions become harder to localize |

---

## GUARDRAILS FOR THE NEXT SESSION

- Do **not** weaken the current no-timeout classification for non-abortable durable mutations without proving a safe abort/compensation path.
- Do **not** reintroduce any built-in stdout diagnostics in stdio mode.
- Preserve legacy replay compatibility while evolving fingerprint/export semantics.
- If you split commits, keep them reviewable:
  - core code + tests
  - docs/ADR/plan
  - handoff prompt refresh if needed
- If you continue implementation, anchor work to the AK task IDs rather than starting a fresh ad-hoc branch of ideas.

---

## SUCCESS CONDITION

You are done with the next session only when all are true:
- the current working-tree state is either committed cleanly or advanced deliberately
- the selected backlog task is resolved or materially advanced with evidence
- relevant tests are added or updated
- `npm run build`, `npm test`, `npm run test:integration`, `npm run test:fuzz`, and `npm run check` pass for behavioral changes
- `next_session_prompt.md` matches reality again

---

## ROLLBACK

If the next session goes sideways:

```bash
git restore --source=HEAD -- <touched-files>
npm run build
npm test
npm run test:integration
npm run test:fuzz
npm run check
```

If you need to discard the full current uncommitted change-set:

```bash
git restore --source=HEAD -- .
git clean -fd
```

---

## NOTE

The previous handoff that assumed “clean tree, pick the next issue later” is no longer accurate.

The right current framing is:

> **ADR-0021 has been implemented and verified in an uncommitted change-set, an implementation plan now exists, AK backlog items 46-51 are created, and the next deliberate move is to review/commit this state or start task #47.**
