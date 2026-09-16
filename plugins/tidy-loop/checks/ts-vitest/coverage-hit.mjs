#!/usr/bin/env node
// `coverage-hit` for the ts-vitest stack — see ../CONTRACT.md §7.
//
// What: whether the repository's own test suite actually executes each named
// file, measured by running the suite once under the repository's installed
// coverage provider and reading the machine-readable report.
//
// Why: "the tests cover the code that moved" is the one question a static
// import graph cannot answer. A file can be imported by a spec and still never
// execute a statement. Execution is the oracle; imports are not.
//
// The coverage report is written into this invocation's temp directory, never
// into the repository. A red suite is still an answer — whether a file ran is
// computable either way — so the document carries `testsPassed` and the exit
// stays 0.
//
// Usage: node coverage-hit.mjs --repo <abs-path> --targets <a,b,c>
//                              [--prelude "<line>"]
// Exit:  0 document on stdout (including `covered: false`); 1 vitest
//        unresolvable, no coverage provider installed, or no report produced;
//        2 bad flags or an unknown target.

import fs from 'node:fs';
import path from 'node:path';

import {
  EXIT_BAD_USAGE,
  EXIT_CANNOT_COMPUTE,
  emit,
  fail,
  main,
  makeTempDir,
  parseArgs,
  resolveRepo,
  resolveVitestBin,
  run,
  tail,
  tryResolveFromRepo,
} from './lib/common.mjs';

// Ordered by preference: the provider a repository is most likely to have, and
// the one whose statement counts are cheapest to produce, comes first.
const PROVIDERS = [
  { name: 'v8', package: '@vitest/coverage-v8' },
  { name: 'istanbul', package: '@vitest/coverage-istanbul' },
];

main(() => {
  const flags = parseArgs(process.argv.slice(2), {
    repo: { required: true },
    targets: { required: true },
    prelude: {},
  });
  const repo = resolveRepo(flags.repo);
  const prelude = flags.prelude;
  const targets = parseTargets(repo, flags.targets);
  const provider = probeProvider(repo);
  const bin = resolveVitestBin(repo);
  const reportsDirectory = path.join(makeTempDir(), 'coverage');

  const argv = [
    bin,
    'run',
    '--coverage.enabled',
    '--coverage.provider',
    provider.name,
    '--coverage.reporter',
    'json',
    '--coverage.reportsDirectory',
    reportsDirectory,
    '--coverage.reportOnFailure',
    ...targets.flatMap((target) => ['--coverage.include', target]),
  ];
  const result = run(argv, { cwd: repo, prelude });

  const reportPath = path.join(reportsDirectory, 'coverage-final.json');
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    fail(
      `vitest produced no coverage report (exit ${result.code}): ${tail(result.stderr || result.stdout)}`,
      EXIT_CANNOT_COMPUTE,
    );
  }

  const byTarget = indexByRepoRelative(repo, report);
  const hit = {};
  let covered = true;
  for (const target of targets) {
    const entry = byTarget.get(target);
    const counts = entry ? countStatements(entry) : { covered: 0, statements: 0 };
    hit[target] = counts;
    if (counts.covered === 0) {
      covered = false;
    }
  }

  emit({ covered, hit, provider: provider.name, testsPassed: result.code === 0 });
});

/**
 * Normalize every target to the one repo-relative posix spelling this command
 * uses for both the coverage filter and the document key.
 *
 * Normalizing is load-bearing, not tidiness: the coverage report is keyed by
 * that spelling, so `./src/math.ts` would otherwise pass validation, miss the
 * report, and answer `covered: false` at exit 0 — a wrong answer where the
 * contract promises either a right one or a non-zero exit. The same check
 * rejects a target that escapes the repository, which CONTRACT.md §2 forbids
 * from appearing in the document at all. Each target must be an existing
 * file for the same reason: a directory exists, matches no report entry,
 * and would otherwise answer `covered: false` at exit 0.
 *
 * @param {string} repo
 * @param {string} value the --targets flag
 * @returns {string[]} repo-relative posix paths, sorted and deduplicated
 */
function parseTargets(repo, value) {
  const normalized = new Set();
  for (const raw of value.split(',')) {
    const entry = raw.trim();
    if (entry === '') {
      continue;
    }
    const relative = path.relative(repo, path.resolve(repo, entry));
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      fail(`--targets entries must name a file inside --repo, got "${entry}"`, EXIT_BAD_USAGE);
    }
    normalized.add(relative.split(path.sep).join('/'));
  }
  const targets = [...normalized].sort();
  if (targets.length === 0) {
    fail('--targets is empty', EXIT_BAD_USAGE);
  }
  for (const target of targets) {
    let stat;
    try {
      stat = fs.statSync(path.join(repo, target));
    } catch {
      fail(`target does not exist in --repo: ${target}`, EXIT_BAD_USAGE);
    }
    if (!stat.isFile()) {
      fail(`target is not a file: ${target}`, EXIT_BAD_USAGE);
    }
  }
  return targets;
}

/**
 * Coverage instrumentation is a separately installed package. When none is
 * present the honest answer is "cannot compute", not a false negative.
 *
 * @param {string} repo
 * @returns {{name: string, package: string}}
 */
function probeProvider(repo) {
  for (const provider of PROVIDERS) {
    if (tryResolveFromRepo(repo, `${provider.package}/package.json`) !== null) {
      return provider;
    }
  }
  return fail(
    `no coverage provider installed — install ${PROVIDERS[0].package}`,
    EXIT_CANNOT_COMPUTE,
  );
}

/**
 * The istanbul-format report keys files by absolute path. Re-key it by the
 * repo-relative paths the caller asked about, dropping anything outside.
 *
 * @param {string} repo
 * @param {Record<string, unknown>} report
 * @returns {Map<string, any>}
 */
function indexByRepoRelative(repo, report) {
  const index = new Map();
  for (const [key, entry] of Object.entries(report)) {
    const relative = path.relative(repo, path.resolve(repo, key));
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      continue;
    }
    index.set(relative.split(path.sep).join('/'), entry);
  }
  return index;
}

/**
 * @param {{s?: Record<string, number>}} entry an istanbul file coverage record
 * @returns {{covered: number, statements: number}}
 */
function countStatements(entry) {
  const counts = Object.values(entry?.s ?? {});
  return {
    covered: counts.filter((count) => count > 0).length,
    statements: counts.length,
  };
}
