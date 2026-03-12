# pi-server: Next Session Prompt

**Operating mode:** Reliability-first, adversarially reviewed  
**Current phase:** Hardening pass verified; SessionStore race fixed  
**Version:** 2.1.0  
**Formalization level:** 2 (Bounded Run)

---

## START HERE

The repo should now be in a **clean working-tree state** after the latest fixes land.

Most recent commits:
- `f2bba0b` — `fix(session-store): harden cross-instance metadata locking`
- `726b87e` — `style(replay): apply biome formatting`
- `5993557` — `docs(prompt): refresh next session handoff`
- `efcceb9` — `fix(server): harden transport and lifecycle boundaries`

The large hardening pass and the SessionStore follow-up are now **landed and verified**.

The immediate next session is **not** “reproduce the SessionStore race” anymore.
The right current framing is:

> **Start from a clean tree, assume the known SessionStore regression is fixed, and choose the next reliability/design task deliberately.**

---

## CURRENT AUTHORITATIVE STATUS

### Verified now
Latest verification snapshot:
- `npm run check` → **PASSED**
- `npm test` → **PASSED**
- `npm run ci` → **PASSED**

### SessionStore regression root cause
The flaky cross-instance metadata-mutation failure was traced to **metadata lock handling**, not just cache freshness.

Observed failure mode:
- one `SessionStore` instance could observe a newly created metadata lock file
- before that lock file's JSON payload was fully readable
- treat it as stale/orphaned
- remove it
- and enter the critical section concurrently with the real writer

That could collapse persisted metadata from `['a', 'b']` to only one session entry.

### What fixed it
The stabilization patch now:
- tracks same-process live metadata locks in runtime state
- treats the lock file's freshness (`mtime`) as authoritative during stale-lock decisions
- only reaps stale locks conservatively
- strengthens the regression test by running the cross-instance mutation scenario repeatedly

### What is solidly landed
The recent hardening work includes:
- control-plane vs data-plane rate-limit policy
- truthful `command_accepted` semantics
- source-cwd-aligned `load_session`
- correct governor cleanup on `disposeAllSessions()`
- durable journal init lock release on failure
- reverse-scan command history
- auth principal propagation into command execution context
- per-connection pending-command caps
- fail-stop handling for critical transport-send failures
- stronger `validateCwd()`
- surfaced runtime cleanup failure for `delete_session`
- deterministic fail-closed terminal replay across restart
- shutdown escalation + late-mutation guard
- SessionStore cache freshness using `mtimeMs + ctimeMs + size`
- SessionStore cross-instance lock-race stabilization

---

## NEXT SESSION OBJECTIVE

### Primary objective
There is no known failing gate right now.

Choose the next highest-leverage task **intentionally**, with preference for reliability/design debt that already has a clear trigger or ADR-sized shape.

### Recommended starting options
1. **Exact guaranteed terminal response delivery over broken transports**
   - requires protocol-level ack/resume or a durable outbound delivery design
2. **Two-phase durable lifecycle intents**
   - requires a persisted lifecycle-intent state machine and recovery semantics
3. **Narrower session-ID lock scope**
   - only if there is a concrete perf/scalability reason to pay the complexity cost
4. **Hard cancellation after shutdown timeout**
   - depends on stronger upstream `AgentSession` guarantees

### Do not start with
- speculative new feature work without an explicit priority signal
- cosmetic refactors
- broad architectural rewrites without tests or an ADR trail

If a new externally reported bug arrives, override this list with that concrete defect.

---

## FILES TO READ FIRST

### If continuing SessionStore / persistence work
- `src/session-store.ts`
- `src/test.ts`
- `AGENTS.md`
- `README.md`

### If picking up larger reliability/design work
- `AGENTS.md`
- `README.md`
- `docs/adr/0019-durable-command-journal-foundation.md`
- `src/session-manager.ts`
- `src/server.ts`

---

## VALIDATION COMMANDS

### Fast gate
```bash
npm run check
```

### Full gate
```bash
npm run ci
```

Optional extra confidence when touching concurrency/replay behavior:
```bash
npm test
npm run test:fuzz
```

---

## KNOWN DEFERRED ITEMS

| Finding | Rationale | Owner | Trigger | Deadline | Blast Radius |
|---|---|---|---|---|---|
| Exact guaranteed terminal response delivery over broken transports | Needs protocol-level ack/resume or durable outbound queue | pi-server maintainer + protocol owner | delivery ADR approval | before any release claiming reliable terminal delivery | clients can still miss a terminal response on transport break |
| Two-phase durable lifecycle intents | Needs persisted lifecycle-intent state machine and recovery design | pi-server maintainer | lifecycle-intent ADR | before clustering / multi-process orchestration | crash windows can still transiently diverge durable/runtime state |
| Narrower session-ID lock scope | Needs reserved-session model to preserve correctness | pi-server maintainer | perf/scalability workstream | before next perf-focused release | same-session ops can still time out under slow upstream work |
| Hard cancellation after shutdown timeout | Needs upstream AgentSession guarantees | upstream `@mariozechner/pi-coding-agent` owner + pi-server maintainer | upstream cancellation contract | before advertising strict bounded shutdown | upstream work may continue after timeout, though server-side state is protected |

---

## GUARDRAILS FOR THE NEXT SESSION

- Prefer **small, test-backed changes** over broad rewrites.
- Preserve the current hardening invariants:
  - explicit-ID replay determinism
  - truthful admission semantics
  - control-plane isolation
  - fail-stop critical transport behavior
  - shutdown late-mutation protection
- If touching SessionStore locking again, do **not** weaken stale-lock handling without proving the replacement interleaving is safe.
- If touching protocol/lifecycle semantics, add or update ADR/documentation intentionally.

---

## SUCCESS CONDITION

You are done with the next session only when all are true:
- the selected task is resolved or deliberately advanced with clear evidence
- relevant tests are added or updated
- `npm run check` passes
- `npm run ci` passes before handoff if behavior changed materially
- the next handoff prompt matches reality

---

## ROLLBACK

If the next session goes sideways while investigating a new issue:

```bash
git restore --source=HEAD -- <touched-files>
npm run check
npm test
```

---

## NOTE

The previous handoff prompt that said “one cross-instance SessionStore race remains” is now obsolete.

The right current framing is:

> **The hardening pass and the SessionStore follow-up are verified; start from a clean tree and pick the next deliberate reliability target.**
