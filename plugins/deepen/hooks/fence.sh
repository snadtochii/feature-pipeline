#!/usr/bin/env bash
# deepen PreToolUse write fence: `fence.sh`, no arguments.
# Bound once, plugin-wide, by hooks/hooks.json — Claude Code ignores `hooks:` in
# a plugin agent's frontmatter, while a plugin hook also fires inside subagents
# with the subagent's `agent_type` in its payload. The script therefore fires on
# every write-tool call of every session that has the plugin enabled, and
# dispatches on `agent_type` to find the role it governs (see AGENT DISPATCH).
# The contract this script implements is skills/run/references/fence.md (§1 the
# file, §2 roots, globs and modes, §3 the named sets and the agents bound to
# them); this header explains the mechanics, not the policy.
#
# WHY THIS ONE DENIES. The run's central claim is that the role making a change
# structurally cannot edit what the change is judged against — the behavior
# inventory, the specs, the profile, the forbidden paths — and that every other
# writing role is confined to its own paths. A green suite is evidence only if
# weakening a check was never reachable; an advisory hook a role may talk itself
# past would make that unverifiable, so the denial is the mechanism.
#
# AGENT DISPATCH. The payload's `agent_type` names the agent making the call. An
# optional leading `plugin:` is stripped, since the plugin-scoped spelling is
# documented both as `plugin:<plugin>:<agent>` and as `<plugin>:<agent>`.
#   - no `agent_type` (the main conversation), or one outside the `deepen:`
#     namespace (every other plugin's agents, the built-in agents): exit 0, no
#     output, before jq or git is consulted — the fence governs deepen's roles
#     and nothing else;
#   - `deepen:<agent>` with a row in FENCE_MAP below: that row's <mode> <set>;
#   - `deepen:<agent>` with no row: every write is refused. Deepen's own
#     namespace fails closed, so a writing agent added without a row is fenced
#     off from writing rather than left free.
# The run skill calls the script the same way, with `agent_type` in the payload,
# so what the fence refuses in a spawn and what the run's own checks refuse are
# one decision.
#   mode   deny-match  refuse a write whose target matches the named set
#          allow-only  refuse a write whose target matches none of it
#   set    a key of the fence file's `sets`, matching [a-z][a-z0-9-]*
# Both modes govern writes only (Write, Edit, MultiEdit, NotebookEdit).
#
# Input:  the PreToolUse payload on stdin (agent_type, tool_name,
#         tool_input.file_path or tool_input.notebook_path, cwd).
# Output: on a denial, one JSON object on stdout, exit 0 —
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse",
#     "permissionDecision":"deny","permissionDecisionReason":"…"}}
#   Otherwise no output and exit 0. The script never blocks by exit code.
#
# WHERE THE FENCE LIVES. `<common-dir>/deepen-fence.json`, beside the run lock in
# the git common directory of the clone the spawn runs in. The location is derived
# from the payload's `cwd` — the spawn's own clone or run worktree — and only when
# `cwd` sits in no repository from the directory of the target, because every
# worktree of a clone shares one common dir: one file covers a run and its
# worktrees, and two clones running at once never see each other's. `cwd` comes
# first so a write aimed into another clone is judged by this run's fence, whose
# roots it lies outside, never by that clone's own fence.
#
# FAILS OPEN FOR READS, CLOSED FOR WRITES — for a deepen agent. Once dispatch has
# matched a `deepen:` agent the call comes from a fenced role, so a write with
# nothing to consult is a write nothing is governing. A write is DENIED when jq
# is absent, the agent has no FENCE_MAP row, its row is malformed (an unknown
# mode or set name), no repository can be located, or the fence file is
# missing, unparseable, lacks a root, or carries no globs for the named set, and
# when the script itself fails unexpectedly. A read in the same state is
# allowed. Without jq the payload cannot be parsed safely, so the agent and the
# tool name alone are taken with a bash regex and the denial is a fixed string
# that needs no escaping.
#
# ROOTS. A write is considered only under `repo_root` (the run worktree) or
# `run_dir` (the QA run directory); outside both it is refused in both modes. A
# glob beginning with `/` is absolute and matches the normalized absolute path;
# any other glob is repo-relative and matches only a target under `repo_root`,
# taken relative to it.
#
# GLOBS. bash 3.2 has no globstar, so each pattern is tried as a `case` pattern in
# three forms — as written, with `/**/` collapsed to `/`, and with a leading `**/`
# stripped — so `src/**/*.spec.ts` also matches `src/x.spec.ts`. A leading `./` is
# stripped from a repo-relative pattern. Brace alternations are expanded first and
# extglob is enabled, since `case` does neither on its own and spec globs are
# routinely spelled `**/*.{test,spec}.?(c|m)[jt]s?(x)`. UNDER-matching is the
# dangerous direction: under deny-match it silently allows a write the set was
# meant to refuse. `*` spans `/` inside a case pattern, so matching errs toward
# over-matching, which only ever produces a loud denial. For the same reason
# deny-match globs match case-insensitively (a case-insensitive filesystem writes
# `Tests/x` into `tests/x`); allow-only globs stay case-sensitive.
#
# CONTAINMENT IS TEXTUAL. `normalize_path` collapses `.` and `..` lexically and
# the root test is a string prefix; no side is resolved through symlinks. A root
# spelled differently (`/var` vs `/private/var` on macOS) reads as outside both
# roots, which refuses the write loudly; a symlink inside a root is judged by its
# own spelling, not its target's. The run skill records both roots in the
# spelling it gives the agent.
#
# Bash version: targets bash 3.2 (macOS default) — no associative arrays, no
# mapfile.

set -euo pipefail

# Half of what a spec glob is spelled with is an extended glob (`?(c|m)[jt]s?(x)`).
# With extglob off, such a pattern matches nothing at all.
shopt -s extglob

FENCE_BASENAME="deepen-fence.json"

# The one agent-to-set mapping: `<agent> <mode> <set>`, one row per fenced deepen
# agent, <agent> being the name after `deepen:`. fence.md §3 carries the same
# rows and scripts/check-deepen-contract.sh holds the two in lockstep.
# BEGIN FENCE_MAP
FENCE_MAP='
implementer deny-match implementer
spec-mover allow-only specs
qa-characterizer allow-only qa
'
# END FENCE_MAP

input=$(cat)
if [ -z "$input" ]; then
    exit 0
fi

# Cheap exit for every call the fence does not govern. Without the key text
# anywhere in the payload there is no `agent_type`, so this is the main
# conversation; nothing is spawned to decide it.
case "$input" in
    *'"agent_type"'*) ;;
    *) exit 0 ;;
esac

have_jq=0
if command -v jq >/dev/null 2>&1; then
    have_jq=1
fi

agent_type=""
if [ "$have_jq" -eq 1 ]; then
    agent_type=$(jq -r 'if (.agent_type | type) == "string" then .agent_type else empty end' <<<"$input" 2>/dev/null || true)
fi
# Without jq, or on a payload jq cannot read, take the key with a regex. Inside a
# JSON string every `"` is escaped, so `"agent_type"` followed by `:` matches only
# a real key, never text inside a written file's content.
if [ -z "$agent_type" ]; then
    agent_re='"agent_type"[[:space:]]*:[[:space:]]*"([^"\\]*)"'
    if [[ "$input" =~ $agent_re ]]; then
        agent_type="${BASH_REMATCH[1]}"
    fi
fi

agent_type="${agent_type#plugin:}"
case "$agent_type" in
    deepen:*) ;;
    *) exit 0 ;;
esac
agent="${agent_type#deepen:}"

mode=""
set_name=""
mapped=0
while read -r row_agent row_mode row_set; do
    if [ -n "$row_agent" ] && [ "$row_agent" = "$agent" ]; then
        mode="$row_mode"
        set_name="$row_set"
        mapped=1
        break
    fi
done <<FENCE_MAP_END
$FENCE_MAP
FENCE_MAP_END

bad_binding=0
case "$mode" in
    deny-match|allow-only) ;;
    *) bad_binding=1 ;;
esac
case "$set_name" in
    [a-z]*)
        case "$set_name" in
            *[!a-z0-9-]*) bad_binding=1 ;;
        esac
        ;;
    *) bad_binding=1 ;;
esac

# Without jq nothing can be parsed or emitted safely. Reads pass; every other
# tool call of a deepen agent is refused with a fixed denial.
if [ "$have_jq" -eq 0 ]; then
    tool_re='"tool_name"[[:space:]]*:[[:space:]]*"([A-Za-z]+)"'
    bare_tool=""
    if [[ "$input" =~ $tool_re ]]; then
        bare_tool="${BASH_REMATCH[1]}"
    fi
    case "$bare_tool" in
        Read|Glob|Grep|LS|NotebookRead) exit 0 ;;
    esac
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The write fence cannot run because jq is not installed, so every write on this run is refused. Report the refused write; do not route it through a shell command instead."}}'
    exit 0
fi

# One jq call per field, deliberately, rather than one `@tsv` row split on tabs:
# tab is IFS whitespace, so a missing field shifts the next one into its place,
# and `@tsv` escapes a tab or backslash inside a path, so the path reaching the
# match would not be the path the tool was given.
tool_name=$(jq -r '.tool_name // empty' <<<"$input" 2>/dev/null || true)
file_path=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input" 2>/dev/null || true)
hook_cwd=$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null || true)
if [ -z "$file_path" ]; then
    exit 0
fi

is_write=0
case "$tool_name" in
    Write|Edit|MultiEdit|NotebookEdit) is_write=1 ;;
esac

# Any failure this script did not plan for would exit non-zero but not 2, which
# the harness treats as a non-blocking error: the write would go through. Turn
# it into the fixed denial instead; a read in the same state still passes.
FIXED_DENY='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The write fence failed unexpectedly, so this write is refused. Report the refused write; do not route it through a shell command instead."}}'
on_error() {
    if [ "$is_write" -eq 1 ]; then
        printf '%s\n' "$FIXED_DENY"
    fi
    exit 0
}
trap on_error ERR

# A function does not inherit the ERR trap below, so a failing jq here falls back
# to the fixed denial itself.
deny() {
    jq -n --arg r "$1" \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}' \
        || printf '%s\n' "$FIXED_DENY"
    exit 0
}

# Absence is allowed for a read and denied for a write; see the header. Anything
# that cannot establish a governing fence routes through here.
no_fence() {
    if [ "$is_write" -eq 0 ]; then
        exit 0
    fi
    deny "$1 Report the refused write; do not route it through a shell command instead."
}

if [ "$mapped" -eq 0 ]; then
    no_fence "The deepen agent '$agent' has no write fence mapping, so its writes are refused."
fi
if [ "$bad_binding" -eq 1 ]; then
    no_fence "The write fence mapping for the deepen agent '$agent' is malformed, so its writes are refused."
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

# Locate the clone from the call: the payload's cwd first, the target's directory
# only as the fallback (see the header). `--path-format=absolute` is load-bearing:
# `-C` selects the directory git resolves from, but `--git-common-dir` still
# prints a path relative to it (plain `.git` for a non-linked checkout).
common_dir=""
if [ -n "$hook_cwd" ] && [ -d "$hook_cwd" ]; then
    common_dir=$(
        git -C "$hook_cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true
    )
fi
if [ -z "$common_dir" ]; then
    probe_dir=$(dirname -- "$abs")
    if [ -d "$probe_dir" ]; then
        common_dir=$(
            git -C "$probe_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true
        )
    fi
fi
if [ -z "$common_dir" ] || [ ! -d "$common_dir" ]; then
    no_fence "This path is not inside a repository this run fences."
fi

FENCE_FILE="${common_dir%/}/${FENCE_BASENAME}"
if [ ! -f "$FENCE_FILE" ]; then
    no_fence "No write fence is active for this repository."
fi

repo_root=$(jq -r '.repo_root // empty' "$FENCE_FILE" 2>/dev/null || true)
run_dir=$(jq -r '.run_dir // empty' "$FENCE_FILE" 2>/dev/null || true)
globs=$(jq -r --arg s "$set_name" '.sets[$s][]? // empty' "$FENCE_FILE" 2>/dev/null || true)
if [ -z "$repo_root" ] || [ -z "$run_dir" ] || [ -z "$globs" ]; then
    no_fence "The write fence for this repository is unreadable or defines no '$set_name' set."
fi

# Both modes govern writes only.
if [ "$is_write" -eq 0 ]; then
    exit 0
fi

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
run_dir=$(normalize_path "$run_dir")

# `rel` is the repo-relative path for a target under repo_root, and empty for a
# target under run_dir, which only absolute globs can match.
rel=""
case "$abs" in
    "$repo_root"/*) rel="${abs#"$repo_root"/}" ;;
    "$run_dir"/*) rel="" ;;
    *)
        deny "This run writes only inside the run worktree ($repo_root) or the QA run directory ($run_dir). Refused: $abs. Do not route the write through a shell command instead."
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

# Over-match on case under deny-match only; the root test above stays exact.
if [ "$mode" = "deny-match" ]; then
    shopt -s nocasematch
fi

matched=0
while IFS= read -r glob; do
    [ -z "$glob" ] && continue
    # Expanded into a variable and checked here, not inside the heredoc below: a
    # substitution in a heredoc is covered by neither `set -e` nor the ERR trap,
    # so a failed expansion would hand back a short pattern list and deny-match
    # would allow the write. A non-empty glob always expands to at least one line.
    patterns=""
    if ! patterns=$(expand_braces "$glob") || [ -z "$patterns" ]; then
        deny "The write fence could not expand the glob '$glob' of the '$set_name' set, so this write is refused. Report the refused write; do not route it through a shell command instead."
    fi
    while IFS= read -r pattern; do
        [ -z "$pattern" ] && continue
        collapsed="${pattern//\/\*\*\//\/}"
        case "$pattern" in
            /*)
                # Absolute: matched against the normalized absolute target.
                # Unquoted on purpose: the glob is the pattern, the path the subject.
                case "$abs" in
                    $pattern) matched=1 ;;
                    $collapsed) matched=1 ;;
                esac
                ;;
            *)
                # Repo-relative: only a target under repo_root can match.
                if [ -n "$rel" ]; then
                    case "$pattern" in
                        './'*) pattern="${pattern#./}" ;;
                    esac
                    collapsed="${pattern//\/\*\*\//\/}"
                    stripped="$pattern"
                    case "$stripped" in
                        '**/'*) stripped="${stripped#\*\*/}" ;;
                    esac
                    case "$rel" in
                        $pattern) matched=1 ;;
                        $collapsed) matched=1 ;;
                        $stripped) matched=1 ;;
                    esac
                fi
                ;;
        esac
        [ "$matched" -eq 1 ] && break
    done <<FENCE_PATTERNS_END
$patterns
FENCE_PATTERNS_END
    [ "$matched" -eq 1 ] && break
done <<FENCE_GLOBS_END
$globs
FENCE_GLOBS_END

shown="${rel:-$abs}"

if [ "$mode" = "deny-match" ] && [ "$matched" -eq 1 ]; then
    deny "This path is in the '$set_name' fence set: part of what your change is judged against, or not yours to change on this run. Refused: $shown. Change what you are allowed to change so the checks pass as written, and do not route this write through a shell command instead."
fi

if [ "$mode" = "allow-only" ] && [ "$matched" -eq 0 ]; then
    deny "On this run you may write only the paths in the '$set_name' fence set. Refused: $shown, which matches none of them. Do not route this write through a shell command instead."
fi

exit 0
