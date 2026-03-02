# ADR-0014: Pluggable Authentication

## Status

**Accepted** — Implemented (2026-02-22)

## Context

pi-server needed a production-safe authentication model without forcing one provider or identity stack.
Hardcoding a single auth mechanism (for example, one token format) would lock deployments into one approach.

## Decision

Introduce a pluggable `AuthProvider` interface and authenticate at **connection setup**.

```ts
interface AuthProvider {
  authenticate(ctx: AuthContext): Promise<AuthResult> | AuthResult;
  dispose?(): Promise<void> | void;
}
```

### Built-in providers

- `AllowAllAuthProvider` (default, backward-compatible)
- `TokenAuthProvider` (header token validation)
- `IPAllowlistAuthProvider` (IP/CIDR allowlist)
- `CompositeAuthProvider` (compose multiple checks)

### Integration point

`PiServer` invokes `authProvider.authenticate()` in the WebSocket connection handler before registering the connection.
If auth fails, the socket is closed with code `1008` (policy violation).

## Why this model

1. **Extensible** — OAuth/JWT/mTLS/custom policies can be added without touching server core.
2. **Backward-compatible** — default behavior remains open via `AllowAllAuthProvider`.
3. **Operationally simple** — one gate at connection admission.

## Consequences

### Positive

- Production deployments can require authentication.
- Integrators can plug in custom auth logic.
- Core remains decoupled from provider-specific dependencies.

### Tradeoffs

- Auth is transport-admission focused (not full per-command RBAC).
- Deployments still need network controls and operational hardening.

## References

- `src/auth.ts`
- `src/server.ts`
- `PROTOCOL.md` §23
