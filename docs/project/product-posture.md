---
summary: "Current pi-server product maturity, proof posture, remaining gaps, and next bounded frontier."
read_when:
  - "Choosing or completing a pi-server Nexus/visible-loop slice."
  - "Reconciling current implementation proof with roadmap or vision claims."
type: "reference"
---

# pi-server product posture

## Current maturity

pi-server is a production-oriented single-node Pi session multiplexer with deterministic command lanes, replay/idempotency semantics, bounded resource controls, session lifecycle coordination, dual WebSocket/stdio transports, and pluggable auth, metrics, and logging.

Replay identity resolution now treats an explicit command ID as the primary identity and an `idempotencyKey` as a fallback retry alias. For both completed and in-flight state, a compound request can no longer bypass the existing ID's replay or conflict by presenting an independently populated key.

Replay maturity now extends through alias claims and terminalization. An idempotency-key replay correlated to a new valid explicit ID claims that ID before yielding and persists an authoritative claim for restart recovery. Idempotency scopes use discriminated structured tuples rather than delimiter-built keys. A `command_finished` persistence failure no longer rewrites an already-committed mutation as failure: runtime replay retains the selected response, `beforePersist` is never bypassed, and only exact policy-approved bytes may be retried after a proven pre-write failure. If no business terminal record was authorized, an owner-approved synthetic recovery record quarantines the identity instead of re-executing it and states that the command may have committed; if policy rejects even that recovery record, startup remains failed closed.

Session persistence is now configuration-aware: the Pi runtime agent directory is captured once and its canonical session-root capabilities are shared by creation, discovery, inventory visibility, load, and switch authorization. Runtime-created sessions therefore remain visible and reloadable when `PI_CODING_AGENT_DIR` overrides the historical default.

The protocol remains the architecture boundary: client-visible behavior belongs in `types.ts`, `PROTOCOL.md`, validation, the command contract registry, handlers, and regression tests together. The server should remain thin over Pi `AgentSession` behavior.

## Proof currently available

The repository contains unit, integration, and fuzz suites plus a full `npm run ci` gate. Accepted ADRs and implementation surfaces cover atomic terminal outcomes, session locking, transport backpressure, bounded stores, authentication, observability, structured logging, and the durable command-journal foundation.

For the bounded generated-state follow-up, `git check-ignore` confirmed that observed `.ontology/` runtime files and `.pi/sessions/` fixtures are ignored while `.pi/prompts/commit.md` remains visible for intentional review. `just loop-impact-run` passed typecheck, lint, policy JSON validation, and strict docs validation. This proof covers only the two task-scoped files and does not green unrelated dirty paths.

For Nexus task `#4609` iteration one, the configured-agent-root round trip is covered across create, metadata rebootstrap, background discovery, list, load, and switch. `just loop-impact-run` passed the fast code/docs gate, and `just loop-impact-wide` passed the full local CI-equivalent gate in an isolated `HOME`/Pi-agent sandbox: build, typecheck, lint, format, consistency, 220 main tests, 49 command-classification tests, 32 integration tests, 17 fuzz tests, and strict docs validation.

For iteration two, focused red tests reproduced the completed-ID and in-flight-ID precedence bypasses. After the initial fix, the replay-store module passed 41/41 tests across cached and in-flight ID/key combinations; `just loop-impact-run`, targeted formatting, and `npm run build` also passed. An earlier independent read-only diff review found no blocking defect, and its requested positive cross-state cases were incorporated.

The follow-up terminal-identity hardening has hermetic build proof, 42/42 replay-store tests, and 243/243 main-suite tests. `just loop-impact-run` and `git diff --check` also passed before the final reconciliation. Regression coverage now includes collision-safe scope tuples, structural validation before alias fallback, pre-yield in-flight claims, restart-stable alias claims, first-valid durable terminal authority through compaction, replay-invalid terminal quarantine, no raw payload persistence after policy rejection, exact approved-byte pre-write retry, no blind retry after an ambiguous write, same-process committed-truth replay, and restart quarantine without re-execution. The later permitted reviewer attempt timed out without findings and is not counted as proof; two subsequent read-only reviews identified the redaction collision and informed the bounded reconciliation.

These proofs establish the observed functional behavior of both bounded implementation slices, but they do not complete task `#4609`: the repo-declared final impact/landing gate, a fresh successful two-iteration Nexus receipt, and AK evidence authority remain outstanding, and unrelated pre-existing dirty files are not green by implication.

## Main gap

The leading broader reliability gap is replay retention: `maxCommandOutcomes` can evict an explicit command ID and permit it to execute again, while the accepted replay invariant says the first terminal response remains authoritative. Resolving that tension requires a bounded durability/retention decision and compatibility proof; dependent AK task `#4642` owns that work, and this iteration intentionally did not hide it behind an unbounded map or combine it with a persistent schema change.

Terminal policy rejection now has an explicit degraded contract rather than a privacy/determinism ambiguity: policy authority wins, committed truth remains replayable in the current process, and a later restart returns a conservative quarantine failure when policy permits that recovery record, preventing re-execution without reconstructing the unpersisted response. If policy rejects the recovery record, startup fails closed. This is deliberately not proof that the business mutation failed. Exact cross-restart replay after policy rejection would require a separate owner-approved lossless persistence representation.

Separate lifecycle findings remain around cancellable background discovery and failed-start ownership. They should not be bundled into replay-retention work. The generated-state boundary reduces accidental staging but does not move fixtures out of the repository, assert post-test cleanliness, refresh the stale handoff, or establish generated-changelog metadata ownership. Those deep-review findings are outside task `#4609`'s path authority and remain owner-routed gaps rather than silently claimed closure. The working tree also contains unrelated pre-existing changes that task `#4609` must continue to preserve.

## Authority and provenance boundaries

### Repository-local generated-state boundary

`.ontology/` and `.pi/sessions/` are local generated runtime state, not product truth, AK evidence, or review artifacts. They are ignored to prevent accidental staging, while `.pi/prompts/` remains visible so an intentional repository prompt still requires explicit review.

This is a staging-safety boundary, not proof that tests avoid repository-local fixtures or that the worktree is clean after interruption. The deep-review findings involving `src/test.ts`, `next_session_prompt.md`, and generated `CHANGELOG.md` metadata are outside task `#4609`'s allowed paths and remain explicitly unresolved; this bounded slice does not claim otherwise.

- `PROTOCOL.md` and protocol/type/validation tests own client-visible wire semantics.
- Product posture can map the observed precedence behavior but cannot amend the wire contract. This iteration preserved the protected pre-existing `PROTOCOL.md` changes; any normative precedence wording requires authorization at that owner surface.
- The command contract registry owns timeout, scheduling, mutation, and replay-history classification.
- Store and execution-engine tests own determinism, replay, terminalization, and bounded-state proof.
- The durable-journal redaction contract owns what may reach disk. Replay/terminalization code cannot override `beforePersist`; when no terminal representation is authorized, privacy and non-reexecution take precedence over reconstructing an unavailable response after restart.
- Pi `AgentSession` remains the upstream session behavior owner; pi-server multiplexes rather than reimplementing it.
- Pi's `getAgentDir()` owns `PI_CODING_AGENT_DIR` resolution; pi-server owns capturing that runtime capability and consistently enforcing it at its persistence and RPC boundaries.
- AK task/evidence state owns task completion claims; loop output or a commit alone is not closure authority.

## Next highest-leverage frontier

Before choosing new product work, obtain the fresh successful two-iteration Nexus receipt and run the repo-declared final landing gate for task `#4609`. Any follow-up to the operational-truth findings must first gain AK and source-owner scope for the affected files; it must not be folded into replay-retention work by convenience. After this task closes, the next product slice should follow AK `#4642`'s authority over replay retention while preserving policy-approved journal bytes, first-terminal authority, pre-yield alias claims, structured scope separation, explicit-ID-first resolution, and the configured-agent session-root invariant. Leave completion and evidence authority with AK.
