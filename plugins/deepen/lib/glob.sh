#!/usr/bin/env bash
# deepen glob patterns: `lib/glob.sh`.
# The grammar this file implements is skills/run/references/fence.md §2. It is
# sourced by hooks/fence.sh and skills/run/scripts/hotspots.sh, so the fence and
# the hotspot exclusions match a glob the same way; run directly it takes only
# --self-test.
#
#   glob_patterns <glob>   print one bash `case` pattern per line such that a
#                          path matches <glob> exactly when it matches one of
#                          them; exit 1 when the glob cannot be expanded.
#
# The caller matches each printed pattern unquoted in a `case`, with extglob on,
# and sets nocasematch itself where its contract asks for case-insensitivity.
#
# bash 3.2 has no globstar, and inside a `case` pattern `*` spans `/`, so `**/`
# written as-is already matches one or more directories. What `case` cannot do
# is match zero: every `**` path segment is therefore either kept or dropped,
# independently of every other one, which yields 2^k patterns for k such
# segments — `**/tests/**/*.ts` prints four, and the one with both dropped is
# what matches `tests/root.ts`.
#
# Globs are data. Nothing here evaluates one; every expansion is string slicing.
#
# Bash version: targets bash 3.2 (macOS default) — no associative arrays, no
# mapfile.

# Expand `{a,b}` alternations into one pattern per branch. `case` performs no
# brace expansion, so an unexpanded `{test,spec}` is matched as those literal
# characters and the glob matches no file at all. Nesting is tracked for `{}` and
# for extglob `()` so a comma inside either stays inside its group.
glob_expand_braces() {
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
        return 0
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
        return 0
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
        glob_expand_braces "$prefix$alt$suffix"
    done
}

# Print every variant of one brace-free pattern in which each `**` path segment
# that is followed by `/` is kept (one or more directories) or dropped (zero).
# $1 is the part already emitted, $2 the part still to walk. A final `**`
# segment is kept as written: a file sits below it, so zero never applies.
glob_zero_dir_variants() {
    local emitted="$1" rest="$2" seg
    case "$rest" in
        */*)
            seg="${rest%%/*}"
            rest="${rest#*/}"
            ;;
        *)
            printf '%s\n' "$emitted$rest"
            return 0
            ;;
    esac
    if [ "$seg" = '**' ]; then
        glob_zero_dir_variants "$emitted" "$rest"
        glob_zero_dir_variants "$emitted**/" "$rest"
    else
        glob_zero_dir_variants "$emitted$seg/" "$rest"
    fi
}

glob_patterns() {
    local glob="$1" expanded pattern
    if [ -z "$glob" ]; then
        return 1
    fi
    if ! expanded=$(glob_expand_braces "$glob") || [ -z "$expanded" ]; then
        return 1
    fi
    while IFS= read -r pattern; do
        if [ -z "$pattern" ]; then
            continue
        fi
        case "$pattern" in
            './'*) pattern="${pattern#./}" ;;
        esac
        glob_zero_dir_variants "" "$pattern"
    done <<GLOB_EXPANDED_END
$expanded
GLOB_EXPANDED_END
}

# --self-test: every case is `<path> <glob> <case-insensitive> <case-sensitive>`,
# tab-separated since a glob may hold `|`, each expectation `y` (matches) or `n`.
# The fence refuses under deny-match on a case-insensitive match and under
# allow-only on a case-sensitive miss, so the two columns are the two modes'
# inputs.
glob_self_test() {
    local path glob want_i want_s got_i got_s pattern patterns failed=0 n=0
    shopt -s extglob
    while IFS=$'\t' read -r path glob want_i want_s; do
        if [ -z "$path" ]; then
            continue
        fi
        n=$(( n + 1 ))
        if ! patterns=$(glob_patterns "$glob"); then
            printf 'self-test: FAIL — could not expand %s\n' "$glob" >&2
            failed=1
            continue
        fi
        got_i=n
        got_s=n
        while IFS= read -r pattern; do
            # Unquoted on purpose: the glob is the pattern, the path the subject.
            shopt -s nocasematch
            case "$path" in $pattern) got_i=y ;; esac
            shopt -u nocasematch
            case "$path" in $pattern) got_s=y ;; esac
        done <<GLOB_SELFTEST_PATTERNS_END
$patterns
GLOB_SELFTEST_PATTERNS_END
        if [ "$got_i" != "$want_i" ] || [ "$got_s" != "$want_s" ]; then
            printf 'self-test: FAIL — %s against %s: case-insensitive %s (want %s), case-sensitive %s (want %s)\n' \
                "$path" "$glob" "$got_i" "$want_i" "$got_s" "$want_s" >&2
            failed=1
        fi
    done <<'GLOB_SELFTEST_CASES_END'
tests/root.ts	**/tests/**/*.ts	y	y
tests/unit/root.ts	**/tests/**/*.ts	y	y
a/tests/root.ts	**/tests/**/*.ts	y	y
a/b/tests/c/d/root.ts	**/tests/**/*.ts	y	y
Tests/root.ts	**/tests/**/*.ts	y	n
src/root.ts	**/tests/**/*.ts	n	n
a/b/c.ts	a/**/b/**/c.ts	y	y
a/x/b/c.ts	a/**/b/**/c.ts	y	y
a/b/y/z/c.ts	a/**/b/**/c.ts	y	y
a/c.ts	a/**/b/**/c.ts	n	n
src/x.spec.ts	**/*.{test,spec}.?(c|m)[jt]s?(x)	y	y
x.test.tsx	**/*.{test,spec}.?(c|m)[jt]s?(x)	y	y
src/deep/x.spec.mjs	**/*.{test,spec}.?(c|m)[jt]s?(x)	y	y
src/x.ts	**/*.{test,spec}.?(c|m)[jt]s?(x)	n	n
src/x.ts	./src/**/*.ts	y	y
inv/a/b.md	inv/**	y	y
inv.md	inv/**	n	n
/w/run/verify-1/x.md	/w/run/**	y	y
GLOB_SELFTEST_CASES_END
    if [ "$failed" -ne 0 ]; then
        return 1
    fi
    printf 'self-test: ok — %s cases\n' "$n"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    set -uo pipefail
    case "${1:-}" in
        --self-test) glob_self_test ;;
        *)
            printf 'usage: glob.sh --self-test   (otherwise sourced by fence.sh and hotspots.sh)\n' >&2
            exit 2
            ;;
    esac
fi
