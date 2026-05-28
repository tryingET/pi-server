---
summary: "Repo-local engineering-core adoption for pi-server."
read_when:
  - "You are selecting engineering lanes, disciplines, or validation evidence for pi-server work."
  - "You need repo-local deviations from shared engineering-core guidance."
type: "reference"
---

# pi-server engineering guidance

## Upstream owner

Shared engineering lane and discipline guidance comes from `/home/tryinget/ai-society/core/engineering-core`.
This file records the repo-local selected subset for pi-server, a Pi app/server TypeScript service. The repo `AGENTS.md` remains the operating authority for repo-specific workflow, source-owner boundaries, and read order.

Machine-readable selection lives in `policy/engineering-lane.json`.

## Selected lanes

- `ts`

```bash
uv tool -n run --from ~/ai-society/core/engineering-core engineering-core show ts
```

## Selected disciplines

- `validation`
- `testing`
- `security-privacy`
- `documentation`
- `dependency-governance`
- `observability`
- `specification-and-dsls`
- `engineering-reasoning`

Catalog/list commands:

```bash
uv tool -n run --from ~/ai-society/core/engineering-core engineering-core catalog --pretty
uv tool -n run --from ~/ai-society/core/engineering-core engineering-core list-disciplines
uv tool -n run --from ~/ai-society/core/engineering-core engineering-core list-templates
```

## Repo-local deviations and emphasis

- Prefer repo-local deterministic wrappers, `Justfile` targets, and package scripts over ad-hoc commands.
- Keep package/app-local validation and release behavior in the owning package or app surface.
- Treat this file as a selector and override note, not a replacement for `AGENTS.md` or runtime task/evidence authority.
- When local practice intentionally diverges from engineering-core guidance, record the reason here or in the owning project/decision document.

## Canonical local commands

- `npm run check`
- `npm run ci`
- `npm run build`
- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run dev`
- `npm run start`
- `npm run check:consistency`
- `npm run test:fuzz`
- `npm run test:integration`

## Validation evidence expectations

For engineering-core adoption metadata changes:

```bash
python -m json.tool policy/engineering-lane.json >/tmp/pi-server-engineering-lane.json
node /home/tryinget/ai-society/core/agent-scripts/scripts/docs-list.mjs --docs . --strict
```

For code/runtime changes, follow `AGENTS.md` and run the smallest truthful local validation command for the touched surface.

## Repo loop validation

This repo adopts `repo-loop-validation-v1` as an evidence-producing command surface for agent/orchestration loops. These commands do not replace AK task scope, CI, release approval, merge approval, npm publication approval, or runtime activation authority.

| Phase | Local command | Notes |
|---|---|---|
| `loop-doctor` | `just loop-doctor` | Non-failing diagnostic for tool versions, git state, AK binding, and obvious blockers. |
| `loop-verify-fast` | `just loop-verify-fast` | Runs the repo fast gate (`just check`, mapped to policy JSON, `npm run check`, and docs strict). |
| `loop-impact-plan` | `just loop-impact-plan` | Reports changed-file impact and the next bounded/wide check. |
| `loop-impact-run` | `just loop-impact-run` | Runs the bounded validation selected by the plan. |
| `loop-impact-wide` | `just loop-impact-wide` | Runs the full local CI-equivalent gate when wide validation is accepted. |
| `loop-landing-check` | `just loop-landing-check` | Runs the repo-declared local landing gate before handoff/commit finalization. |
