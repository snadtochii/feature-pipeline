// The insights extractor's self-test (../CONTRACT.md §9).
//
// Every case is `[name, fn(world)]`. The world is built once per run under a
// realpath temporary directory: the committed synthetic fixtures copied into
// a redirected HOME's transcript store, and the project tree, a git
// repository with a linked worktree, a scratch directory and the entries the
// scan must skip materialized beside them. The rules are exercised
// in-process; the verb end to end as a child process with a minimal
// environment. The `extract` cases run in order over the same world. Every
// child run is checked for the fixtures' sentinel in its output, for an
// unchanged store, and for the cache's modes and contents.
//
// Private to the implementation: only insights.mjs is a command.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ComputeError, UsageError, render } from '../../lib/output.mjs';
import { CaseFailure, assert, commitAll, equal, git, initRepo, throwsKind } from '../../lib/selftest-kit.mjs';
import { parseArgv } from './args.mjs';
import { SCHEMA_VERSION, loadDigests } from './cache.mjs';
import { makeMapper, mapProject } from './project.mjs';
import { consumeLine, finishAgent, newAgent, readTranscript } from './transcript.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'insights.mjs');
const FIXTURES = path.join(HERE, '..', 'fixtures', 'transcripts');
const SENTINEL = 'FIXTURE-TEXT-9c41';
const ROOT_TOKEN = '<ROOT>';

const SESSIONS = {
  a: { id: '0a0a0a0a-0000-4000-8000-00000000000a', slug: '-ROOT-repo' },
  b: { id: '0b0b0b0b-0000-4000-8000-00000000000b', slug: '-ROOT-repo-worktrees-wt' },
  c: { id: '0c0c0c0c-0000-4000-8000-00000000000c', slug: '-ROOT-repo-worktrees-gone' },
  d: { id: '0d0d0d0d-0000-4000-8000-00000000000d', slug: '-ROOT-scratch' },
};

const LINKED_SESSION_ID = '0e0e0e0e-0000-4000-8000-00000000000e';

const transcriptOf = (key) => `${SESSIONS[key].slug}/${SESSIONS[key].id}.jsonl`;

function copyFixtures(source, target, root) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyFixtures(from, to, root);
    } else {
      fs.writeFileSync(to, fs.readFileSync(from, 'utf8').replaceAll(ROOT_TOKEN, root));
    }
  }
}

function gitBinDir() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir !== '' && fs.existsSync(path.join(dir, 'git'))) {
      return dir;
    }
  }
  return null;
}

function childEnv(home) {
  const dirs = [gitBinDir(), '/usr/bin', '/bin'].filter(Boolean);
  const env = { PATH: dirs.join(path.delimiter) };
  if (home !== null) {
    env.HOME = home;
  }
  return env;
}

function makeWorld() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-insights-')));
  const ws = path.join(dir, 'ws');
  const home = path.join(dir, 'home');
  const repo = initRepo(path.join(ws, 'repo'));
  fs.writeFileSync(path.join(repo, 'README'), 'fixture\n');
  commitAll(repo);
  fs.mkdirSync(path.join(repo, 'claudedocs', 'tickets'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(path.join(ws, 'repo-worktrees'));
  git(repo, 'worktree', 'add', '-q', path.join(ws, 'repo-worktrees', 'wt'));
  fs.mkdirSync(path.join(ws, 'scratch'));
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
  return { cacheRoot: path.join(home, '.feature-pipeline', 'insights', 'digests'), dir, home, repo, store, ws };
}

/** Run the entry as a child; the sentinel must reach neither stream. */
function runEntry(args, env) {
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

function listing(dir, base = dir, out = []) {
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

function checkCache(world) {
  equal(fs.readdirSync(world.home).sort(), ['.claude', '.feature-pipeline'], 'entries under HOME');
  equal(fs.readdirSync(path.join(world.home, '.feature-pipeline')), ['insights'], 'entries under .feature-pipeline');
  const insights = path.dirname(world.cacheRoot);
  equal(fs.readdirSync(insights), ['digests'], 'entries under insights');
  for (const dir of [insights, world.cacheRoot]) {
    equal(modeOf(dir), 0o700, `mode of ${path.basename(dir)}`);
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

/** One `extract` run: exit 0, the store untouched, the cache well formed. Returns the summary. */
async function extractRun(world) {
  const before = listing(world.store);
  const result = await runEntry(['extract'], childEnv(world.home));
  equal(result.status, 0, `extract exit (stdout ${result.stdout.slice(0, 200)})`);
  assert(result.doc !== null, 'extract printed no JSON document');
  equal(result.stderr, '', 'extract stderr');
  equal(listing(world.store), before, 'store listing after extract');
  checkCache(world);
  return result.doc;
}

function digestOf(world, key) {
  const digest = loadDigests(world.cacheRoot).find((item) => item.transcript === transcriptOf(key));
  assert(digest !== undefined, `no digest for session ${key}`);
  return digest;
}

const digestFile = (world, key) => path.join(world.cacheRoot, SESSIONS[key].slug, `${SESSIONS[key].id}.json`);

async function rootOfA(world) {
  const acc = newAgent('root', null);
  equal(await readTranscript(path.join(world.store, transcriptOf('a')), acc), true, 'session A read');
  return finishAgent(acc);
}

function agentOfLines(lines) {
  const acc = newAgent('root', null);
  lines.forEach((line) => consumeLine(acc, typeof line === 'string' ? line : JSON.stringify(line)));
  return finishAgent(acc);
}

const at = (seconds) => new Date(Date.UTC(2026, 10, 12, 10, 0, seconds)).toISOString();

const SESSION_COUNTS = { cache_corrupt: 0, kept_stale: 0, kept_without_transcript: 0, mapped: 0, parsed: 0, remapped: 0, reused: 0, seen: 0, unmapped: 0 };

const CASES = [
  ['args: extract and --self-test parse, anything else is a usage error', async () => {
    equal(parseArgv(['extract']), { verb: 'extract' }, 'extract');
    equal(parseArgv(['--self-test']), { selfTest: true }, 'self-test');
    for (const argv of [[], ['bogus'], ['extract', '--x'], ['extract', 'more'], ['extract', '--self-test'], ['--self-test', 'extract'], ['--flag=1']]) {
      throwsKind(() => parseArgv(argv), UsageError);
    }
    const bad = await runEntry(['bogus'], childEnv(null));
    equal(bad.status, 2, 'bad verb exit');
    assert(typeof bad.doc?.error === 'string', 'bad verb prints an error document');
    const noHome = await runEntry(['extract'], childEnv(null));
    equal(noHome.status, 1, 'unset HOME exit');
    assert(noHome.doc?.error.includes('HOME'), `unset HOME error names HOME: ${noHome.stdout}`);
  }],
  ['tokens: one usage per message id, the terminal record preferred', async (world) => {
    const root = await rootOfA(world);
    equal(root.turns, 3, 'distinct message ids');
    equal(root.turns_without_usage, 1, 'turns without usage');
    equal(root.tokens, { cache_read: 2700, cache_write: 200, input: 10, output: 120 }, 'root tokens');
    equal(
      root.tokens_by_model,
      { 'claude-opus-test': { cache_read: 2000, cache_write: 200, input: 3, output: 50 }, 'claude-sonnet-test': { cache_read: 700, cache_write: 0, input: 7, output: 70 } },
      'tokens by model',
    );
    equal(root.models, ['claude-opus-test', 'claude-sonnet-test'], 'models');
    equal(root.anomalies.no_message_id, 1, 'assistant record without message.id');
  }],
  ['tokens: only the four top-level usage keys count, as non-negative integers', () => {
    const agent = agentOfLines([
      { message: { id: 'm1', stop_reason: 'end_turn', usage: { cache_creation: { x: 50 }, cache_creation_input_tokens: '4', input_tokens: 2.9, iterations: [{ input_tokens: 99 }], output_tokens: -5 } }, timestamp: at(0), type: 'assistant' },
      { message: { id: 'm2', usage: 'not an object' }, timestamp: at(1), type: 'assistant' },
      { message: { id: 'm3', usage: { input_tokens: 1 } }, timestamp: at(2), type: 'user' },
    ]);
    equal(agent.tokens, { cache_read: 0, cache_write: 4, input: 2, output: 0 }, 'coerced top-level keys');
    equal([agent.turns, agent.turns_without_usage], [2, 1], 'turns and turns without usage');
  }],
  ['friction: each tool result is classified once', async (world) => {
    const root = await rootOfA(world);
    equal(root.friction, { interrupts: 1, permission_denials: 2, rejections: 1, tool_errors: 1 }, 'root friction');
  }],
  ['skills: only isMeta skill loads count, with the feature plugin version', async (world) => {
    const root = await rootOfA(world);
    equal(root.skills, { 'feature:build': 1, 'git-workflow': 1 }, 'skills');
    equal(root.feature_versions, ['3.40.0'], 'feature versions');
    const load = (text) => ({ isMeta: true, message: { content: text }, timestamp: at(0), type: 'user' });
    const agent = agentOfLines([
      load('Base directory for this skill: /h/.claude/plugins/cache/m/kit/1.2.3/skills/engineering/pr\nbody'),
      load('Base directory for this skill: /private/tmp/claude/bundled-skills/2.1.0/0f0f/claude-api'),
      load('Base directory for this skill: /h/.claude/plugins/cache/m/feature/not-a-version/skills/flow'),
      load('Base directory for this skill: /nowhere/useful'),
      { message: { content: 'Base directory for this skill: /h/.claude/plugins/cache/m/feature/1.0.0/skills/flow' }, timestamp: at(1), type: 'user' },
    ]);
    equal(agent.skills, { 'claude-api': 1, 'feature:flow': 1, 'kit:pr': 1 }, 'nested, bundled and unversioned skill paths');
    equal(agent.feature_versions, [], 'no version from a malformed version or a non-meta record');
    equal(agent.anomalies.bad_skill_path, 1, 'an unrecognized skill path');
  }],
  ['commands: names kept, arguments reduced to ticket IDs', async (world) => {
    const root = await rootOfA(world);
    equal(root.commands, [{ ids: ['FP-7'], name: '/feature:build' }, { ids: ['FP-8'], name: 'feature:plan' }], 'commands');
    const agent = agentOfLines([{ message: { content: '<command-name>/bad name!</command-name>' }, timestamp: at(0), type: 'user' }]);
    equal([agent.commands, agent.anomalies.bad_command_name], [[], 1], 'an invalid command name is not kept');
  }],
  ['malformed: bad and truncated lines are counted and the read goes on', async (world) => {
    const root = await rootOfA(world);
    equal(root.malformed_lines, 2, 'the broken middle line and the truncated last line');
    equal(root.end, at(45), 'records after the broken line still counted');
    const file = path.join(world.dir, 'separators.jsonl');
    const record = { message: { content: 'a b c\rd' }, timestamp: at(0), type: 'user' };
    const raw = JSON.stringify(record).replace(/\\u2028/g, ' ').replace(/\\u2029/g, ' ');
    fs.writeFileSync(file, `${raw}\r\n\n[1]\n"text"\n`);
    const acc = newAgent('root', null);
    equal(await readTranscript(file, acc), true, 'separators file read');
    equal(finishAgent(acc).malformed_lines, 2, 'only the two non-object lines are malformed');
    const missing = newAgent('root', null);
    equal(await readTranscript(path.join(world.dir, 'absent.jsonl'), missing), false, 'unreadable file');
    const gone = finishAgent(missing);
    equal([gone.malformed_lines, gone.anomalies.unreadable_file], [1, 1], 'an unreadable file is counted');
  }],
  ['timestamps: start and end are the minimum and maximum, the cwd the earliest', async (world) => {
    const root = await rootOfA(world);
    equal([root.start, root.end, root.duration_ms], [at(5), at(45), 40_000], 'root span');
    equal(root.cwd, path.join(world.ws, 'repo'), 'cwd of the earliest record, not the first line');
  }],
  ['project: cwd, subdirectory, live worktree, deleted worktree and unmapped', (world) => {
    const mapped = (cwd) => mapProject(cwd);
    equal(mapped(world.repo), { project: world.repo, project_via: 'cwd' }, 'project root');
    equal(mapped(path.join(world.repo, 'src')), { project: world.repo, project_via: 'cwd' }, 'subdirectory');
    equal(mapped(path.join(world.repo, 'claudedocs', 'tickets')), { project: world.repo, project_via: 'cwd' }, 'inside claudedocs');
    equal(mapped(path.join(world.ws, 'repo-worktrees', 'wt')), { project: world.repo, project_via: 'worktree' }, 'live worktree');
    equal(mapped(path.join(world.ws, 'repo-worktrees', 'gone', 'sub')), { project: world.repo, project_via: 'worktree-sibling' }, 'deleted worktree');
    for (const cwd of [path.join(world.ws, 'scratch'), 'relative/dir', '', null]) {
      equal(mapped(cwd), { project: null, project_via: null }, `unmapped ${JSON.stringify(cwd)}`);
    }
    const noGit = { gitDirs: () => null, isDir: (dir) => fs.existsSync(dir) };
    equal(mapProject(path.join(world.ws, 'repo-worktrees', 'wt'), noGit), { project: null, project_via: null }, 'git missing degrades to the cwd walk');
    let calls = 0;
    const countingIsDir = (dir) => {
      calls += 1;
      return fs.existsSync(dir);
    };
    const counted = makeMapper({ gitDirs: () => null, isDir: countingIsDir });
    counted(world.repo);
    const first = calls;
    counted(world.repo);
    equal(calls, first, 'memoized per cwd');
  }],
  ['extract: the first run parses every session', async (world) => {
    const doc = await extractRun(world);
    equal(doc.sessions, { ...SESSION_COUNTS, mapped: 3, parsed: 4, seen: 4, unmapped: 1 }, 'sessions');
    equal(doc.subagents, { orphan_jsonl: 1, orphan_meta: 1, parsed: 3 }, 'subagents');
    equal([doc.malformed_lines, doc.malformed_sessions, doc.malformed_sessions_total], [2, [transcriptOf('a')], 1], 'malformed');
    equal(doc.anomalies, { bad_meta: 1, no_message_id: 1, orphan_jsonl: 1, orphan_meta: 1 }, 'anomalies');
    equal(
      [doc.skipped_entries, doc.schema_version, doc.cache_dir],
      [3, SCHEMA_VERSION, world.cacheRoot],
      'skipped (memory/, a symlinked transcript, a symlinked subagents), schema and cache dir',
    );
    const a = digestOf(world, 'a');
    equal([a.session_id, a.project, a.project_via, a.cwd], [SESSIONS.a.id, world.repo, 'cwd', path.join(world.ws, 'repo')], 'session A identity');
    equal([a.start, a.end, a.duration_ms], [at(5), at(70), 65_000], 'session A span across agents');
    equal(a.tokens, { cache_read: 2703, cache_write: 204, input: 21, output: 122 }, 'session A tokens');
    equal(a.agents.map((agent) => agent.agent_id), ['root', 'a1', 'a2'], 'agents');
    equal(a.sources.map((source) => source.path.split('/').pop()), [`${SESSIONS.a.id}.jsonl`, 'agent-a1.jsonl', 'agent-a1.meta.json', 'agent-a2.jsonl'], 'sources');
    const [, a1, a2] = a.agents;
    equal([a1.agent_type, a1.tool_use_id, a1.spawn_depth, a1.parent_agent_id], ['feature:code-reviewer', 'toolu_agent1', 1, null], 'subagent meta');
    assert(!('description' in a1), 'the meta description is not kept');
    equal([a2.agent_type, a2.anomalies], [null, { orphan_jsonl: 1 }], 'orphan transcript');
    const b = digestOf(world, 'b');
    equal([b.project, b.project_via], [world.repo, 'worktree'], 'session B');
    equal([b.agents.length, b.sources.length], [1, 1], 'session B: its symlinked subagents directory is not followed');
    const c = digestOf(world, 'c');
    equal([c.project, c.project_via], [world.repo, 'worktree-sibling'], 'session C');
    equal([c.agents[1].agent_id, c.agents[1].agent_type, c.agents[1].anomalies], ['c1', null, { bad_meta: 1 }], 'a meta file that is not an object');
    equal([digestOf(world, 'd').project, digestOf(world, 'd').project_via], [null, null], 'session D');
  }],
  ['extract: a second run reuses every digest', async (world) => {
    const doc = await extractRun(world);
    equal(doc.sessions, { ...SESSION_COUNTS, mapped: 3, reused: 4, seen: 4, unmapped: 1 }, 'sessions');
    equal(doc.subagents.parsed, 0, 'no subagent read');
    equal(doc.malformed_lines, 2, 'malformed lines still reported');
  }],
  ['extract: a reused digest whose project changed is remapped, not parsed', async (world) => {
    const before = digestOf(world, 'd');
    fs.mkdirSync(path.join(world.ws, 'scratch', 'claudedocs', 'tickets'), { recursive: true });
    const doc = await extractRun(world);
    equal(doc.sessions, { ...SESSION_COUNTS, mapped: 4, remapped: 1, reused: 4, seen: 4 }, 'sessions');
    equal(doc.subagents.parsed, 0, 'no subagent read');
    const after = digestOf(world, 'd');
    equal([after.project, after.project_via], [path.join(world.ws, 'scratch'), 'cwd'], 'session D remapped');
    equal({ ...after, project: null, project_via: null }, before, 'only the project fields rewritten');
  }],
  ['extract: a grown transcript is parsed again', async (world) => {
    const line = { cwd: path.join(world.ws, 'repo-worktrees', 'wt'), message: { id: 'msg_b2', model: 'claude-opus-test', stop_reason: 'end_turn', usage: { input_tokens: 5 } }, timestamp: '2026-11-12T11:00:20.000Z', type: 'assistant' };
    fs.appendFileSync(path.join(world.store, transcriptOf('b')), `${JSON.stringify(line)}\n`);
    const doc = await extractRun(world);
    equal([doc.sessions.parsed, doc.sessions.reused], [1, 3], 'parsed and reused');
    equal([digestOf(world, 'b').agents[0].turns, digestOf(world, 'b').tokens.input], [2, 6], 'session B re-read');
  }],
  ['extract: a schema change or a corrupt digest is parsed again', async (world) => {
    const file = digestFile(world, 'c');
    fs.writeFileSync(file, render({ ...JSON.parse(fs.readFileSync(file, 'utf8')), schema_version: SCHEMA_VERSION + 1 }));
    const changed = await extractRun(world);
    equal([changed.sessions.parsed, changed.sessions.reused], [1, 3], 'schema change');
    equal(digestOf(world, 'c').schema_version, SCHEMA_VERSION, 'session C rewritten');
    fs.writeFileSync(digestFile(world, 'b'), '{"not": "a digest"');
    const corrupt = await extractRun(world);
    equal([corrupt.sessions.cache_corrupt, corrupt.sessions.parsed, corrupt.sessions.reused], [1, 1, 3], 'corrupt digest');
  }],
  ['extract: a session missing a subagent file keeps its digest unchanged, under a schema change too', async (world) => {
    const file = digestFile(world, 'a');
    fs.writeFileSync(file, render({ ...JSON.parse(fs.readFileSync(file, 'utf8')), schema_version: SCHEMA_VERSION + 1 }));
    const before = fs.readFileSync(file, 'utf8');
    fs.rmSync(path.join(world.store, SESSIONS.a.slug, SESSIONS.a.id, 'subagents', 'agent-a1.jsonl'));
    const doc = await extractRun(world);
    equal([doc.sessions.kept_stale, doc.sessions.parsed, doc.sessions.reused], [1, 0, 3], 'kept stale');
    equal(fs.readFileSync(digestFile(world, 'a'), 'utf8'), before, 'session A digest bytes');
  }],
  ['extract: a digest whose transcript is gone is kept', async (world) => {
    fs.rmSync(path.join(world.store, transcriptOf('d')));
    const doc = await extractRun(world);
    equal([doc.sessions.seen, doc.sessions.kept_without_transcript, doc.sessions.unmapped], [3, 1, 0], 'kept without transcript');
    assert(fs.existsSync(digestFile(world, 'd')), 'session D digest still present');
  }],
];

/** Run every case; return the document, or throw a ComputeError naming the first failure. */
export async function runSelfTest() {
  let world = null;
  try {
    world = makeWorld();
    for (const [name, fn] of CASES) {
      try {
        await fn(world);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new ComputeError(`self-test: ${name} — ${detail}`);
      }
    }
  } finally {
    if (world !== null) {
      fs.rmSync(world.dir, { force: true, recursive: true });
    }
  }
  return { cases: CASES.length, ok: true };
}
