#!/usr/bin/env bash
# deepen hotspot measure: `hotspots.sh`.
# The contract this script implements is skills/run/references/hotspots.md —
# §1 the window, §2 churn, §3 the measured set, §4 lines, §5 indentation, §6 the
# ranking, §7 this script's invocation, output and exit codes, §8 the worked
# example --self-test reproduces. This header explains mechanics, not policy.
#
# Usage:
#   hotspots.sh --repo <abs-path> --exclude-file <abs-path> --out <abs-path>
#   hotspots.sh --self-test
# Exit: 0 an answer was computed (an empty table included), 1 the answer could
# not be computed, 2 a wrong invocation.
#
# Portability: bash 3.2 (no associative arrays, no mapfile) and BSD awk or
# mawk (awk limited to match/RLENGTH/gsub/substr). Paths are read NUL-delimited
# from git and reach every command as quoted `./<path>` operands, never through
# eval or an unquoted expansion. Exclusion globs are data from the profile: they
# are matched with `case`, never executed.

set -uo pipefail
shopt -s extglob

WINDOW="6 months ago"
TOP=40
TAB=$'\t'
GENERIC_EXCLUDES='*.lock
*-lock.json
*-lock.yaml
**/go.sum
*.min.*
*.map'

WORK=""
TEST_DIR=""
cleanup() {
    if [ -n "$WORK" ]; then
        rm -rf "$WORK"
    fi
    if [ -n "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}
trap cleanup EXIT

usage() {
    printf 'usage: hotspots.sh --repo <abs-path> --exclude-file <abs-path> --out <abs-path>\n' >&2
    printf '       hotspots.sh --self-test\n' >&2
    exit 2
}

fail() {
    printf 'hotspots: %s\n' "$1" >&2
    exit 1
}

# Expand `{a,b}` alternations into one pattern per branch, nesting-aware for
# `{}` and extglob `()`; an unbalanced brace is kept as written (fence.md §2).
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
        expand_braces "$prefix$alt$suffix"
    done
}

# PATTERNS holds every expanded exclusion pattern, leading `./` stripped.
PATTERNS=()
add_glob() {
    local glob="$1" expanded pattern
    glob="${glob%$'\r'}"
    if [ -z "$glob" ]; then
        return 0
    fi
    if ! expanded=$(expand_braces "$glob") || [ -z "$expanded" ]; then
        fail "could not expand the exclusion glob '$glob'"
    fi
    while IFS= read -r pattern; do
        if [ -z "$pattern" ]; then
            continue
        fi
        case "$pattern" in
            './'*) pattern="${pattern#./}" ;;
        esac
        PATTERNS=( "${PATTERNS[@]+"${PATTERNS[@]}"}" "$pattern" )
    done <<< "$expanded"
}

# Exit 0 when the repo-relative path matches an exclusion pattern in any of the
# three forms of fence.md §2, case-insensitively.
is_excluded() {
    local rel="$1" pattern collapsed stripped hit=1
    shopt -s nocasematch
    for pattern in "${PATTERNS[@]+"${PATTERNS[@]}"}"; do
        collapsed="${pattern//\/\*\*\//\/}"
        stripped="$pattern"
        case "$stripped" in
            '**/'*) stripped="${stripped#\*\*/}" ;;
        esac
        # Unquoted on purpose: the glob is the pattern, the path the subject.
        case "$rel" in
            $pattern|$collapsed|$stripped)
                hit=0
                break
                ;;
        esac
    done
    shopt -u nocasematch
    return "$hit"
}

measure() {
    local repo="$1" exclude_file="$2" out="$3"
    local top p churn line lines ind width reason entry
    local excluded_n=0 skipped_n=0 survivors=0 measured=0
    local -a files

    top=$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null) || fail "not a git repository: $repo"
    WORK=$(mktemp -d "${TMPDIR:-/tmp}/deepen-hotspots.XXXXXX") || fail "mktemp failed"

    while IFS= read -r line; do
        add_glob "$line"
    done <<< "$GENERIC_EXCLUDES"
    if [ -f "$exclude_file" ]; then
        while IFS= read -r line || [ -n "$line" ]; do
            add_glob "$line"
        done < "$exclude_file"
    fi

    git -C "$top" log --since="$WINDOW" --no-renames -z --name-only --format= > "$WORK/log" \
        || fail "git log failed in $top"

    # NUL-delimited paths to one path per line; a path holding a newline or a
    # tab cannot be a table row, so it goes to the skipped list instead.
    while IFS= read -r -d '' p; do
        if [ -z "$p" ]; then
            continue
        fi
        case "$p" in
            *$'\n'*|*"$TAB"*) printf '%s\0' "$p" >&3 ;;
            *) printf '%s\n' "$p" ;;
        esac
    done < "$WORK/log" > "$WORK/paths" 3> "$WORK/odd"
    skipped_n=$(LC_ALL=C sort -zu "$WORK/odd" | tr -cd '\000' | wc -c | tr -d ' ')

    : > "$WORK/measured"
    if [ -s "$WORK/paths" ]; then
        LC_ALL=C awk '{ c[$0]++ } END { for (p in c) printf "%d\t%s\n", c[p], p }' "$WORK/paths" \
            | LC_ALL=C sort -t "$TAB" -k1,1nr -k2 > "$WORK/churn" \
            || fail "churn count failed"

        cd "$top" || fail "cannot enter $top"
        while IFS="$TAB" read -r -u 4 churn p; do
            if is_excluded "$p"; then
                excluded_n=$(( excluded_n + 1 ))
                continue
            fi
            # Membership is HEAD's tree entry, not the disk: an untracked or
            # ignored file left on disk, and a path under a symlinked
            # directory, have no regular-file entry at HEAD.
            entry=$(git --literal-pathspecs -C "$top" ls-tree HEAD -- "$p") \
                || fail "git ls-tree failed on $p"
            case "$entry" in
                "100644 "*|"100755 "*) ;;
                *)
                    skipped_n=$(( skipped_n + 1 ))
                    continue
                    ;;
            esac
            if [ ! -f "./$p" ]; then
                skipped_n=$(( skipped_n + 1 ))
                continue
            fi
            survivors=$(( survivors + 1 ))
            if ! grep -Iq . "./$p" 2>/dev/null; then
                skipped_n=$(( skipped_n + 1 ))
                continue
            fi
            printf '%s\t%s\n' "$churn" "$p" >> "$WORK/measured"
            measured=$(( measured + 1 ))
            if [ "$measured" -ge "$TOP" ]; then
                break
            fi
        done 4< "$WORK/churn"
    fi

    if [ "$measured" -eq 0 ]; then
        printf 'path\tchurn\tlines\tindentation\tchurn_x_lines\tchurn_x_indentation\n' > "$out" \
            || fail "cannot write $out"
        if [ ! -s "$WORK/log" ]; then
            reason="no commits in window"
        elif [ "$survivors" -eq 0 ]; then
            reason="no churned file survives the measured-set filter"
        else
            reason="no text in the measured set"
        fi
        printf 'measured: 0, excluded: %s, skipped: %s\n' "$excluded_n" "$skipped_n"
        printf 'empty: %s\n' "$reason"
        return 0
    fi

    files=()
    while IFS="$TAB" read -r -u 4 churn p; do
        files=( "${files[@]+"${files[@]}"}" "./$p" )
    done 4< "$WORK/measured"

    width=$(awk '/^ +[^ ]/ { match($0, /^ +/); c[RLENGTH]++ }
     END {
       best = 0; bestn = 0
       for (w in c) {
         if (c[w] > bestn || (c[w] == bestn && w + 0 < best)) { best = w + 0; bestn = c[w] }
       }
       if (best == 0) { print 1; exit }
       while (best % 2 == 0 && ((best / 2) in c)) { best = best / 2 }
       print best
     }' "${files[@]}" < /dev/null) || fail "width detection failed"

    while IFS="$TAB" read -r -u 4 churn p; do
        lines=$(wc -l < "./$p" | tr -d ' ') || fail "wc failed on $p"
        ind=$(awk -v w="$width" '/[^[:space:]]/ {
       match($0, /^[ \t]*/); ind = substr($0, 1, RLENGTH)
       tabs = gsub(/\t/, "", ind)
       lvl += tabs + int(length(ind) / w)
     } END { print lvl + 0 }' "./$p" < /dev/null) || fail "indentation failed on $p"
        printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$p" "$churn" "$lines" "$ind" \
            "$(( churn * lines ))" "$(( churn * ind ))"
    done 4< "$WORK/measured" > "$WORK/rows" || fail "measurement failed"

    {
        printf 'path\tchurn\tlines\tindentation\tchurn_x_lines\tchurn_x_indentation\n'
        LC_ALL=C sort -t "$TAB" -k6,6nr -k1,1 "$WORK/rows"
    } > "$out" || fail "cannot write $out"

    printf 'measured: %s, excluded: %s, skipped: %s, width: %s\n' \
        "$measured" "$excluded_n" "$skipped_n" "$width"
    return 0
}

self_test() {
    local self d i out summary expected
    self="${BASH_SOURCE[0]}"
    TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/deepen-hotspots-test.XXXXXX") || fail "mktemp failed"
    d="$TEST_DIR/repo"
    mkdir -p "$d/Specs" || fail "mkdir failed"
    g() {
        git -C "$d" -c user.name=deepen -c user.email=deepen@example.invalid \
            -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"
    }
    g init -q || fail "git init failed"

    printf 'x\n' > "$d/gone.ts"
    printf '\tone\n    two\n' > "$d/mixed.ts"
    printf '{}\n' > "$d/package-lock.json"
    printf 'const s = 1\n' > "$d/Specs/skip.ts"
    printf 'a\000b\n' > "$d/bin.dat"
    for i in 1 2 3 4 5 6 7; do
        if [ "$i" -lt 7 ]; then
            printf 'function f() {\n    if (a) {\n        return 1\n    }\n}\n// rev %s\n' "$i" > "$d/example.ts"
        else
            printf 'function f() {\n    if (a) {\n        return 1\n    }\n}\n' > "$d/example.ts"
        fi
        if [ "$i" -eq 7 ]; then
            rm -f "$d/gone.ts"
        fi
        g add -A && g commit -q -m "c$i" || fail "commit $i failed"
    done

    printf '{specs,other}/**\n' > "$TEST_DIR/exclude"
    out="$TEST_DIR/table.tsv"
    summary=$(bash "$self" --repo "$d" --exclude-file "$TEST_DIR/exclude" --out "$out") \
        || fail "self-test: measure exited non-zero"
    expected="measured: 2, excluded: 2, skipped: 2, width: 4"
    if [ "$summary" != "$expected" ]; then
        printf 'self-test: FAIL — summary is "%s", expected "%s"\n' "$summary" "$expected"
        exit 1
    fi
    expected=$(printf 'path\tchurn\tlines\tindentation\tchurn_x_lines\tchurn_x_indentation\nexample.ts\t7\t5\t4\t35\t28\nmixed.ts\t1\t2\t2\t2\t2')
    if [ "$(cat "$out")" != "$expected" ]; then
        printf 'self-test: FAIL — table differs from hotspots.md §8:\n'
        cat "$out"
        exit 1
    fi

    printf '*\n' > "$TEST_DIR/exclude"
    summary=$(bash "$self" --repo "$d" --exclude-file "$TEST_DIR/exclude" --out "$out") \
        || fail "self-test: empty measure exited non-zero"
    expected=$(printf 'measured: 0, excluded: 6, skipped: 0\nempty: no churned file survives the measured-set filter')
    if [ "$summary" != "$expected" ]; then
        printf 'self-test: FAIL — empty case printed "%s"\n' "$summary"
        exit 1
    fi

    printf 'self-test: ok — hotspots.md §8 reproduced (example.ts 7 5 4 35 28, mixed.ts indentation 2)\n'
}

REPO=""
EXCLUDE=""
OUT=""
if [ "$#" -eq 1 ] && [ "$1" = "--self-test" ]; then
    self_test
    exit 0
fi
while [ "$#" -gt 0 ]; do
    case "$1" in
        --repo) [ "$#" -ge 2 ] || usage; REPO="$2"; shift 2 ;;
        --exclude-file) [ "$#" -ge 2 ] || usage; EXCLUDE="$2"; shift 2 ;;
        --out) [ "$#" -ge 2 ] || usage; OUT="$2"; shift 2 ;;
        *) usage ;;
    esac
done
if [ -z "$REPO" ] || [ -z "$EXCLUDE" ] || [ -z "$OUT" ]; then
    usage
fi
case "$REPO" in /*) ;; *) usage ;; esac
case "$EXCLUDE" in /*) ;; *) usage ;; esac
case "$OUT" in /*) ;; *) usage ;; esac

measure "$REPO" "$EXCLUDE" "$OUT"
