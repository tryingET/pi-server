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

Session persistence is now configuration-aware: the Pi runtime agent directory is captured once and its canonical session-root capabilities are shared by creation, discovery, inventory visibility, load, and switch authorization. Runtime-created sessions therefore remain visible and reloadable when `PI_CODING_AGENT_DIR` overrides the historical default.

The protocol remains the architecture boundary: client-visible behavior belongs in `types.ts`, `PROTOCOL.md`, validation, the command contract registry, handlers, and regression tests together. The server should remain thin over Pi `AgentSession` behavior.

## Proof currently available

The repository contains unit, integration, and fuzz suites plus a full `npm run ci` gate. Accepted ADRs and implementation surfaces cover atomic terminal outcomes, session locking, transport backpressure, bounded stores, authentication, observability, structured logging, and the durable command-journal foundation.

For Nexus task `#4609` iteration one, the configured-agent-root round trip is covered across create, metadata rebootstrap, background discovery, list, load, and switch. `just loop-impact-run` passed the fast code/docs gate, and `just loop-impact-wide` passed the full local CI-equivalent gate in an isolated `HOME`/Pi-agent sandbox: build, typecheck, lint, format, consistency, 220 main tests, 49 command-classification tests, 32 integration tests, 17 fuzz tests, and strict docs validation.

For iteration two, focused red tests reproduced the completed-ID and in-flight-ID precedence bypasses. After the fix, the replay-store module passed 41/41 tests across cached and in-flight ID/key combinations; `just loop-impact-run`, targeted formatting, and `npm run build` also passed. One independent read-only diff review found no blocking defect, and its requested positive cross-state cases were incorporated before final focused verification.

These proofs close both bounded implementation slices, but they do not by themselves complete task `#4609`: the repo-declared final impact/landing gate and AK evidence authority remain outstanding, and unrelated pre-existing dirty files are not green by implication.

## Main gap

The leading unresolved evidence-backed reliability gap is replay retention: `maxCommandOutcomes` can evict an explicit command ID and permit it to execute again, while the accepted replay invariant says the first terminal response remains authoritative. Resolving that tension requires a bounded durability/retention decision and compatibility proof; this iteration intentionally did not hide it behind an unbounded map or combine it with a persistent schema change.

Separate lifecycle findings remain around cancellable background discovery and failed-start ownership. They should not be bundled into replay-retention work. The working tree also contains unrelated pre-existing changes that task `#4609` must continue to preserve.

## Authority and provenance boundaries

- `PROTOCOL.md` and protocol/type/validation tests own client-visible wire semantics.
- Product posture can map the observed precedence behavior but cannot amend the wire contract. This iteration preserved the protected pre-existing `PROTOCOL.md` changes; any normative precedence wording requires authorization at that owner surface.
- The command contract registry owns timeout, scheduling, mutation, and replay-history classification.
- Store and execution-engine tests own determinism, replay, terminalization, and bounded-state proof.
- Pi `AgentSession` remains the upstream session behavior owner; pi-server multiplexes rather than reimplementing it.
- Pi's `getAgentDir()` owns `PI_CODING_AGENT_DIR` resolution; pi-server owns capturing that runtime capability and consistently enforcing it at its persistence and RPC boundaries.
- AK task/evidence state owns task completion claims; loop output or a commit alone is not closure authority.

## Next highest-leverage frontier

Before choosing another implementation slice, revalidate the explicit-ID eviction path and resolve the authority question between bounded volatile retention and durable replay lookup/tombstones. Any resulting work must preserve explicit-ID-first resolution and the configured-agent session-root invariant, avoid absorbing the separate lifecycle findings, and carry compatibility and bounded-state proof. Before task closeout, run the repo-declared final landing gate and leave completion/evidence authority with AK.
