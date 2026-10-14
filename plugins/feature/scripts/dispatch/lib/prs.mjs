// Open pull requests for the dispatcher's PR cap (CONTRACT.md §8).
//
// One `gh pr list` call per invocation, run in the project root with an
// argument vector. `countOpenPrs` is pure: the union, by URL, of open PRs the
// dispatcher recorded in runs.json and open PRs titled `<ID>:` for a tagged
// ticket.
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

/** The PR URLs recorded in runs.json records. */
export function recordedPrUrls(runs) {
  const urls = new Set();
  for (const record of runs) {
    for (const item of Array.isArray(record?.items) ? record.items : []) {
      if (typeof item?.pr_url === 'string' && item.pr_url !== '') {
        urls.add(item.pr_url);
      }
    }
  }
  return urls;
}

/**
 * Count the open PRs that hold a dispatch slot. Returns `{ count, urls }`,
 * `urls` sorted.
 */
export function countOpenPrs({ openPrs, runs, taggedIds }) {
  const recorded = recordedPrUrls(runs);
  const prefixes = taggedIds.map((id) => `${id}:`);
  const counted = new Set();
  for (const pr of openPrs) {
    if (recorded.has(pr.url) || prefixes.some((prefix) => pr.title.startsWith(prefix))) {
      counted.add(pr.url);
    }
  }
  return { count: counted.size, urls: [...counted].sort() };
}
