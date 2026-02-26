# pi-server Roadmap

This roadmap is an execution document, not an idea backlog.
Each unchecked item requires an **owner**, an **acceptance test**, and a **decision gate**.

### Quick navigation

- [Program status](#program-status)
- [Level 3 — Causal Command Protocol (complete)](#level-3--causal-command-protocol-complete)
- [Level 4 — Durable command journal + replay (next)](#level-4--durable-command-journal--replay-next)
- [Level 5 — Formal invariants + chaos harness](#level-5--formal-invariants--chaos-harness)
- [Decision ledger (open)](#decision-ledger-open)
- [Operating discipline](#operating-discipline)

---

## Program status

- **Current phase:** Level 3 (Causal Command Protocol)
- **State:** ✅ **Complete**
- **Protocol baseline:** `1.0.0`
- **Normative contract:** `PROTOCOL.md`

---

## Level 3 — Causal Command Protocol (complete)

### L3.1 Deterministic execution lanes ✅
- [x] Serialize commands by lane (`session:<id>` / `server`)
- [x] Preserve causal order for burst traffic on the same session
- [x] Add integration coverage

**Acceptance evidence**
- `integration: serializes create -> steer -> follow_up on same session lane`

### L3.2 Causal command envelope ✅
- [x] Support `dependsOn`, `ifSessionVersion`, `idempotencyKey`
- [x] Validate envelope fields at admission
- [x] Gate execution on dependency + version preconditions

**Acceptance evidence**
- Validation coverage for envelope fields
- Session manager coverage for dependency + version checks

### L3.3 Lifecycle visibility ✅
- [x] Emit `command_accepted`, `command_started`, `command_finished`
- [x] Include causal metadata + outcome fields
- [x] Document ordering guarantees

**Acceptance evidence**
- `integration: emits command lifecycle events`
- lifecycle contract documented in `README.md` and `PROTOCOL.md`

### L3.4 Replay safety ✅
- [x] Implement TTL idempotency cache
- [x] Replay duplicate command IDs from in-flight/completed outcomes
- [x] Reject conflicting `id`/`idempotencyKey` fingerprints

**Acceptance evidence**
- Unit + integration coverage for replay and conflict paths

### L3.5 Session versioning ✅
- [x] Track monotonic per-session `sessionVersion`
- [x] Keep read-only commands version-neutral
- [x] Return `sessionVersion` in applicable successful responses

**Acceptance evidence**
- Tests for create/switch/mutation version behavior

### L3.6 Hardening closure ✅
- [x] Dependency timeout behavior
- [x] Idempotency TTL expiry behavior
- [x] Replay behavior around timeout edge cases

**Acceptance evidence**
- Runtime-tuned unit tests for timeout/TTL boundaries

---

## Level 4 — Durable command journal + replay (next)

> Goal: make causality crash-survivable and replay-auditable.

### L4.1 Durable command journal
- [ ] Persist envelope + lifecycle transitions + terminal outcome
- [ ] Assign deterministic per-lane sequence numbers
- [ ] Define stable on-disk schema + migration policy

**Owner:** TBD

**Acceptance tests**
- Restart preserves completed outcomes
- Journal entries are strictly ordered per lane
- One-version schema migration fixture passes

**Decision gate (DG-L4.1)**
- Backend choice: append-only JSONL vs embedded store (SQLite)
- Durability mode: strongest fsync vs throughput-biased

### L4.2 Crash recovery model
- [ ] Rehydrate journal on startup
- [ ] Classify pre-crash in-flight commands (`recoverable` / `failed`) with explicit reason
- [ ] Expose recovery summary event/endpoint

**Owner:** TBD

**Acceptance tests**
- Forced kill during active commands recovers without protocol corruption
- Recovery classification is deterministic across repeated boots

**Decision gate (DG-L4.2)**
- Side-effect policy for in-flight work: compensate vs mark failed

### L4.3 Replay and trace extraction
- [ ] Deterministic replay mode for audit/debug
- [ ] `get_command_history` API (session, commandId, time-window filters)
- [ ] Redaction-aware export path for incident reports

**Owner:** TBD

**Acceptance tests**
- Replay output matches lane order + terminal outcomes
- History API round-trips trace fixtures

**Decision gate (DG-L4.3)**
- Replay placement: in-process feature vs offline tool

### L4.4 Retention, compaction, privacy controls
- [ ] Retention policy (time + size)
- [ ] Compaction that preserves replay correctness
- [ ] PII redaction hooks before persistence/export

**Owner:** TBD

**Acceptance tests**
- Compaction remains replay-equivalent
- Redaction policy enforced on persistence + export

**Decision gate (DG-L4.4)**
- Compliance envelope: retainable vs prohibited data classes

---

## Level 5 — Formal invariants + chaos harness

> Goal: adversarial confidence, not just happy-path confidence.

### L5.1 Invariant suite
- [ ] Property tests: dependency causality
- [ ] Property tests: deterministic per-session order
- [ ] Property tests: sessionVersion monotonic/gap-free on success

**Owner:** TBD

**Acceptance tests**
- Invariants hold under randomized schedules

### L5.2 Fault injection
- [ ] Inject transport drops, duplicates, delayed writes, partial frames
- [ ] Inject extension UI stalls and timeout races
- [ ] Inject journal write failures (L4+)

**Owner:** TBD

**Acceptance tests**
- No invariant regression under configured fault matrix

### L5.3 Concurrency fuzzing
- [ ] Build randomized multi-client burst harness
- [ ] Differential-check against single-threaded reference model

**Owner:** TBD

**Acceptance tests**
- Differential checker reports zero semantic drift across seeded runs

### L5.4 SLO-backed release gates
- [ ] CI gate: invariant suite + chaos smoke
- [ ] Release gate: replay determinism non-regression

**Owner:** TBD

**Acceptance tests**
- Build fails on reliability SLO regression

---

## Decision ledger (open)

- **DL-001:** journal backend + durability profile (L4.1)
- **DL-002:** recovery semantics for side-effecting in-flight commands (L4.2)
- **DL-003:** replay engine placement: in-process vs offline (L4.3)
- **DL-004:** retention/compliance data envelope (L4.4)

---

## Operating discipline

1. Update this file in the same PR as architecture/protocol changes.
2. No item closes without acceptance evidence (test name or artifact).
3. Deferred findings require: rationale, owner, trigger, deadline, blast radius.
4. Link incidents to roadmap items so failure becomes design input, not recurring surprise.
