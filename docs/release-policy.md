# Release and Changelog Policy

This repository uses **release-please** for versioning and release-note generation, and **SemVer** for version numbers.

Package / CLI naming:
- npm package: `pi-app-server`
- executable: `pi-server`

## Source of Truth

- `CHANGELOG.md` is a **generated release artifact**, not a hand-maintained project diary.
- Release notes are generated from **Conventional Commit** subjects and explicit breaking-change markers.
- GitHub releases and npm publication are related but distinct steps.
- Until the publish pipeline is fully consolidated, **verify npm dist-tags after each GitHub release** instead of assuming a GitHub release implies a successful npm publish.

## Changelog Policy

- Keep `CHANGELOG.md` focused on **released versions**.
- Do **not** maintain a manual `[Unreleased]` section in `CHANGELOG.md`.
- If a change deserves release-note visibility, express that in the **commit message**, not by manually patching the changelog afterward.
- Treat the release-please release PR as the place where generated changelog output is reviewed before release.

## Commit Message Policy for Releasable Work

Optimize commit subjects for **release-note quality**, not just local git history.

### Core rules

1. **Prefer one user-visible change per commit**
   - Split umbrella work into multiple commits when it changes multiple external behaviors.
2. **Use Conventional Commits**
   - Format: `type(scope): summary`
3. **Choose type by external effect, not implementation mechanism**
   - `feat`: new capability
   - `fix`: bug fix, reliability fix, validation correction, or externally observable behavior correction
   - `docs`: docs-only change
   - `refactor`: internal-only restructuring with no user-visible behavior change
   - `test`: test-only change
   - `chore` / `ci` / `build`: tooling and maintenance
4. **Keep non-releasable work separate**
   - Split docs/test/style/chore commits away from `feat` / `fix` commits where practical.
5. **Avoid umbrella summaries**
   - Bad: `implement reliability pass`
   - Better: `fix(server): fail closed on critical transport send errors`

### Scope guidance

Prefer stable subsystem scopes such as:
- `server`
- `session-manager`
- `session-store`
- `replay`
- `validation`
- `protocol`
- `router`
- `durable-journal`
- `auth`
- `ci`
- `docs`
- `release`

## Breaking Change Policy

Mark breaking changes explicitly so SemVer and generated release notes stay truthful.

### Required marking

Use either:
- `type(scope)!: summary`

and/or a footer:
- `BREAKING CHANGE: <what changed and how to migrate>`

### What counts as breaking here

Examples:
- protocol or wire-contract incompatibilities
- stricter validation that can reject previously accepted client input
- CLI argument or transport behavior changes that break existing automation
- removal or renaming of externally used commands / fields / semantics

### Breaking-change body guidance

When a commit is breaking, include:
- what changed
- who is affected
- the migration path

## Examples

Good:
- `fix(session-store): harden cross-instance metadata locking`
- `feat(router): add get_tree command`
- `fix(validation)!: reject relative cwd values`
  - `BREAKING CHANGE: create_session and load_session now require absolute existing cwd paths.`

Bad:
- `implement reliability pass`
- `more fixes`
- `update docs and tests and release flow`
- `refactor(server): tighten websocket validation` when the real external effect is a bug fix or breaking validation change

## Release Review Checklist

Before merging a release PR, verify:
- generated release notes reflect the intended external changes
- breaking changes are marked explicitly and explained clearly
- `CHANGELOG.md` does not carry stale manual `[Unreleased]` content
- npm publication is verified after the GitHub release completes
