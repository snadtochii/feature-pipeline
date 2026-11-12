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
import { FIXTURES_DIR as FIXTURES, SENTINEL, copyFixtures } from './fixtures.mjs';
import { makeMapper, mapProject } from './project.mjs';
import {
  UNATTRIBUTED_MARK,
  closeResultOf,
  findTicket,
  isCheckRun,
  roleOf,
  rootStageOf,
  slashBuildTicket,
  validCloseResult,
  validRole,
  validStage,
  validTicket,
} from './recognize.mjs';
import { sessionTotals, ticketRuns } from './runs.mjs';
import { consumeLine, finishAgent, newAgent, readTranscript } from './transcript.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'insights.mjs');

const SESSIONS = {
  a: { id: '0a0a0a0a-0000-4000-8000-00000000000a', slug: '-ROOT-repo' },
  b: { id: '0b0b0b0b-0000-4000-8000-00000000000b', slug: '-ROOT-repo-worktrees-wt' },
  c: { id: '0c0c0c0c-0000-4000-8000-00000000000c', slug: '-ROOT-repo-worktrees-gone' },
  d: { id: '0d0d0d0d-0000-4000-8000-00000000000d', slug: '-ROOT-scratch' },
  e: { id: '0f0f0f0f-0000-4000-8000-00000000000f', slug: '-ROOT-pipeline' },
  f: { id: '1a1a1a1a-0000-4000-8000-00000000001a', slug: '-ROOT-pipeline' },
};

const LINKED_SESSION_ID = '0e0e0e0e-0000-4000-8000-00000000000e';

const transcriptOf = (key) => `${SESSIONS[key].slug}/${SESSIONS[key].id}.jsonl`;

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
  fs.mkdirSync(path.join(ws, 'pipeline', 'claudedocs', 'tickets'), { recursive: true });
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

/** Weighted units are float sums; each must be within 1e-9 of its hand-computed value. */
function near(actual, expected, label) {
  equal(actual.length, expected.length, `${label}: count`);
  actual.forEach((value, index) => assert(Math.abs(value - expected[index]) < 1e-9, `${label}: ${value} is not ${expected[index]}`));
}

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
  ['recognize: roles from the type, refined by description for general-purpose only', () => {
    equal(roleOf('general-purpose', `Build stage for FP-7 ${SENTINEL}`), 'build-stage', 'build stage');
    equal(roleOf('general-purpose', `${SENTINEL} review stage`), 'review-stage', 'one-word review stage');
    equal(roleOf('general-purpose', `FP-8 ${SENTINEL} implementer via flow`), 'ship-implementer', 'end-anchored');
    equal(roleOf('general-purpose', `FP-8 implementer via flow ${SENTINEL}`), 'general-purpose (other)', 'end anchor holds');
    equal(roleOf('general-purpose', 42), 'general-purpose (other)', 'a non-string description');
    equal(roleOf('feature:code-reviewer', 'Build stage for FP-7'), 'feature:code-reviewer', 'a typed agent keeps its type');
    equal(roleOf(null, 'x'), null, 'no type');
  }],
  ['recognize: tickets skip standards names and the sentinel', () => {
    equal(findTicket(`normalise to UTF-8, SHA-256 then FP-8 ${SENTINEL}`), 'FP-8', 'standards skipped');
    equal(findTicket(SENTINEL), null, 'the sentinel is no ticket');
    equal(findTicket(undefined), null, 'no text');
  }],
  ['recognize: the slash-build rule reads string content only', () => {
    const slash = (args) => `<command-name>/feature:build</command-name>\n<command-args>${args}</command-args>`;
    equal(slashBuildTicket(slash(`FP-9 ${SENTINEL}`)), 'FP-9', 'string content');
    equal(slashBuildTicket(slash(SENTINEL)), UNATTRIBUTED_MARK, 'ticket-less');
    equal(slashBuildTicket([{ text: slash('FP-9'), type: 'text' }]), null, 'array content');
    equal(slashBuildTicket('<command-name>/feature:plan</command-name>'), null, 'another command');
    const sticky = newAgent('root', null);
    const line = (args) => ({ message: { content: slash(args) }, timestamp: at(0), type: 'user' });
    consumeLine(sticky, JSON.stringify(line(SENTINEL)));
    consumeLine(sticky, JSON.stringify(line('FP-9')));
    equal(sticky.slashBuild, UNATTRIBUTED_MARK, 'the first match sticks, ticket-less too');
    equal(rootStageOf(UNATTRIBUTED_MARK, [{ ids: [], name: '/feature:build' }, { ids: [], name: 'feature:close-stage' }]), 'close', 'a ticket-less slash build is no implement stage');
    equal(rootStageOf('FP-9', []), 'implement', 'a ticketed slash build');
    equal(rootStageOf(null, [{ ids: [], name: '/feature:flow' }]), null, 'no stage command');
  }],
  ['recognize: check runs strip heredoc bodies and skip read-only leading words', () => {
    equal(isCheckRun('head -8 scripts/check-tool-parity.sh'), false, 'a read of a check script');
    equal(isCheckRun('D=/tmp node x.mjs --self-test'), true, 'an assignment before the command');
    equal(isCheckRun(`cat > f <<'EOF'\nnode ${SENTINEL}\nnpm run lint\nEOF`), false, 'checks inside a heredoc body');
    equal(isCheckRun(`cat > f <<'EOF'\nbody\nEOF\nbash scripts/check-mode-split.sh`), true, 'a check after a heredoc');
    equal(isCheckRun('cat <<EOF\nnpm test'), true, 'an unterminated heredoc is not stripped');
    equal(isCheckRun('grep -n vitest x && ls'), false, 'only read-only segments');
    equal(isCheckRun(42), false, 'no command');
  }],
  ['recognize: the close result line, last match wins', () => {
    equal(closeResultOf(`PAUSED: ${SENTINEL}\nclose: caller — verdict partial\nclose: done — verdict pass \r\n/abs`), { ending: 'done', verdict: 'pass' }, 'last match, trailing space and CR');
    equal(closeResultOf('close: done - verdict stuck'), { ending: 'done', verdict: 'stuck' }, 'ASCII dash');
    equal(closeResultOf('close: merged — verdict pass'), { ending: 'merged', verdict: null }, 'a verdict-less ending drops its verdict');
    equal(closeResultOf('close: error'), { ending: 'error', verdict: null }, 'error');
    for (const text of ['close: shipped — verdict pass', '`close: done — verdict pass`', 'see close: done — verdict pass', 'close: done — verdict great', 42]) {
      equal(closeResultOf(text), null, `no close line in ${JSON.stringify(text)}`);
    }
  }],
  ['recognize: stored values are drawn from closed vocabularies', () => {
    equal([validRole('close-stage', null), validRole('feature:x', 'feature:x'), validRole('feature:x', 'feature:y'), validRole(SENTINEL, null)], ['close-stage', 'feature:x', null, null], 'roles');
    equal([validTicket('FP-7'), validTicket(`FP-${'9'.repeat(40)}`), validTicket('fp-7'), validTicket(SENTINEL)], ['FP-7', null, null, null], 'tickets');
    equal([validStage('implement'), validStage('build')], ['implement', null], 'stages');
    equal(
      [validCloseResult({ ending: 'done', verdict: 'pass' }), validCloseResult({ ending: 'done', verdict: null }), validCloseResult({ ending: 'merged', verdict: 'pass' }), validCloseResult({ ending: SENTINEL, verdict: null })],
      [{ ending: 'done', verdict: 'pass' }, null, null, null],
      'close results',
    );
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
    equal(doc.sessions, { ...SESSION_COUNTS, mapped: 5, parsed: 6, seen: 6, unmapped: 1 }, 'sessions');
    equal(doc.subagents, { orphan_jsonl: 1, orphan_meta: 1, parsed: 21 }, 'subagents');
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
  ['extract: each agent carries its role, ticket, stage, close result and check runs', (world) => {
    const recognitionOf = (key) =>
      Object.fromEntries(digestOf(world, key).agents.map((agent) => [agent.agent_id, [agent.role, agent.ticket, agent.stage, agent.close_result]]).sort(([a], [b]) => (a < b ? -1 : 1)));
    const a = digestOf(world, 'a');
    equal(recognitionOf('a'), { a1: ['feature:code-reviewer', 'FP-7', 'implement', null], a2: [null, null, null, null], root: ['root-session', 'FP-7', 'implement', null] }, 'session A');
    equal(a.schema_version, SCHEMA_VERSION, 'schema version');
    equal(recognitionOf('e'), {
      e1: ['plan-stage', 'FP-7', 'plan', null],
      e10: ['ship-implementer', 'FP-8', 'implement', null],
      e11: ['claude', 'FP-9', 'implement', null],
      e2: ['feature:code-explorer', 'FP-7', 'plan', null],
      e3: ['feature:requirements-analyst', 'FP-7', 'plan', null],
      e4: ['build-stage', 'FP-7', 'implement', null],
      e5: ['general-purpose (other)', 'FP-7', 'implement', null],
      e6: ['review-stage', 'FP-7', 'review', null],
      e7: ['feature:code-reviewer', 'FP-7', 'review', null],
      e8: ['close-stage', 'FP-7', 'close', { ending: 'caller', verdict: 'pass' }],
      e9: ['feature:finalizer', 'FP-7', 'close', null],
      root: ['root-session', 'FP-9', 'implement', null],
    }, 'session E: relayed close lines and a non-close agent\'s close line do not count');
    equal(recognitionOf('f'), {
      f1: ['close-stage', 'FP-7', 'close', { ending: 'continue-with-hint', verdict: 'partial' }],
      f2: ['review-stage', 'FP-7', 'review', null],
      f3: ['close-stage', 'FP-7', 'close', { ending: 'done', verdict: 'pass' }],
      f4: ['finalize-child', 'FP-7', 'close', null],
      f5: ['ship-review', 'FP-8', null, null],
      f6: ['ship-address', 'FP-8', null, null],
      f7: ['close-stage', null, 'close', null],
      root: ['root-session', null, null, null],
    }, 'session F: an array-content slash build attributes nothing; every standard prefix is skipped');
    const e = digestOf(world, 'e');
    const root = e.agents[0];
    equal(root.check_runs, { failed: 1, total: 4 }, 'root check runs: the streamed repeat once, the rejection not failed, the background run unpaired');
    equal([root.friction.rejections, root.friction.tool_errors], [1, 1], 'root friction');
    assert(e.agents.slice(1).every((agent) => agent.check_runs.total === 0), 'no check runs in the subagents');
    for (const digest of loadDigests(world.cacheRoot)) {
      for (const agent of digest.agents) {
        assert(!('description' in agent), `a description was kept for ${digest.transcript} ${agent.agent_id}`);
      }
    }
    equal(e.anomalies, {}, 'no bad_recognition');
  }],
  ['runs: per-session ticket and role totals with measure-session.py weights', (world) => {
    const e = digestOf(world, 'e');
    const tickets = sessionTotals(e, 'ticket');
    equal(tickets.map((bucket) => [bucket.ticket, bucket.count, bucket.turns]), [['FP-7', 9, 10], ['FP-9', 2, 8], ['FP-8', 1, 1]], 'tickets in weighted order');
    const fp7 = tickets[0];
    equal([fp7.input_tokens, fp7.cache_write_tokens, fp7.cache_read_tokens, fp7.output_tokens], [540, 108, 5400, 54], 'FP-7 token sums');
    near(tickets.map((bucket) => bucket.weighted_units), [1485, 522.5, 302.5], 'ticket units');
    const roles = sessionTotals(e, 'role');
    equal(roles.length, 12, 'one role per agent');
    near([roles.find((bucket) => bucket.role === 'close-stage').weighted_units], [247.5], 'close-stage units');
    equal(sessionTotals(digestOf(world, 'f'), 'ticket').map((bucket) => bucket.ticket), ['FP-7', 'FP-8', 'unattributed'], 'a null ticket is unattributed');
  }],
  ['runs: a ticket across sessions is one ticket, its stages and close results in start order', (world) => {
    const project = path.join(world.ws, 'pipeline');
    const runs = ticketRuns(loadDigests(world.cacheRoot));
    equal(runs.without_recognition, 0, 'every digest recognized');
    const ofProject = runs.tickets.filter((run) => run.project === project);
    equal(ofProject.map((run) => run.ticket), ['FP-7', 'FP-8', 'FP-9'], 'tickets of the project');
    const [fp7, fp8, fp9] = ofProject;
    equal(fp7.sessions.map((session) => session.session_id), [SESSIONS.e.id, SESSIONS.f.id], 'FP-7 sessions');
    near([fp7.weighted_units, ...fp7.sessions.map((session) => session.weighted_units)], [1760, 1485, 275], 'FP-7 units');
    equal(fp7.close_results.map((item) => [item.session_id, item.agent_id, item.close_result]), [
      [SESSIONS.e.id, 'e8', { ending: 'caller', verdict: 'pass' }],
      [SESSIONS.f.id, 'f1', { ending: 'continue-with-hint', verdict: 'partial' }],
      [SESSIONS.f.id, 'f3', { ending: 'done', verdict: 'pass' }],
    ], 'close results');
    const stagesE = fp7.sessions[0].stages;
    equal(stagesE.map((stage) => [stage.agent_id, stage.stage, stage.feature_versions]), [
      ['e1', 'plan', ['3.41.2']],
      ['e4', 'implement', ['3.41.1']],
      ['e6', 'review', ['3.41.1']],
      ['e8', 'close', ['3.41.2']],
    ], 'session E stages: own versions, else the nearest ancestor\'s');
    near(stagesE.map((stage) => stage.weighted_units), [247.5, 302.5, 412.5, 522.5], 'stage units: head plus its unstaged descendants');
    equal(stagesE[0].models, ['claude-opus-test', 'claude-sonnet-test'], 'plan stage models');
    equal([stagesE[0].start, stagesE[0].end, stagesE[0].duration_ms], ['2026-11-12T12:01:00.000Z', '2026-11-12T12:01:50.000Z', 50_000], 'plan stage span');
    equal(fp7.sessions[1].stages.map((stage) => [stage.agent_id, stage.stage, stage.feature_versions]), [
      ['f1', 'close', ['3.41.2']],
      ['f2', 'review', ['3.41.2']],
      ['f3', 'close', ['3.41.2']],
    ], 'session F stages: the session\'s versions when no ancestor has one');
    equal(fp8.sessions[0].stages, [], 'a ship implementer is no stage head');
    const [implement] = fp9.sessions[0].stages;
    equal([implement.agent_id, implement.end, implement.duration_ms, implement.check_runs], ['root', '2026-11-12T12:01:00.000Z', 60_000, { failed: 1, total: 4 }], 'a slash-build root ends where its first stage child starts');
    near([implement.weighted_units, fp9.weighted_units], [522.5, 522.5], 'root implement subtree holds only FP-9 agents, not the FP-8 implementer under it');
    equal(Object.keys(fp9.by_role), ['claude', 'root-session'], 'FP-9 roles');
    near([fp9.by_role.claude, fp9.by_role['root-session']], [330, 192.5], 'FP-9 units by role');
  }],
  ['extract: a second run reuses every digest', async (world) => {
    const doc = await extractRun(world);
    equal(doc.sessions, { ...SESSION_COUNTS, mapped: 5, reused: 6, seen: 6, unmapped: 1 }, 'sessions');
    equal(doc.subagents.parsed, 0, 'no subagent read');
    equal(doc.malformed_lines, 2, 'malformed lines still reported');
  }],
  ['extract: a reused digest whose project changed is remapped, not parsed', async (world) => {
    const before = digestOf(world, 'd');
    fs.mkdirSync(path.join(world.ws, 'scratch', 'claudedocs', 'tickets'), { recursive: true });
    const doc = await extractRun(world);
    equal(doc.sessions, { ...SESSION_COUNTS, mapped: 6, remapped: 1, reused: 6, seen: 6 }, 'sessions');
    equal(doc.subagents.parsed, 0, 'no subagent read');
    const after = digestOf(world, 'd');
    equal([after.project, after.project_via], [path.join(world.ws, 'scratch'), 'cwd'], 'session D remapped');
    equal({ ...after, project: null, project_via: null }, before, 'only the project fields rewritten');
  }],
  ['extract: a grown transcript is parsed again', async (world) => {
    const line = { cwd: path.join(world.ws, 'repo-worktrees', 'wt'), message: { id: 'msg_b2', model: 'claude-opus-test', stop_reason: 'end_turn', usage: { input_tokens: 5 } }, timestamp: '2026-11-12T11:00:20.000Z', type: 'assistant' };
    fs.appendFileSync(path.join(world.store, transcriptOf('b')), `${JSON.stringify(line)}\n`);
    const doc = await extractRun(world);
    equal([doc.sessions.parsed, doc.sessions.reused], [1, 5], 'parsed and reused');
    equal([digestOf(world, 'b').agents[0].turns, digestOf(world, 'b').tokens.input], [2, 6], 'session B re-read');
  }],
  ['extract: a schema change or a corrupt digest is parsed again', async (world) => {
    const file = digestFile(world, 'c');
    fs.writeFileSync(file, render({ ...JSON.parse(fs.readFileSync(file, 'utf8')), schema_version: SCHEMA_VERSION - 1 }));
    const changed = await extractRun(world);
    equal([changed.sessions.parsed, changed.sessions.reused], [1, 5], 'schema change');
    equal(digestOf(world, 'c').schema_version, SCHEMA_VERSION, 'session C rewritten');
    fs.writeFileSync(digestFile(world, 'b'), '{"not": "a digest"');
    const corrupt = await extractRun(world);
    equal([corrupt.sessions.cache_corrupt, corrupt.sessions.parsed, corrupt.sessions.reused], [1, 1, 5], 'corrupt digest');
  }],
  ['extract: a session missing a subagent file keeps its digest unchanged, under a schema change too', async (world) => {
    const file = digestFile(world, 'a');
    fs.writeFileSync(file, render({ ...JSON.parse(fs.readFileSync(file, 'utf8')), schema_version: SCHEMA_VERSION - 1 }));
    const before = fs.readFileSync(file, 'utf8');
    fs.rmSync(path.join(world.store, SESSIONS.a.slug, SESSIONS.a.id, 'subagents', 'agent-a1.jsonl'));
    const doc = await extractRun(world);
    equal([doc.sessions.kept_stale, doc.sessions.parsed, doc.sessions.reused], [1, 0, 5], 'kept stale');
    equal(fs.readFileSync(digestFile(world, 'a'), 'utf8'), before, 'session A digest bytes');
    equal(ticketRuns(loadDigests(world.cacheRoot)).without_recognition, 1, 'the kept-stale older-schema digest is counted, never read');
  }],
  ['extract: a digest whose transcript is gone is kept', async (world) => {
    fs.rmSync(path.join(world.store, transcriptOf('d')));
    const doc = await extractRun(world);
    equal([doc.sessions.seen, doc.sessions.kept_without_transcript, doc.sessions.unmapped], [5, 1, 0], 'kept without transcript');
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
