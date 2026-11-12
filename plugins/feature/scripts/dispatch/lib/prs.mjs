// Pull requests for the dispatcher: the PR cap (CONTRACT.md §8) and a
// dispatched item's pull-request state (CONTRACT.md §10).
//
// One `gh pr list` call per invocation, one `gh pr view` per dispatched ticket,
// one `gh pr checks` per ticket with a pull request open into the base branch,
// and one more `gh pr list` per ticket merged into an integration branch, each
// run in the project root with an argument vector. `countOpenPrs`
// is pure: the number of dispatch slots held
// by open PRs the dispatcher recorded in runs.json and open PRs titled `<ID>:`
// for a tagged ticket, an epic's PRs holding one slot.
//
// Private to the implementation: only dispatch.mjs is a command.

import { spawnSync } from 'node:child_process';

import { runGh } from '../../lib/gh.mjs';

const GH_LIST_ARGS = ['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,url'];

/** The JSON array `text` holds, or null when it holds anything else. */
function parseJsonArray(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

const NOT_A_PR_LIST = 'gh pr list printed something other than a pull-request list';

/**
 * List open PRs: `{ ok: true, prs: [{number, title, url}] }` or
 * `{ ok: false, detail }`. The caller decides what a failure means.
 */
export function listOpenPrs({ projectRoot, env = process.env, runner = spawnSync }) {
  const run = runGh(GH_LIST_ARGS, { cwd: projectRoot, env, runner });
  if (!run.ok) {
    return run;
  }
  const parsed = parseJsonArray(run.stdout);
  const valid = parsed?.every((pr) => pr !== null && typeof pr === 'object' && typeof pr.title === 'string' && typeof pr.url === 'string');
  if (!valid) {
    return { ok: false, detail: NOT_A_PR_LIST };
  }
  return { ok: true, prs: parsed.map((pr) => ({ number: pr.number, title: pr.title, url: pr.url })) };
}

const PR_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._/-]+\/pull\/\d+$/;
const PR_STATES = new Set(['OPEN', 'CLOSED', 'MERGED']);
const PR_VIEW_JQ = '.state + " " + .baseRefName + " " + (any(.labels[]; (.name | ascii_downcase) == "ship-failed") | tostring)';

/**
 * One pull request's state, base branch and whether it carries the `ship-failed`
 * label: `{ ok: true, state, base, shipFailed }` (`state` is `OPEN`, `CLOSED` or
 * `MERGED`) or `{ ok: false, detail }`. The answer is exactly three tokens, the
 * third `true` or `false`; anything else is a failed read. A URL that is not
 * `https://<host>/<path>/pull/<digits>` runs nothing.
 */
export function prState({ projectRoot, env = process.env, url, runner = spawnSync }) {
  if (typeof url !== 'string' || !PR_URL.test(url)) {
    return { ok: false, detail: 'not a pull-request URL' };
  }
  const run = runGh(['pr', 'view', url, '--json', 'state,baseRefName,labels', '--jq', PR_VIEW_JQ], { cwd: projectRoot, env, runner });
  if (!run.ok) {
    return run;
  }
  const tokens = run.stdout.trim().split(' ');
  const [state, base, label] = tokens;
  if (tokens.length !== 3 || !PR_STATES.has(state) || !base || (label !== 'true' && label !== 'false')) {
    return { ok: false, detail: 'gh pr view printed something other than a state, a base branch and a label answer' };
  }
  return { ok: true, state, base, shipFailed: label === 'true' };
}

/**
 * The number of a pull request's checks in `gh`'s `fail` bucket, or null when
 * they could not be read. A URL that is not a pull request's runs nothing.
 */
export function failingChecks({ projectRoot, env = process.env, url, runner = spawnSync }) {
  if (typeof url !== 'string' || !PR_URL.test(url)) {
    return null;
  }
  const run = runGh(['pr', 'checks', url, '--json', 'bucket', '--jq', '[.[] | select(.bucket == "fail")] | length'], { cwd: projectRoot, env, runner });
  const text = run.ok ? run.stdout.trim() : '';
  return /^\d+$/.test(text) ? Number(text) : null;
}

/**
 * The newest open same-repository pull request from `head` into `base`:
 * `{ ok: true, url }`, `url` null when there is none, or `{ ok: false, detail }`.
 */
export function openPrFromHead({ projectRoot, env = process.env, head, base, runner = spawnSync }) {
  const run = runGh(['pr', 'list', '--head', head, '--base', base, '--state', 'open', '--json', 'number,url,isCrossRepository'], { cwd: projectRoot, env, runner });
  if (!run.ok) {
    return run;
  }
  const parsed = parseJsonArray(run.stdout);
  if (parsed === null) {
    return { ok: false, detail: NOT_A_PR_LIST };
  }
  const sameRepo = parsed.filter((pr) => pr?.isCrossRepository === false && Number.isInteger(pr.number) && PR_URL.test(pr.url));
  const newest = sameRepo.sort((a, b) => b.number - a.number)[0];
  return { ok: true, url: newest?.url ?? null };
}

const TITLE_ID = /^([^\s:]+):/;

/**
 * The dispatch slot each ticket's PRs count toward: a Map from ticket id to
 * slot id. A child of a tagged epic, tagged or not, counts toward its epic;
 * every other tagged ticket is its own slot. Untagged tickets have no entry.
 */
export function prSlots(rows, tag) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const isTaggedEpic = (id) => {
    const row = byId.get(id);
    return row !== undefined && row.kind === 'epic' && row.tags.includes(tag);
  };
  const slots = new Map();
  for (const row of rows) {
    if (row.parent_id !== null && isTaggedEpic(row.parent_id)) {
      slots.set(row.id, row.parent_id);
    } else if (row.tags.includes(tag)) {
      slots.set(row.id, row.id);
    }
  }
  return slots;
}

/**
 * The PRs recorded in runs.json records: a Map from PR URL to the id of the
 * dispatched item that opened it, or to the URL itself when the record names
 * no item id.
 */
export function recordedPrs(runs) {
  const recorded = new Map();
  for (const record of runs) {
    for (const item of Array.isArray(record?.items) ? record.items : []) {
      if (typeof item?.pr_url === 'string' && item.pr_url !== '') {
        recorded.set(item.pr_url, typeof item.id === 'string' && item.id !== '' ? item.id : item.pr_url);
      }
    }
  }
  return recorded;
}

/**
 * Count the dispatch slots held by open PRs. A PR titled `<ID>:` for a ticket
 * in `slots` holds that ticket's slot; a PR recorded in runs.json holds its
 * item's slot. Several PRs of one item — an epic's child PRs and its
 * integration PR — hold one slot. Returns `{ count, slots, urls }`, both
 * lists sorted.
 */
export function countOpenPrs({ openPrs, runs, slots }) {
  const recorded = recordedPrs(runs);
  const held = new Set();
  const counted = new Set();
  for (const pr of openPrs) {
    const titleId = TITLE_ID.exec(pr.title)?.[1];
    let slot = titleId !== undefined ? slots.get(titleId) : undefined;
    if (slot === undefined && recorded.has(pr.url)) {
      const id = recorded.get(pr.url);
      slot = slots.get(id) ?? id;
    }
    if (slot !== undefined) {
      held.add(slot);
      counted.add(pr.url);
    }
  }
  return { count: held.size, slots: [...held].sort(), urls: [...counted].sort() };
}
