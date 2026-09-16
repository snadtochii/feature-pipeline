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

node - "$checks_dir" <<'JS'
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const checksDir = process.argv[2];
const fixturesDir = path.join(checksDir, "fixtures");

const failures = [];
let comparisons = 0;

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

function canonical(document) {
  return JSON.stringify(sortKeysDeep(document), null, 2);
}

// Reduce a coverage-hit document to the machine-stable part.
function projectCoverageHit(document) {
  const hit = document.hit;
  if (hit === null || typeof hit !== "object" || Array.isArray(hit)) {
    return document;
  }
  const projected = {};
  for (const name of Object.keys(hit)) {
    const entry = hit[name] ?? {};
    projected[name] = { covered: Number(entry.covered ?? 0) > 0 };
  }
  return {
    covered: document.covered,
    hit: projected,
    provider: document.provider,
    testsPassed: document.testsPassed,
  };
}

// The single-tree commands this runner knows how to drive, and how to derive
// each one's arguments. See this script's header.
const ARGUMENTS = {
  "test-names": () => ["--prelude", "true"],
  "exported-surface": (fixture) => ["--rename-map", path.join(fixture, "rename-map.json")],
  "coverage-hit": (fixture, expected) => {
    const targets = Object.keys(expected.hit ?? {}).sort();
    if (targets.length === 0) {
      return null;
    }
    return ["--targets", targets.join(",")];
  },
};

function isDir(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function subdirs(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => isDir(path.join(dir, name)))
    .sort()
    .map((name) => path.join(dir, name));
}

function stems(dir, suffix) {
  if (!isDir(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(suffix) && isFile(path.join(dir, name)))
    .map((name) => name.slice(0, -suffix.length))
    .sort();
}

function tail(text) {
  return (text ?? "").trim().slice(-400);
}

// Which stack a fixture exercises. Declared, never guessed.
function readManifest(fixture) {
  const fixtureName = path.basename(fixture);
  const manifestPath = path.join(fixture, "fixture.json");
  if (!isFile(manifestPath)) {
    return [null, `${fixtureName}: no fixture.json declaring its stack`];
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return [null, `${fixtureName}: fixture.json is not JSON: ${error.message}`];
  }
  const stack = manifest.stack;
  if (typeof stack !== "string" || stack === "") {
    return [null, `${fixtureName}: fixture.json declares no "stack"`];
  }
  const stackDir = path.join(checksDir, stack);
  if (!isDir(stackDir)) {
    return [null, `${fixtureName}: declared stack "${stack}" not found at ${stackDir}`];
  }
  return [stackDir, null];
}

// Lines present in only one of the two canonical documents, in order, capped.
function describeDifference(expectedText, actualText) {
  const expectedLines = expectedText.split("\n");
  const actualLines = actualText.split("\n");
  const expectedSet = new Set(expectedLines);
  const actualSet = new Set(actualLines);
  const parts = [];
  for (const line of expectedLines) {
    if (!actualSet.has(line)) {
      parts.push(`-${line.trim()}`);
    }
  }
  for (const line of actualLines) {
    if (!expectedSet.has(line)) {
      parts.push(`+${line.trim()}`);
    }
  }
  const shown = parts.slice(0, 12);
  if (parts.length > shown.length) {
    shown.push(`… ${parts.length - shown.length} more differing line(s)`);
  }
  return shown.join("; ");
}

const fixtures = subdirs(fixturesDir);
if (fixtures.length === 0) {
  process.stderr.write(`FAIL: no fixtures found under ${fixturesDir}\n`);
  process.exit(1);
}

for (const fixture of fixtures) {
  const fixtureName = path.basename(fixture);
  const [stackDir, problem] = readManifest(fixture);
  if (problem !== null) {
    failures.push(problem);
    continue;
  }

  // Only top-level *.mjs files are commands; lib/ is private to the stack.
  let commands = stems(stackDir, ".mjs");
  if (commands.length === 0) {
    failures.push(`${fixtureName}: no commands found in ${stackDir}`);
    continue;
  }
  const unwired = commands.filter((command) => !(command in ARGUMENTS));
  for (const command of unwired) {
    failures.push(
      `${fixtureName}: ${path.basename(stackDir)}/${command}.mjs is not wired into this runner`,
    );
  }
  commands = commands.filter((command) => command in ARGUMENTS);

  const install = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: fixture,
    encoding: "utf8",
  });
  if (install.status !== 0) {
    failures.push(
      `${fixtureName}: npm ci failed (exit ${install.status}): ${tail(install.stderr)}`,
    );
    continue;
  }

  const expectedRoot = path.join(fixture, "expected");
  const trees = subdirs(fixture).filter(
    (tree) => !["expected", "node_modules"].includes(path.basename(tree)),
  );
  if (trees.length === 0) {
    failures.push(`${fixtureName}: no trees to check`);
    continue;
  }

  for (const tree of trees) {
    const treeName = path.basename(tree);
    const expectedDir = path.join(expectedRoot, treeName);
    // A command with no implementation must still fail loudly when an
    // expected document names it — that keeps expected/ honest.
    const named = stems(expectedDir, ".json");
    for (const orphan of named) {
      if (!commands.includes(orphan) && !unwired.includes(orphan)) {
        failures.push(`${fixtureName}/${treeName}/${orphan}: expected document has no command`);
      }
    }

    for (const command of commands) {
      const label = `${fixtureName}/${treeName}/${command}`;
      const expectedPath = path.join(expectedDir, `${command}.json`);
      if (!isFile(expectedPath)) {
        failures.push(`${label}: no expected document at ${expectedPath}`);
        continue;
      }
      let expected;
      try {
        expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
      } catch (error) {
        failures.push(`${label}: expected document is not JSON: ${error.message}`);
        continue;
      }

      const args = ARGUMENTS[command](fixture, expected);
      if (args === null) {
        failures.push(`${label}: expected document carries no arguments to derive`);
        continue;
      }

      const result = spawnSync(
        "node",
        [path.join(stackDir, `${command}.mjs`), "--repo", path.resolve(tree), ...args],
        { encoding: "utf8" },
      );
      if (result.status !== 0) {
        failures.push(
          `${label}: exited ${result.status}: ${tail(result.stdout || result.stderr)}`,
        );
        continue;
      }
      let actual;
      try {
        actual = JSON.parse(result.stdout);
      } catch (error) {
        failures.push(`${label}: stdout is not one JSON document: ${error.message}`);
        continue;
      }

      if (command === "coverage-hit") {
        actual = projectCoverageHit(actual);
      }

      comparisons += 1;
      const expectedText = canonical(expected);
      const actualText = canonical(actual);
      if (expectedText === actualText) {
        process.stdout.write(`  ok  ${label}\n`);
      } else {
        failures.push(`${label}: ${describeDifference(expectedText, actualText)}`);
      }
    }
  }
}

if (comparisons === 0 && failures.length === 0) {
  process.stderr.write(`FAIL: no comparisons ran under ${fixturesDir}\n`);
  process.exit(1);
}

if (failures.length > 0) {
  // stdout is written synchronously above, so the ok lines land ahead of the
  // failure block when both are redirected into the same stream.
  process.stderr.write(`\nFAIL (${failures.length}):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(`\nOK: ${comparisons} comparison(s) across ${fixtures.length} fixture(s)\n`);
JS
