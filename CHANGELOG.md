# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## 1.0.0 (2026-02-26)


### Features

* **core:** extract command execution stores and engine (ADR-0001) ([3ded1eb](https://github.com/tryingET/pi-server/commit/3ded1eb045c6bc7e881ac44598ff6d82354d3711))
* Phase 3 - Extension UI wiring via bindExtensions ([1ecd2af](https://github.com/tryingET/pi-server/commit/1ecd2af7d211738755d365343186e197167d6b1c))
* Phase 3.5 - Critical fixes (validation, timeout, tests) ([da2fad9](https://github.com/tryingET/pi-server/commit/da2fad93120766964155c13af03f2a7f8f976875))


### Bug Fixes

* **ci:** add package-lock.json for reproducible builds ([c6743b3](https://github.com/tryingET/pi-server/commit/c6743b39212e8e8c69e5a0e435feea716b464bb0))
* close critical protocol gaps + harden validation/rate-limits ([ec2506d](https://github.com/tryingET/pi-server/commit/ec2506df62ccf0d75371f69806831dc99ac5f693))
* Deep review findings - broadcast safety, error handling ([b628bda](https://github.com/tryingET/pi-server/commit/b628bda2b9f62bba02492772e352537790e4eb9a))
* **packaging:** exclude test artifacts from npm tarball ([5139785](https://github.com/tryingET/pi-server/commit/5139785c503796676a584dd4af8286947b45862c))
* **replay:** implement atomic outcome storage (ADR-0001) ([1dbb35d](https://github.com/tryingET/pi-server/commit/1dbb35d8ef8a4cd413fc3b3c4e8f393edf5eb87b))
* **review:** address deep review findings from prompt-snippets.md ([8059076](https://github.com/tryingET/pi-server/commit/80590768e14283f3a3406b57bf8da98336c3b6dd))
* **server:** harden causal command execution and replay safety ([f1f4ed3](https://github.com/tryingET/pi-server/commit/f1f4ed383a67335b243397eba1638705f8b9832a))
* **test:** update timeout replay test for ADR-0001 invariant ([85c2693](https://github.com/tryingET/pi-server/commit/85c269370cb8ecc8c64a8120d087d2d0df15ff90))

## [Unreleased]

### Added

- Initial release of pi-server session multiplexer
- WebSocket transport (port 3141)
- stdio transport (JSON lines)
- Session lifecycle management (create/delete/list/switch)
- Command execution with deterministic lane serialization
- Idempotent command replay with atomic outcome storage (ADR-0001)
- Optimistic concurrency via session versioning
- Extension UI round-trip support
- Resource governance (rate limiting, session limits, message size)
- Input validation for all commands
- Graceful shutdown with drain
- Protocol versioning (serverVersion + protocolVersion)
- Comprehensive test suite (unit, integration, fuzz)

### Security

- Session ID validation (alphanumeric, no path traversal)
- CWD validation (blocks `..` and `~`)
- Connection limits
- Reserved ID prefix rejection (`anon:` is server-only)
