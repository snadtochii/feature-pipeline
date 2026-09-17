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
# WHERE THE FENCE LIVES. Beside the run lock, in the git common directory of the
# clone the call is touching — `<common-dir>/tidy-loop-fence.json`, located from
# the payload itself (the directory of `file_path`, else `cwd`). Every worktree of
# a clone shares one common dir, so one file covers a run and its worktrees while
# two clones running at once cannot see each other's. That is the whole reason the
# location is derived rather than fixed: a single machine-global path would make
# concurrent runs in different clones contend, and the skill would have to carry
# run-id bookkeeping at every write, sweep and clear to paper over it.
#
# FAILS OPEN FOR READS, CLOSED FOR WRITES. Missing jq, an empty payload or an empty
# file_path exit 0 — a hook that killed an unattended run over its own plumbing
# would be worse than the risk it covers. But once a WRITE is in hand, absence
# stops being a plumbing detail and becomes the dangerous direction: this script is
# bound from agent frontmatter, so it runs only inside a fenced spawn of a live
# run, and a write with no fence to consult is a write nothing is governing. So a
# write is DENIED when the clone cannot be located, or its fence file is missing,
# unparseable, or carries no globs; a read in the same state is allowed. Reading a
# spec cannot corrupt the evidence the run is judged on — writing one can.
#
# The compensating controls still live in the calling skill: a self-test proves
# this script denies before each spawn, and a per-commit diff assertion proves it
# denied afterwards.
#
# Glob matching: bash 3.2 has no globstar, so each glob is tried as a `case`
# pattern in three forms — literally, with `/**/` collapsed to `/`, and with a
# leading `**/` stripped — so `src/**/*.spec.ts` also matches `src/x.spec.ts`.
# A leading `./` is stripped first, because a runner's config often spells its
# include patterns that way and the subject path never does.
#
# Brace alternations are expanded before matching, and extglob is enabled, since
# `case` does neither on its own. A runner's own include pattern is routinely
# spelled with both — vitest's default is `**/*.{test,spec}.?(c|m)[jt]s?(x)` — and
# that is the spelling tidy-setup is told to derive `test_globs` from. UNDER-
# matching is the dangerous direction, and it is silent in one mode and loud in
# the other: a glob that matches nothing leaves `deny-match` allowing every spec
# edit, which unfences the implementer — the one invariant this file exists to
# enforce — and leaves `deny-unmatch` denying every spec write, which fences the
# spec-mover out of its own job. Over-matching is the tolerable direction: `*`
# spans `/` inside a case pattern, which makes this slightly over-permissive for
# exotic globs, and the skill's commit assertion is the backstop.
#
# Path containment is textual. `normalize_path` collapses `.` and `..` lexically
# and the containment test is a string prefix; neither side is resolved through
# symlinks. Where `repo_root` and the agent's `file_path` spell the same directory
# differently — one side through a symlink (`/var` vs `/private/var` on macOS, a
# symlinked projects root) — the path reads as outside the root, which denies a
# write loudly and allows a read under `deny-match` silently. Both sides are
# expected to arrive in one spelling: the skill records `repo_root` as the same
# worktree path it gives the agent to work in.
#
# Bash version: targets bash 3.2 (macOS default) — no associative arrays, no mapfile.

set -euo pipefail

# Half of what a runner's include pattern is spelled with is an extended glob
# (`?(c|m)[jt]s?(x)`). With extglob off, such a pattern matches nothing at all.
shopt -s extglob

FENCE_BASENAME="tidy-loop-fence.json"

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

# The payload is parsed FIRST, because the fence's location is derived from it.
#
# One jq call per field, deliberately, rather than one `@tsv` row split on tabs.
# The combined row saves two forks and costs two parsing hazards, in the one
# script whose job is to be unambiguous about which path it was asked about. Tab
# is IFS *whitespace*, so a run of tabs collapses: a payload carrying `cwd` but
# no `file_path` shifts the cwd into `file_path`, and the guard below can then
# never fire for that shape. And `@tsv` escapes a tab or backslash inside a path
# to `\t` / `\\`, which `read -r` preserves verbatim, so the path reaching
# `dirname`, `normalize_path` and the glob match is not the path the tool was
# given — and under `deny-match` a path that fails to match is an allowed write.
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

deny() {
    jq -n --arg r "$1" \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
    exit 0
}

# Absence is allowed for a read and denied for a write; see the header. Anything
# that cannot establish a governing fence routes through here.
no_fence() {
    if [ "$is_write" -eq 0 ]; then
        exit 0
    fi
    deny "$1"
}

# Locate the clone from the call itself. `--path-format=absolute` is load-bearing:
# `-C` selects the directory git resolves from, but `--git-common-dir` still prints
# a path relative to it (plain `.git` for a non-linked checkout), which would then
# be joined against this script's own working directory.
probe_dir=$(dirname -- "$file_path")
if [ ! -d "$probe_dir" ]; then
    probe_dir="${hook_cwd:-.}"
fi
common_dir=$(
    git -C "$probe_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true
)
if [ -z "$common_dir" ] || [ ! -d "$common_dir" ]; then
    no_fence "this path is not inside a repository this run fences"
fi

FENCE_FILE="${common_dir%/}/${FENCE_BASENAME}"
if [ ! -f "$FENCE_FILE" ]; then
    no_fence "no write fence is active for this repository"
fi

repo_root=$(jq -r '.repo_root // empty' "$FENCE_FILE" 2>/dev/null || true)
globs=$(jq -r '.test_globs[]? // empty' "$FENCE_FILE" 2>/dev/null || true)
if [ -z "$repo_root" ] || [ -z "$globs" ]; then
    no_fence "the write fence for this repository is unreadable"
fi
repo_root="${repo_root%/}"

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

# Expand `{a,b}` alternations into one pattern per branch. `case` performs no
# brace expansion, so an unexpanded `{test,spec}` is matched as those literal
# characters and the glob matches no file at all. Nesting is tracked for `{}` and
# for extglob `()` so a comma inside either stays inside its group. Never `eval` —
# the glob is data from the fence file and is matched, never executed.
expand_braces() {
    local pat="$1"
    local i ch open close depth bdepth pdepth body prefix suffix seg alt
    local -a alts

    open=-1
    for (( i=0; i<${#pat}; i++ )); do
        if [ "${pat:i:1}" = '{' ]; then
            open=$i
            break
        fi
    done
    if [ "$open" -lt 0 ]; then
        printf '%s\n' "$pat"
        return
    fi

    depth=0
    close=-1
    for (( i=open; i<${#pat}; i++ )); do
        ch="${pat:i:1}"
        if [ "$ch" = '{' ]; then
            depth=$(( depth + 1 ))
        elif [ "$ch" = '}' ]; then
            depth=$(( depth - 1 ))
            if [ "$depth" -eq 0 ]; then
                close=$i
                break
            fi
        fi
    done
    # Unbalanced braces: match the pattern as written rather than guessing.
    if [ "$close" -lt 0 ]; then
        printf '%s\n' "$pat"
        return
    fi

    prefix="${pat:0:open}"
    body="${pat:open+1:close-open-1}"
    suffix="${pat:close+1}"

    alts=()
    seg=""
    bdepth=0
    pdepth=0
    for (( i=0; i<${#body}; i++ )); do
        ch="${body:i:1}"
        case "$ch" in
            '{') bdepth=$(( bdepth + 1 )); seg="$seg$ch" ;;
            '}') bdepth=$(( bdepth - 1 )); seg="$seg$ch" ;;
            '(') pdepth=$(( pdepth + 1 )); seg="$seg$ch" ;;
            ')') pdepth=$(( pdepth - 1 )); seg="$seg$ch" ;;
            ',')
                if [ "$bdepth" -eq 0 ] && [ "$pdepth" -eq 0 ]; then
                    alts=( "${alts[@]+"${alts[@]}"}" "$seg" )
                    seg=""
                else
                    seg="$seg$ch"
                fi
                ;;
            *) seg="$seg$ch" ;;
        esac
    done
    alts=( "${alts[@]+"${alts[@]}"}" "$seg" )

    for alt in "${alts[@]+"${alts[@]}"}"; do
        expand_braces "$prefix$alt$suffix"
    done
}

matched=0
while IFS= read -r glob; do
    [ -z "$glob" ] && continue
    while IFS= read -r pattern; do
        [ -z "$pattern" ] && continue
        # A runner spells its include patterns relative to the repo root and often
        # writes that leading `./`; `rel` never carries one.
        case "$pattern" in
            './'*) pattern="${pattern#./}" ;;
        esac
        collapsed="${pattern//\/\*\*\//\/}"
        stripped="$pattern"
        case "$stripped" in
            '**/'*) stripped="${stripped#\*\*/}" ;;
        esac
        # Unquoted on purpose: the glob is the pattern, the path is the subject.
        case "$rel" in
            $pattern) matched=1 ;;
            $collapsed) matched=1 ;;
            $stripped) matched=1 ;;
        esac
        [ "$matched" -eq 1 ] && break
    done <<INNER_EOF
$(expand_braces "$glob")
INNER_EOF
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
