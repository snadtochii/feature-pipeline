#!/usr/bin/env bash
# Check the tidy-loop checks script against its committed fixtures: install
# each fixture's pinned toolchain, run every implemented command against every
# tree in that fixture, and compare the JSON document to the expected one.
#
# The checks commands are consumed by unattended gates that never look at the
# output themselves — they branch on it. A silent shape drift (a key renamed, an
# array reordered, a digest that stopped being stable) would therefore turn into
# a false-green refactor rather than a visible failure. The fixtures are the only
# thing standing between a change to these commands and that outcome, so this
# script runs them all and diffs byte-for-byte.
#
# This runner drives the contract's SINGLE-TREE commands: each one is pointed at
# one tree and compared to one expected document. Adding another single-tree
# command is one row in the ARGUMENTS table below plus one expected document per
# tree. A command whose input is a PAIR of trees does not fit that model and
# needs its own section here rather than a table row.
#
# The table is also the wiring check: a command script present in the stack
# directory but absent from the table is reported as a failure rather than run
# with guessed arguments, so a new command cannot slip in unverified.
#   test-names        no arguments (plus --prelude 'true', to exercise the
#                     prelude composition path the fixtures otherwise never hit)
#   exported-surface  --rename-map <fixture>/rename-map.json
#   coverage-hit      --targets = the key set of the expected document's "hit"
#
# Each fixture names the stack it exercises in its own `fixture.json`, so a
# second stack's fixture is driven by that stack's commands and not by these.
#
# `coverage-hit` is compared as a projection — provider, covered, testsPassed,
# and each target's covered count reduced to a boolean. Raw statement counts
# depend on the coverage provider and the Node build and buy a gate no signal.
#
# Requires `node` and `npm` on PATH (Node >= 20). Each fixture is installed with
# `npm ci`, which dominates the runtime — this is a pre-commit check, not a
# per-edit one.
#
# Usage:  scripts/check-tidy-checks.sh
# Exit:   0 every command's output matches its expected document; 1 on any
#         mismatch, command failure, install failure, missing expected
#         document, missing toolchain, or an empty fixture set.

set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
checks_dir="$repo_root/plugins/tidy-loop/checks"

if [ ! -d "$checks_dir/fixtures" ]; then
  echo "FAIL: fixtures directory not found at $checks_dir/fixtures" >&2
  exit 1
fi

for tool in node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL: $tool not found on PATH — the fixtures need Node >= 20 and npm" >&2
    exit 1
  fi
done

python3 - "$checks_dir" <<'PY'
import json
import pathlib
import subprocess
import sys

checks_dir = pathlib.Path(sys.argv[1])
fixtures_dir = checks_dir / "fixtures"

failures = []
comparisons = 0


def canonical(document):
    return json.dumps(document, indent=2, sort_keys=True)


def project_coverage_hit(document):
    """Reduce a coverage-hit document to the machine-stable part."""
    hit = document.get("hit")
    if not isinstance(hit, dict):
        return document
    return {
        "covered": document.get("covered"),
        "hit": {
            name: {"covered": bool(entry.get("covered", 0) > 0)}
            for name, entry in hit.items()
        },
        "provider": document.get("provider"),
        "testsPassed": document.get("testsPassed"),
    }


def test_names_args(fixture, expected):
    return ["--prelude", "true"]


def exported_surface_args(fixture, expected):
    return ["--rename-map", str(fixture / "rename-map.json")]


def coverage_hit_args(fixture, expected):
    targets = sorted(expected.get("hit", {}))
    if not targets:
        return None
    return ["--targets", ",".join(targets)]


# The single-tree commands this runner knows how to drive, and how to derive
# each one's arguments. See this script's header.
ARGUMENTS = {
    "test-names": test_names_args,
    "exported-surface": exported_surface_args,
    "coverage-hit": coverage_hit_args,
}


def read_manifest(fixture):
    """Which stack a fixture exercises. Declared, never guessed."""
    manifest_path = fixture / "fixture.json"
    if not manifest_path.is_file():
        return None, f"{fixture.name}: no fixture.json declaring its stack"
    try:
        manifest = json.loads(manifest_path.read_text())
    except json.JSONDecodeError as error:
        return None, f"{fixture.name}: fixture.json is not JSON: {error}"
    stack = manifest.get("stack")
    if not isinstance(stack, str) or not stack:
        return None, f"{fixture.name}: fixture.json declares no \"stack\""
    stack_dir = checks_dir / stack
    if not stack_dir.is_dir():
        return None, f"{fixture.name}: declared stack \"{stack}\" not found at {stack_dir}"
    return stack_dir, None


fixtures = sorted(path for path in fixtures_dir.iterdir() if path.is_dir())
if not fixtures:
    print(f"FAIL: no fixtures found under {fixtures_dir}", file=sys.stderr)
    sys.exit(1)

for fixture in fixtures:
    stack_dir, problem = read_manifest(fixture)
    if problem is not None:
        failures.append(problem)
        continue

    # Only top-level *.mjs files are commands; lib/ is private to the stack.
    commands = sorted(path.stem for path in stack_dir.glob("*.mjs"))
    if not commands:
        failures.append(f"{fixture.name}: no commands found in {stack_dir}")
        continue
    unwired = sorted(set(commands) - set(ARGUMENTS))
    for command in unwired:
        failures.append(
            f"{fixture.name}: {stack_dir.name}/{command}.mjs is not wired into this runner"
        )
    commands = [command for command in commands if command in ARGUMENTS]

    install = subprocess.run(
        ["npm", "ci", "--no-audit", "--no-fund"],
        cwd=fixture,
        capture_output=True,
        text=True,
    )
    if install.returncode != 0:
        failures.append(
            f"{fixture.name}: npm ci failed (exit {install.returncode}): "
            f"{install.stderr.strip()[-400:]}"
        )
        continue

    expected_root = fixture / "expected"
    trees = sorted(
        path
        for path in fixture.iterdir()
        if path.is_dir() and path.name not in {"expected", "node_modules"}
    )
    if not trees:
        failures.append(f"{fixture.name}: no trees to check")
        continue

    for tree in trees:
        expected_dir = expected_root / tree.name
        # A command with no implementation must still fail loudly when an
        # expected document names it — that keeps expected/ honest.
        named = sorted(
            path.stem for path in expected_dir.glob("*.json")
        ) if expected_dir.is_dir() else []
        for orphan in sorted(set(named) - set(commands) - set(unwired)):
            failures.append(
                f"{fixture.name}/{tree.name}/{orphan}: expected document has no command"
            )

        for command in commands:
            label = f"{fixture.name}/{tree.name}/{command}"
            expected_path = expected_dir / f"{command}.json"
            if not expected_path.is_file():
                failures.append(f"{label}: no expected document at {expected_path}")
                continue
            try:
                expected = json.loads(expected_path.read_text())
            except json.JSONDecodeError as error:
                failures.append(f"{label}: expected document is not JSON: {error}")
                continue

            args = ARGUMENTS[command](fixture, expected)
            if args is None:
                failures.append(f"{label}: expected document carries no arguments to derive")
                continue

            result = subprocess.run(
                [
                    "node",
                    str(stack_dir / f"{command}.mjs"),
                    "--repo",
                    str(tree.resolve()),
                    *args,
                ],
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                failures.append(
                    f"{label}: exited {result.returncode}: "
                    f"{(result.stdout or result.stderr).strip()[-400:]}"
                )
                continue
            try:
                actual = json.loads(result.stdout)
            except json.JSONDecodeError as error:
                failures.append(f"{label}: stdout is not one JSON document: {error}")
                continue

            if command == "coverage-hit":
                actual = project_coverage_hit(actual)

            comparisons += 1
            if canonical(actual) == canonical(expected):
                print(f"  ok  {label}")
            else:
                import difflib

                diff = "; ".join(
                    line.rstrip()
                    for line in difflib.unified_diff(
                        canonical(expected).splitlines(),
                        canonical(actual).splitlines(),
                        fromfile="expected",
                        tofile="actual",
                        lineterm="",
                        n=1,
                    )
                )
                failures.append(f"{label}: {diff}")

if comparisons == 0 and not failures:
    print(f"FAIL: no comparisons ran under {fixtures_dir}", file=sys.stderr)
    sys.exit(1)

if failures:
    # Keep the ok lines ahead of the failure block when both are redirected
    # into the same stream.
    sys.stdout.flush()
    print(f"\nFAIL ({len(failures)}):", file=sys.stderr)
    for failure in failures:
        print(f"  - {failure}", file=sys.stderr)
    sys.exit(1)

print(f"\nOK: {comparisons} comparison(s) across {len(fixtures)} fixture(s)")
PY
