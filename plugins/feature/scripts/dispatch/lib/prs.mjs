// Open pull requests for the dispatcher's PR cap (CONTRACT.md §8).
//
// One `gh pr list` call per invocation, run in the project root with an
// argument vector. `countOpenPrs` is pure: the number of dispatch slots held
// by open PRs the dispatcher recorded in runs.json and open PRs titled `<ID>:`
// for a tagged ticket, an epic's PRs holding one slot.
//
// Private to the implementation: only dispatch.mjs is a command.

import { spawnSync } from 'node:child_process';

import { oneLine } from './output.mjs';

const GH_ARGS = ['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,url'];
const GH_TIMEOUT_MS = 60_000;

/**
 * List open PRs: `{ ok: true, prs: [{number, title, url}] }` or
 * `{ ok: false, detail }`. The caller decides what a failure means.
 */
export function listOpenPrs({ projectRoot, env = process.env, runner = spawnSync }) {
  const result = runner('gh', GH_ARGS, {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    const detail = result.error.code === 'ENOENT' ? 'gh not found on PATH' : `gh could not run (${result.error.code ?? 'error'})`;
    return { ok: false, detail };
  }
  if (result.status !== 0) {
    const stderr = oneLine(result.stderr ?? '').slice(-200);
    return { ok: false, detail: `gh pr list exited ${result.status ?? `on ${result.signal}`}${stderr ? `: ${stderr}` : ''}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  const valid =
    Array.isArray(parsed) &&
    parsed.every((pr) => pr !== null && typeof pr === 'object' && typeof pr.title === 'string' && typeof pr.url === 'string');
  if (!valid) {
    return { ok: false, detail: 'gh pr list printed something other than a pull-request list' };
  }
  return { ok: true, prs: parsed.map((pr) => ({ number: pr.number, title: pr.title, url: pr.url })) };
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
