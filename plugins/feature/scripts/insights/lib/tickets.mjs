// Ticket outcomes (../CONTRACT.md §7): the fixed lines of an fs-native
// ticket's artifacts, classified into closed-vocabulary fields. Each
// classifier takes an artifact's text, or null for an absent file, and returns
// a record holding only closed tokens, integer counts, ticket IDs, dates and a
// PR's owner/name and number, plus an `unrecognized` flag for a form that
// matches no producer's. No artifact text leaves a classifier.
//
// The reader decides a project's storage mode from its `config.yaml` and
// walks an fs-native ticket tree read-only: inside the tree no symlink is
// followed and only regular files under the size cap are read.
//
// Private to the implementation: only insights.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';

import { parseMiniYaml } from '../../lib/mini-yaml.mjs';
import { validTicket } from './recognize.mjs';

const STATES = ['backlog', 'in-progress', 'review', 'done'];
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const OUTCOME_ARTIFACTS = [
  ['04-review.md', 'review', classifyReview],
  ['05-tests.md', 'tests', classifyTests],
  ['06-summary.md', 'summary', classifySummary],
];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COMPLEXITIES = new Set(['S', 'M', 'L', 'XL']);
const STATUSES = new Set(['backlog', 'in-progress', 'in-review', 'done', 'cancelled', 'partial-completion']);
const FRONTMATTER_FIELDS = ['kind', 'parent', 'complexity', 'status', 'created'];
const FENCE = '---';
const TOP_LEVEL_KEY = /^([A-Za-z_][A-Za-z0-9_-]*):/;

const REVIEW_LABELS = new Map([
  ['verdict: skipped (trivial diff)', 'skipped-trivial'],
  ['verdict: skipped (no changes)', 'skipped-no-changes'],
  ['verdict: reviewed', 'reviewed'],
  ['verdict: failed (all reviewers)', 'failed-all'],
]);
const REVIEW_PARTIAL = /^verdict: reviewed \(partial — ([1-3])\/4 reviewers\)$/;
const REVIEW_STUCK = /^verdict: stuck \(.+\)$/;
const FIX_STEP = /^fix-step: (pending|complete)$/;
const DECISION = /^[ \t]*- decision: (accepted|dismissed|deferred)\b/;
const OUTCOME = /^[ \t]*- outcome: (applied|fix-failed|not attempted)\b/;
const MARKED_LINE = /^[ \t]*- (decision|outcome):/;
const FINDING = /^[ \t]*- \[F\d+\]/;
const OUTCOME_KEYS = { applied: 'applied', 'fix-failed': 'fix_failed', 'not attempted': 'not_attempted' };

const SKIP_LINE = /^verdict: skipped \((.+)\)$/;
const SKIP_CAUSES = new Map([
  ['no UI work in plan', 'no-ui-work'],
  ['UI testing disabled by --no-ui-testing', 'no-ui-testing-flag'],
  ['no testable repo in ticket', 'no-testable-repo'],
  ['app unreachable', 'app-unreachable'],
  ['browser driver unavailable', 'driver-unavailable'],
]);
const SHIP_SOURCE = 'Source: ship end-of-run UI verification';
const SHIP_VERDICT = /^verdict: (pass|partial)$/;
const CLOSE_PASS_HEADING = /^## (?:Pass: |Screenshots$)/;
const FAILED_CRITERIA_HEADING = /^## Failed Criteria$/;

const SUMMARY_VERDICT = /^verdict: (pass|partial|stuck)$/;
const PR_KEY = /^pr:(?:\s|$)/;
const PR_URL = /^pr: https:\/\/github\.com\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,12})$/;
const PR_NONE = /^pr: none(?:\s|$)/;
const BRANCH_LINE = /^branch: \S/;

/** The lines of `text`, split on `\n` only, each without one trailing `\r`, and a leading BOM dropped. */
export function linesOf(text) {
  return text.replace(/^﻿/, '').split('\n').map((line) => line.replace(/\r$/, ''));
}

const trimmed = (line) => (line ?? '').trimEnd();

function vocabulary(value, allowed) {
  return typeof value === 'string' && allowed(value) ? value : null;
}

/**
 * The first `---` block of a `01-spec.md` or `prd.md`: `kind` (`epic` or
 * null), `parent` (an ID), `complexity`, `status` and `created`, each null
 * when absent or outside its vocabulary. A present value outside its
 * vocabulary, a stored key written twice, a missing `status` and a missing
 * block each mark the record unrecognized; a missing optional key does not.
 */
export function parseFrontmatter(text) {
  const empty = { complexity: null, created: null, kind: null, parent: null, status: null };
  if (typeof text !== 'string') {
    return { ...empty, unrecognized: true };
  }
  const lines = linesOf(text);
  const close = lines.findIndex((line, index) => index > 0 && trimmed(line) === FENCE);
  if (trimmed(lines[0]) !== FENCE || close === -1) {
    return { ...empty, unrecognized: true };
  }
  const block = lines.slice(1, close);
  const seen = new Map();
  for (const line of block) {
    const match = TOP_LEVEL_KEY.exec(line);
    if (match !== null) {
      seen.set(match[1], (seen.get(match[1]) ?? 0) + 1);
    }
  }
  const doc = parseMiniYaml(block.join('\n'));
  const checks = {
    complexity: (value) => COMPLEXITIES.has(value),
    created: (value) => DATE.test(value),
    kind: (value) => value === 'epic',
    parent: (value) => validTicket(value) !== null,
    status: (value) => STATUSES.has(value),
  };
  const record = { ...empty };
  let unrecognized = false;
  for (const field of FRONTMATTER_FIELDS) {
    const count = seen.get(field) ?? 0;
    if (count === 0) {
      unrecognized ||= field === 'status';
      continue;
    }
    record[field] = count === 1 ? vocabulary(doc[field], checks[field]) : null;
    unrecognized ||= record[field] === null;
  }
  return { ...record, unrecognized };
}

/** A ticket's kind: `epic` for a `prd.md` or `kind: epic`, `child` when it names a parent, else `solo`. */
export function kindOf(frontmatter, hasPrd) {
  if (hasPrd || frontmatter.kind === 'epic') {
    return 'epic';
  }
  return frontmatter.parent === null ? 'solo' : 'child';
}

/**
 * `04-review.md`: its line-1 label, `reviewers_ok` for a partial review, the
 * line-2 `fix-step` marker, and the counts of each decision and outcome
 * token, matched on the leading token of every `- decision:` / `- outcome:`
 * line. A label outside the producer's set, a marked line with another
 * token, or a count of `- [F<k>]` finding lines other than the count of
 * decision lines marks it unrecognized; the counts are kept either way.
 */
export function classifyReview(text) {
  const decisions = { accepted: 0, deferred: 0, dismissed: 0 };
  const outcomes = { applied: 0, fix_failed: 0, not_attempted: 0 };
  if (typeof text !== 'string') {
    return { decisions, fix_step: null, label: null, outcomes, present: false, reviewers_ok: null, unrecognized: false };
  }
  const lines = linesOf(text);
  const first = trimmed(lines[0]);
  let label = REVIEW_LABELS.get(first) ?? null;
  let reviewersOk = null;
  const partial = REVIEW_PARTIAL.exec(first);
  if (partial !== null) {
    label = 'reviewed-partial';
    reviewersOk = Number(partial[1]);
  } else if (REVIEW_STUCK.test(first)) {
    label = 'stuck';
  }
  let unrecognized = label === null;
  let findings = 0;
  let decided = 0;
  for (const line of lines) {
    const decision = DECISION.exec(line);
    const outcome = OUTCOME.exec(line);
    if (decision !== null) {
      decisions[decision[1]] += 1;
      decided += 1;
    } else if (outcome !== null) {
      outcomes[OUTCOME_KEYS[outcome[1]]] += 1;
    } else if (MARKED_LINE.test(line)) {
      unrecognized = true;
    } else if (FINDING.test(line)) {
      findings += 1;
    }
  }
  unrecognized ||= findings !== decided;
  const fixStep = FIX_STEP.exec(trimmed(lines[1]));
  return { decisions, fix_step: fixStep === null ? null : fixStep[1], label, outcomes, present: true, reviewers_ok: reviewersOk, unrecognized };
}

/**
 * `05-tests.md`: `absent`; `skipped` with its cause token; `ran` by `ship`
 * with its result; or `ran` by `close`, a browser pass's report with its
 * `## Failed Criteria` presence. Only lines 1 and 2 carry a label, so a label
 * further down marks it unrecognized.
 */
export function classifyTests(text) {
  const none = { by: null, cause: null, failed_criteria: null, result: null };
  if (typeof text !== 'string') {
    return { ...none, state: 'absent', unrecognized: false };
  }
  const lines = linesOf(text);
  const first = trimmed(lines[0]);
  const skip = SKIP_LINE.exec(first);
  if (skip !== null && SKIP_CAUSES.has(skip[1])) {
    return { ...none, cause: SKIP_CAUSES.get(skip[1]), state: 'skipped', unrecognized: false };
  }
  const shipVerdict = SHIP_VERDICT.exec(trimmed(lines[1]));
  if (first.startsWith(SHIP_SOURCE) && shipVerdict !== null) {
    return { ...none, by: 'ship', result: shipVerdict[1], state: 'ran', unrecognized: false };
  }
  if (!first.startsWith('verdict:') && !first.startsWith('Source:') && lines.some((line) => CLOSE_PASS_HEADING.test(trimmed(line)))) {
    return { ...none, by: 'close', failed_criteria: lines.some((line) => FAILED_CRITERIA_HEADING.test(trimmed(line))), state: 'ran', unrecognized: false };
  }
  return { ...none, state: null, unrecognized: true };
}

function lastMatching(lines, pattern) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (pattern.test(lines[index])) {
      return trimmed(lines[index]);
    }
  }
  return null;
}

function prOf(line) {
  const url = PR_URL.exec(line);
  if (url !== null) {
    const number = Number(url[3]);
    return number > 0 ? { number, repo: `${url[1]}/${url[2]}` } : null;
  }
  return PR_NONE.test(line) ? 'none' : null;
}

/**
 * `06-summary.md`: its line-1 verdict, the last column-0 `pr:` line as
 * `{repo, number}` or `none`, and whether a `branch:` line is present. A
 * first line or a `pr:` line outside the producer's forms marks it
 * unrecognized.
 */
export function classifySummary(text) {
  if (typeof text !== 'string') {
    return { has_branch: false, pr: null, present: false, unrecognized: false, verdict: null };
  }
  const lines = linesOf(text);
  const verdict = SUMMARY_VERDICT.exec(trimmed(lines[0]));
  const prLine = lastMatching(lines, PR_KEY);
  const pr = prLine === null ? null : prOf(prLine);
  return {
    has_branch: lastMatching(lines, BRANCH_LINE) !== null,
    pr,
    present: true,
    unrecognized: verdict === null || (prLine !== null && pr === null),
    verdict: verdict === null ? null : verdict[1],
  };
}

/** The ticket store under a project root. */
export function ticketsDirOf(root) {
  return path.join(root, 'claudedocs', 'tickets');
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** `'missing'`, `'dir'` for a real directory, or `'other'` for a symlink, a file or an entry that cannot be inspected. */
function entryKind(entry) {
  try {
    return fs.lstatSync(entry).isDirectory() ? 'dir' : 'other';
  } catch (err) {
    return err.code === 'ENOENT' ? 'missing' : 'other';
  }
}

const isRealDirectory = (dir) => entryKind(dir) === 'dir';

/**
 * A project's join state from `<root>/claudedocs/tickets/config.yaml`: `fs`
 * for a missing file or any mode but `server-native`, `server-native`, or
 * `missing` when the root is gone or the file is not a readable regular file
 * under the artifact cap — the same read rule as every artifact.
 */
export function storageModeOf(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !isDirectory(root)) {
    return 'missing';
  }
  const config = readArtifact(ticketsDirOf(root), 'config.yaml');
  if (config.state === 'absent') {
    return 'fs';
  }
  if (config.state !== 'ok') {
    return 'missing';
  }
  return parseMiniYaml(config.text).mode === 'server-native' ? 'server-native' : 'fs';
}

const ABSENT = Object.freeze({ state: 'absent' });
const UNREADABLE = Object.freeze({ state: 'unreadable' });

/** One artifact: `absent`, `unreadable` (not a regular file, over the cap, or failing to read), or `ok` with its text. */
function readArtifact(folder, name) {
  const file = path.join(folder, name);
  try {
    if (!fs.lstatSync(file).isFile()) {
      return UNREADABLE;
    }
  } catch (err) {
    return err.code === 'ENOENT' ? ABSENT : UNREADABLE;
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) {
      return UNREADABLE;
    }
    return { mtime_ms: stat.mtimeMs, state: 'ok', text: fs.readFileSync(fd, 'utf8') };
  } catch {
    return UNREADABLE;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

const isTicketFolder = (entry) => entry.isDirectory() && validTicket(entry.name) !== null;

/** The ID-named real directories under `dir`, sorted; null when `dir` is not a real directory or cannot be listed. */
function ticketFolders(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  return entries.filter(isTicketFolder).map((entry) => entry.name).sort();
}

function frontmatterRecord(read, artifact, unrecognized) {
  const frontmatter = parseFrontmatter(read.state === 'ok' ? read.text : null);
  if (frontmatter.unrecognized) {
    unrecognized.push(artifact);
  }
  return frontmatter;
}

function ticketRecord({ epicFolder, folder, frontmatter, hasPrd, state, ticket, unrecognized }) {
  const record = {
    complexity: frontmatter.complexity,
    created: frontmatter.created,
    epic_folder: epicFolder,
    kind: kindOf(frontmatter, hasPrd),
    parent: frontmatter.parent,
    review: null,
    state,
    status: frontmatter.status,
    summary: null,
    summary_mtime: null,
    tests: null,
    ticket,
    unrecognized,
  };
  if (hasPrd) {
    return record;
  }
  for (const [artifact, field, classify] of OUTCOME_ARTIFACTS) {
    const read = readArtifact(folder, artifact);
    if (read.state === 'unreadable') {
      unrecognized.push(artifact);
      continue;
    }
    const outcome = classify(read.state === 'ok' ? read.text : null);
    if (outcome.unrecognized) {
      unrecognized.push(artifact);
    }
    const { unrecognized: _flag, ...fields } = outcome;
    record[field] = fields;
    if (field === 'summary' && read.state === 'ok') {
      record.summary_mtime = new Date(read.mtime_ms).toISOString();
    }
  }
  return record;
}

/** The record of one ticket folder, or null when it holds neither `prd.md` nor `01-spec.md`. */
function readTicketFolder(folder, ticket, state, epicFolder) {
  const unrecognized = [];
  const prd = readArtifact(folder, 'prd.md');
  if (prd.state !== 'absent') {
    const frontmatter = frontmatterRecord(prd, 'prd.md', unrecognized);
    return ticketRecord({ epicFolder, folder, frontmatter, hasPrd: true, state, ticket, unrecognized });
  }
  const spec = readArtifact(folder, '01-spec.md');
  if (spec.state === 'absent') {
    return null;
  }
  const frontmatter = frontmatterRecord(spec, '01-spec.md', unrecognized);
  return ticketRecord({ epicFolder, folder, frontmatter, hasPrd: false, state, ticket, unrecognized });
}

/**
 * Every ticket of an fs-native tree: the `<state>/<ID>/` folders of the four
 * state folders and the `<state>/<EPIC>/tasks/<ID>/` children of each epic,
 * keyed by ID. A child carries its epic's state folder as `state` and the
 * epic's ID as `epic_folder`; `status` is its own frontmatter's. A second
 * folder with an ID already read is counted in `duplicates`, the first in
 * state-folder order kept; a folder holding neither `prd.md` nor
 * `01-spec.md`, or a state folder that cannot be listed, is counted in
 * `skipped_folders`. Returns null when the store is not a directory.
 */
export function readTicketTree(root) {
  const ticketsDir = ticketsDirOf(root);
  if (!isDirectory(ticketsDir)) {
    return null;
  }
  const tickets = new Map();
  const tree = { duplicates: 0, skipped_folders: 0, tickets };
  const visit = (parentDir, state, epicFolder) => {
    const names = ticketFolders(parentDir);
    if (names === null) {
      tree.skipped_folders += 1;
      return;
    }
    for (const name of names) {
      const folder = path.join(parentDir, name);
      const record = readTicketFolder(folder, name, state, epicFolder);
      if (record === null) {
        tree.skipped_folders += 1;
        continue;
      }
      if (tickets.has(name)) {
        tree.duplicates += 1;
      } else {
        tickets.set(name, record);
      }
      const tasks = path.join(folder, 'tasks');
      if (epicFolder === null && record.kind === 'epic' && isRealDirectory(tasks)) {
        visit(tasks, state, name);
      }
    }
  };
  for (const state of STATES) {
    const stateDir = path.join(ticketsDir, state);
    const kind = entryKind(stateDir);
    if (kind === 'dir') {
      visit(stateDir, state, null);
    } else if (kind === 'other') {
      tree.skipped_folders += 1;
    }
  }
  return tree;
}
