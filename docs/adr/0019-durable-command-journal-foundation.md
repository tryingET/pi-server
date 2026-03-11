# ADR-0019: Durable Command Journal Foundation

## Status

**Accepted** (2026-03-02)

## Context

Level 3 replay guarantees are strong during process lifetime, but outcomes are in-memory only.
After a crash or restart, command identity history is lost, which weakens:

- deterministic replay guarantees across restarts
- auditability of command lifecycle transitions
- recovery behavior for commands that were in-flight during process death

Roadmap Level 4 requires a durable substrate for command causality.

## Decision

We introduce a **feature-flagged durable command journal** with the following foundation choices.

### 1. Backend choice: append-only JSONL

For the Level 4 foundation, we choose append-only JSONL over SQLite.

Rationale:
- minimal moving parts
- straightforward operational debugging (`tail`, `jq`, backups)
- easy schema-versioned records
- low integration risk for first durable milestone

SQLite remains a future option if throughput/compaction needs outgrow JSONL.

### 2. On-disk schema (v1)

Each line is a standalone JSON object with:

- `schemaVersion: 1`
- lifecycle phase (`command_accepted`, `command_started`, `command_finished`)
- command identity and causal metadata (`commandId`, `fingerprint`, `dependsOn`, etc.)
- lane metadata (`laneKey`, `laneSequence`)
- terminal outcome payload for finished records (`success`, `error`, `response`, ...)

### 3. Deterministic per-lane sequencing

Every appended lifecycle record receives a monotonic `laneSequence` within its lane.
Startup rehydration scans existing entries and resumes from the max observed sequence per lane.

### 4. Startup rehydration model

On startup (when enabled), the server:

1. Scans the journal
2. Rehydrates completed explicit command outcomes into replay storage
3. Detects pre-crash in-flight explicit commands (accepted/started without finished)
4. Classifies them as **failed during recovery** with deterministic terminal responses
5. Appends synthetic `command_finished` recovery entries

This ensures explicit command IDs remain deterministic across restart boundaries.

### 5. Migration policy

- Current schema: `1`
- `schemaVersion > current`: skip as unsupported (counted in stats)
- `schemaVersion < current`: skipped for now (no auto-migrator in foundation)
- malformed records: skipped, counted in stats

This policy is conservative and deterministic; explicit migrators can be added in later iterations.

### 6. Rollout posture

The feature is behind `durableJournal.enabled` (default: off).
This preserves rollback safety while validating operational behavior.

## Consequences

### Positive

- Crash-survivable replay base for explicit command IDs
- Durable lifecycle trace for admitted commands
- Deterministic handling of pre-crash in-flight commands
- Clear schema/version seam for future migration tooling

### Trade-offs

- JSONL can grow quickly without retention/compaction policy (future Level 4 work)
- Throughput cost from append writes (fsync mode configurable)
- Recovery currently prefers determinism over side-effect compensation

## Follow-up work

- ✅ recovery summary endpoint (`get_startup_recovery`) in protocol surface
- ✅ recovery summary startup event (`startup_recovery_summary`) in protocol surface (convenience; endpoint remains canonical)
- ✅ bounded history query endpoint (`get_command_history`) with session/command/time filters
- ✅ retention + compaction foundation (`durableJournal.retention` with maxEntries/maxAgeMs/maxBytes), preserving retained replay + in-flight recovery semantics
- ✅ single-writer lock file enforcement to prevent multi-process compaction/append races on one journal path
- ✅ bounded history-query scan guardrails (line/time budget) to avoid unbounded server-lane scans
- ✅ append write-failure strictness policy (`durableJournal.appendFailurePolicy`: `best_effort` / `fail_closed`)
- ✅ redaction hooks for persistence/export surfaces (`durableJournal.redaction.beforePersist` / `beforeExport`)
- ✅ chaos coverage for malformed/partial journal lines around recovery + compaction
- ✅ newest-first command history queries for incident usefulness
- ✅ canonical replay identity and failure-atomic session lifecycle integration at the runtime boundary (see ADR-0020)
- optional SQLite backend evaluation (decision gate revisit)
- schema migration tooling and fixtures
- deterministic replay/export tooling for incident workflows

## References

- `src/command-journal.ts`
- `src/session-manager.ts`
- `ROADMAP.md` (Level 4)
- `docs/adr/0020-failure-atomic-lifecycle-and-canonical-replay.md`
