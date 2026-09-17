#!/usr/bin/env bash
# tidy-loop PreToolUse write fence.
# Bound from an agent's own frontmatter, never from a plugin hooks.json, so it
# applies to exactly the agent that declares it and to no other agent and not to
# the skill's own edits.
#
# WHY THIS ONE DENIES. Every other hook this plugin ships is a reminder. This one
# blocks, because the loop's central claim is that the agent making a structural
# change structurally cannot edit the tests it is judged against. A run reaches
# "tests green" honestly only if weakening a test was never reachable; an advisory
# hook an agent may talk itself past would make that claim unverifiable, so the
# denial is the mechanism and not a warning about it.
#
# Modes — the direction is the FIRST POSITIONAL ARGUMENT, supplied by the binding
# agent's frontmatter. It is not looked up from the stdin payload: a control that
# fails open must not key on a field whose presence is not documented.
#   deny-match    the implementer. Denies any path matching test_globs.
#   deny-unmatch  the spec-mover. Denies any written path matching none of them.
# An unknown or missing mode exits 0, which is why the calling skill self-tests
# this script — in the spawn's own mode — immediately before each spawn.
#
# Input:  the PreToolUse payload on stdin (tool_name, tool_input.file_path, cwd).
# Output: on a denial, one JSON object on stdout, exit 0 —
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse",
#     "permissionDecision":"deny","permissionDecisionReason":"…"}}
#   Otherwise no output and exit 0. The script never blocks by exit code.
#
# FAILS OPEN, DELIBERATELY AND VISIBLY. Missing jq, a missing or unparseable fence
# file, an empty glob set, an empty file_path: every one of them exits 0 and allows
# the call. A hook that killed an unattended run over its own plumbing would be
# worse than the risk it covers. The compensating controls live in the calling
# skill, not here: a self-test proves this script denies before each spawn, and a
# per-commit diff assertion proves it denied afterwards.
#
# Glob matching: bash 3.2 has no globstar, so each glob is tried as a `case`
# pattern in three forms — literally, with `/**/` collapsed to `/`, and with a
# leading `**/` stripped — so `src/**/*.spec.ts` also matches `src/x.spec.ts`.
# `*` spans `/` inside a case pattern, which makes this slightly over-permissive
# for exotic globs; the skill's commit assertion is the backstop.
#
# Bash version: targets bash 3.2 (macOS default) — no associative arrays, no mapfile.

set -euo pipefail

FENCE_FILE="${HOME}/.tidy-loop/fence.json"

mode="${1:-}"
case "$mode" in
    deny-match|deny-unmatch) ;;
    *) exit 0 ;;
esac

# jq is required to parse the payload and to emit safe JSON. Absent -> silent no-op.
if ! command -v jq >/dev/null 2>&1; then
    exit 0
fi

input=$(cat)
if [ -z "$input" ]; then
    exit 0
fi

if [ ! -f "$FENCE_FILE" ]; then
    exit 0
fi

repo_root=$(jq -r '.repo_root // empty' "$FENCE_FILE" 2>/dev/null || true)
globs=$(jq -r '.test_globs[]? // empty' "$FENCE_FILE" 2>/dev/null || true)
if [ -z "$repo_root" ] || [ -z "$globs" ]; then
    exit 0
fi
repo_root="${repo_root%/}"

tool_name=$(jq -r '.tool_name // empty' <<<"$input" 2>/dev/null || true)
file_path=$(jq -r '.tool_input.file_path // empty' <<<"$input" 2>/dev/null || true)
hook_cwd=$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null || true)
if [ -z "$file_path" ]; then
    exit 0
fi

is_write=0
case "$tool_name" in
    Write|Edit|MultiEdit) is_write=1 ;;
esac

# deny-unmatch governs writes only. The spec-mover's binding matches write tools,
# and a mode that denied every read outside the spec set would fence it out of the
# code it is repointing imports at.
if [ "$mode" = "deny-unmatch" ] && [ "$is_write" -eq 0 ]; then
    exit 0
fi

# Resolve the path against the payload's cwd. The hook process's own working
# directory is not a documented guarantee, so $PWD is only the last resort.
case "$file_path" in
    /*) abs="$file_path" ;;
    *)
        if [ -n "$hook_cwd" ]; then
            abs="${hook_cwd%/}/$file_path"
        else
            abs="$PWD/$file_path"
        fi
        ;;
esac

# Collapse `.` and `..` textually. Without this, `<repo_root>/../elsewhere/x`
# would read as a path inside the root and be measured against the globs there.
normalize_path() {
    local raw="$1"
    local -a out
    local seg
    local oldifs="$IFS"
    IFS='/'
    # Intentional word-split on the separator; segments are compared, never run.
    set -f
    # shellcheck disable=SC2086
    local -a parts=($raw)
    set +f
    IFS="$oldifs"
    for seg in "${parts[@]+"${parts[@]}"}"; do
        case "$seg" in
            ''|'.') ;;
            '..')
                if [ "${#out[@]}" -gt 0 ]; then
                    unset "out[$(( ${#out[@]} - 1 ))]"
                    out=( "${out[@]+"${out[@]}"}" )
                fi
                ;;
            *) out=( "${out[@]+"${out[@]}"}" "$seg" ) ;;
        esac
    done
    local joined=""
    for seg in "${out[@]+"${out[@]}"}"; do
        joined="$joined/$seg"
    done
    printf '%s' "${joined:-/}"
}

abs=$(normalize_path "$abs")
repo_root=$(normalize_path "$repo_root")

deny() {
    jq -n --arg r "$1" \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
    exit 0
}

# Outside the run's worktree. A write there escapes the run's isolation whichever
# direction the fence points, so both modes refuse it; a read is left alone.
rel=""
case "$abs" in
    "$repo_root"/*) rel="${abs#"$repo_root"/}" ;;
    *)
        if [ "$is_write" -eq 1 ]; then
            deny "This run writes only inside its own worktree ($repo_root). Refused: $file_path. Make the change inside the worktree, and do not route it through a shell command either."
        fi
        exit 0
        ;;
esac

matched=0
while IFS= read -r glob; do
    [ -z "$glob" ] && continue
    collapsed="${glob//\/\*\*\//\/}"
    stripped="$glob"
    case "$stripped" in
        '**/'*) stripped="${stripped#\*\*/}" ;;
    esac
    # Unquoted on purpose: the glob is the pattern, the path is the subject.
    case "$rel" in
        $glob) matched=1 ;;
        $collapsed) matched=1 ;;
        $stripped) matched=1 ;;
    esac
    [ "$matched" -eq 1 ] && break
done <<EOF
$globs
EOF

if [ "$mode" = "deny-match" ] && [ "$matched" -eq 1 ]; then
    deny "This is a test file, and you are fenced out of the tests your change is judged against. Refused: $rel. Change the source so the existing tests pass as written — do not edit, delete, or skip them, and do not reach them through a shell command instead."
fi

if [ "$mode" = "deny-unmatch" ] && [ "$matched" -eq 0 ]; then
    deny "You may write only test files on this run. Refused: $rel, which matches none of the project's spec globs. Apply the rename map to the specs; leave the source to the change that is already committed, and do not route a write through a shell command instead."
fi

exit 0
