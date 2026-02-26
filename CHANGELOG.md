# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

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
