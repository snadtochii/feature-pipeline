#!/usr/bin/env node
// `test-names` for the ts-vitest stack — see ../CONTRACT.md §5.
//
// What: the full test-name multiset of a repository, collected through the
// repository's own vitest (`vitest list --json`), sorted by file then name.
//
// Why: a refactor that moves tests must move all of them. Comparing the
// multiset of two trees is what makes a silently dropped or collapsed case
// visible; comparing counts or a set would not.
//
// Collection is attempted statically (`--staticParse`, no test file is
// executed). A vitest too old to know that option is retried without it, and
// the document records which mode answered.
//
// Usage: node test-names.mjs --repo <abs-path> [--prelude "<line>"]
// Exit:  0 document on stdout (including an empty `tests` array);
//        1 vitest unresolvable or `list` unusable; 2 bad flags.

import fs from 'node:fs';
import path from 'node:path';

import {
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
  toRepoRelative,
} from './lib/common.mjs';

const UNKNOWN_OPTION = /unknown option|unknown flag|unexpected option|invalid option/i;

main(() => {
  const flags = parseArgs(process.argv.slice(2), {
    repo: { required: true },
    prelude: {},
  });
  const repo = resolveRepo(flags.repo);
  const prelude = flags.prelude;
  const bin = resolveVitestBin(repo);
  const outputPath = path.join(makeTempDir(), 'tests.json');

  const base = [bin, 'list', `--json=${outputPath}`];
  let collection = 'static';
  let result = run([...base, '--staticParse'], { cwd: repo, prelude });
  if (result.code !== 0 && UNKNOWN_OPTION.test(result.stderr)) {
    collection = 'runtime';
    result = run(base, { cwd: repo, prelude });
  }
  if (result.code !== 0) {
    fail(
      `vitest list failed in ${path.basename(repo)} (exit ${result.code}): ${tail(result.stderr || result.stdout)}`,
      EXIT_CANNOT_COMPUTE,
    );
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } catch (error) {
    fail(`vitest list wrote no readable JSON: ${error.message}`, EXIT_CANNOT_COMPUTE);
  }
  if (!Array.isArray(raw)) {
    fail('vitest list produced an unexpected document shape (expected an array)', EXIT_CANNOT_COMPUTE);
  }

  const tests = raw.map((entry) => ({
    file: toRepoRelative(repo, entry.file),
    name: String(entry.name ?? ''),
  }));
  tests.sort((a, b) => (a.file === b.file ? compare(a.name, b.name) : compare(a.file, b.file)));

  emit({ collection, tests });
});

/**
 * Ascending comparison by code unit — the ordering CONTRACT.md §2 requires,
 * and the one `sorted()` gives the runner on the other side of the diff.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compare(a, b) {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}
