# ADR-0009: Connection Authentication (Historical Proposal)

## Status

**Superseded** by [ADR-0014](./0014-pluggable-authentication.md) (2026-02-22)

## Why this file still exists

ADR-0009 captured an early proposal for command-level authentication via an `authenticate` RPC flow.
During implementation, the team converged on a cleaner transport-level model and shipped it as ADR-0014.

## What changed

- **Then (ADR-0009):** explicit `authenticate` command and token flow in protocol
- **Now (ADR-0014):** pluggable `AuthProvider` interface evaluated at connection setup

## Current source of truth

Use **ADR-0014** for all current behavior and implementation guidance.

## Historical note

The original proposal helped shape threat modeling and migration concerns,
but its concrete protocol design is no longer authoritative.
