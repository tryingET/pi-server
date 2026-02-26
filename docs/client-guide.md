# pi-server Client Integration Guide

Practical guidance for building robust clients on top of the `pi-server` protocol.

For normative behavior, always defer to `PROTOCOL.md`.

---

## 1) Core model

Treat a command as having three identities:

1. **Type** (`type`)
2. **Intent identity** (`id`)
3. **Retry identity** (`idempotencyKey`)

Use them consistently and your client becomes naturally resilient.

---

## 2) Required habits

### Always send `id`

`id` should be unique per logical command intent.
Do not reuse an `id` for a semantically different payload.

### Use `idempotencyKey` for retries

When retrying due to network issues/timeouts, reuse:

- the same `id`
- the same `idempotencyKey`
- the same semantic payload

### Treat timeout as terminal for that command identity

A timeout response (`timedOut: true`) is a stored terminal outcome for that command ID.
Replay of the same identity will return the same timeout response.

If you want a fresh execution attempt, issue a **new** command identity (`id`, optional `idempotencyKey`).

---

## 3) Concurrency and causal safety

### Use `ifSessionVersion` for writes

For mutating session commands, include `ifSessionVersion` from latest known state.
If mismatch occurs, refresh state and retry intentionally.

### Use `dependsOn` for explicit causality

When command B must not run before command A succeeds, set:

```json
{"id":"B","type":"...","dependsOn":["A"]}
```

Avoid creating same-lane dependency inversions (A waits on B while B is queued behind A).

---

## 4) Event handling model

You will receive:

- session-scoped `event` messages (only for subscribed sessions)
- global command lifecycle events:
  - `command_accepted`
  - `command_started`
  - `command_finished`

Important:

- ordering is deterministic **within a lane**
- no global total ordering across different lanes
- replay responses emit `accepted -> finished` (no `started`)

---

## 5) Recommended retry algorithm

1. Generate `id` + `idempotencyKey`.
2. Send command.
3. If transport fails, retry with same identities and same payload.
4. If timeout occurs, replay once with same identities to confirm canonical timeout outcome.
5. If a fresh execution is needed after timeout, send a new command identity.
6. If response has `replayed: true`, treat as canonical prior result.
7. If conflict error appears, stop retrying and escalate (identity misuse).

---

## 6) Example command envelope (safe defaults)

```json
{
  "id": "cmd-42",
  "type": "prompt",
  "sessionId": "s1",
  "message": "Summarize this file",
  "idempotencyKey": "retry-cmd-42",
  "ifSessionVersion": 8,
  "dependsOn": ["cmd-41"]
}
```

---

## 7) Troubleshooting map

- **Conflict error for `id`** → same `id` reused with changed payload.
- **Conflict error for `idempotencyKey`** → key reused with changed payload.
- **Version mismatch** → stale client state; refresh `sessionVersion`.
- **Dependency unknown/failed** → upstream command missing or failed; repair chain.
- **Timeout** → terminal for that command identity; replay confirms same timeout, use new ID for fresh attempt.

---

## 8) Reference

- `PROTOCOL.md` — normative contract
- `README.md` — overview and architecture
- `docs/quickstart.md` — operator startup path
