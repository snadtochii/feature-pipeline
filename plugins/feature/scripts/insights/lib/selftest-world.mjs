// The insights self-test's world (../CONTRACT.md §11): the fixture sessions,
// the world builder and the helpers the case lists share. The world is built
// once per run under a realpath temporary directory: the committed synthetic
// transcript fixtures copied into a redirected HOME's transcript store, the
// ticket-tree fixtures copied into the projects' `claudedocs/tickets/`, and
// the project tree, a git repository with a linked worktree, a scratch
// directory and the entries the scans must skip materialized beside them.
// Every child run is checked for the fixtures' sentinel in its output, for an
// unchanged store and ticket trees, and for the cache's modes and contents.
//
// Private to the implementation: only insights.mjs is a command.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaseFailure, assert, commitAll, equal, git, initRepo } from '../../lib/selftest-kit.mjs';
import { SCHEMA_VERSION, loadDigests } from './cache.mjs';
import { FIXTURES_DIR as FIXTURES, SENTINEL, copyFixtures, copyTicketFixtures } from './fixtures.mjs';
import { consumeLine, finishAgent, newAgent, readTranscript } from './transcript.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'insights.mjs');

export const SESSIONS = {
  a: { id: '0a0a0a0a-0000-4000-8000-00000000000a', slug: '-ROOT-repo' },
  b: { id: '0b0b0b0b-0000-4000-8000-00000000000b', slug: '-ROOT-repo-worktrees-wt' },
  c: { id: '0c0c0c0c-0000-4000-8000-00000000000c', slug: '-ROOT-repo-worktrees-gone' },
  d: { id: '0d0d0d0d-0000-4000-8000-00000000000d', slug: '-ROOT-scratch' },
  e: { id: '0f0f0f0f-0000-4000-8000-00000000000f', slug: '-ROOT-pipeline' },
  f: { id: '1a1a1a1a-0000-4000-8000-00000000001a', slug: '-ROOT-pipeline' },
};

const LINKED_SESSION_ID = '0e0e0e0e-0000-4000-8000-00000000000e';

export const transcriptOf = (key) => `${SESSIONS[key].slug}/${SESSIONS[key].id}.jsonl`;

function gitBinDir() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir !== '' && fs.existsSync(path.join(dir, 'git'))) {
      return dir;
    }
  }
  return null;
}

export function childEnv(home) {
  const dirs = [gitBinDir(), '/usr/bin', '/bin'].filter(Boolean);
  const env = { PATH: dirs.join(path.delimiter) };
  if (home !== null) {
    env.HOME = home;
  }
  return env;
}

export function makeWorld() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-insights-')));
  const ws = path.join(dir, 'ws');
  const home = path.join(dir, 'home');
  const repo = initRepo(path.join(ws, 'repo'));
  fs.writeFileSync(path.join(repo, 'README'), 'fixture\n');
  commitAll(repo);
  const tickets = { pipeline: path.join(ws, 'pipeline', 'claudedocs', 'tickets'), repo: path.join(repo, 'claudedocs', 'tickets') };
  fs.mkdirSync(tickets.repo, { recursive: true });
  copyTicketFixtures('repo', tickets.repo);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(path.join(ws, 'repo-worktrees'));
  git(repo, 'worktree', 'add', '-q', path.join(ws, 'repo-worktrees', 'wt'));
  fs.mkdirSync(path.join(ws, 'scratch'));
  fs.mkdirSync(tickets.pipeline, { recursive: true });
  copyTicketFixtures('pipeline', tickets.pipeline);
  fs.symlinkSync(path.join(tickets.pipeline, 'done', 'FP-30'), path.join(tickets.pipeline, 'done', 'FP-40'));
  const store = path.join(home, '.claude', 'projects');
  copyFixtures(FIXTURES, store, JSON.stringify(ws).slice(1, -1));
  fs.mkdirSync(path.join(store, SESSIONS.a.slug, 'memory'));
  fs.writeFileSync(path.join(store, SESSIONS.a.slug, 'memory', 'MEMORY.md'), `${SENTINEL}\n`);
  fs.writeFileSync(path.join(store, SESSIONS.a.slug, SESSIONS.a.id, 'custom-title.json'), JSON.stringify({ title: SENTINEL }));
  const subagentsOfA = path.join(store, SESSIONS.a.slug, SESSIONS.a.id, 'subagents');
  fs.writeFileSync(path.join(subagentsOfA, 'agent-a1.prefix.json'), JSON.stringify({ prefix: SENTINEL }));
  fs.symlinkSync(path.join(store, transcriptOf('a')), path.join(store, SESSIONS.a.slug, `${LINKED_SESSION_ID}.jsonl`));
  fs.mkdirSync(path.join(store, SESSIONS.b.slug, SESSIONS.b.id));
  fs.symlinkSync(subagentsOfA, path.join(store, SESSIONS.b.slug, SESSIONS.b.id, 'subagents'));
  const subagentsOfC = path.join(store, SESSIONS.c.slug, SESSIONS.c.id, 'subagents');
  fs.mkdirSync(subagentsOfC, { recursive: true });
  fs.writeFileSync(path.join(subagentsOfC, 'agent-c1.jsonl'), '');
  fs.writeFileSync(path.join(subagentsOfC, 'agent-c1.meta.json'), JSON.stringify([SENTINEL]));
  return { cacheRoot: path.join(home, '.feature-pipeline', 'insights', 'digests'), dir, home, repo, store, tickets, ws };
}

/** Run the entry as a child; the sentinel must reach neither stream. */
export function runEntry(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      if (stdout.includes(SENTINEL) || stderr.includes(SENTINEL)) {
        reject(new CaseFailure(`the sentinel reached the output of: ${args.join(' ')}`));
        return;
      }
      let doc = null;
      try {
        doc = JSON.parse(stdout);
      } catch {
        doc = null;
      }
      resolve({ doc, status, stderr, stdout });
    });
  });
}

export function listing(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listing(file, base, out);
    } else {
      const stat = fs.lstatSync(file);
      out.push([path.relative(base, file), stat.size, stat.mtimeMs]);
    }
  }
  return out.sort();
}

const modeOf = (file) => fs.statSync(file).mode & 0o777;

export function checkCache(world) {
  equal(fs.readdirSync(world.home).sort(), ['.claude', '.feature-pipeline'], 'entries under HOME');
  equal(fs.readdirSync(path.join(world.home, '.feature-pipeline')), ['insights'], 'entries under .feature-pipeline');
  const insights = path.dirname(world.cacheRoot);
  const entries = fs.readdirSync(insights).sort();
  assert(['["digests"]', '["digests","reports"]'].includes(JSON.stringify(entries)), `entries under insights: ${JSON.stringify(entries)}`);
  for (const dir of [insights, world.cacheRoot]) {
    equal(modeOf(dir), 0o700, `mode of ${path.basename(dir)}`);
  }
  if (entries.includes('reports')) {
    const reports = path.join(insights, 'reports');
    equal(modeOf(reports), 0o700, 'mode of reports');
    for (const name of fs.readdirSync(reports)) {
      const file = path.join(reports, name);
      assert(name.endsWith('.html') && !name.includes('.tmp-'), `unexpected report file ${name}`);
      equal(modeOf(file), 0o600, `mode of reports/${name}`);
      assert(!fs.readFileSync(file, 'utf8').includes(SENTINEL), `the sentinel reached reports/${name}`);
    }
  }
  for (const slug of fs.readdirSync(world.cacheRoot)) {
    const slugDir = path.join(world.cacheRoot, slug);
    equal(modeOf(slugDir), 0o700, `mode of digests/${slug}`);
    for (const name of fs.readdirSync(slugDir)) {
      const file = path.join(slugDir, name);
      assert(name.endsWith('.json') && !name.includes('.tmp-'), `unexpected cache file ${slug}/${name}`);
      equal(modeOf(file), 0o600, `mode of ${slug}/${name}`);
      assert(!fs.readFileSync(file, 'utf8').includes(SENTINEL), `the sentinel reached ${slug}/${name}`);
    }
  }
}

export const ticketListings = (world) => Object.values(world.tickets).map((dir) => listing(dir));

/** One `extract` run: exit 0, the store and the ticket trees untouched, the cache well formed. Returns the summary. */
export async function extractRun(world) {
  const before = listing(world.store);
  const ticketsBefore = ticketListings(world);
  const result = await runEntry(['extract'], childEnv(world.home));
  equal(result.status, 0, `extract exit (stdout ${result.stdout.slice(0, 200)})`);
  assert(result.doc !== null, 'extract printed no JSON document');
  equal(result.stderr, '', 'extract stderr');
  equal(listing(world.store), before, 'store listing after extract');
  equal(ticketListings(world), ticketsBefore, 'ticket tree listings after extract');
  checkCache(world);
  return result.doc;
}

export const NO_DECISIONS = { accepted: 0, deferred: 0, dismissed: 0 };
export const NO_OUTCOMES = { applied: 0, fix_failed: 0, not_attempted: 0 };
export const NO_TESTS = { by: null, cause: null, failed_criteria: null, result: null };

/** A tree record as `readTicketTree` returns it, for the in-memory join cases. */
export function treeRecord(ticket, overrides = {}) {
  return {
    complexity: 'M', created: '2026-11-01', epic_folder: null, kind: 'solo', parent: null, review: null, state: 'done', status: 'done', summary: null, summary_mtime: null, tests: null, ticket, unrecognized: [],
    ...overrides,
  };
}

export function runOf(project, ticket, closeVerdicts = [], versions = []) {
  return {
    by_role: { 'root-session': 1 },
    close_results: closeVerdicts.map((verdict, index) => ({ agent_id: `c${index}`, close_result: verdict === undefined ? null : { ending: 'caller', verdict }, session_id: 's' })),
    project,
    sessions: [{ end: null, session_id: 's', stages: versions.map((feature_versions) => ({ feature_versions })), start: null, transcript: 'x/s.jsonl', weighted_units: 1 }],
    ticket,
    weighted_units: 1,
  };
}

export function digestOf(world, key) {
  const digest = loadDigests(world.cacheRoot).find((item) => item.transcript === transcriptOf(key));
  assert(digest !== undefined, `no digest for session ${key}`);
  return digest;
}

export const digestFile = (world, key) => path.join(world.cacheRoot, SESSIONS[key].slug, `${SESSIONS[key].id}.json`);

export async function rootOfA(world) {
  const acc = newAgent('root', null);
  equal(await readTranscript(path.join(world.store, transcriptOf('a')), acc), true, 'session A read');
  return finishAgent(acc);
}

export function agentOfLines(lines) {
  const acc = newAgent('root', null);
  lines.forEach((line) => consumeLine(acc, typeof line === 'string' ? line : JSON.stringify(line)));
  return finishAgent(acc);
}

export const at = (seconds) => new Date(Date.UTC(2026, 10, 12, 10, 0, seconds)).toISOString();

/** Weighted units are float sums; each must be within 1e-9 of its hand-computed value. */
export function near(actual, expected, label) {
  equal(actual.length, expected.length, `${label}: count`);
  actual.forEach((value, index) => assert(Math.abs(value - expected[index]) < 1e-9, `${label}: ${value} is not ${expected[index]}`));
}

export const SESSION_COUNTS = { cache_corrupt: 0, kept_stale: 0, kept_without_transcript: 0, mapped: 0, parsed: 0, remapped: 0, reused: 0, seen: 0, unmapped: 0 };

export const NO_FLAGS = { compare: null, cwd: null, project: null, since: null };
export const NO_FRICTION = { interrupts: 0, permission_denials: 0, rejections: 0, tool_errors: 0 };
export const EMPTY_DATASET = { counts: {}, projects: [], tickets: [], unrecognized: [], without_recognition: 0 };
export const NOV = (day, hour = 10) => Date.UTC(2026, 10, day, hour);
export const isoNov = (day, hour = 10) => new Date(NOV(day, hour)).toISOString();

/** A digest agent with every field the report reads; `fields` overrides. */
export function synthAgent(agentId, parentId, fields = {}) {
  return {
    agent_id: agentId, check_runs: { failed: 0, total: 0 }, close_result: null, commands: [], end: null, feature_versions: [], friction: NO_FRICTION, models: [],
    parent_agent_id: parentId, role: null, run_ticket: null, stage: null, start: null, tokens: { cache_read: 0, cache_write: 0, input: 0, output: 0 },
    ...fields,
  };
}

/** A digest of `agents` in `project` starting at `start`, its working directory carrying the sentinel. */
export function synthDigest(project, start, agents, sessionId = `s-${start}`) {
  return {
    agents, cwd: `/w/${SENTINEL}/x`, end: start, feature_versions: [], project, project_via: project === null ? null : 'cwd', schema_version: SCHEMA_VERSION,
    session_id: sessionId, sources: [], start, tokens: { cache_read: 0, cache_write: 0, input: 100, output: 10 }, transcript: `x/${sessionId}.jsonl`,
  };
}

/** A joined run ticket for the compare cases: one plan stage on 2026-01-<day>, units 10 × day. */
export function runTicket(id, versions, day, overrides = {}) {
  const start = new Date(Date.UTC(2026, 0, day)).toISOString();
  return {
    by_role: {}, close_results: [], feature_versions: versions,
    outcome: { kind: 'solo', review: { decisions: { accepted: 1, deferred: 0, dismissed: 0 }, label: 'reviewed', present: true }, tests: null },
    project: '/p', sessions: [{ session_id: `s-${id}`, stages: [{ duration_ms: 1000 * day, stage: 'plan', start, weighted_units: 10 * day }], start }],
    source: 'both', ticket: id, verdict: 'pass', weighted_units: 10 * day,
    ...overrides,
  };
}

export const days = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
export const bodyMarkers = (html) => /<body data-state="([a-z]+)" data-compare="([a-z]+)">/.exec(html)?.slice(1) ?? null;
export const boxOf = (html, name) => html.slice(html.indexOf(`data-box="${name}"`), html.indexOf('</div>', html.indexOf(`data-box="${name}"`)));
