#!/usr/bin/env node
// Check that the insights extractor and scripts/measure-session.py agree on
// token units. Both parsers recognize the same agents, roles and tickets with
// the same rules and weights; this script holds them equal on the committed
// synthetic pipeline fixture. It copies that fixture into a temporary HOME,
// runs `insights.mjs extract` there, and for each parity session compares the
// per-ticket and per-role totals of the digest (lib/runs.mjs) with
// `measure-session.py report <session> --json`: the same keys, agent counts,
// turns and the four token sums exactly, weighted units within 0.001 (Python
// rounds them to three decimals).
//
// Python's report carries agent descriptions, so it is held in memory only and
// never printed or written; a failure line names the session, the key and the
// two numbers. Both children get argv arrays, never a shell. Needs Node 22+,
// git and python3 3.9+.
//
// Usage: node scripts/check-insights-parity.mjs
// Exit: 0 every comparison equal, 1 otherwise.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDigests } from '../plugins/feature/scripts/insights/lib/cache.mjs';
import { FIXTURES_DIR, SENTINEL, copyFixtures } from '../plugins/feature/scripts/insights/lib/fixtures.mjs';
import { sessionTotals } from '../plugins/feature/scripts/insights/lib/runs.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACTOR = path.join(REPO, 'plugins', 'feature', 'scripts', 'insights', 'insights.mjs');
const MEASURE = path.join(REPO, 'scripts', 'measure-session.py');
const SLUG = '-ROOT-pipeline';
const PARITY_SESSIONS = [
  { id: '0f0f0f0f-0000-4000-8000-00000000000f', label: 'session E' },
  { id: '1a1a1a1a-0000-4000-8000-00000000001a', label: 'session F' },
];
const EXACT_FIELDS = ['count', 'turns', 'input_tokens', 'cache_write_tokens', 'cache_read_tokens', 'output_tokens'];
const UNIT_TOLERANCE = 0.001;

const lines = [];
const failures = [];

function compare(label, key, nodeBuckets, pythonBuckets) {
  const nodeOf = new Map(nodeBuckets.map((bucket) => [bucket[key], bucket]));
  const pythonOf = new Map(pythonBuckets.map((bucket) => [bucket[key], bucket]));
  const names = [...new Set([...nodeOf.keys(), ...pythonOf.keys()])].sort();
  let equal = true;
  for (const name of names) {
    const node = nodeOf.get(name);
    const python = pythonOf.get(name);
    if (node === undefined || python === undefined) {
      failures.push(`${label} ${key} ${name}: present only in ${node === undefined ? 'measure-session.py' : 'the extractor'}`);
      equal = false;
      continue;
    }
    for (const field of EXACT_FIELDS) {
      if (node[field] !== python[field]) {
        failures.push(`${label} ${key} ${name} ${field}: extractor ${node[field]}, measure-session.py ${python[field]}`);
        equal = false;
      }
    }
    if (!(Math.abs(node.weighted_units - python.weighted_units) <= UNIT_TOLERANCE)) {
      failures.push(`${label} ${key} ${name} weighted_units: extractor ${node.weighted_units}, measure-session.py ${python.weighted_units}`);
      equal = false;
    }
  }
  if (equal) {
    lines.push(`  ok  ${label} ${key}s: ${names.length} key(s)`);
  }
}

function measure(transcript) {
  const result = spawnSync('python3', [MEASURE, 'report', transcript, '--json'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) {
    throw new Error(`python3 could not run (${result.error.code ?? 'error'}) — this check needs python3 3.9+ on PATH`);
  }
  if (result.status !== 0) {
    throw new Error(`measure-session.py exited ${result.status}: ${(result.stderr ?? '').split('\n', 1)[0]}`);
  }
  return JSON.parse(result.stdout);
}

function run(tmp) {
  const home = path.join(tmp, 'home');
  const store = path.join(home, '.claude', 'projects');
  copyFixtures(path.join(FIXTURES_DIR, SLUG), path.join(store, SLUG), JSON.stringify(path.join(tmp, 'ws')).slice(1, -1));
  const extract = spawnSync(process.execPath, [EXTRACTOR, 'extract'], { encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH ?? '' } });
  if (extract.status !== 0) {
    throw new Error(`insights.mjs extract exited ${extract.status}`);
  }
  const digests = loadDigests(path.join(home, '.feature-pipeline', 'insights', 'digests'));
  for (const { id, label } of PARITY_SESSIONS) {
    const digest = digests.find((item) => item.session_id === id);
    if (digest === undefined) {
      failures.push(`${label}: the extractor wrote no digest`);
      continue;
    }
    const report = measure(path.join(store, SLUG, `${id}.jsonl`));
    compare(label, 'ticket', sessionTotals(digest, 'ticket'), report.tickets);
    compare(label, 'role', sessionTotals(digest, 'role'), report.roles);
  }
}

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'insights-parity-'));
try {
  run(tmp);
} catch (err) {
  failures.push(err instanceof Error ? err.message : String(err));
} finally {
  fs.rmSync(tmp, { force: true, recursive: true });
}

if ([...lines, ...failures].some((line) => line.includes(SENTINEL))) {
  process.stderr.write('FAIL: fixture text reached the output\n');
  process.exit(1);
}
if (lines.length > 0) {
  process.stdout.write(`${lines.join('\n')}\n`);
}
if (failures.length > 0) {
  process.stderr.write(`\nFAIL (${failures.length}):\n${failures.map((line) => `  ${line}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`\nOK: the extractor's per-ticket and per-role units equal measure-session.py's on ${PARITY_SESSIONS.length} fixture session(s)\n`);
