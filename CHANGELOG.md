# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [1.1.0](https://github.com/tryingET/pi-server/compare/v1.0.0...v1.1.0) (2026-02-28)


### Features

* **circuit-breaker:** implement LLM provider circuit breaker (ADR-0010) ([b7a350a](https://github.com/tryingET/pi-server/commit/b7a350a41786e8e7781235c20092ede12c307cad))
* **governor:** add generation-based rate limit refund and periodic cleanup ([25bcec5](https://github.com/tryingET/pi-server/commit/25bcec5764d85a4ca28a0dfa439e7d32c1405bda))
* implement bash circuit breaker for non-LLM commands ([bfde12f](https://github.com/tryingET/pi-server/commit/bfde12f5ed7c4a7edcccf22d4313667da43e8ebe))
* **infra:** add auth, metrics, logging, and bounded-map utilities ([ab302ba](https://github.com/tryingET/pi-server/commit/ab302baea332a4f67fe78d660372ef9df5b61de7))
* **metrics:** add ThresholdAlertSink for pluggable alerting ([4b166c8](https://github.com/tryingET/pi-server/commit/4b166c88cd144010c04ab70f1c24a3c8bbb290ff))
* **server:** integrate auth, metrics, logging, and stdio backpressure ([40d7642](https://github.com/tryingET/pi-server/commit/40d76424fbac49ad071700099e6af75c0c173df4))
* **server:** wire ThresholdAlertSink with default thresholds ([82584b5](https://github.com/tryingET/pi-server/commit/82584b5289c10b89523caec90caffdb34581787c))
* **session-manager:** enforce maxSessionLifetimeMs with periodic cleanup ([cf6703f](https://github.com/tryingET/pi-server/commit/cf6703fdabbb49e21fe644e1ba23bb27391f9a1c))


### Bug Fixes

* address pre-existing lint warnings ([3a173d6](https://github.com/tryingET/pi-server/commit/3a173d6f652affa6ac95863280f9424dd15ab904))
* **core:** enforce terminal command outcomes ([46a1352](https://github.com/tryingET/pi-server/commit/46a13525b0f028c6a596df77db038d4bc1f3e632))
* prevent race conditions and improve error handling ([1b44aef](https://github.com/tryingET/pi-server/commit/1b44aeff2df0464d8c96bf37f08c11e998f7171f))
* prevent resource leaks and memory exhaustion ([bec028c](https://github.com/tryingET/pi-server/commit/bec028c76e062e209fef93c66b7f8aafe86d6dd5))
* resolve race conditions and add safety bounds from deep review ([db09bdf](https://github.com/tryingET/pi-server/commit/db09bdfe9cbbc080ac243474ae360bc0e83913fa))
* **session-store:** close readline interface in finally block ([087b043](https://github.com/tryingET/pi-server/commit/087b043eb447cb69a495b7bc3fec1445b92e500d))
* **session:** sanitize npm prefix during agent session creation ([9f67477](https://github.com/tryingET/pi-server/commit/9f67477196dfbc3b6fbf30506ebd5be3e73655ae))

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
