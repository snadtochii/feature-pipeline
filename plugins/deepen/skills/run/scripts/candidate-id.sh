#!/usr/bin/env bash
# deepen candidate id: `candidate-id.sh`.
# The contract this script implements is skills/run/references/candidates.md §4 —
# the payload encoding, byte-order sorting, the worked example --self-test
# reproduces, and the invalid-line and exit-code rules. This header explains
# mechanics, not policy.
#
# Usage:
#   candidate-id.sh <records-file>    one record per line:
#                                     category<TAB>files<TAB>structural_key
#   candidate-id.sh --self-test
# Output: one line per record, in input order —
#         `<id><TAB>category<TAB>files<TAB>structural_key` with files and key in
#         the sorted form that was hashed, or `invalid<TAB><the line as read>`.
# Exit: 0 every line answered (invalid lines included), 1 no sha256 tool or a
# hash failed, 2 a wrong invocation.
#
# Records are data: every field reaches a command as a quoted operand or on a
# pipe, never through eval.

set -uo pipefail

TAB=$'\t'

usage() {
    printf 'usage: candidate-id.sh <records-file>\n       candidate-id.sh --self-test\n' >&2
    exit 2
}

fail() {
    printf 'candidate-id: %s\n' "$1" >&2
    exit 1
}

sha256() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256
    elif command -v sha256sum >/dev/null 2>&1; then
        sha256sum
    else
        return 1
    fi
}

# Split a comma-joined value, sort its elements in byte order, re-join.
sort_joined() {
    printf '%s\n' "$1" | tr ',' '\n' | LC_ALL=C sort | paste -sd, -
}

# Print the id for one record line, or `invalid`.
mint() {
    local line="$1" tabs category rest files key payload digest
    tabs="${line//[!$TAB]/}"
    if [ "${#tabs}" -ne 2 ]; then
        printf 'invalid'
        return 0
    fi
    category="${line%%"$TAB"*}"
    rest="${line#*"$TAB"}"
    files="${rest%%"$TAB"*}"
    key="${rest#*"$TAB"}"
    if [ -z "$category" ] || [ -z "$files" ] || [ -z "$key" ]; then
        printf 'invalid'
        return 0
    fi
    case ",$files,$key," in
        *,,*)
            printf 'invalid'
            return 0
            ;;
    esac
    files=$(sort_joined "$files") || fail "sort failed"
    key=$(sort_joined "$key") || fail "sort failed"
    digest=$(printf '%s\n%s\n%s' "$category" "$files" "$key" | sha256) \
        || fail "no sha256 tool (shasum or sha256sum) on PATH, or the hash failed"
    printf '%s\t%s\t%s\t%s' "$(printf '%s' "${digest:0:6}" | tr 'A-F' 'a-f')" \
        "$category" "$files" "$key"
}

run() {
    local file="$1" line out
    if [ ! -f "$file" ] || [ ! -r "$file" ]; then
        usage
    fi
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        out=$(mint "$line") || exit 1
        if [ "$out" = "invalid" ]; then
            printf 'invalid\t%s\n' "$line"
        else
            printf '%s\n' "$out"
        fi
    done < "$file"
}

TEST_DIR=""
cleanup() {
    if [ -n "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}
trap cleanup EXIT

self_test() {
    local dir out expected
    TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/deepen-candidate-id-test.XXXXXX") || fail "mktemp failed"
    dir="$TEST_DIR"
    # Elements deliberately out of byte order: the script sorts them itself.
    printf 'extract-function\tsrc/features/entry/step-card.tsx,src/features/entry/form.ts,src/features/entry/review-screen.tsx\tstepDefault,StepCard,buildSaveInput,ReviewScreen\n' > "$dir/records"
    printf 'in-process\t\tKey\n' >> "$dir/records"
    out=$(run "$dir/records") || fail "self-test: run exited non-zero"
    expected=$(printf 'b876d3\textract-function\tsrc/features/entry/form.ts,src/features/entry/review-screen.tsx,src/features/entry/step-card.tsx\tReviewScreen,StepCard,buildSaveInput,stepDefault\ninvalid\tin-process\t\tKey')
    if [ "$out" != "$expected" ]; then
        printf 'self-test: FAIL — expected b876d3 and one invalid line, got:\n%s\n' "$out"
        exit 1
    fi
    printf 'self-test: ok — candidates.md §4 reproduced (b876d3)\n'
}

if [ "$#" -ne 1 ]; then
    usage
fi
case "$1" in
    --self-test) self_test ;;
    -*) usage ;;
    *) run "$1" ;;
esac
