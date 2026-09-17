#!/usr/bin/env node
// Check the tidy-loop checks script against its committed fixtures: install
// each fixture's pinned toolchain, run every implemented command against every
// tree in that fixture, and compare the JSON document to the expected one.
//
// The checks commands are consumed by unattended gates that never look at the
// output themselves — they branch on it. A silent shape drift (a key renamed, an
// array reordered, a digest that stopped being stable) would therefore turn into
// a false-green refactor rather than a visible failure. The fixtures are the only
// thing standing between a change to these commands and that outcome, so this
// script runs them all and diffs byte-for-byte.
//
// This runner drives the contract's SINGLE-TREE commands from a table: each one
// is pointed at one tree and compared to one expected document. Adding another
// single-tree command is one row in the ARGUMENTS table below plus one expected
// document per tree.
//   test-names        no arguments (plus --prelude 'true', to exercise the
//   exported-surface  --rename-map <fixture>/rename-map.json
//   coverage-hit      --targets = the key set of the expected document's "hit"
//
// A command whose input is a PAIR of trees does not fit that model and gets its
// own section instead, driven by the fixture's `specPatch` declaration:
//   verify-spec-patch  one throwaway git repository per candidate, committed
//
// Both sets are the wiring check: a command script present in the stack
// directory but named by neither the table nor PAIR_COMMANDS is reported as a
// failure rather than run with guessed arguments, so a new command cannot slip
// in unverified. A pair command that no fixture declares fails the run for the
// same reason — it would otherwise sit on disk silently unexercised.
//
// Each fixture names the stack it exercises in its own `fixture.json`, so a
// second stack's fixture is driven by that stack's commands and not by these.
// That file also carries the optional keys this runner reads:
//   trees          {"<tree>": ["<single-tree command>", …]} — which commands
//   specPatch      {"base": "<tree>", "candidates": ["<tree>", …],
//   sameTestNames  [["<tree>", "<tree>"], …] — tree pairs whose `test-names`
//
// Fixture trees carry no ignore file of their own: the pair section stages them
// with `git add -A`, and a `.gitignore` inside a tree would silently withhold
// files from the base commit. Only the `node_modules` symlink the section
// creates is excluded, through the throwaway repository's `.git/info/exclude`.
//
// `coverage-hit` is compared as a projection — provider, covered, testsPassed,
// and each target's covered count reduced to a boolean. Raw statement counts
// depend on the coverage provider and the Node build and buy a gate no signal.
//
// Requires `node`, `npm`, and `git` on PATH (Node >= 20). Each fixture is
// installed with `npm ci`, which dominates the runtime — this is a pre-commit
// check, not a per-edit one.
//
//
// Usage:  node scripts/check-tidy-checks.mjs
// Exit:   0 every command's output matches its expected document; 1 on any
//         mismatch, command failure, install failure, missing expected
//         document, unusable fixture declaration, missing toolchain, or an
//         empty fixture set.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checksDir = path.join(repoRoot, "plugins", "tidy-loop", "checks");

if (!fs.existsSync(path.join(checksDir, "fixtures"))) {
  process.stderr.write(`FAIL: fixtures directory not found at ${path.join(checksDir, "fixtures")}\n`);
  process.exit(1);
}

// node is running this file, so only npm and git need probing.
for (const tool of ["npm", "git"]) {
  const probe = spawnSync(tool, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    process.stderr.write(
      `FAIL: ${tool} not found on PATH — the fixtures need Node >= 20, npm, and git\n`,
    );
    process.exit(1);
  }
}

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

// Commands whose input is a pair of trees. Driven by the pair section below,
// not by ARGUMENTS, and each one must be exercised by at least one fixture.
const PAIR_COMMANDS = new Set(["verify-spec-patch"]);
const exercisedPairCommands = new Set();

// Every throwaway repository this run creates lives under one of these.
const scratchDirs = [];
process.on("exit", () => {
  for (const dir of scratchDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort — the OS reclaims the temp directory either way.
    }
  }
});

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

// Which stack a fixture exercises, and how this runner should drive it.
// Declared, never guessed.
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
  return [{ stackDir, manifest }, null];
}

// A declaration that names a tree or a command that does not exist is a
// fixture bug that would otherwise read as "this command simply does not
// apply here" — the one reading a declared-never-guessed scheme must refuse.
function validateManifest(fixtureName, manifest, treeNames, singleTreeCommands) {
  const problems = [];
  const knownTree = (name) => treeNames.includes(name);

  if (manifest.trees !== undefined) {
    if (manifest.trees === null || typeof manifest.trees !== "object" || Array.isArray(manifest.trees)) {
      problems.push(`${fixtureName}: fixture.json "trees" must be an object`);
    } else {
      for (const [tree, commands] of Object.entries(manifest.trees)) {
        if (!knownTree(tree)) {
          problems.push(`${fixtureName}: fixture.json "trees" names a missing tree "${tree}"`);
        }
        if (!Array.isArray(commands) || commands.some((name) => typeof name !== "string")) {
          problems.push(`${fixtureName}: fixture.json "trees.${tree}" must be an array of command names`);
          continue;
        }
        for (const name of commands) {
          if (!singleTreeCommands.includes(name)) {
            problems.push(`${fixtureName}: fixture.json "trees.${tree}" names an unknown command "${name}"`);
          }
        }
      }
    }
  }

  if (manifest.specPatch !== undefined) {
    const spec = manifest.specPatch;
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      problems.push(`${fixtureName}: fixture.json "specPatch" must be an object`);
    } else {
      if (!knownTree(spec.base)) {
        problems.push(`${fixtureName}: fixture.json "specPatch.base" names a missing tree "${spec.base}"`);
      }
      if (!Array.isArray(spec.candidates) || spec.candidates.length === 0) {
        problems.push(`${fixtureName}: fixture.json "specPatch.candidates" must be a non-empty array`);
      } else {
        for (const tree of spec.candidates) {
          if (!knownTree(tree)) {
            problems.push(
              `${fixtureName}: fixture.json "specPatch.candidates" names a missing tree "${tree}"`,
            );
          }
        }
      }
      if (
        !Array.isArray(spec.testGlobs) ||
        spec.testGlobs.length === 0 ||
        spec.testGlobs.some((glob) => typeof glob !== "string" || glob === "")
      ) {
        problems.push(`${fixtureName}: fixture.json "specPatch.testGlobs" must be a non-empty array of globs`);
      }
    }
  }

  if (manifest.sameTestNames !== undefined) {
    if (!Array.isArray(manifest.sameTestNames)) {
      problems.push(`${fixtureName}: fixture.json "sameTestNames" must be an array of tree pairs`);
    } else {
      for (const pair of manifest.sameTestNames) {
        if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(knownTree)) {
          problems.push(
            `${fixtureName}: fixture.json "sameTestNames" entry must be two existing tree names, got ${JSON.stringify(pair)}`,
          );
        }
      }
    }
  }

  return problems;
}

// Which single-tree commands apply to one tree: what the manifest declares, or
// all of them when it declares nothing.
function commandsForTree(manifest, treeName, singleTreeCommands) {
  const declared = manifest.trees?.[treeName];
  if (!Array.isArray(declared)) {
    return singleTreeCommands;
  }
  return singleTreeCommands.filter((command) => declared.includes(command));
}

// Occurrences of each line, in first-seen order.
function countLines(text) {
  const counts = new Map();
  for (const line of text.split("\n")) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

// One expected-vs-actual comparison. Both call sites — the per-tree loop and
// the pair section — read and parse the expected document, spawn the command,
// check the exit, parse stdout, canonicalize both sides and report, differing
// only in how the argv is derived. That sequence lives here once so a third
// pair command is a declaration rather than a third copy.
//
// Returns whether a comparison was actually made (the caller counts those) and
// the problem to report, or null.
function compareDocument(label, expectedPath, argvFor, project) {
  if (!isFile(expectedPath)) {
    return { compared: false, problem: `no expected document at ${expectedPath}` };
  }
  let expected;
  try {
    expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  } catch (error) {
    return { compared: false, problem: `expected document is not JSON: ${error.message}` };
  }

  const [argv, argvProblem] = argvFor(expected);
  if (argvProblem !== null) {
    return { compared: false, problem: argvProblem };
  }

  const result = spawnSync("node", argv, { encoding: "utf8" });
  if (result.status !== 0) {
    return {
      compared: false,
      problem: `exited ${result.status}: ${tail(result.stdout || result.stderr)}`,
    };
  }
  let actual;
  try {
    actual = JSON.parse(result.stdout);
  } catch (error) {
    return { compared: false, problem: `stdout is not one JSON document: ${error.message}` };
  }

  const expectedText = canonical(expected);
  const actualText = canonical(project ? project(actual) : actual);
  if (expectedText === actualText) {
    process.stdout.write(`  ok  ${label}\n`);
    return { compared: true, problem: null };
  }
  return { compared: true, problem: describeDifference(expectedText, actualText) };
}

// Lines whose occurrence count differs between the two canonical documents,
// in order, capped. Counted rather than set-based: the documents are
// multisets (a duplicated test name is the fixture's headline case), and a
// duplicate collapsing to one occurrence must still explain itself.
function describeDifference(expectedText, actualText) {
  const expectedCounts = countLines(expectedText);
  const actualCounts = countLines(actualText);
  const parts = [];
  for (const [line, count] of expectedCounts) {
    const missing = count - (actualCounts.get(line) ?? 0);
    if (missing > 0) {
      parts.push(`-${line.trim()}${missing > 1 ? ` (x${missing})` : ""}`);
    }
  }
  for (const [line, count] of actualCounts) {
    const extra = count - (expectedCounts.get(line) ?? 0);
    if (extra > 0) {
      parts.push(`+${line.trim()}${extra > 1 ? ` (x${extra})` : ""}`);
    }
  }
  const shown = parts.slice(0, 12);
  if (parts.length > shown.length) {
    shown.push(`… ${parts.length - shown.length} more differing line(s)`);
  }
  return shown.join("; ");
}

// CI runs with no git identity and no global configuration, so every commit
// carries its own. Hooks are skipped because a contributor's global hooksPath
// is not part of what this fixture is testing.
const GIT_IDENTITY = [
  "-c",
  "user.name=tidy-checks",
  "-c",
  "user.email=tidy-checks@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

function git(repo, args) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

// A throwaway repository holding the base tree as one commit and the candidate
// tree as the next. Built from copies: pointing git at the tracked fixture
// directory would commit into this repository instead.
function buildThrowawayRepo(fixture, baseTree, candidateTree, repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.cpSync(path.join(fixture, baseTree), repo, { recursive: true });

  const init = git(repo, ["-c", "init.defaultBranch=main", "init", "-q"]);
  if (init.status !== 0) {
    return [null, `git init failed: ${tail(init.stderr)}`];
  }
  // The toolchain is the fixture's, installed once. Excluded through
  // .git/info/exclude rather than a .gitignore: the exclude file is shared by
  // linked worktrees and is not itself part of any commit, so neither the base
  // nor the candidate commit captures the link.
  fs.symlinkSync(path.join(fixture, "node_modules"), path.join(repo, "node_modules"), "dir");
  fs.writeFileSync(path.join(repo, ".git", "info", "exclude"), "node_modules\n");

  const baseProblem = commitEverything(repo, "base");
  if (baseProblem !== null) {
    return [null, baseProblem];
  }
  const head = git(repo, ["rev-parse", "HEAD"]);
  if (head.status !== 0) {
    return [null, `git rev-parse failed: ${tail(head.stderr)}`];
  }
  const baseSha = head.stdout.trim();

  for (const entry of fs.readdirSync(repo)) {
    if (entry === ".git" || entry === "node_modules") {
      continue;
    }
    fs.rmSync(path.join(repo, entry), { recursive: true, force: true });
  }
  fs.cpSync(path.join(fixture, candidateTree), repo, { recursive: true });
  const candidateProblem = commitEverything(repo, "candidate");
  if (candidateProblem !== null) {
    return [null, candidateProblem];
  }
  return [baseSha, null];
}

function commitEverything(repo, message) {
  const staged = git(repo, ["add", "-A"]);
  if (staged.status !== 0) {
    return `git add failed for ${message}: ${tail(staged.stderr)}`;
  }
  const committed = git(repo, [...GIT_IDENTITY, "commit", "--no-verify", "-q", "-m", message]);
  if (committed.status !== 0) {
    return `git commit failed for ${message}: ${tail(committed.stderr)}`;
  }
  return null;
}

const fixtures = subdirs(fixturesDir);
if (fixtures.length === 0) {
  process.stderr.write(`FAIL: no fixtures found under ${fixturesDir}\n`);
  process.exit(1);
}

for (const fixture of fixtures) {
  const fixtureName = path.basename(fixture);
  const [declaration, problem] = readManifest(fixture);
  if (problem !== null) {
    failures.push(problem);
    continue;
  }
  const { stackDir, manifest } = declaration;

  // Only top-level *.mjs files are commands; lib/ is private to the stack.
  const commands = stems(stackDir, ".mjs");
  if (commands.length === 0) {
    failures.push(`${fixtureName}: no commands found in ${stackDir}`);
    continue;
  }
  const unwired = commands.filter(
    (command) => !(command in ARGUMENTS) && !PAIR_COMMANDS.has(command),
  );
  for (const command of unwired) {
    failures.push(
      `${fixtureName}: ${path.basename(stackDir)}/${command}.mjs is not wired into this runner`,
    );
  }
  const singleTreeCommands = commands.filter((command) => command in ARGUMENTS);

  const expectedRoot = path.join(fixture, "expected");
  const trees = subdirs(fixture).filter(
    (tree) => !["expected", "node_modules"].includes(path.basename(tree)),
  );
  if (trees.length === 0) {
    failures.push(`${fixtureName}: no trees to check`);
    continue;
  }
  const treeNames = trees.map((tree) => path.basename(tree));

  const declarationProblems = validateManifest(fixtureName, manifest, treeNames, singleTreeCommands);
  if (declarationProblems.length > 0) {
    failures.push(...declarationProblems);
    continue;
  }

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

  const specPatch = manifest.specPatch;
  const pairTrees = new Set(specPatch === undefined ? [] : specPatch.candidates);

  for (const tree of trees) {
    const treeName = path.basename(tree);
    const expectedDir = path.join(expectedRoot, treeName);
    const applicable = commandsForTree(manifest, treeName, singleTreeCommands);
    // An expected document that nothing will run must fail loudly — that keeps
    // expected/ honest about which commands a tree actually exercises.
    for (const orphan of stems(expectedDir, ".json")) {
      const isPairDocument = PAIR_COMMANDS.has(orphan) && pairTrees.has(treeName);
      if (!applicable.includes(orphan) && !unwired.includes(orphan) && !isPairDocument) {
        failures.push(`${fixtureName}/${treeName}/${orphan}: expected document has no command`);
      }
    }

    for (const command of applicable) {
      const label = `${fixtureName}/${treeName}/${command}`;
      const { compared, problem } = compareDocument(
        label,
        path.join(expectedDir, `${command}.json`),
        (expected) => {
          const args = ARGUMENTS[command](fixture, expected);
          if (args === null) {
            return [null, "expected document carries no arguments to derive"];
          }
          return [
            [path.join(stackDir, `${command}.mjs`), "--repo", path.resolve(tree), ...args],
            null,
          ];
        },
        command === "coverage-hit" ? projectCoverageHit : undefined,
      );
      if (compared) {
        comparisons += 1;
      }
      if (problem !== null) {
        failures.push(`${label}: ${problem}`);
      }
    }
  }

  // The pair section: one throwaway git repository per candidate tree, shared by
  // every command PAIR_COMMANDS declares. Candidates are the outer loop because
  // the repository is a property of the candidate, not of the command run
  // against it — building it per command would copy the base tree over the
  // candidate's files and re-symlink node_modules into a directory that already
  // has one.
  if (specPatch !== undefined) {
    const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "tidy-checks-"));
    scratchDirs.push(scratch);
    for (const candidateTree of specPatch.candidates) {
      const repo = path.join(scratch, `${fixtureName}-${candidateTree}`);
      const [baseSha, buildProblem] = buildThrowawayRepo(
        fixture,
        specPatch.base,
        candidateTree,
        repo,
      );

      for (const pairCommand of PAIR_COMMANDS) {
        exercisedPairCommands.add(pairCommand);
        const label = `${fixtureName}/${candidateTree}/${pairCommand}`;
        if (buildProblem !== null) {
          failures.push(`${label}: ${buildProblem}`);
          continue;
        }

        const { compared, problem } = compareDocument(
          label,
          path.join(expectedRoot, candidateTree, `${pairCommand}.json`),
          () => [
            [
              path.join(stackDir, `${pairCommand}.mjs`),
              "--repo",
              repo,
              "--base-sha",
              baseSha,
              "--test-globs",
              specPatch.testGlobs.join(","),
            ],
            null,
          ],
        );
        if (compared) {
          comparisons += 1;
        }
        if (problem !== null) {
          failures.push(`${label}: ${problem}`);
        }
      }
    }
  }

  // The name multiset carries the half of the evidence the pair command
  // excludes: a moved spec file is an addition there, so only this comparison
  // shows that the tests it holds are the same ones.
  //
  // It reads the two COMMITTED documents, not the two actual ones. The actuals
  // were byte-compared against these a few lines up, so asserting on them would
  // be determined by the same two files and could only ever restate a failure
  // already reported. Reading expected/ instead makes this an unconditional
  // check of the fixture's own invariant: a hand-edit to either document that
  // breaks the multiset fails here even when every command is healthy.
  for (const [left, right] of manifest.sameTestNames ?? []) {
    const label = `${fixtureName}/test-names-multiset/${left}=${right}`;
    const names = [];
    let readable = true;
    for (const tree of [left, right]) {
      const documentPath = path.join(expectedRoot, tree, "test-names.json");
      if (!isFile(documentPath)) {
        failures.push(`${label}: no expected document at ${documentPath}`);
        readable = false;
        break;
      }
      try {
        const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
        names.push((document.tests ?? []).map((test) => test.name).sort().join("\n"));
      } catch (error) {
        failures.push(`${label}: ${documentPath} is not JSON: ${error.message}`);
        readable = false;
        break;
      }
    }
    if (!readable) {
      continue;
    }
    comparisons += 1;
    if (names[0] === names[1]) {
      process.stdout.write(`  ok  ${label}\n`);
    } else {
      failures.push(`${label}: ${describeDifference(names[0], names[1])}`);
    }
  }
}

// A pair command on disk that no fixture declares would sit unverified, which
// is the one thing the wiring checks exist to prevent.
for (const command of PAIR_COMMANDS) {
  if (!exercisedPairCommands.has(command)) {
    failures.push(`${command}: no fixture declares a "specPatch" exercising this pair command`);
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
