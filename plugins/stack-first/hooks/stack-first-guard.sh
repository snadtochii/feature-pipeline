#!/usr/bin/env bash
# stack-first PreToolUse guard.
# Non-blocking tripwire on the Bash tool: when the command adds a new dependency
# (pnpm add / npm install <pkg> / yarn add / bun add / bun/pnpm i <pkg>), emit a
# systemMessage reminding the user to run the stack-first skill. NEVER blocks —
# always exits 0. Command filtering lives here, not in the matcher (matchers match
# tool names only; a package-regex matcher does not work on Codex).
#
# Output: a JSON object with a top-level "systemMessage" field on stdout — a
# non-blocking warning recognized on both Claude and Codex. No block/deny field
# is ever set.
#
# Bash version: targets bash 3.2 (macOS default) — no associative arrays, no mapfile.

set -euo pipefail

# jq is required to parse the hook input and emit safe JSON. Absent -> silent no-op.
if ! command -v jq >/dev/null 2>&1; then
    exit 0
fi

input=$(cat)
if [ -z "$input" ]; then
    exit 0
fi

cmd=$(jq -r '.tool_input.command // empty' <<<"$input" 2>/dev/null || true)
if [ -z "$cmd" ]; then
    exit 0
fi

# Global options that consume the FOLLOWING token as their value. They must be
# skipped together with their value, so a workspace/filter selector is mistaken
# for neither the subcommand (`pnpm --filter web add …`) nor a package argument
# (`pnpm install --filter web` adds nothing). Value consumption is MANAGER-AWARE
# because the same flag differs across CLIs: npm/yarn `-w`/`--workspace` take a
# workspace value (`npm -w web install zod`), while pnpm's `-w` is boolean
# (`pnpm -w add react`) and pnpm selects workspaces with `--filter <pkg>`.
# $1 = manager (pnpm|npm|yarn|bun), $2 = token.
value_opt() {
    # Common to all managers.
    case "$2" in
        --cwd|-C|--dir|--prefix) return 0 ;;
    esac
    case "$1" in
        pnpm) case "$2" in --filter) return 0 ;; esac ;;
        npm|yarn) case "$2" in -w|--workspace) return 0 ;; esac ;;
    esac
    return 1
}

# Shell redirections are not package arguments. A token that opens with a
# redirection operator (`2>&1`, `>/dev/null`, `&>log`, `<in`) is skipped; a bare
# operator (`>`, `2>>`, `&>`) is skipped together with its target word.
redir_re='^([0-9]+|&)?[<>]'
bare_redir_re='^([0-9]+|&)?[<>]+[&|]?$'
assign_re='^[A-Za-z_][A-Za-z0-9_]*='

# Turn the whole command into its simple commands, one per line. The only place
# that decides where a command starts and ends:
# - Split on the shell separators && || ; | — pure-bash replacement (no sed: BSD
#   sed on macOS emits a literal "n" for "\n", which would defeat the split), with
#   && and || replaced before the single | so the two-character separators win.
# - Tokenize each part once: a standalone `&` token (background) ends a command,
#   the grouping words `(` `)` `{` `}` are dropped, and a `(` or `)` glued to a
#   word is peeled off it — so `(pnpm i)` reads as `pnpm i`, `2>&1` and `&>` are
#   left alone, and no grouping character reaches the command word or the package
#   scan.
simple_commands() {
    local parts="$1"
    parts="${parts//&&/$'\n'}"
    parts="${parts//\|\|/$'\n'}"
    parts="${parts//;/$'\n'}"
    parts="${parts//\|/$'\n'}"
    local part out tok
    local -a toks
    while IFS= read -r part; do
        toks=()
        read -r -a toks <<<"$part" || true
        [ "${#toks[@]}" -gt 0 ] || continue
        out=""
        for tok in "${toks[@]}"; do
            case "$tok" in
                '&')
                    printf '%s\n' "$out"
                    out=""
                    continue
                    ;;
                '('|')'|'{'|'}') continue ;;
            esac
            while [[ "$tok" == '('* ]]; do tok="${tok#\(}"; done
            while [[ "$tok" == *')' ]]; do tok="${tok%\)}"; done
            if [ -n "$tok" ]; then
                out="$out $tok"
            fi
        done
        printf '%s\n' "$out"
    done <<<"$parts"
}

# Decide whether a single simple command adds a package.
# The manager must be the command word — the first token after any `VAR=value`
# assignments, shell keywords that open a command (if/then/do/else/elif/while/
# until/!) and pass-through wrappers (env/sudo/command/exec/time/nohup and
# their flags) — so a manager named inside prose, an `echo` string or a grep
# pattern is not a command. Locates the manager subcommand past any leading
# global options (so workspace/filter forms are handled), then fires on
# add/install/i ONLY when a real package argument follows — bare `pnpm install`
# / `npm i` (lockfile-only) stays exempt, redirected or not.
decide_fire() {
    local sub="$1"
    local -a toks
    # Intentional word-split into tokens; we only compare tokens, never eval them.
    read -r -a toks <<<"$sub" || return 1
    local n=${#toks[@]}
    local i=0
    local wrapped=0
    while [ "$i" -lt "$n" ]; do
        case "${toks[$i]}" in
            if|then|do|else|elif|while|until|'!') ;;
            env|sudo|command|exec|time|nohup) wrapped=1 ;;
            -*) [ "$wrapped" -eq 1 ] || return 1 ;;
            *) [[ "${toks[$i]}" =~ $assign_re ]] || break ;;
        esac
        i=$((i + 1))
    done
    [ "$i" -lt "$n" ] || return 1
    local mgr="${toks[$i]}"
    case "$mgr" in
        pnpm|npm|yarn|bun) ;;
        *) return 1 ;;
    esac
    # Locate the subcommand, skipping leading global options (and the values of
    # value-consuming ones) between the manager and it.
    local j=$((i + 1))
    local subcmd=""
    while [ "$j" -lt "$n" ]; do
        case "${toks[$j]}" in
            add|install|i)
                subcmd="${toks[$j]}"
                break
                ;;
            --*=*)
                j=$((j + 1))           # --opt=value, single token — skip
                ;;
            -*)
                if value_opt "$mgr" "${toks[$j]}"; then
                    j=$((j + 2))       # option + its value
                else
                    j=$((j + 1))       # boolean flag
                fi
                ;;
            *)
                break                  # positional that isn't a subcommand -> not an add
                ;;
        esac
    done
    [ -n "$subcmd" ] || return 1
    # Scan tokens after the subcommand for a real package argument, skipping
    # flags, the values of value-consuming options and redirections. A `#`
    # comment ends the command.
    local k=$((j + 1))
    local tok
    while [ "$k" -lt "$n" ]; do
        tok="${toks[$k]}"
        if [[ "$tok" =~ $bare_redir_re ]]; then
            k=$((k + 2))
            continue
        fi
        if [[ "$tok" =~ $redir_re ]]; then
            k=$((k + 1))
            continue
        fi
        case "$tok" in
            '#'*) return 1 ;;
            --*=*) k=$((k + 1)) ;;                        # --save-dev=… etc — skip
            -*)
                if value_opt "$mgr" "$tok"; then
                    k=$((k + 2))
                else
                    k=$((k + 1))
                fi
                ;;
            *) return 0 ;;                                # package argument present -> fire
        esac
    done
    return 1
}

# Evaluate each simple command. A shadcn CLI invocation (npx/pnpm dlx/bunx/local/
# direct) is exempt broadly — its component adds are UI scaffolding, not
# ecosystem-adoption decisions.
fire=0
while IFS= read -r sub; do
    [ -z "$sub" ] && continue
    if printf '%s' "$sub" | grep -Eq '(^|[[:space:]/])shadcn(-ui)?([[:space:]]|$)'; then
        continue
    fi
    if decide_fire "$sub"; then
        fire=1
        break
    fi
done <<EOF
$(simple_commands "$cmd")
EOF

if [ "$fire" -eq 1 ]; then
    msg="stack-first: this command adds a dependency. Run the stack-first skill before installing — read docs/STACK.md, check the preferred ecosystem for an in-ecosystem analog, then record the ruling. (This is a reminder; the install is not blocked.)"
    jq -n --arg m "$msg" '{systemMessage: $m}'
fi

exit 0
