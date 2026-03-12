# Implementation Plan — ADR-0021 Follow-Through

## Purpose

This plan turns `ADR-0021` into an executable backlog for the **next hardening wave**.

ADR-0021 established the architecture:
- command contract registry
- protocol-pure stdio for built-ins
- opaque replay identity
- serialized env sanitization
- complete shutdown disposal

The first implementation landed the core fixes.
This plan covers the **remaining architectural closure work** so the design is enforced end-to-end instead of only by convention.

## Current State

### Already implemented
- centralized command contract resolution in `src/command-classification.ts`
- no-timeout classification for non-abortable durable mutations
- versioned hashed replay fingerprints (`v2:sha256:*`)
- legacy raw-fingerprint replay compatibility
- built-in stdout/stderr separation for logs/alerts/console sinks
- stdio regression tests that fail on non-JSON stdout pollution
- global mutex for npm env sanitization during `createAgentSession()`
- logger + metrics sink disposal on shutdown

### Remaining architectural gaps
1. **Custom integrations can still violate stdout purity** by writing directly to `stdout`.
2. **Command contract coverage is not yet mechanically exhaustive** at the type/system boundary.
3. **Fingerprint versioning is implicit in the prefix**, not an explicit exported schema contract.
4. **Operational observability of migration state is weak** (legacy fingerprint counts, purity violations, contract drift).
5. **Regression coverage is good but not yet organized as a hardening suite** tied to the architecture.

## Architectural Goal

Move from:
> “the built-ins behave correctly”

to:
> “the system makes the correct behavior the path of least resistance, and drift becomes detectable.”

---

## Workstreams

## WS1 — Output Channel Enforcement

### Objective
Make protocol purity enforceable beyond current built-ins.

### Design
Introduce explicit output-channel abstractions:
- `ProtocolWriter` — machine-readable transport frames only
- `DiagnosticWriter` — human-readable diagnostics only
- `OutputPolicy` / `TransportOutputGuard` — prevents stdout misuse in stdio mode

### Deliverables
- a small internal output abstraction layer in server transport code
- wrappers/adapters for built-in logger + alert + metrics console surfaces
- a documented contract for custom integrations
- tests that prove stdio mode stays protocol-pure under default server startup/shutdown paths

### Exit criteria
- no built-in code path writes human-readable diagnostics to stdout in stdio mode
- custom integration guidance points to the safe output abstraction
- CI fails if a new built-in stdout diagnostic slips in

---

## WS2 — Exhaustive Command Contract Coverage

### Objective
Make the command contract registry authoritative and mechanically complete.

### Design
Replace “best-effort classification by string sets” with an exhaustive mapping strategy:
- every command type must resolve through one typed contract entry
- add compile-time or test-time drift detection between `RpcCommand` union and registry coverage
- make timeout/abortability/history sensitivity impossible to forget when adding commands

### Deliverables
- explicit contract map keyed by command type
- drift-check test ensuring every command in `RpcCommand` has a contract entry
- contributor guidance for adding commands

### Exit criteria
- adding a new command without a contract entry fails CI
- command behavior is reviewable from one location

---

## WS3 — Replay Fingerprint Schema Contract

### Objective
Turn fingerprint versioning into an explicit protocol/history contract.

### Design
Add explicit schema semantics for replay identity:
- introduce a named fingerprint schema/version in exported history data
- document compatibility policy for legacy raw fingerprints and future digest migrations
- count and expose legacy-normalized entries for operators

### Deliverables
- history/export shape updated with fingerprint schema metadata
- migration notes in docs/ADR/PROTOCOL
- metrics or recovery counters for legacy fingerprint normalization

### Exit criteria
- operators can tell whether they are still carrying legacy replay data
- future fingerprint migrations do not require archaeology

---

## WS4 — Observability and Drift Detection

### Objective
Make architectural regressions visible before users discover them.

### Design
Add explicit observability for:
- legacy fingerprint normalization counts
- protocol purity violations / blocked stdout diagnostics
- contract coverage drift checks
- shutdown disposal failures

### Deliverables
- metrics and/or diagnostic counters in `get_metrics`
- evidence-oriented test assertions
- log lines or metrics with stable names

### Exit criteria
- operators can detect partial rollout/drift from the running system
- architecture violations are visible without code inspection

---

## WS5 — Architecture Regression Suite

### Objective
Turn this architecture into a reusable verification surface.

### Design
Create a named regression/hardening suite covering:
- non-abortable mutation timeout safety
- protocol purity over stdio
- replay identity opacity
- legacy replay continuity
- env sanitization serialization
- shutdown disposal completeness

### Deliverables
- grouped tests or documented test sections
- CI inclusion under normal build/test flow
- checklist mapping tests back to ADR-0021 invariants

### Exit criteria
- each ADR-0021 invariant has an automated proof point
- failures localize to the violated invariant

---

## Recommended Sequence

### Phase 1 — Guardrails first
1. WS2 — Exhaustive command contract coverage
2. WS1 — Output channel enforcement

Why first:
- they prevent new drift while later work lands

### Phase 2 — Schema clarity
3. WS3 — Replay fingerprint schema contract

Why next:
- replay/history semantics become explicit before more durable rollout

### Phase 3 — Operational safety net
4. WS4 — Observability and drift detection
5. WS5 — Architecture regression suite

Why last:
- observability and proofs should target the stabilized shape

---

## Dependency Graph

```text
WS2 (contract coverage) ───────┐
                               ├──► WS4 (observability)
WS1 (output enforcement) ──────┤
                               └──► WS5 (regression suite)

WS3 (fingerprint schema) ──────┬──► WS4 (observability)
                               └──► WS5 (regression suite)
```

---

## Risk Notes

### Highest risk if delayed
- custom logger/sink stdout contamination in stdio deployments
- future command additions missing safe timeout classification
- fingerprint version drift without export-level schema clarity

### Rollback posture
- WS1/WS2 are low-regret and reversible
- WS3 requires compatibility discipline because it touches durable/history-facing semantics
- WS4/WS5 are additive and low-risk

---

## Verification Strategy

For each workstream, require:
- unit tests
- integration proof where transport behavior changes
- docs update if a public or semi-public contract changes
- explicit rollback note if durable/history schema changes

Global acceptance command set:

```bash
npm run build
npm test
npm run test:integration
npm run test:fuzz
npm run check
```

---

## Task Mapping

This plan is intended to map into society.v2 task items as:
1. Output channel abstraction + enforcement
2. Contract registry exhaustiveness gate
3. Fingerprint schema/export contract
4. Architecture observability counters
5. Architecture regression suite
6. Docs + operator guidance for custom integrations

---

## Definition of Done

ADR-0021 follow-through is complete when:
- protocol purity is enforced by abstraction, not only by discipline
- command contracts are exhaustive and CI-enforced
- replay fingerprint versioning is explicit in export/history semantics
- drift is visible in metrics/tests
- the hardening architecture is documented for contributors and operators
