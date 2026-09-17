#!/usr/bin/env node
// `verify-spec-patch` for the ts-vitest stack — see ../CONTRACT.md §8.
//
// What: whether a change's test suite is symmetric evidence. The test-file
// portion of the change (the spec patch) is applied to a checkout of the base
// revision, and the suite is run on that tree and on the candidate. Base plus
// patch must be green, and no test may go from passing there to failing or
// missing on the candidate.
//
// Why: a spec that moved is evidence; a spec that was rewritten to suit the new
// code is not. Running the moved spec against the *old* code is the only
// mechanical way to tell those apart, and it needs no judgement call.
//
// A test file whose imports did not exist at the base revision cannot run
// there. It is an addition: excluded from the base-plus-patch run, executed on
// the candidate only, and listed in the document so the evidence states what
// was not cross-checked.
//
// The base tree is a detached worktree inside this invocation's temp
// directory, registered in the repository's own worktree list (its common git
// directory, which is the main repository's when --repo is itself a linked
// worktree) and removed on every exit path — a normal exit, an error exit, and
// a termination signal, which the two awaited suite runs let a listener
// observe. Nothing else is written under --repo.
//
// Usage: node verify-spec-patch.mjs --repo <abs-path> --base-sha <rev>
//                                   --test-globs <a,b,c> [--tsconfig <path>]
//                                   [--prelude "<line>"]
//
// Relative path flags, per CONTRACT.md §4: `--tsconfig` and the `--test-globs`
// patterns name things inside the repository and resolve against `--repo`.
// Exit:  0 document on stdout (including `verdict: false`); 1 an untracked test
//        file, a dirty temporary worktree, a patch that does not apply, no
//        node_modules to bridge, a run that produced no JSON report, or an
//        interrupt, termination, or hangup signal; 2 bad flags, a --repo that
//        is not a git working-tree root, an unresolvable --base-sha, or a
//        malformed glob.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  EXIT_BAD_USAGE,
  EXIT_CANNOT_COMPUTE,
  compare,
  emit,
  fail,
  interruptSubprocess,
  isRepoSource,
  loadTsconfig,
  main,
  makeTempDir,
  parseArgs,
  requireFromRepo,
  resolveReferencePath,
  resolveRepo,
  resolveVitestBin,
  runAsync,
  runTool,
  tail,
  toolCommand,
  toRepoRelative,
  repoRelativeOrNull,
} from './lib/common.mjs';

/**
 * The signals whose default disposition would terminate the process without
 * running its `exit` listeners. Each is forwarded to the suite run in flight,
 * and the run then ends as the exit-1 document naming the signal, so the
 * teardown runs on the way out. `SIGHUP` matters most here: the consuming loop
 * is scheduled and detached, so a vanishing session is the likeliest
 * interruption of all, and it is the one that would leave a registration behind
 * in the caller's repository.
 *
 * A listener only ever runs between turns of the event loop, which is why the
 * two suite runs — the only long stretches of this command — are awaited
 * rather than blocked on.
 */
const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** How many pathspecs one `git ls-tree` invocation carries. */
const PATHSPEC_CHUNK = 400;

main(async () => {
  const flags = parseArgs(process.argv.slice(2), {
    repo: { required: true },
    'base-sha': { required: true },
    'test-globs': { required: true },
    tsconfig: {},
    prelude: {},
  });
  const repo = resolveRepo(flags.repo);
  const prelude = flags.prelude;
  const git = (args, cwd = repo) => runTool('git', args, { cwd, prelude });

  // Claimed before anything creates the temp directory, so that git removes the
  // base checkout ahead of the temp-directory sweep: Node runs exit listeners
  // in registration order, and the sweep would otherwise take the prelude
  // script this teardown needs.
  const teardown = armTeardown(repo);

  requireGitRoot(git, repo);
  const baseSha = requireRevision(git, flags['base-sha']);
  const pathspecs = parseTestGlobs(flags['test-globs']);

  requireTrackedTestFiles(git, pathspecs);
  const patchPath = writeSpecPatch(git, baseSha, pathspecs);
  const patchedFiles = listPatchedFiles(git, repo, baseSha, pathspecs);
  const additions = findAdditions(git, repo, baseSha, patchedFiles, flags.tsconfig);

  const worktree = materialiseBase(git, repo, baseSha, patchPath, prelude, teardown);

  const bin = resolveVitestBin(repo);
  const basePlusPatchTests = await runSuite(worktree, bin, 'base', additions, prelude);
  const candidateTests = await runSuite(repo, bin, 'candidate', [], prelude);

  emit(classify(basePlusPatchTests, candidateTests, additions));
});

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * `git cat-file` and git's pathspecs address the repository by paths relative
 * to its root, so a --repo pointing at a subdirectory would mis-key every one
 * of them while still looking like it worked. Refuse it instead.
 *
 * @param {(args: string[], cwd?: string) => any} git
 * @param {string} repo
 */
function requireGitRoot(git, repo) {
  const result = git(['rev-parse', '--show-toplevel']);
  if (result.code !== 0) {
    fail(`--repo is not inside a git working tree: ${repo}`, EXIT_BAD_USAGE);
  }
  const top = result.fullStdout.trim();
  let real;
  try {
    real = fs.realpathSync(top);
  } catch {
    real = top;
  }
  if (real !== repo) {
    fail(`--repo must be the root of a git working tree; its root is ${real}`, EXIT_BAD_USAGE);
  }
}

/**
 * @param {(args: string[], cwd?: string) => any} git
 * @param {string} value
 * @returns {string} the full commit id
 */
function requireRevision(git, value) {
  const result = git(['rev-parse', '--verify', '--quiet', `${value}^{commit}`]);
  if (result.code !== 0) {
    fail(`--base-sha does not resolve to a commit in --repo: ${value}`, EXIT_BAD_USAGE);
  }
  const sha = result.fullStdout.trim();
  if (sha === '') {
    fail(`--base-sha does not resolve to a commit in --repo: ${value}`, EXIT_BAD_USAGE);
  }
  return sha;
}

/**
 * Turn the comma-separated glob list into git pathspecs.
 *
 * `:(glob)` is what makes `**` mean what the consuming profile writes it to
 * mean; git's default pathspec dialect would read `*` as matching separators.
 * A pattern that is absolute or climbs out of the repository is rejected rather
 * than silently matching nothing: an empty match set answers "no spec changed",
 * which is a wrong answer where the contract promises a right one or a non-zero
 * exit.
 *
 * @param {string} value the --test-globs flag
 * @returns {string[]}
 */
function parseTestGlobs(value) {
  const patterns = [];
  for (const raw of value.split(',')) {
    const entry = raw.trim();
    if (entry === '') {
      continue;
    }
    if (entry.startsWith('/') || path.win32.isAbsolute(entry)) {
      fail(`--test-globs entries must be repo-relative, got "${entry}"`, EXIT_BAD_USAGE);
    }
    if (entry.split('/').includes('..')) {
      fail(`--test-globs entries must stay inside --repo, got "${entry}"`, EXIT_BAD_USAGE);
    }
    patterns.push(`:(glob)${entry}`);
  }
  if (patterns.length === 0) {
    fail('--test-globs is empty', EXIT_BAD_USAGE);
  }
  return patterns;
}

/**
 * The spec patch is computed against version control, so an unstaged new test
 * file is invisible to it — the comparison would quietly proceed without the
 * very file the change added. Name them and stop.
 *
 * `--exclude-standard` leaves ignored files out on purpose: the repository has
 * declared them outside version control, and a test that ran on the candidate
 * alone never reaches the document, which is keyed by base-plus-patch.
 *
 * @param {(args: string[], cwd?: string) => any} git
 * @param {string[]} pathspecs
 */
function requireTrackedTestFiles(git, pathspecs) {
  const result = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecs]);
  if (result.code !== 0) {
    fail(`git ls-files failed: ${tail(result.stderr)}`, EXIT_CANNOT_COMPUTE);
  }
  const untracked = splitNul(result.fullStdout);
  if (untracked.length > 0) {
    fail(
      `untracked test files match --test-globs — stage or commit them: ${untracked.join(', ')}`,
      EXIT_CANNOT_COMPUTE,
    );
  }
}

/**
 * @param {(args: string[], cwd?: string) => any} git
 * @param {string} baseSha
 * @param {string[]} pathspecs
 * @returns {string} absolute path to the patch file
 */
function writeSpecPatch(git, baseSha, pathspecs) {
  const patchPath = path.join(makeTempDir(), 'spec.patch');
  // Fixed prefixes and no external diff driver: the patch must be one git
  // itself can apply, independent of whatever the repository configured for
  // human reading.
  const result = git([
    '-c',
    'diff.noprefix=false',
    '-c',
    'diff.mnemonicPrefix=false',
    'diff',
    '--no-renames',
    '--full-index',
    '--binary',
    '--no-ext-diff',
    '--no-color',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    `--output=${patchPath}`,
    baseSha,
    '--',
    ...pathspecs,
  ]);
  if (result.code !== 0) {
    fail(`git diff failed: ${tail(result.stderr)}`, EXIT_CANNOT_COMPUTE);
  }
  return patchPath;
}

/**
 * The test files the patch adds or modifies. Deletions are excluded: a file the
 * candidate removed has no imports to inspect, and the patch deletes it on the
 * base tree too.
 *
 * @param {(args: string[], cwd?: string) => any} git
 * @param {string} repo
 * @param {string} baseSha
 * @param {string[]} pathspecs
 * @returns {string[]} repo-relative posix paths
 */
function listPatchedFiles(git, repo, baseSha, pathspecs) {
  const result = git([
    'diff',
    '--no-renames',
    '--name-only',
    '-z',
    '--diff-filter=ACM',
    baseSha,
    '--',
    ...pathspecs,
  ]);
  if (result.code !== 0) {
    fail(`git diff --name-only failed: ${tail(result.stderr)}`, EXIT_CANNOT_COMPUTE);
  }
  return splitNul(result.fullStdout)
    .map((name) => toRepoRelative(repo, path.join(repo, name)))
    .sort(compare);
}

// ---------------------------------------------------------------------------
// Additions
// ---------------------------------------------------------------------------

/**
 * A patched test file is an addition when one of its imports resolves to a
 * repository file that did not exist at the base revision — it cannot run
 * there, so it is not evidence of anything about the old code.
 *
 * Detection is deliberately conservative in one direction: an import this
 * cannot resolve is ignored rather than counted. A file wrongly treated as an
 * addition would be dropped from the evidence silently; a file wrongly kept
 * simply fails on base-plus-patch, which the document reports.
 *
 * @param {(args: string[], cwd?: string) => any} git
 * @param {string} repo
 * @param {string} baseSha
 * @param {string[]} patchedFiles
 * @param {string | undefined} tsconfigFlag
 * @returns {{file: string, missingImports: string[]}[]}
 */
function findAdditions(git, repo, baseSha, patchedFiles, tsconfigFlag) {
  if (patchedFiles.length === 0) {
    return [];
  }
  const ts = requireFromRepo(repo, 'typescript');
  const projects = loadProjects(ts, repo, tsconfigFlag);
  const hosts = new Map();

  // Resolve every import first, then ask git once. The existence question is
  // per-import but the answer is one tree listing, and behind a `--prelude`
  // every subprocess re-runs the caller's toolchain activation — a per-import
  // spawn would put that fixed cost on the same order as the two suite runs
  // this command exists to perform.
  const resolvedImports = [];
  const wanted = new Set();
  for (const file of patchedFiles) {
    const absolute = path.join(repo, file);
    let text;
    try {
      text = fs.readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    const options = optionsFor(projects, absolute);
    if (!hosts.has(options)) {
      hosts.set(options, ts.createCompilerHost(options));
    }
    const host = hosts.get(options);

    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      const specifier = imported.fileName;
      const resolved = ts.resolveModuleName(specifier, absolute, options, host).resolvedModule;
      if (!resolved || resolved.isExternalLibraryImport) {
        continue;
      }
      if (!isRepoSource(repo, resolved.resolvedFileName)) {
        continue;
      }
      const target = repoRelativeOrNull(repo, resolved.resolvedFileName);
      resolvedImports.push({ file, specifier, target });
      wanted.add(target);
    }
  }

  const present = existingAt(git, baseSha, [...wanted].sort(compare));
  const missingByFile = new Map();
  for (const { file, specifier, target } of resolvedImports) {
    if (present.has(target)) {
      continue;
    }
    if (!missingByFile.has(file)) {
      missingByFile.set(file, new Set());
    }
    missingByFile.get(file).add(specifier);
  }

  return [...missingByFile]
    .map(([file, specifiers]) => ({ file, missingImports: [...specifiers].sort(compare) }))
    .sort((a, b) => compare(a.file, b.file));
}

/**
 * The parsed tsconfigs a test file could belong to: the root, plus each of its
 * referenced projects when the root is solution-style. A missing configuration
 * is not fatal — default compiler options still resolve relative imports, which
 * is what addition detection needs.
 *
 * @param {any} ts
 * @param {string} repo
 * @param {string | undefined} tsconfigFlag
 * @returns {{options: any, files: Set<string>}[]}
 */
function loadProjects(ts, repo, tsconfigFlag) {
  const rootConfig = path.resolve(repo, tsconfigFlag ?? 'tsconfig.json');
  if (!fs.existsSync(rootConfig)) {
    return [{ options: ts.getDefaultCompilerOptions(), files: new Set() }];
  }
  const { parsed, real } = loadTsconfig(ts, rootConfig, toRepoRelative(repo, rootConfig));
  const projects = [{ options: parsed.options, files: fileSet(parsed.fileNames) }];
  for (const reference of parsed.projectReferences ?? []) {
    const configPath = resolveReferencePath(reference.path);
    if (!fs.existsSync(configPath) || fs.realpathSync(configPath) === real) {
      continue;
    }
    const child = loadTsconfig(ts, configPath, toRepoRelative(repo, configPath));
    projects.push({ options: child.parsed.options, files: fileSet(child.parsed.fileNames) });
  }
  return projects;
}

/**
 * @param {string[]} fileNames
 * @returns {Set<string>}
 */
function fileSet(fileNames) {
  return new Set((fileNames ?? []).map((name) => path.resolve(name)));
}

/**
 * The options of the project that owns this file, else the root's. A test file
 * is commonly excluded from every project's file set, which is why the root is
 * the fallback rather than an error.
 *
 * @param {{options: any, files: Set<string>}[]} projects
 * @param {string} absolute
 * @returns {any}
 */
function optionsFor(projects, absolute) {
  for (const project of projects) {
    if (project.files.has(absolute)) {
      return project.options;
    }
  }
  return projects[0].options;
}

/**
 * Which of these repo-relative paths exist as files at the base revision.
 *
 * `:(literal)` keeps a path containing a glob character from matching anything
 * but itself, and `-z` keeps a non-ASCII name from coming back C-quoted. The
 * pathspec list is chunked so a change touching thousands of files cannot build
 * an argument vector past the platform's limit.
 *
 * @param {(args: string[], cwd?: string) => any} git
 * @param {string} baseSha
 * @param {string[]} paths
 * @returns {Set<string>}
 */
function existingAt(git, baseSha, paths) {
  const present = new Set();
  for (let index = 0; index < paths.length; index += PATHSPEC_CHUNK) {
    const chunk = paths.slice(index, index + PATHSPEC_CHUNK);
    const result = git([
      'ls-tree',
      '-r',
      '-z',
      '--name-only',
      baseSha,
      '--',
      ...chunk.map((entry) => `:(literal)${entry}`),
    ]);
    if (result.code !== 0) {
      fail(`git ls-tree failed: ${tail(result.stderr)}`, EXIT_CANNOT_COMPUTE);
    }
    for (const name of splitNul(result.fullStdout)) {
      present.add(name);
    }
  }
  return present;
}

// ---------------------------------------------------------------------------
// The base tree
// ---------------------------------------------------------------------------

/**
 * Check the base revision out beside the patch, apply the patch, and bridge the
 * toolchain.
 *
 * The teardown claimed at startup is armed with the checkout's path before git
 * creates it, so an interruption between the two is still cleaned up by the
 * `prune` half.
 *
 * @param {(args: string[], cwd?: string) => any} git
 * @param {string} repo
 * @param {string} baseSha
 * @param {string} patchPath
 * @param {string | undefined} prelude
 * @param {{arm: (worktree: string, prelude: string | undefined) => void}} teardown
 * @returns {string} absolute path to the base-plus-patch tree
 */
function materialiseBase(git, repo, baseSha, patchPath, prelude, teardown) {
  const worktree = path.join(makeTempDir(), 'base');
  teardown.arm(worktree, prelude);

  const added = git(['worktree', 'add', '--detach', worktree, baseSha]);
  if (added.code !== 0) {
    fail(`git worktree add failed: ${tail(added.stderr)}`, EXIT_CANNOT_COMPUTE);
  }

  const status = git(['status', '--porcelain', '-z'], worktree);
  if (status.code !== 0) {
    fail(`git status failed in the base worktree: ${tail(status.stderr)}`, EXIT_CANNOT_COMPUTE);
  }
  const dirty = splitNul(status.fullStdout);
  if (dirty.length > 0) {
    fail(`the base worktree is not clean: ${dirty.join(', ')}`, EXIT_CANNOT_COMPUTE);
  }

  // An empty patch is legal: base-plus-patch is then base, and `git apply`
  // would reject the empty input rather than do nothing.
  if (fs.statSync(patchPath).size > 0) {
    const applied = git(['apply', '--3way', patchPath], worktree);
    if (applied.code !== 0) {
      fail(`the spec patch does not apply to ${baseSha}: ${tail(applied.stderr)}`, EXIT_CANNOT_COMPUTE);
    }
  }

  // A refactor-only change shares the base revision's lockfile by definition,
  // so the candidate's installed toolchain is the one the base tree should run
  // under. Linked after the cleanliness check, which it would otherwise trip.
  const nodeModules = findNodeModules(repo);
  if (nodeModules === null) {
    fail(`no node_modules found by walking up from ${repo}`, EXIT_CANNOT_COMPUTE);
  }
  fs.symlinkSync(nodeModules, path.join(worktree, 'node_modules'), 'dir');

  return fs.realpathSync(worktree);
}

/**
 * Claim the exit and signal listeners that remove the base checkout, before any
 * worktree exists. Until `arm` is called the handlers do nothing, so claiming
 * them early costs nothing and buys the registration order the teardown needs.
 *
 * A signal listener forwards the signal to the suite run in flight — the child
 * must not outlive the tree it runs in — and ends the run through `fail`, whose
 * `process.exit` is what runs this teardown.
 *
 * `--force` is safe here and nowhere else: the checkout holds the applied patch
 * and a symlink, both of which this invocation put there. The `prune` that
 * follows is what makes the handler correct when the checkout is already gone —
 * an interrupted `worktree add`, or a directory the temp sweep reached first —
 * because a stale registration in the repository's worktree list is exactly
 * what it removes.
 *
 * @param {string} repo
 * @returns {{arm: (worktree: string, prelude: string | undefined) => void}}
 */
function armTeardown(repo) {
  let commands = null;
  let done = false;
  const teardown = () => {
    if (done || commands === null) {
      return;
    }
    done = true;
    try {
      const removed = spawnSync(commands.remove.file, commands.remove.args, {
        cwd: repo,
        stdio: 'ignore',
      });
      if (removed.status === 0) {
        return;
      }
      // Only now: `prune` is repository-wide and would drop another tool's
      // registration whose directory is merely unreachable right now. It runs
      // solely to clean up after a removal that did not take.
      spawnSync(commands.prune.file, commands.prune.args, { cwd: repo, stdio: 'ignore' });
    } catch {
      // Best effort: the process is already on its way out.
    }
  };
  process.on('exit', teardown);
  for (const signal of TERMINATION_SIGNALS) {
    process.on(signal, () => {
      interruptSubprocess(signal);
      fail(`interrupted by ${signal}`, EXIT_CANNOT_COMPUTE);
    });
  }
  return {
    arm(worktree, prelude) {
      commands = {
        remove: toolCommand('git', ['worktree', 'remove', '--force', worktree], { prelude }),
        prune: toolCommand('git', ['worktree', 'prune'], { prelude }),
      };
    },
  };
}

/**
 * @param {string} start
 * @returns {string | null}
 */
function findNodeModules(start) {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, 'node_modules');
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Keep walking.
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// The two runs
// ---------------------------------------------------------------------------

/**
 * Run the whole suite in one tree and reduce its report to a status per test
 * identity.
 *
 * The whole suite runs on both sides; additions are subtracted with one
 * `--exclude` each, which is the only vitest mechanism that names files
 * exactly — positional filters are lowercase substring matches.
 * `--passWithNoTests` keeps an all-excluded run an answer rather than a false
 * red. Classification keys on the report file and never on the exit code: a red
 * suite, a zero-file run and a startup crash all exit 1.
 *
 * The run is awaited, not blocked on, so that a termination signal arriving
 * mid-suite reaches its listener (see `TERMINATION_SIGNALS`).
 *
 * @param {string} tree absolute path to the tree to run in
 * @param {string} bin vitest executable
 * @param {string} label report file stem
 * @param {{file: string}[]} excluded
 * @param {string | undefined} prelude
 * @returns {Promise<Map<string, string>>} identity to "passed" or "failed"
 */
async function runSuite(tree, bin, label, excluded, prelude) {
  const reportPath = path.join(makeTempDir(), `${label}.json`);
  const argv = [
    bin,
    'run',
    '--reporter=json',
    `--outputFile=${reportPath}`,
    '--passWithNoTests',
    ...excluded.flatMap((addition) => ['--exclude', toExcludeGlob(addition.file)]),
  ];
  const result = await runAsync(argv, { cwd: tree, prelude });

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    return fail(
      `the ${label} run produced no readable JSON report (exit ${result.code}): ${tail(result.stderr || result.stdout)}`,
      EXIT_CANNOT_COMPUTE,
    );
  }
  return collect(tree, report);
}

/**
 * Quote a path for vitest's `--exclude`, which takes a glob rather than a path.
 *
 * Measured at the pinned vitest: a wildcard in a filename makes the pattern
 * match its siblings, so one addition named `src/star*.spec.ts` withdraws every
 * sibling spec from the base run — and with `--passWithNoTests` that run comes
 * back green, answering `verdict: true` having cross-checked nothing. That
 * fail-open direction is the one worth engineering against in an oracle meant to
 * be non-gameable.
 *
 * A bracket expression needs no escaping — picomatch matches a character class
 * against its own literal spelling too, so `app/[id]/page.spec.ts` excludes
 * itself either way — but escaping it is measured to be equally correct, so this
 * escapes the whole metacharacter set rather than carving out exceptions.
 *
 * @param {string} file repo-relative posix path
 * @returns {string}
 */
function toExcludeGlob(file) {
  return file.replace(/[\\*?[\]{}()!+@|]/g, '\\$&');
}

/**
 * Reduce one vitest JSON report to a status per test identity.
 *
 * A suite that failed to collect has no assertions to key on; its identity is
 * the file alone, which CONTRACT.md §8 states is how a collection failure
 * reads. Two tests sharing an identity collapse to failed if either failed —
 * a passing duplicate must not mask a failing one.
 *
 * @param {string} tree
 * @param {{testResults?: any[]}} report
 * @returns {Map<string, string>}
 */
function collect(tree, report) {
  const statuses = new Map();
  const record = (identity, status) => {
    if (status === 'failed' || !statuses.has(identity)) {
      statuses.set(identity, status);
    }
  };
  for (const suite of report.testResults ?? []) {
    const file = toRepoRelative(tree, suite.name);
    const assertions = suite.assertionResults ?? [];
    if (assertions.length === 0) {
      if (suite.status === 'failed') {
        record(file, 'failed');
      }
      continue;
    }
    for (const assertion of assertions) {
      if (assertion.status !== 'passed' && assertion.status !== 'failed') {
        continue;
      }
      const titles = [...(assertion.ancestorTitles ?? []), assertion.title ?? ''];
      record(`${file} > ${titles.join(' > ')}`, assertion.status);
    }
  }
  return statuses;
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/**
 * @param {Map<string, string>} base
 * @param {Map<string, string>} candidate
 * @param {{file: string, missingImports: string[]}[]} additions
 * @returns {Record<string, unknown>}
 */
function classify(base, candidate, additions) {
  const addedFiles = new Set(additions.map((addition) => addition.file));
  const failed = [];
  const passToFail = [];
  const missingToFail = [];

  for (const [identity, status] of base) {
    if (status === 'failed') {
      failed.push(identity);
    }
    const onCandidate = candidate.get(identity);
    if (onCandidate === undefined) {
      // A whole-file identity is a suite that failed to collect on base, so it
      // contributed no tests there and the candidate deleted nothing — it is
      // already reported in `failed`, and repeating it here would assert
      // something false. An addition never ran on base either; that guard only
      // matters if a future change lets one through.
      const isWholeFile = !identity.includes(' > ');
      if (!isWholeFile && !addedFiles.has(identity.split(' > ')[0])) {
        missingToFail.push(identity);
      }
      continue;
    }
    if (status === 'passed' && onCandidate === 'failed') {
      passToFail.push(identity);
    }
  }

  failed.sort(compare);
  passToFail.sort(compare);
  missingToFail.sort(compare);
  const green = failed.length === 0;

  return {
    additions,
    basePlusPatch: { failed, green },
    candidate: { missingToFail, passToFail },
    verdict: green && passToFail.length === 0 && missingToFail.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * Split git's `-z` output. Entries are NUL-terminated and never quoted or
 * escaped, so a path holding a newline, a quote, or a non-ASCII byte survives
 * intact — which matters because these names become both JSON keys and tool
 * arguments.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitNul(text) {
  return text.split('\0').filter((entry) => entry !== '');
}
