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

# Decide whether a single sub-command adds a package.
# Fires on add/install/i ONLY when a non-flag package argument is present, so a
# bare `pnpm install` / `npm i` (lockfile-only, no new dependency) is exempt.
decide_fire() {
    local sub="$1"
    local -a toks
    # Intentional word-split into tokens; we only compare tokens, never eval them.
    read -r -a toks <<<"$sub" || return 1
    local n=${#toks[@]}
    local i=0
    while [ "$i" -lt "$n" ]; do
        case "${toks[$i]}" in
            pnpm|npm|yarn|bun)
                local sc="${toks[$((i + 1))]:-}"
                case "$sc" in
                    add|install|i)
                        local k=$((i + 2))
                        while [ "$k" -lt "$n" ]; do
                            case "${toks[$k]}" in
                                -*) ;;          # flag (e.g. -D, -g, --save-dev) — skip
                                *) return 0 ;;  # package argument present -> fire
                            esac
                            k=$((k + 1))
                        done
                        ;;
                esac
                ;;
        esac
        i=$((i + 1))
    done
    return 1
}

# Split the command on shell separators (&& || ; |) and evaluate each sub-command.
# A shadcn CLI invocation (npx/pnpm dlx/bunx/local/direct) is exempt broadly — its
# component adds are UI scaffolding, not ecosystem-adoption decisions.
# Pure-bash replacement (no sed): BSD sed on macOS emits a literal "n" for "\n",
# which would defeat the split on the target platform. Replace && and || before the
# single | so the multi-char separators are consumed first.
subcmds="$cmd"
subcmds="${subcmds//&&/$'\n'}"
subcmds="${subcmds//\|\|/$'\n'}"
subcmds="${subcmds//;/$'\n'}"
subcmds="${subcmds//\|/$'\n'}"

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
$subcmds
EOF

if [ "$fire" -eq 1 ]; then
    msg="stack-first: this command adds a dependency. Run the stack-first skill before installing — read docs/STACK.md, check the preferred ecosystem for an in-ecosystem analog, then record the ruling. (This is a reminder; the install is not blocked.)"
    jq -n --arg m "$msg" '{systemMessage: $m}'
fi

exit 0
