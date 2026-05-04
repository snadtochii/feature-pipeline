#!/usr/bin/env bash
# feature PostToolUse validator.
# Runs lint and typecheck commands declared in claudedocs/tickets/config.yaml's
# validate: block after every Write/Edit/MultiEdit. Silent no-op outside an
# FP-managed workspace or when the validate: block is empty/absent.
#
# Concurrency: assumes Claude Code serializes hook execution per turn (no locking).
# Bash version: targets bash 3.2 (macOS default) — no associative arrays, no mapfile.

set -euo pipefail

DEFAULT_MARKERS="package.json pyproject.toml Cargo.toml go.mod Gemfile composer.json mix.exs tsconfig.json"
MAX_OUTPUT_LINES=60

input=$(cat)
if [ -z "$input" ]; then
    exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "[validate] jq not installed; skipping" >&2
    exit 0
fi

file_path=$(jq -r '.tool_input.file_path // empty' <<<"$input" 2>/dev/null || true)
if [ -z "$file_path" ]; then
    exit 0
fi

case "$file_path" in
    /*) ;;
    *) file_path="$PWD/$file_path" ;;
esac
file_dir=$(dirname "$file_path")

# Workspace walk-up: find the nearest ancestor containing claudedocs/tickets/config.yaml.
# Bounds the project-root walk-up below; outside an FP workspace the hook is a no-op.
workspace=""
dir="$file_dir"
while :; do
    if [ -f "${dir%/}/claudedocs/tickets/config.yaml" ]; then
        workspace="$dir"
        break
    fi
    if [ "$dir" = "/" ] || [ -z "$dir" ]; then
        break
    fi
    parent=$(dirname "$dir")
    if [ "$parent" = "$dir" ]; then
        break
    fi
    dir="$parent"
done

if [ -z "$workspace" ]; then
    exit 0
fi

config="${workspace%/}/claudedocs/tickets/config.yaml"

lint_cmd=""
typecheck_cmd=""
cwd_markers=""

parse_with_yq() {
    local lint typecheck markers
    lint=$(yq -r '.validate.lint // ""' "$config" 2>/dev/null) || return 1
    typecheck=$(yq -r '.validate.typecheck // ""' "$config" 2>/dev/null) || return 1
    markers=$(yq -r '(.validate.cwd_markers // []) | join(" ")' "$config" 2>/dev/null) || return 1
    lint_cmd="$lint"
    typecheck_cmd="$typecheck"
    cwd_markers="$markers"
    return 0
}

parse_with_grep() {
    local section
    section=$(awk '
        /^validate:/ { in_section=1; next }
        in_section {
            if (/^[^[:space:]]/) { in_section=0; next }
            print
        }
    ' "$config" 2>/dev/null) || return 0

    extract_value() {
        local key="$1"
        printf '%s\n' "$section" \
            | grep -E "^[[:space:]]+${key}:" \
            | head -n1 \
            | sed -E "s/^[[:space:]]+${key}:[[:space:]]*//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/" \
            || true
    }

    lint_cmd=$(extract_value "lint")
    typecheck_cmd=$(extract_value "typecheck")
    local markers_raw
    markers_raw=$(extract_value "cwd_markers")
    cwd_markers=$(printf '%s' "$markers_raw" | tr -d '[]' | tr ',' ' ')
    return 0
}

if command -v yq >/dev/null 2>&1; then
    if ! parse_with_yq; then
        echo "[validate] config.yaml malformed; skipping" >&2
        exit 0
    fi
else
    parse_with_grep
fi

if [ -z "$lint_cmd" ] && [ -z "$typecheck_cmd" ]; then
    exit 0
fi

# Project-root walk-up: find the nearest marker between file_dir and workspace.
# Bounded above by workspace so we never pick up a parent project's package.json
# the user didn't intend. If no marker found, fall back to workspace root.
markers="$DEFAULT_MARKERS"
if [ -n "$cwd_markers" ]; then
    markers="$cwd_markers"
fi

project_root=""
dir="$file_dir"
while :; do
    for m in $markers; do
        if [ -f "${dir%/}/$m" ]; then
            project_root="$dir"
            break 2
        fi
    done
    if [ "$dir" = "$workspace" ]; then
        break
    fi
    if [ "$dir" = "/" ] || [ -z "$dir" ]; then
        break
    fi
    parent=$(dirname "$dir")
    if [ "$parent" = "$dir" ]; then
        break
    fi
    dir="$parent"
done

if [ -z "$project_root" ]; then
    project_root="$workspace"
fi

cd "$project_root" 2>/dev/null || exit 0

had_failure=0

run_check() {
    local name="$1"
    local cmd="$2"
    if [ -z "$cmd" ]; then
        return 0
    fi
    set +e
    output=$(bash -c "$cmd" 2>&1)
    rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
        # Cap output so a noisy linter (hundreds of lines) doesn't blow the model's context.
        local total_lines
        total_lines=$(printf '%s\n' "$output" | wc -l | tr -d ' ')
        if [ "$total_lines" -gt "$MAX_OUTPUT_LINES" ]; then
            local truncated_output omitted
            truncated_output=$(printf '%s\n' "$output" | head -n "$MAX_OUTPUT_LINES")
            omitted=$((total_lines - MAX_OUTPUT_LINES))
            printf '[validate.%s] command failed (exit %d)\n%s\n[truncated, %d more lines]\n' "$name" "$rc" "$truncated_output" "$omitted" >&2
        else
            printf '[validate.%s] command failed (exit %d)\n%s\n' "$name" "$rc" "$output" >&2
        fi
        had_failure=1
    fi
}

run_check "lint" "$lint_cmd"
run_check "typecheck" "$typecheck_cmd"

# Exit 1 (not 2) so the model sees the failure but the Edit/Write isn't rolled back.
if [ "$had_failure" -ne 0 ]; then
    exit 1
fi
exit 0
