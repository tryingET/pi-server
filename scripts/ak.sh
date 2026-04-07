#!/usr/bin/env sh
# repo_capability:begin
# {
#   "schema_version": 1,
#   "slug": "ak.launcher",
#   "summary": "Resolve and launch the canonical Agent Kernel CLI for this repo.",
#   "kind": "ak-wrapper",
#   "when_to_use": "Use for repo-scoped AK task, repo, evidence, and work-item operations instead of guessing which ak binary or cargo manifest to invoke.",
#   "scope": "repo",
#   "lifecycle_state": "canonical",
#   "risk_class": "repo-and-runtime-mutation",
#   "receipt_mode": "observational",
#   "inputs": [
#     {
#       "name": "argv",
#       "kind": "argv",
#       "required": false,
#       "summary": "Arguments forwarded to the selected AK runner."
#     }
#   ],
#   "outputs": [
#     {
#       "kind": "process-exit",
#       "summary": "Delegated AK exit status plus the wrapped command's console output."
#     }
#   ],
#   "composition_eligibility": "manual-only",
#   "summary_visibility": "default"
# }
# repo_capability:end
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
answers_file="$repo_root/.copier-answers.yml"
answers_lib="$repo_root/scripts/lib/copier-answers.sh"
core_project_default="${AK_CORE_PROJECT:-$HOME/ai-society/softwareco/owned/agent-kernel}"
operator_cargo="$repo_root/scripts/cargo-operator.sh"

if [ -f "$answers_lib" ]; then
  # shellcheck source=/dev/null
  . "$answers_lib"
fi

say() {
  printf '%s\n' "$*"
}

err() {
  printf '%s\n' "$*" >&2
}

die() {
  err "error: $*"
  exit 1
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

has_operator_cargo() {
  [ -x "$operator_cargo" ] && "$operator_cargo" --available >/dev/null 2>&1
}

path_fallback_enabled() {
  case "${AK_ALLOW_PATH_FALLBACK:-0}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

path_shim_active() {
  case "${AK_PATH_SHIM_ACTIVE:-0}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

usage() {
  cat <<'EOF'
usage: scripts/ak.sh [--doctor|--which|--help] [ak args...]

Portable Agent Kernel launcher with deterministic resolution order:
  1) AK_BIN override
  2) vendored ./crates/ak-cli/Cargo.toml via the repo's explicit nightly cargo wrapper
  3) workspace core ~/ai-society/softwareco/owned/agent-kernel via the same nightly cargo wrapper
  4) ak on PATH only when AK_ALLOW_PATH_FALLBACK=1

When invoked as:
  ./scripts/ak.sh work-items export ...
  ./scripts/ak.sh work-items check ...
  ./scripts/ak.sh work-items import ...

the wrapper auto-fills:
  - --repo with the repo root when omitted
  - --owner / --project-name from environment or ./.copier-answers.yml

Resolution order for owner/project metadata:
  - AK_WORK_ITEMS_OWNER / AK_WORK_ITEMS_PROJECT_NAME
  - ./.copier-answers.yml (project_owner_handle, maintainer_handle, repo_slug, ...)
  - repo basename fallback for project name

Examples:
  ./scripts/ak.sh --doctor
  ./scripts/ak.sh --which
  ./scripts/ak.sh task ready
  ./scripts/ak.sh work-items check --path governance/work-items.json
  ./scripts/ak.sh work-items export --path governance/work-items.json
  ./scripts/ak.sh work-items import --path governance/work-items.json
EOF
}

value_from_answers() {
  file="$1"
  key="$2"

  if command -v copier_answers_try_scalar >/dev/null 2>&1; then
    value=""
    status=0

    value="$(copier_answers_try_scalar "$file" "$key" 2>/dev/null)" || status=$?

    if [ "$status" -eq 0 ]; then
      printf '%s\n' "$value"
      return 0
    fi

    echo "error: unable to parse '$key' from $file; install python3/python with PyYAML for multiline or escaped Copier answers" >&2
    return "$status"
  fi

  [ -f "$file" ] || return 1

  awk -F ':' -v key="$key" '
    $1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
      v=$0
      sub("^[^:]*:[[:space:]]*", "", v)
      gsub(/^[ \t]+|[ \t]+$/, "", v)
      gsub(/^"|"$/, "", v)
      gsub(/^\047|\047$/, "", v)
      print v
      exit
    }
  ' "$file"
}

default_work_items_owner() {
  if [ -n "${AK_WORK_ITEMS_OWNER:-}" ]; then
    printf '%s\n' "$AK_WORK_ITEMS_OWNER"
    return 0
  fi

  for key in project_owner_handle maintainer_handle agent_owner_handle org_owner_handle core_owner_handle; do
    value=""
    value_status=0
    value="$(value_from_answers "$answers_file" "$key")" || value_status=$?
    case "$value_status" in
      0)
        ;;
      1)
        value=""
        ;;
      *)
        return "$value_status"
        ;;
    esac
    if [ -n "$value" ]; then
      printf '%s\n' "$value"
      return 0
    fi
  done

  return 1
}

default_work_items_project_name() {
  if [ -n "${AK_WORK_ITEMS_PROJECT_NAME:-}" ]; then
    printf '%s\n' "$AK_WORK_ITEMS_PROJECT_NAME"
    return 0
  fi

  for key in repo_slug package_name; do
    value=""
    value_status=0
    value="$(value_from_answers "$answers_file" "$key")" || value_status=$?
    case "$value_status" in
      0)
        ;;
      1)
        value=""
        ;;
      *)
        return "$value_status"
        ;;
    esac
    if [ -n "$value" ]; then
      printf '%s\n' "$value"
      return 0
    fi
  done

  basename "$repo_root"
}

has_flag() {
  flag="$1"
  shift

  for arg in "$@"; do
    case "$arg" in
      "$flag"|"$flag"=*)
        return 0
        ;;
    esac
  done

  return 1
}

wants_work_items_defaults() {
  [ "${1:-}" = "work-items" ] || return 1
  case "${2:-}" in
    export|check|import) return 0 ;;
    *) return 1 ;;
  esac
}

select_runner() {
  if [ -n "${AK_BIN:-}" ]; then
    if [ -x "$AK_BIN" ] || command -v "$AK_BIN" >/dev/null 2>&1; then
      printf '%s\n' "ak-bin"
      return
    fi
    printf '%s\n' "ak-bin-missing"
    return
  fi

  if [ -f "$repo_root/crates/ak-cli/Cargo.toml" ]; then
    if has_operator_cargo; then
      printf '%s\n' "vendored-cargo"
      return
    fi
    printf '%s\n' "vendored-missing-cargo"
    return
  fi

  if [ -f "$core_project_default/crates/ak-cli/Cargo.toml" ]; then
    if has_operator_cargo; then
      printf '%s\n' "workspace-core-cargo"
      return
    fi
    printf '%s\n' "workspace-core-missing-cargo"
    return
  fi

  if has_cmd ak; then
    if path_fallback_enabled; then
      if path_shim_active; then
        printf '%s\n' "path-ak-recursive-blocked"
      else
        printf '%s\n' "path-ak"
      fi
    else
      printf '%s\n' "path-ak-blocked"
    fi
    return
  fi

  printf '%s\n' "missing"
}

runner_desc() {
  case "$1" in
    ak-bin)
      printf 'AK_BIN=%s\n' "$AK_BIN"
      ;;
    ak-bin-missing)
      printf 'AK_BIN is set but not executable/resolvable (%s)\n' "$AK_BIN"
      ;;
    vendored-cargo)
      printf 'vendored via nightly cargo wrapper: %s\n' "$repo_root/crates/ak-cli/Cargo.toml"
      ;;
    vendored-missing-cargo)
      printf 'vendored crates/ak-cli found but nightly cargo wrapper is unavailable: %s\n' "$repo_root/crates/ak-cli/Cargo.toml"
      ;;
    workspace-core-cargo)
      printf 'workspace core via nightly cargo wrapper: %s\n' "$core_project_default/crates/ak-cli/Cargo.toml"
      ;;
    workspace-core-missing-cargo)
      printf 'workspace core found but nightly cargo wrapper is unavailable: %s\n' "$core_project_default/crates/ak-cli/Cargo.toml"
      ;;
    path-ak)
      printf 'ak on PATH (%s) with explicit AK_ALLOW_PATH_FALLBACK=1\n' "$(command -v ak)"
      ;;
    path-ak-recursive-blocked)
      printf 'ak on PATH resolves to the installed launcher shim (%s) but the current repo has no non-PATH runner; fix vendored/workspace-core launcher wiring instead of falling back recursively\n' "$(command -v ak)"
      ;;
    path-ak-blocked)
      printf 'ak on PATH is available (%s) but blocked by default; set AK_ALLOW_PATH_FALLBACK=1 or AK_BIN=/absolute/path/to/ak\n' "$(command -v ak)"
      ;;
    missing)
      printf 'unresolved (no viable ak runner)\n'
      ;;
    *)
      printf 'unknown runner token: %s\n' "$1"
      ;;
  esac
}

doctor() {
  runner="$(select_runner)"

  work_items_owner=""
  work_items_owner_status=0
  work_items_owner="$(default_work_items_owner)" || work_items_owner_status=$?
  case "$work_items_owner_status" in
    0|1)
      ;;
    *)
      return "$work_items_owner_status"
      ;;
  esac

  work_items_project_name=""
  work_items_project_name_status=0
  work_items_project_name="$(default_work_items_project_name)" || work_items_project_name_status=$?
  case "$work_items_project_name_status" in
    0|1)
      ;;
    *)
      return "$work_items_project_name_status"
      ;;
  esac

  say "ak launcher doctor"
  say "- repo_root: $repo_root"
  say "- core_project_default: $core_project_default"
  say "- has operator cargo: $(has_operator_cargo && printf yes || printf no)"
  say "- has ak on PATH: $(has_cmd ak && printf yes || printf no)"
  say "- path fallback enabled: $(path_fallback_enabled && printf yes || printf no)"
  say "- has answers file: $([ -f "$answers_file" ] && printf yes || printf no)"
  say "- has vendored crates/ak-cli: $([ -f "$repo_root/crates/ak-cli/Cargo.toml" ] && printf yes || printf no)"
  say "- has workspace core ak-cli: $([ -f "$core_project_default/crates/ak-cli/Cargo.toml" ] && printf yes || printf no)"
  say "- derived work-items owner: ${work_items_owner:-<unset>}"
  say "- derived work-items project name: ${work_items_project_name:-<unset>}"
  say "- selected runner: $(runner_desc "$runner")"

  case "$runner" in
    ak-bin-missing|vendored-missing-cargo|workspace-core-missing-cargo|path-ak-recursive-blocked|path-ak-blocked|missing)
      return 1
      ;;
  esac
  return 0
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "${1:-}" = "--doctor" ]; then
  doctor
  exit $?
fi

runner="$(select_runner)"

if [ "${1:-}" = "--which" ]; then
  runner_desc "$runner"
  case "$runner" in
    ak-bin-missing|vendored-missing-cargo|workspace-core-missing-cargo|path-ak-recursive-blocked|path-ak-blocked|missing)
      exit 1
      ;;
  esac
  exit 0
fi

if wants_work_items_defaults "$@"; then
  if ! has_flag "--repo" "$@"; then
    set -- "$@" --repo "$repo_root"
  fi

  if ! has_flag "--owner" "$@"; then
    work_items_owner=""
    work_items_owner_status=0
    work_items_owner="$(default_work_items_owner)" || work_items_owner_status=$?
    case "$work_items_owner_status" in
      0|1)
        ;;
      *)
        exit "$work_items_owner_status"
        ;;
    esac
    if [ -n "$work_items_owner" ]; then
      set -- "$@" --owner "$work_items_owner"
    fi
  fi

  if ! has_flag "--project-name" "$@"; then
    work_items_project_name=""
    work_items_project_name_status=0
    work_items_project_name="$(default_work_items_project_name)" || work_items_project_name_status=$?
    case "$work_items_project_name_status" in
      0|1)
        ;;
      *)
        exit "$work_items_project_name_status"
        ;;
    esac
    if [ -n "$work_items_project_name" ]; then
      set -- "$@" --project-name "$work_items_project_name"
    fi
  fi
fi

case "$runner" in
  ak-bin)
    exec "$AK_BIN" "$@"
    ;;
  ak-bin-missing)
    die "AK_BIN is set but not executable/resolvable: $AK_BIN"
    ;;
  vendored-cargo)
    exec "$operator_cargo" run --quiet --manifest-path "$repo_root/crates/ak-cli/Cargo.toml" --bin ak -- "$@"
    ;;
  vendored-missing-cargo)
    die "vendored crates/ak-cli/Cargo.toml detected but the nightly cargo wrapper is unavailable"
    ;;
  workspace-core-cargo)
    exec "$operator_cargo" run --quiet --manifest-path "$core_project_default/crates/ak-cli/Cargo.toml" --bin ak -- "$@"
    ;;
  workspace-core-missing-cargo)
    die "workspace core agent-kernel detected but the nightly cargo wrapper is unavailable"
    ;;
  path-ak)
    exec ak "$@"
    ;;
  path-ak-recursive-blocked)
    die "ak on PATH resolves to the installed launcher shim but the current repo has no vendored/workspace-core Agent Kernel runner; fix scripts/cargo-operator.sh or AK_CORE_PROJECT instead of falling back recursively"
    ;;
  path-ak-blocked)
    die "ak on PATH is available but blocked by default; set AK_ALLOW_PATH_FALLBACK=1 for an explicit ambient fallback, set AK_BIN=/absolute/path/to/ak, or provide the vendored/workspace-core Agent Kernel"
    ;;
  *)
    die "unable to locate Agent Kernel CLI; set AK_BIN=/absolute/path/to/ak, provide the vendored/workspace-core Agent Kernel, or explicitly allow ak on PATH with AK_ALLOW_PATH_FALLBACK=1"
    ;;
esac
