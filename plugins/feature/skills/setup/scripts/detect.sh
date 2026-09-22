#!/usr/bin/env bash
# feature setup detector.
# Inspects one repository and prints a JSON document of the evidence a setup
# dialogue proposes claudedocs/tickets/config.yaml defaults from. Read-only:
# writes nothing, runs nothing from the repository, never reads a dotenv file.
# Every fact is null unless the repository declares it — never a guess.
#
# Contract: ../references/detection.md (schema, every rule, exit codes).
# Bash version: targets bash 3.2 (macOS default) — no associative arrays, no mapfile.
#
# Usage:  bash detect.sh [<root>]      (<root> defaults to the current directory)
# Exit:   0 document printed; 1 jq not installed; 2 root not a directory or bad usage

set -euo pipefail

if [ "$#" -gt 1 ]; then
    echo "[detect] usage: detect.sh [<root>]" >&2
    exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "[detect] jq not installed" >&2
    exit 1
fi

root_arg=${1:-$PWD}
if [ ! -d "$root_arg" ]; then
    echo "[detect] not a directory: $root_arg" >&2
    exit 2
fi
root=$(cd "$root_arg" && pwd -P)

# JSON string for a non-empty value, else the literal null.
json_str() {
    if [ -n "$1" ]; then
        jq -n --arg v "$1" '$v'
    else
        printf 'null'
    fi
}

# --- prefix (§5) ---------------------------------------------------------------

detect_prefix() {
    local name word count first out IFS
    name=$(basename "$root")
    count=0
    first=""
    out=""
    IFS='-_'  # split on hyphen and underscore only
    set -f    # the unquoted split below must not glob a name like "a*b"
    for word in $name; do
        word=$(printf '%s' "$word" | tr -cd '[:alnum:]')
        if [ -z "$word" ]; then
            continue
        fi
        count=$((count + 1))
        if [ "$count" -eq 1 ]; then
            first="$word"
        fi
        out="$out$(printf '%s' "$word" | cut -c1)"
    done
    set +f
    if [ "$count" -eq 0 ]; then
        return 0
    fi
    if [ "$count" -eq 1 ]; then
        out=$(printf '%s' "$first" | cut -c1-2)
    fi
    printf '%s' "$out" | tr '[:lower:]' '[:upper:]'
}

# --- workspace shape (§4) ------------------------------------------------------

detect_workspace_shape() {
    local d
    if [ -e "$root/.git" ]; then
        printf 'single-repo'
        return 0
    fi
    for d in "$root"/*/; do
        if [ -e "${d}.git" ]; then
            printf 'multi-repo'
            return 0
        fi
    done
    printf 'single-repo'
}

# --- git facts (§4, §10) -------------------------------------------------------

in_git=false
if command -v git >/dev/null 2>&1; then
    if [ "$(git -C "$root" rev-parse --is-inside-work-tree 2>/dev/null || true)" = "true" ]; then
        in_git=true
    fi
fi

detect_claudedocs_ignored() {
    local rc
    if [ "$in_git" != true ]; then
        printf 'null'
        return 0
    fi
    rc=0
    git -C "$root" check-ignore -q claudedocs/ >/dev/null 2>&1 || rc=$?
    case "$rc" in
        0) printf 'true' ;;
        1) printf 'false' ;;
        *) printf 'null' ;;
    esac
}

# Existence test and git check-ignore only — a candidate's content is never read.
detect_worktreeinclude_candidates() {
    local f name found
    if [ "$in_git" != true ]; then
        printf 'null'
        return 0
    fi
    found=""
    for f in "$root/.env" "$root"/.env.* "$root/.envrc" "$root/claudedocs/tickets/config.yaml"; do
        if [ ! -f "$f" ]; then
            continue
        fi
        name=${f#"$root"/}
        if git -C "$root" check-ignore -q -- "$name" >/dev/null 2>&1; then
            found="$found$name
"
        fi
    done
    printf '%s' "$found" | LC_ALL=C sort -u | jq -R . | jq -s -c .
}

# --- instruction files (§11) ---------------------------------------------------

has_commands_section() {
    awk '
        /^[ \t]*(```|~~~)/ { in_fence = !in_fence; next }
        in_fence { next }
        /^#(#(#(#(#(#)?)?)?)?)?[ \t]/ {
            if (tolower($0) ~ /(commands|validation|testing)/) { found = 1; exit }
        }
        END { exit found ? 0 : 1 }
    ' "$1" 2>/dev/null
}

instruction_file_json() {
    local path="$root/$1" exists=false commands=false
    if [ -f "$path" ]; then
        exists=true
        if has_commands_section "$path"; then
            commands=true
        fi
    fi
    printf '{"exists":%s,"commands_section":%s}' "$exists" "$commands"
}

# --- manifests (§6–§9) ---------------------------------------------------------

package_manager=""
validate_lint=""
validate_typecheck=""
validate_test=""
test_url=""
test_start=""
worktree_setup=""
compose_file=""

# Node: every fact requires a package.json that parses as a JSON object.
node_scripts=""
has_script() {
    case "
$node_scripts
" in
        *"
$1
"*) return 0 ;;
    esac
    return 1
}

# Pipes into grep read their whole input (no -q): an early exit under pipefail
# can fail the writer with SIGPIPE and turn a match into a miss.
names_word() {
    printf '%s\n' "$1" | grep -E "(^|[^[:alnum:]_.-])$2([^[:alnum:]_.-]|\$)" >/dev/null
}

# Prints the dev server's port when the dev script names vite or next, else nothing.
dev_script_port() {
    local dev="$1" port=""
    if names_word "$dev" vite; then
        port=5173
    elif names_word "$dev" next; then
        port=3000
    else
        return 0
    fi
    local override
    override=$(printf '%s\n' "$dev" \
        | sed -nE 's/^(.*[[:space:]])?(--port(=|[[:space:]]+)|-p[[:space:]]+)([0-9]+)([[:space:]].*)?$/\4/p' \
        | head -n 1 || true)
    if [ -n "$override" ]; then
        port="$override"
    fi
    printf '%s' "$port"
}

if [ -f "$root/package.json" ] && jq -e 'type == "object"' "$root/package.json" >/dev/null 2>&1; then
    if [ -f "$root/pnpm-lock.yaml" ]; then
        package_manager=pnpm
        worktree_setup="pnpm install --frozen-lockfile"
    elif [ -f "$root/yarn.lock" ]; then
        package_manager=yarn
        if head -n 5 "$root/yarn.lock" 2>/dev/null | grep 'yarn lockfile v1' >/dev/null; then
            worktree_setup="yarn install --frozen-lockfile"
        else
            worktree_setup="yarn install --immutable"
        fi
    elif [ -f "$root/bun.lockb" ] || [ -f "$root/bun.lock" ]; then
        package_manager=bun
        worktree_setup="bun install --frozen-lockfile"
    elif [ -f "$root/package-lock.json" ]; then
        package_manager=npm
        worktree_setup="npm ci"
    else
        package_manager=npm
    fi

    node_scripts=$(jq -r '
        .scripts | if type == "object" then
            to_entries[] | select((.value | type) == "string" and (.value | length) > 0) | .key
        else empty end' "$root/package.json" 2>/dev/null || true)

    if has_script lint; then
        validate_lint="$package_manager run lint"
    fi
    for name in typecheck type-check tsc; do
        if has_script "$name"; then
            validate_typecheck="$package_manager run $name"
            break
        fi
    done
    if has_script test; then
        validate_test="$package_manager run test"
    fi

    if has_script dev; then
        dev=$(jq -r '.scripts.dev' "$root/package.json" 2>/dev/null || true)
        dev_port=$(dev_script_port "$dev")
        if [ -n "$dev_port" ]; then
            test_url="http://localhost:$dev_port"
            test_start="$package_manager run dev"
        fi
    fi
fi

# Python: lockfile picks the runner prefix; tool table headers declare the commands.
py_prefix=""
if [ -f "$root/uv.lock" ]; then
    py_prefix="uv run "
    if [ -z "$package_manager" ]; then
        package_manager=uv
    fi
elif [ -f "$root/poetry.lock" ]; then
    py_prefix="poetry run "
    if [ -z "$package_manager" ]; then
        package_manager=poetry
    fi
fi

toml_has_tool() {
    grep -Eq "^[[:space:]]*\[tool\.$1(\]|\.)" "$root/pyproject.toml" 2>/dev/null
}

if [ -f "$root/pyproject.toml" ]; then
    if [ -z "$validate_lint" ] && toml_has_tool ruff; then
        validate_lint="${py_prefix}ruff check ."
    fi
    if [ -z "$validate_typecheck" ]; then
        if toml_has_tool mypy; then
            validate_typecheck="${py_prefix}mypy ."
        elif toml_has_tool pyright; then
            validate_typecheck="${py_prefix}pyright"
        fi
    fi
    if [ -z "$validate_test" ] && toml_has_tool pytest; then
        validate_test="${py_prefix}pytest"
    fi
fi

# Makefile: a rule line naming the target among the words before its first
# colon (`test:`, `lint typecheck:`), not a variable assignment (`=`, `:=`, `::=`).
make_has_target() {
    awk -v t="$1" '
        /^[ \t#]/ { next }
        {
            i = index($0, ":")
            if (i == 0) { next }
            head = substr($0, 1, i - 1)
            rest = substr($0, i + 1)
            if (head ~ /=/ || rest ~ /^:?=/) { next }
            n = split(head, words, /[ \t]+/)
            for (k = 1; k <= n; k++) {
                if (words[k] == t) { found = 1; exit }
            }
        }
        END { exit found ? 0 : 1 }
    ' "$root/Makefile" 2>/dev/null
}

if [ -f "$root/Makefile" ]; then
    if [ -z "$validate_lint" ] && make_has_target lint; then
        validate_lint="make lint"
    fi
    if [ -z "$validate_typecheck" ] && make_has_target typecheck; then
        validate_typecheck="make typecheck"
    fi
    if [ -z "$validate_test" ] && make_has_target test; then
        validate_test="make test"
    fi
fi

# Compose: first host port published in a block-style ports: list, in file order.
compose_first_port() {
    awk -v q="'" '
        function indent(s) { match(s, /^[ \t]*/); return RLENGTH }
        /^[ \t]*(#.*)?$/ { next }
        {
            ind = indent($0)
            if (in_ports && (ind < pind || (ind == pind && $0 !~ /^[ \t]*-/))) { in_ports = 0 }
            if (!in_ports) {
                if ($0 ~ /^[ \t]*ports:[ \t]*(#.*)?$/) { in_ports = 1; pind = ind }
                next
            }
            line = $0
            sub(/[ \t]+#.*$/, "", line)
            gsub("[\"" q "]", "", line)
            if (line ~ /^[ \t]*-[ \t]*([0-9.]+:)?[0-9]+:[0-9]+(\/[a-z]+)?[ \t]*$/) {
                sub(/^[ \t]*-[ \t]*/, "", line)
                sub(/[ \t]+$/, "", line)
                sub(/\/[a-z]+$/, "", line)
                n = split(line, parts, ":")
                print parts[n - 1]
                exit
            }
            if (line ~ /^[ \t]*(-[ \t]*)?published:[ \t]*[0-9]+[ \t]*$/) {
                sub(/^[^:]*:[ \t]*/, "", line)
                sub(/[ \t]+$/, "", line)
                print line
                exit
            }
        }
    ' "$1" 2>/dev/null || true
}

for name in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
    if [ -f "$root/$name" ]; then
        compose_file="$name"
        break
    fi
done

if [ -z "$test_url" ] && [ -n "$compose_file" ]; then
    compose_port=$(compose_first_port "$root/$compose_file")
    if [ -n "$compose_port" ]; then
        test_url="http://localhost:$compose_port"
    fi
fi

# --- assemble ------------------------------------------------------------------

prefix=$(detect_prefix)

jq -n \
    --argjson prefix "$(json_str "$prefix")" \
    --argjson package_manager "$(json_str "$package_manager")" \
    --argjson lint "$(json_str "$validate_lint")" \
    --argjson typecheck "$(json_str "$validate_typecheck")" \
    --argjson test_cmd "$(json_str "$validate_test")" \
    --argjson url "$(json_str "$test_url")" \
    --argjson start "$(json_str "$test_start")" \
    --argjson worktree_setup "$(json_str "$worktree_setup")" \
    --argjson candidates "$(detect_worktreeinclude_candidates)" \
    --argjson claudedocs_ignored "$(detect_claudedocs_ignored)" \
    --argjson claude_md "$(instruction_file_json CLAUDE.md)" \
    --argjson agents_md "$(instruction_file_json AGENTS.md)" \
    --argjson compose_file "$(json_str "$compose_file")" \
    --arg workspace_shape "$(detect_workspace_shape)" \
    '{
        prefix: $prefix,
        package_manager: $package_manager,
        validate: { lint: $lint, typecheck: $typecheck, test: $test_cmd },
        test: { url: $url, start: $start },
        worktree_setup: $worktree_setup,
        worktreeinclude_candidates: $candidates,
        claudedocs_ignored: $claudedocs_ignored,
        instruction_files: { "CLAUDE.md": $claude_md, "AGENTS.md": $agents_md },
        compose_file: $compose_file,
        workspace_shape: $workspace_shape
    }'
