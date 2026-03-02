# pi-server Vision

**Status:** Draft (2026-03-02)  
**Scope:** 10,000ft view + forward strategy  
**Method:** Deep-review trigger stack (Inversion → Telescopic → Nexus → Audit → Blast Radius → Escape Hatch → Crystallization)

---

## 0) Executive summary (where we are now)

pi-server is no longer a prototype. It is a **reliable single-node session multiplexer** with strong correctness semantics:

- Deterministic per-lane execution + dependency gates
- Atomic outcome storage and replay-safe idempotency
- Bounded in-memory stores and rejection-based backpressure controls
- Session lifecycle locking and race-condition hardening
- Extension UI round-trip wiring with bounded pending requests
- Pluggable auth, metrics, and logging abstractions
- Strong test gates passing (`npm test`, `npm run test:integration`, `npm run test:fuzz`)

At the same time, pi-server has not yet crossed into **audit-grade infrastructure**. The biggest unfinished frontier is still Level 4: **durable command journaling + crash recovery**.

---

## 1) INVERSION (shadow analysis)

What must be true for pi-server to look healthy while still being sick?

1. **Healthy tests, stale truth surfaces**  
   Runtime emits `serverVersion: "0.1.0"` while package is `2.0.1`.
2. **Strong architecture, drifting narrative**  
   Docs still describe authentication as planned in places, while auth is implemented.
3. **Pluggable logging exists, but console paths remain**  
   Structured logger exists, yet many core paths still use `console.*` directly.
4. **Single-node determinism is strong, crash semantics are not yet durable**  
   In-memory replay guarantees are excellent until process death.

These are not catastrophic bugs, but they are trust erosions at system boundaries.

---

## 2) TELESCOPIC (micro + macro)

### Micro (implementation-level reality)

- Core stores are bounded (in-flight, outcomes, extension UI pending requests, rate limit maps).
- Race-condition patterns are concretely applied (`settled` flags, lock manager, cleanup guards).
- Timeout semantics are explicit and deterministic (timeout is stored terminal outcome).
- Test surface is broad (unit + integration + fuzz) and currently green.

### Macro (system-level reality)

- Architecture follows clean seams (router/handlers/stores/execution engine/session resolver).
- Reliability posture is high for a single process.
- Release automation is mature (release-please + trusted publish + CI gates).
- **Main strategic gap:** no durable journal/recovery model yet (Roadmap Level 4 still open).

### Synthesis

pi-server has solved many “hard local correctness” problems. The next frontier is “hard temporal correctness”:

- correctness across restarts,
- replay/audit beyond process memory,
- forensic traceability and compliance posture.

---

## 3) NEXUS (highest-leverage intervention)

**The Nexus:** Build a **Durable Truth Plane**.

In practical terms, this means:

1. **Durable command journal** (append-only, per-lane ordered, terminal outcomes)
2. **Recovery semantics** (deterministic startup rehydration + explicit classification)
3. **Single-source metadata truth** (version/protocol/docs/runtime generated from one source)

Why this is the nexus:

- Solves crash survivability, auditability, and replay confidence together
- Reduces doc/runtime drift by introducing generated truth artifacts
- Enables future enterprise posture (compliance, forensic exports, incident replay)

---

## 4) AUDIT (bugs, debt, smells, gaps)

### BUGS / correctness-adjacent defects

- **Version identity drift:** runtime/server metadata reports `0.1.0` while published package is `2.x`.

### DEBT

- **Documentation drift debt:** roadmap/docs still reference outdated status in several places.
- **Observability debt:** logger abstraction exists, but core paths are mixed between logger and `console.*`.
- **Centralization debt:** `session-manager.ts` remains a large orchestration hotspot.

### SMELLS

- Multiple truth sources for version/status (package, runtime constants, docs, ADR status).
- Partial migration patterns (structured logging introduced, not fully enforced).

### GAPS

- No durable replay substrate yet (Level 4 incomplete).
- No formal invariant/chaos release gate yet (Level 5 incomplete).
- Missing explicit “docs freshness” release check.

### Root cause

The core has evolved fast and correctly, but **truth synchronization mechanisms** (runtime metadata, docs, lifecycle status) have not been fully automated.

---

## 5) BLAST RADIUS (for the next major move)

### Change summary
Implement Level 4 durable journal + truth alignment hardening.

### Direct effects

- `session-manager`, execution/replay pipeline, persistence layer
- protocol surface (`get_command_history`, recovery metadata/events)
- startup/shutdown behavior

### Secondary effects

- test strategy shifts from in-memory correctness to restart/recovery correctness
- metrics/logging dimensions expand (recovery classification, journal lag, compaction stats)
- operational docs and client expectations must be updated

### Tertiary effects

- unlocks incident replay tooling and compliance narratives
- enables stronger multi-user/enterprise packaging later

### Risk assessment

- **Scope:** Global
- **Reversibility:** Recoverable (if feature-flagged and append-only format is versioned)
- **Confidence:** Medium (design known, implementation still substantial)

---

## 6) ESCAPE HATCH (rollback-first)

For Level 4 rollout, enforce reversibility by design:

1. Ship journal behind feature flag (`durableJournal.enabled`)
2. Keep in-memory behavior as fallback path during rollout
3. Use additive protocol fields/events only in first release
4. Maintain journal schema version + migration guard

**Point of no return:** once durability becomes required for command admission.  
Until then, rollback is straightforward by disabling the feature flag and ignoring on-disk journal.

---

## 7) CRYSTALLIZED LEARNINGS

1. Correctness invariants are now a strength; preserve them as non-negotiable constraints.
2. “Reject, don’t evict” and bounded structures should remain baseline design policy.
3. Replay semantics are product-defining; durability is the natural next step.
4. Architecture quality is high enough to support Level 4 without a rewrite.
5. Documentation/version drift is now a first-class reliability issue, not cosmetic debt.

---

## 8) Vision statement (12–18 months)

pi-server becomes the **deterministic, crash-survivable command fabric** for the pi ecosystem:

- deterministic while alive,
- durable across failure,
- auditable after the fact,
- observable in real time,
- safe by default under pressure.

### Strategic pillars

1. **Protocol Truth** — single generated source for command types, protocol version, runtime metadata
2. **Durable Causality** — command journal, deterministic recovery, replay extraction
3. **Operational Trust** — unified structured logging + pluggable metrics + actionable alerts
4. **Adversarial Confidence** — invariant/property/chaos gates as release requirements

---

## 9) Horizon plan

### Horizon A (now → 2 weeks): alignment hardening

- unify runtime version sourcing from `package.json`
- docs sync pass (ROADMAP/README/PROTOCOL/ADR status consistency)
- add CI check for version/docs drift

### Horizon B (2 → 8 weeks): Level 4 foundation

- choose journal backend + durability profile
- persist admitted command envelope + terminal outcomes
- startup rehydration + deterministic recovery summary

### Horizon C (8 → 16 weeks): Level 4 completion + Level 5 entry

- `get_command_history` + replay export path
- retention/compaction with replay equivalence guarantees
- begin invariant suite + fault injection smoke gates

---

## 10) Success metrics

- **Determinism:** same command identity always yields same outcome (including timeout)
- **Recovery:** no protocol corruption under forced-kill restart tests
- **Drift:** zero runtime/package/docs version mismatches at release time
- **Observability:** 100% command lifecycle traceability with structured logs/metrics
- **Confidence:** invariant + chaos smoke required in release pipeline

---

## 11) Non-goals (for now)

- distributed global ordering across nodes
- full multi-tenant RBAC matrix
- replacing lane model with distributed transaction orchestration

The next win is not scale-first; it is **durable trust-first**.
