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

Session persistence is now configuration-aware: the Pi runtime agent directory is captured once and its canonical session-root capabilities are shared by creation, discovery, inventory visibility, load, and switch authorization. Runtime-created sessions therefore remain visible and reloadable when `PI_CODING_AGENT_DIR` overrides the historical default.

The protocol remains the architecture boundary: client-visible behavior belongs in `types.ts`, `PROTOCOL.md`, validation, the command contract registry, handlers, and regression tests together. The server should remain thin over Pi `AgentSession` behavior.

## Proof currently available

The repository contains unit, integration, and fuzz suites plus a full `npm run ci` gate. Accepted ADRs and implementation surfaces cover atomic terminal outcomes, session locking, transport backpressure, bounded stores, authentication, observability, structured logging, and the durable command-journal foundation.

For Nexus task `#4609` iteration one, the configured-agent-root round trip is covered across create, metadata rebootstrap, background discovery, list, load, and switch. `just loop-impact-run` passed the fast code/docs gate, and `just loop-impact-wide` passed the full local CI-equivalent gate in an isolated `HOME`/Pi-agent sandbox: build, typecheck, lint, format, consistency, 220 main tests, 49 command-classification tests, 32 integration tests, 17 fuzz tests, and strict docs validation.

This proof closes the iteration-one session-root slice; it does not complete task `#4609`, replace AK evidence authority, or make unrelated pre-existing dirty files green by implication.

## Main gap

The leading unresolved evidence-backed reliability gap is shutdown single-flight behavior: concurrent `PiServer.stop()` callers can still overlap teardown because shutdown ownership is not established before the first asynchronous disposal boundary. That finding remains unimplemented and must be reproduced against the current tree before any second-iteration mutation.

The working tree also contains unrelated pre-existing changes, including stale handoff narrative. Nexus task `#4609` must preserve that baseline, isolate its own edits, and avoid treating those projections as product truth or commit scope unless the bound review proves they belong to the next fix.

## Authority and provenance boundaries

- `PROTOCOL.md` and protocol/type/validation tests own client-visible wire semantics.
- The command contract registry owns timeout, scheduling, mutation, and replay-history classification.
- Store and execution-engine tests own determinism, replay, terminalization, and bounded-state proof.
- Pi `AgentSession` remains the upstream session behavior owner; pi-server multiplexes rather than reimplementing it.
- Pi's `getAgentDir()` owns `PI_CODING_AGENT_DIR` resolution; pi-server owns capturing that runtime capability and consistently enforcing it at its persistence and RPC boundaries.
- AK task/evidence state owns task completion claims; loop output or a commit alone is not closure authority.

## Next highest-leverage frontier

The second task-bound Nexus iteration should treat concurrent shutdown single-flight as the leading known candidate, revalidate it before mutation, and keep any fix bounded to shared teardown ownership plus direct concurrency proof. It must preserve the now-proven configured-agent session-root invariant, avoid absorbing stale handoff cleanup as product implementation, rerun impact-selected validation, and leave final completion/evidence authority with AK.
