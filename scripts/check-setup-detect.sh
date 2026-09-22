#!/usr/bin/env bash
# The setup detector's fixtures: every fixture under
# plugins/feature/skills/setup/fixtures/ is materialized into a throwaway
# directory and plugins/feature/skills/setup/scripts/detect.sh's document for it
# must equal the fixture's committed expected.json.
#
# The detector is where every proposed setup default comes from, so a wrong
# default has to be a failing check here rather than a wrong config.yaml in a
# consuming project. Fixtures are declared rather than committed as-is: dotfiles,
# claudedocs/ paths, nested .git directories and instruction files cannot live
# in this repository's tree, so each fixture's fixture.json declares them and
# this script creates them. The developer's own git configuration is kept out of
# every run (HOME, XDG_CONFIG_HOME, GIT_CONFIG_NOSYSTEM, GIT_CEILING_DIRECTORIES).
#
# Unguarded here: forms no fixture declares, and invocation from a Claude or
# Codex session — this script calls the detector with bash directly.
#
# Usage:  scripts/check-setup-detect.sh
# Exit:   0 every fixture matches its expected.json; 1 on any mismatch, malformed
#         or missing fixture file, detector failure, missing tool, or no fixtures.

set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
setup_dir="$repo_root/plugins/feature/skills/setup"
detect="$setup_dir/scripts/detect.sh"
fixtures_dir="$setup_dir/fixtures"

for tool in jq git; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL: $tool not on PATH" >&2
    exit 1
  fi
done
if [ ! -f "$detect" ]; then
  echo "FAIL: detector not found at $detect" >&2
  exit 1
fi
if [ ! -d "$fixtures_dir" ]; then
  echo "FAIL: fixtures directory not found at $fixtures_dir" >&2
  exit 1
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/check-setup-detect.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
scratch=$(cd "$scratch" && pwd -P)
mkdir -p "$scratch/home/.config" "$scratch/fixtures"
sandbox="$scratch/fixtures"

# Runs a command with the developer's git configuration out of reach.
isolated() {
  env HOME="$scratch/home" XDG_CONFIG_HOME="$scratch/home/.config" \
    GIT_CONFIG_NOSYSTEM=1 GIT_CEILING_DIRECTORIES="$sandbox" "$@"
}

failures=""
fail_count=0
fixture_count=0

add_failure() {
  failures="$failures  - $1
"
  fail_count=$((fail_count + 1))
}

# fixture.json: an object with only the known keys, right value types, and
# every declared path relative with no `..` segment.
fixture_json_valid() {
  jq -e '
    type == "object"
    and ((keys - ["git_init", "gitignore", "create", "write"]) | length == 0)
    and ((.git_init // []) | type == "array" and all(type == "string"))
    and ((.create // []) | type == "array" and all(type == "string"))
    and ((.gitignore // {}) | type == "object"
         and all(.[]; type == "array" and all(type == "string")))
    and ((.write // {}) | type == "object" and all(.[]; type == "string"))
    and ([(.git_init // [])[], ((.gitignore // {}) | keys[]),
          (.create // [])[], ((.write // {}) | keys[])]
         | all(. != "" and (startswith("/") | not)
               and (split("/") | any(. == "..") | not)))
  ' "$1" >/dev/null 2>&1
}

# Builds the fixture tree at $2 from fixture dir $1. File content comes from
# fixture.json through jq into a file, never through a shell command line.
materialize() {
  local src="$1" target="$2" config="$1/fixture.json" path dir
  mkdir "$target" || return 1
  if [ -d "$src/repo" ]; then
    cp -R "$src/repo/." "$target/" || return 1
  fi
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    mkdir -p "$(dirname "$target/$path")" || return 1
    jq -j --arg p "$path" '.write[$p]' "$config" > "$target/$path" || return 1
  done <<EOF
$(jq -r '(.write // {}) | keys[]' "$config")
EOF
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    mkdir -p "$(dirname "$target/$path")" || return 1
    : > "$target/$path" || return 1
  done <<EOF
$(jq -r '(.create // [])[]' "$config")
EOF
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    isolated git -c init.defaultBranch=main init -q "$target/$dir" || return 1
  done <<EOF
$(jq -r '(.git_init // [])[]' "$config")
EOF
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    mkdir -p "$target/$dir" || return 1
    jq -r --arg d "$dir" '.gitignore[$d][]' "$config" > "$target/$dir/.gitignore" || return 1
  done <<EOF
$(jq -r '(.gitignore // {}) | keys[]' "$config")
EOF
  return 0
}

for fixture in "$fixtures_dir"/*/; do
  [ -d "$fixture" ] || continue
  fixture=${fixture%/}
  name=$(basename "$fixture")
  fixture_count=$((fixture_count + 1))

  if [ ! -f "$fixture/fixture.json" ]; then
    add_failure "$name: fixture.json missing"
    continue
  fi
  if ! fixture_json_valid "$fixture/fixture.json"; then
    add_failure "$name: fixture.json malformed (object of git_init/gitignore/create/write with relative paths only)"
    continue
  fi
  if [ ! -f "$fixture/expected.json" ]; then
    add_failure "$name: expected.json missing"
    continue
  fi
  if ! jq -S . "$fixture/expected.json" > "$scratch/$name.expected" 2>/dev/null; then
    add_failure "$name: expected.json is not valid JSON"
    continue
  fi
  if ! materialize "$fixture" "$sandbox/$name" 2> "$scratch/$name.err"; then
    add_failure "$name: could not materialize fixture: $(head -n 1 "$scratch/$name.err")"
    continue
  fi

  rc=0
  isolated bash "$detect" "$sandbox/$name" > "$scratch/$name.raw" 2> "$scratch/$name.err" || rc=$?
  if [ "$rc" -ne 0 ]; then
    add_failure "$name: detect.sh exited $rc: $(head -n 1 "$scratch/$name.err")"
    continue
  fi
  if ! jq -S . "$scratch/$name.raw" > "$scratch/$name.actual" 2>/dev/null; then
    add_failure "$name: detect.sh output is not valid JSON"
    continue
  fi
  if ! diff "$scratch/$name.expected" "$scratch/$name.actual" > "$scratch/$name.diff"; then
    excerpt=$(head -n 12 "$scratch/$name.diff" | sed 's/^/      /' || true)
    add_failure "$name: detect.sh output differs from expected.json (< expected, > actual)
$excerpt"
    continue
  fi
  echo "  ok  $name"
done

if [ "$fixture_count" -eq 0 ]; then
  add_failure "no fixtures found under ${fixtures_dir#"$repo_root"/}"
fi

# A root that is not a directory must exit 2 with nothing on stdout.
rc=0
probe_out=$(isolated bash "$detect" "$detect" 2>/dev/null) || rc=$?
if [ "$rc" -eq 2 ] && [ -z "$probe_out" ]; then
  echo "  ok  exit-code probe (non-directory root exits 2)"
else
  add_failure "exit-code probe: non-directory root exited $rc (expected 2, empty stdout)"
fi

if [ "$fail_count" -gt 0 ]; then
  printf '\nFAIL (%d):\n%s' "$fail_count" "$failures" >&2
  exit 1
fi

echo
echo "OK: $fixture_count fixture(s) match expected.json under ${fixtures_dir#"$repo_root"/}/"
