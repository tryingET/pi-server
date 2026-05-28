help:
    @just --list

doctor:
    @echo "repo: pi-server"
    @git --version
    @node --version
    @npm --version
    @ak repo show .

check:
    python3 -m json.tool policy/engineering-lane.json >/tmp/pi-server-engineering-lane.json
    npm run check
    node /home/tryinget/ai-society/core/agent-scripts/scripts/docs-list.mjs --docs . --strict

test:
    npm test

build:
    npm run build

lint:
    npm run lint

fmt:
    npm run format

ci:
    python3 -m json.tool policy/engineering-lane.json >/tmp/pi-server-engineering-lane.json
    npm run ci
    node /home/tryinget/ai-society/core/agent-scripts/scripts/docs-list.mjs --docs . --strict

run:
    npm run start

dev:
    npm run dev

loop-doctor:
    @echo "phase=loop-doctor result=diagnostic scope=repo:pi-server"
    @echo "tooling:"
    @git --version || true
    @node --version || true
    @npm --version || true
    @just --version || true
    @echo "git-status:"
    @git status --short || true
    @echo "ak-binding:"
    @ak repo show . || true
    @echo "authority-boundary: diagnostic only; AK/CI/release authority is unchanged"

loop-verify-fast:
    just check

loop-impact-plan:
    @echo "phase=loop-impact-plan result=passed scope=changed-files"
    @echo "impact=bounded"
    @echo "changed-files:"
    @git status --short || true
    @echo "next=just loop-impact-run"
    @echo "wide-if=protocol/types/session lifecycle/auth/command registry/package-manager metadata, CI scripts, or release files change"

loop-impact-run:
    just loop-verify-fast

loop-impact-wide:
    just ci

loop-landing-check:
    just ci
