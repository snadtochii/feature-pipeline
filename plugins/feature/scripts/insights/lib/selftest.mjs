// The insights extractor's self-test (../CONTRACT.md §10).
//
// Every case is `[name, fn(world)]`. The world is built once per run under a
// realpath temporary directory: the committed synthetic transcript fixtures
// copied into a redirected HOME's transcript store, the ticket-tree fixtures
// copied into the projects' `claudedocs/tickets/`, and the project tree, a
// git repository with a linked worktree, a scratch directory and the entries
// the scans must skip materialized beside them. The rules are exercised
// in-process; the verb end to end as a child process with a minimal
// environment. The `extract` cases run in order over the same world. Every
// child run is checked for the fixtures' sentinel in its output, for an
// unchanged store and ticket trees, and for the cache's modes and contents.
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
import { FIXTURES_DIR as FIXTURES, SENTINEL, copyFixtures, copyTicketFixtures } from './fixtures.mjs';
import { joinOutcomes, ticketDataset } from './outcomes.mjs';
import { makeMapper, mapProject } from './project.mjs';
import {
  UNATTRIBUTED_MARK,
  closeResultOf,
  commandTicketOf,
  findTicket,
  isCheckRun,
  recognizeSession,
  roleOf,
  rootStageOf,
  slashBuildTicket,
  validCloseResult,
  validRole,
  validStage,
  validTicket,
} from './recognize.mjs';
import { sessionTotals, ticketRuns } from './runs.mjs';
import { classifyReview, classifySummary, classifyTests, kindOf, parseFrontmatter, readTicketTree, storageModeOf } from './tickets.mjs';
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

const ticketListings = (world) => Object.values(world.tickets).map((dir) => listing(dir));

/** One `extract` run: exit 0, the store and the ticket trees untouched, the cache well formed. Returns the summary. */
async function extractRun(world) {
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

const NO_DECISIONS = { accepted: 0, deferred: 0, dismissed: 0 };
const NO_OUTCOMES = { applied: 0, fix_failed: 0, not_attempted: 0 };
const NO_TESTS = { by: null, cause: null, failed_criteria: null, result: null };

/** A tree record as `readTicketTree` returns it, for the in-memory join cases. */
function treeRecord(ticket, overrides = {}) {
  return {
    complexity: 'M', created: '2026-11-01', epic_folder: null, kind: 'solo', parent: null, review: null, state: 'done', status: 'done', summary: null, summary_mtime: null, tests: null, ticket, unrecognized: [],
    ...overrides,
  };
}

function runOf(project, ticket, closeVerdicts = [], versions = []) {
  return {
    by_role: { 'root-session': 1 },
    close_results: closeVerdicts.map((verdict, index) => ({ agent_id: `c${index}`, close_result: verdict === undefined ? null : { ending: 'caller', verdict }, session_id: 's' })),
    project,
    sessions: [{ end: null, session_id: 's', stages: versions.map((feature_versions) => ({ feature_versions })), start: null, transcript: 'x/s.jsonl', weighted_units: 1 }],
    ticket,
    weighted_units: 1,
  };
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
    equal([findTicket('\u00e9FP-12'), findTicket('FP-12\u00e9'), findTicket('_FP-12'), findTicket('(FP-12).')], [null, null, null, 'FP-12'], 'word boundaries are Unicode-aware, as in Python');
    equal(findTicket('FP-\u0661\u0662 then FP-3'), 'FP-\u0661\u0662', 'any decimal digit, as in Python');
    equal(validTicket(findTicket('FP-\u0661\u0662')), null, 'a ticket with non-ASCII digits fails its vocabulary');
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
    equal(closeResultOf('close: already-complete'), { ending: 'already-complete', verdict: null }, 'already-complete without a verdict');
    equal(closeResultOf('close: already-complete — verdict stuck'), { ending: 'already-complete', verdict: 'stuck' }, 'already-complete with a verdict');
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
    equal(
      [validCloseResult({ ending: 'already-complete', verdict: null }), validCloseResult({ ending: 'already-complete', verdict: 'partial' }), validCloseResult({ ending: 'already-complete', verdict: SENTINEL })],
      [{ ending: 'already-complete', verdict: null }, { ending: 'already-complete', verdict: 'partial' }, null],
      'already-complete carries a verdict or none',
    );
  }],
  ['recognize: a root stage command gives the run ticket, never measure-session.py\'s ticket', () => {
    equal(commandTicketOf([{ ids: ['FP-1'], name: '/feature:build' }, { ids: ['UTF-8', 'FP-5'], name: '/feature:close-stage' }, { ids: ['FP-6'], name: 'feature:flow' }]), 'FP-5', 'the first stage or flow command carrying a ticket');
    equal([commandTicketOf([{ ids: [], name: 'feature:plan' }, { ids: ['FP-6'], name: 'feature:flow' }]), commandTicketOf([{ ids: ['FP-1'], name: 'feature:ship' }])], ['FP-6', null], 'an ID-less command is passed over; other commands give none');
    const commands = [{ ids: ['FP-5'], name: '/feature:close-stage' }];
    const tokens = (input, output) => ({ cache_read: 0, cache_write: 0, input, output });
    const agent = (agentId, agentType, start, input, output) => ({
      agent_id: agentId, agent_type: agentType, anomalies: {}, check_runs: { failed: 0, total: 0 }, end: at(start + 5), feature_versions: [], models: [], parent_agent_id: null, start: at(start), tokens: tokens(input, output), turns: 1,
    });
    const signal = (role, ownTicket, extra = {}) => ({ closeResult: null, commandTicket: null, ownTicket, role, rootStage: null, slashBuild: null, walks: true, ...extra });
    const agents = recognizeSession(
      [agent('root', null, 0, 10, 2), agent('fin', 'general-purpose', 10, 4, 1), agent('ui', 'feature:ui-tester', 20, 2, 0)],
      [
        signal('root-session', null, { closeResult: closeResultOf('close: done — verdict pass'), commandTicket: commandTicketOf(commands), rootStage: rootStageOf(null, commands) }),
        signal(roleOf('general-purpose', 'Finalize FP-5'), findTicket('Finalize FP-5')),
        signal('feature:ui-tester', null),
      ],
    );
    equal(agents.map((item) => [item.agent_id, item.ticket, item.run_ticket, item.stage, item.close_result]), [
      ['root', null, 'FP-5', 'close', { ending: 'done', verdict: 'pass' }],
      ['fin', 'FP-5', 'FP-5', 'close', null],
      ['ui', null, 'FP-5', 'close', null],
    ], 'the root keeps measure-session.py\'s null ticket; the run ticket reaches every agent');
    assert(agents.every((item) => Object.keys(item.anomalies).length === 0), 'no bad_recognition');
    const digest = { agents, feature_versions: [], project: '/p', schema_version: SCHEMA_VERSION, session_id: 's', transcript: 'x/s.jsonl' };
    equal(sessionTotals(digest, 'ticket').map((bucket) => [bucket.ticket, bucket.count]), [['unattributed', 2], ['FP-5', 1]], 'per-session ticket totals follow measure-session.py');
    const [run] = ticketRuns([digest]).tickets;
    equal([run.ticket, run.sessions[0].stages.map((stage) => [stage.agent_id, stage.stage])], ['FP-5', [['root', 'close']]], 'the root is the ticket\'s close stage head');
    equal(run.close_results, [{ agent_id: 'root', close_result: { ending: 'done', verdict: 'pass' }, session_id: 's' }], 'the close result is the ticket\'s');
    near([run.weighted_units, run.sessions[0].stages[0].weighted_units, run.by_role['root-session']], [31, 31, 20], 'the run ticket\'s units hold the whole session');
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
  ['tickets: frontmatter fields checked against their vocabularies, the first block only', () => {
    const fm = (...lines) => parseFrontmatter(`---\n${lines.join('\n')}\n---\n${SENTINEL}\n`);
    const blank = { complexity: null, created: null, kind: null, parent: null, status: null };
    equal(
      fm('id: FP-1', `title: ${SENTINEL}`, 'kind: epic   # comment', 'complexity: XL', 'status: partial-completion', 'created: 2026-11-01', 'parent: FP-2'),
      { complexity: 'XL', created: '2026-11-01', kind: 'epic', parent: 'FP-2', status: 'partial-completion', unrecognized: false },
      'every field',
    );
    equal(fm('status: done'), { ...blank, status: 'done', unrecognized: false }, 'optional keys absent');
    equal(fm('complexity: M'), { ...blank, complexity: 'M', unrecognized: true }, 'a missing status');
    equal(fm('status: done', 'status: done', 'complexity: M'), { ...blank, complexity: 'M', unrecognized: true }, 'a repeated key');
    const bad = [['complexity: XXL', 'complexity'], ['kind: story', 'kind'], [`parent: ${SENTINEL}`, 'parent'], ['created: 2026-1-1', 'created'], ['parent:', 'parent'], [`parent: FP-${'1'.repeat(38)}`, 'parent']];
    for (const [line, field] of bad) {
      const record = fm('status: done', line);
      equal([record[field], record.status, record.unrecognized], [null, 'done', true], `a ${field} outside its vocabulary`);
    }
    equal(fm('status: shipped'), { ...blank, unrecognized: true }, 'a status outside its vocabulary');
    equal(parseFrontmatter('﻿---\r\nstatus: done\r\n---\r\n---\nstatus: cancelled\n---\n').status, 'done', 'BOM and CRLF, the first block only');
    for (const text of [`${SENTINEL}\n---\nstatus: done\n---\n`, '---\nstatus: done\n', '', null]) {
      equal(parseFrontmatter(text), { ...blank, unrecognized: true }, `no block in ${JSON.stringify(text?.slice(0, 3))}`);
    }
    equal(
      [kindOf(fm('status: done'), true), kindOf(fm('status: done', 'kind: epic'), false), kindOf(fm('status: done', 'parent: FP-2'), false), kindOf(fm('status: done'), false)],
      ['epic', 'epic', 'child', 'solo'],
      'kinds',
    );
  }],
  ['tickets: 04-review.md labels match exactly, decisions and outcomes count on their leading token', () => {
    const review = (first, ...body) => classifyReview([first, 'fix-step: complete', ...body].join('\n'));
    const labels = [
      ['verdict: skipped (trivial diff)', 'skipped-trivial', null],
      ['verdict: skipped (no changes)', 'skipped-no-changes', null],
      ['verdict: reviewed  ', 'reviewed', null],
      ['verdict: reviewed (partial — 2/4 reviewers)', 'reviewed-partial', 2],
      ['verdict: failed (all reviewers)', 'failed-all', null],
      [`verdict: stuck (${SENTINEL})`, 'stuck', null],
    ];
    labels.forEach(([line, label, reviewersOk], index) => {
      const record = review(line);
      equal([record.label, record.reviewers_ok, record.fix_step, record.unrecognized], [label, reviewersOk, 'complete', false], `label ${index}`);
    });
    const drift = ['verdict: reviewed — 8 applied', 'verdict: skipped (trivial diff — by intent)', 'verdict: pass', '# Review', 'reviewed', 'verdict: reviewed (partial — 4/4 reviewers)', 'verdict: stuck ()', ''];
    drift.forEach((line, index) => equal([review(line).label, review(line).unrecognized], [null, true], `drift label ${index}`));
    const counted = review(
      'verdict: reviewed',
      '- decision: accepted — x',
      '  - decision: accepted',
      '\t- decision: dismissed — y',
      '  - decision: deferred (conflict) — z',
      '  - outcome: applied (touches w)',
      '  - outcome: fix-failed — e',
      '  - outcome: not attempted',
      `${SENTINEL} decision: the prose`,
      'decision: accepted',
    );
    equal(
      [counted.decisions, counted.outcomes, counted.unrecognized],
      [{ accepted: 2, deferred: 1, dismissed: 1 }, { applied: 1, fix_failed: 1, not_attempted: 1 }, false],
      'indented and unindented marked lines, trailing text, unmarked prose',
    );
    const unknown = review('verdict: reviewed', '  - outcome: applied', `  - decision: ${SENTINEL}`, '  - outcome: appliedx');
    equal([unknown.label, unknown.outcomes, unknown.unrecognized], ['reviewed', { ...NO_OUTCOMES, applied: 1 }, true], 'an unknown token');
    equal(classifyReview('verdict: reviewed\nfix-step: halfway\n').fix_step, null, 'the fix-step vocabulary');
    equal(
      classifyReview(null),
      { decisions: NO_DECISIONS, fix_step: null, label: null, outcomes: NO_OUTCOMES, present: false, reviewers_ok: null, unrecognized: false },
      'an absent file',
    );
  }],
  ['tickets: 05-tests.md skipped with its cause, ran by ship or close, absent, or unrecognized', () => {
    const causes = [
      ['no UI work in plan', 'no-ui-work'],
      ['UI testing disabled by --no-ui-testing', 'no-ui-testing-flag'],
      ['no testable repo in ticket', 'no-testable-repo'],
      ['app unreachable', 'app-unreachable'],
      ['browser driver unavailable', 'driver-unavailable'],
    ];
    for (const [cause, token] of causes) {
      equal(classifyTests(`verdict: skipped (${cause})\r\n\n${SENTINEL}\n`), { ...NO_TESTS, cause: token, state: 'skipped', unrecognized: false }, cause);
    }
    equal(
      classifyTests(`Source: ship end-of-run UI verification — branch ${SENTINEL} @ abc\nverdict: pass\n`),
      { ...NO_TESTS, by: 'ship', result: 'pass', state: 'ran', unrecognized: false },
      'the ship pass',
    );
    equal(classifyTests(`# Tests ${SENTINEL}\n\n## Pass: repo\n\n## Screenshots\n`), { ...NO_TESTS, by: 'close', failed_criteria: false, state: 'ran', unrecognized: false }, 'a close pass');
    equal(classifyTests(`# Tests\n\n## Failed Criteria\n\n## Screenshots\n`).failed_criteria, true, 'a close pass with failed criteria');
    equal(classifyTests(null), { ...NO_TESTS, state: 'absent', unrecognized: false }, 'an absent file');
    const drift = [
      '# Tests\n\nverdict: skipped (--no-ui-testing)\n',
      'verdict: passed (all criteria)\n## Pass: repo\n',
      `verdict: skipped (no app surface — ${SENTINEL})\n`,
      'verdict: skipped (no UI signals)\n',
      'Source: ship end-of-run UI verification — x\nverdict: fail\n',
      '# Tests\n\n### Pass: repo\n',
      '',
    ];
    drift.forEach((text, index) => equal([classifyTests(text).state, classifyTests(text).unrecognized], [null, true], `drift form ${index}`));
  }],
  ['tickets: 06-summary.md verdict, the last column-0 pr: line and branch presence', () => {
    equal(
      classifySummary(`verdict: pass\n\n${SENTINEL}\npr: https://github.com/o/r/pull/1\npr: https://github.com/own-er/re.po_x/pull/42  \nbranch: feature/FP-1-${SENTINEL}\n`),
      { has_branch: true, pr: { number: 42, repo: 'own-er/re.po_x' }, present: true, unrecognized: false, verdict: 'pass' },
      'the last pr: wins',
    );
    equal(classifySummary(`verdict: partial\npr: none — ${SENTINEL}\n`), { has_branch: false, pr: 'none', present: true, unrecognized: false, verdict: 'partial' }, 'pr: none');
    equal(classifySummary(`verdict: stuck\npr: https://github.com/o/r/pull/12\n${SENTINEL}\n`).pr, { number: 12, repo: 'o/r' }, 'pr: on line 2');
    const badPr = ['pr: https://github.com/o/r/pull/7x', 'pr: https://gitlab.com/o/r/pull/7', `pr: ${SENTINEL}`, 'pr: https://github.com/o/r/pull/0', 'pr:'];
    badPr.forEach((line, index) => {
      const record = classifySummary(`verdict: pass\n${line}\n`);
      equal([record.pr, record.verdict, record.unrecognized], [null, 'pass', true], `pr form ${index}`);
    });
    equal(classifySummary('verdict: pass\n  pr: https://github.com/o/r/pull/1\nbranch:\n'), { has_branch: false, pr: null, present: true, unrecognized: false, verdict: 'pass' }, 'column 0 only, a branch needs a value');
    [`# Summary ${SENTINEL}\n\nverdict: pass\n`, 'verdict: passed\n', ''].forEach((text, index) => equal([classifySummary(text).verdict, classifySummary(text).unrecognized], [null, true], `verdict form ${index}`));
    equal(classifySummary(null), { has_branch: false, pr: null, present: false, unrecognized: false, verdict: null }, 'an absent file');
  }],
  ['tickets: the storage mode from config.yaml, and a tree read without following symlinks', (world) => {
    const base = path.join(world.dir, 'modes');
    const projectRoot = (name) => {
      const dir = path.join(base, name);
      fs.mkdirSync(path.join(dir, 'claudedocs', 'tickets'), { recursive: true });
      return dir;
    };
    const withConfig = (name, text) => {
      const dir = projectRoot(name);
      fs.writeFileSync(path.join(dir, 'claudedocs', 'tickets', 'config.yaml'), text);
      return dir;
    };
    const configDir = projectRoot('config-dir');
    fs.mkdirSync(path.join(configDir, 'claudedocs', 'tickets', 'config.yaml'));
    const configLink = projectRoot('config-link');
    fs.symlinkSync(path.join(base, 'server', 'claudedocs', 'tickets', 'config.yaml'), path.join(configLink, 'claudedocs', 'tickets', 'config.yaml'));
    equal(
      [
        storageModeOf(projectRoot('none')),
        storageModeOf(withConfig('fs', 'mode: fs-native\n')),
        storageModeOf(withConfig('server', 'prefix: FP\nmode: "server-native" # comment\n')),
        storageModeOf(withConfig('odd', `mode: ${SENTINEL}\n`)),
        storageModeOf(configDir),
        storageModeOf(configLink),
        storageModeOf(path.join(base, 'gone')),
        storageModeOf('relative/dir'),
      ],
      ['fs', 'fs', 'server-native', 'fs', 'missing', 'missing', 'missing', 'missing'],
      'modes',
    );
    equal(readTicketTree(path.join(base, 'gone')), null, 'no store');
    const tree = projectRoot('tree');
    const store = path.join(tree, 'claudedocs', 'tickets');
    const spec = (status) => `---\nstatus: ${status}\n---\n${SENTINEL}\n`;
    const put = (relative, text) => {
      const file = path.join(store, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    };
    put('in-progress/FP-1/01-spec.md', spec('done'));
    fs.symlinkSync(put('elsewhere/05-tests.md', 'verdict: skipped (app unreachable)\n'), path.join(store, 'in-progress', 'FP-1', '05-tests.md'));
    put('done/FP-1/01-spec.md', spec('done'));
    put('done/FP-2/01-spec.md', spec('done'));
    put('done/FP-2/06-summary.md', `verdict: pass\n${'x'.repeat(1024 * 1024)}\n`);
    put('done/fp-3/01-spec.md', spec('done'));
    put('done/FP-4/prd.md', '---\nkind: epic\nstatus: done\n---\n');
    put('_lessons.md', `${SENTINEL}\n`);
    fs.mkdirSync(path.join(base, 'real-backlog', 'FP-5'), { recursive: true });
    fs.writeFileSync(path.join(base, 'real-backlog', 'FP-5', '01-spec.md'), spec('backlog'));
    fs.symlinkSync(path.join(base, 'real-backlog'), path.join(store, 'backlog'));
    const read = readTicketTree(tree);
    equal([[...read.tickets.keys()].sort(), read.duplicates, read.skipped_folders], [['FP-1', 'FP-2', 'FP-4'], 1, 1], 'IDs, one duplicate, the symlinked state folder skipped');
    const [fp1, fp2, fp4] = ['FP-1', 'FP-2', 'FP-4'].map((id) => read.tickets.get(id));
    equal([fp1.state, fp1.status, fp1.tests, fp1.unrecognized], ['in-progress', 'done', null, ['05-tests.md']], 'the first state folder kept; a symlinked artifact unread; status beside state');
    equal([fp2.summary, fp2.summary_mtime, fp2.unrecognized], [null, null, ['06-summary.md']], 'an artifact over the cap unread');
    equal([fp4.kind, fp4.review, fp4.tests, fp4.summary], ['epic', null, null, null], 'an epic without tasks/');
  }],
  ['tickets: the join marks each ticket both, artifacts or sessions, and counts verdict mismatches', () => {
    const pass = { has_branch: false, pr: null, present: true, verdict: 'pass' };
    const trees = new Map([
      ['/p', { duplicates: 1, join: 'fs', skipped_folders: 2, tickets: new Map([['FP-1', treeRecord('FP-1', { summary: pass })], ['FP-4', treeRecord('FP-4', { unrecognized: ['04-review.md'] })]]) }],
      ['/q', { duplicates: 0, join: 'server-native', skipped_folders: 0, tickets: new Map() }],
      ['/r', { duplicates: 0, join: 'missing', skipped_folders: 0, tickets: new Map() }],
    ]);
    const runs = {
      tickets: [runOf('/p', 'FP-1', ['pass', 'partial', undefined], [['3.2.0'], ['3.1.0', '3.2.0']]), runOf('/p', 'FP-2'), runOf('/q', 'FP-4'), runOf('/r', 'FP-1'), runOf(null, 'FP-1')],
      without_recognition: 2,
    };
    const joined = joinOutcomes(runs, trees);
    equal(joined.tickets.map((entry) => [entry.project, entry.ticket, entry.source, entry.verdict]), [
      [null, 'FP-1', 'sessions', null],
      ['/p', 'FP-1', 'both', 'pass'],
      ['/p', 'FP-2', 'sessions', null],
      ['/p', 'FP-4', 'artifacts', null],
      ['/q', 'FP-4', 'sessions', null],
      ['/r', 'FP-1', 'sessions', null],
    ], 'sources; a server-native or missing project, and another project\'s ID, are never joined');
    const both = joined.tickets[1];
    equal([both.feature_versions, both.outcome.summary, both.close_results.length, both.weighted_units], [['3.1.0', '3.2.0'], pass, 3, 1], 'a joined ticket keeps its runs');
    const { ticket: _ticket, unrecognized: _unrecognized, ...fp4Outcome } = treeRecord('FP-4');
    equal(
      joined.tickets[3],
      { by_role: {}, close_results: [], feature_versions: null, outcome: fp4Outcome, project: '/p', sessions: [], source: 'artifacts', ticket: 'FP-4', verdict: null, weighted_units: null },
      'an artifact-only entry',
    );
    equal(joined.tickets[4].outcome, null, 'a run without a join carries no outcome');
    equal(joined.counts, {
      artifacts_only: 1, duplicates: 1, joined: 1, projects_by_join: { fs: 1, missing: 1, 'server-native': 1 }, sessions_only: 3, skipped_folders: 2, unmapped_runs: 1, unrecognized_total: 1, verdict_mismatch: 1,
    }, 'counts: the last non-null close verdict partial against the artifact pass');
    equal([joined.unrecognized, joined.without_recognition], [[{ artifact: '04-review.md', project: '/p', ticket: 'FP-4' }], 2], 'unrecognized artifacts listed by ID and name');
    equal(joined.projects, [{ join: 'fs', path: '/p' }, { join: 'server-native', path: '/q' }, { join: 'missing', path: '/r' }], 'projects');
    const calls = [];
    const readTree = (root) => {
      calls.push(root);
      return { duplicates: 0, join: 'missing', skipped_folders: 0, tickets: new Map() };
    };
    const dataset = ticketDataset([{ project: '/b', schema_version: 1 }, { project: '/a', schema_version: 1 }, { project: '/b', schema_version: 1 }, { project: null, schema_version: 1 }], { readTree });
    equal([calls, dataset.projects.map((project) => project.path), dataset.without_recognition], [['/a', '/b'], ['/a', '/b'], 4], 'every distinct project read once, digests without recognition included');
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
    const pipeline = path.join(world.ws, 'pipeline');
    equal(doc.tickets, {
      artifacts_only: 4,
      duplicates: 0,
      joined: 3,
      projects: [{ join: 'fs', path: pipeline }, { join: 'server-native', path: world.repo }],
      projects_by_join: { fs: 1, missing: 0, 'server-native': 1 },
      projects_total: 2,
      sessions_only: 1,
      skipped_folders: 1,
      unmapped_runs: 0,
      unrecognized: ['01-spec.md', '04-review.md', '05-tests.md', '06-summary.md'].map((artifact) => ({ artifact, project: pipeline, ticket: 'FP-32' })),
      unrecognized_total: 4,
      verdict_mismatch: 0,
    }, 'the tickets block');
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
  ['tickets: the dataset joins the fixture ticket trees to the cached runs', (world) => {
    const pipeline = path.join(world.ws, 'pipeline');
    const dataset = ticketDataset(loadDigests(world.cacheRoot));
    assert(!JSON.stringify(dataset).includes(SENTINEL), 'the sentinel reached the dataset');
    const entriesOf = (project) => Object.fromEntries(dataset.tickets.filter((entry) => entry.project === project).map((entry) => [entry.ticket, entry]));
    const p = entriesOf(pipeline);
    equal(
      Object.fromEntries(Object.entries(p).map(([id, entry]) => [id, [entry.source, entry.verdict, entry.outcome.kind, entry.outcome.state, entry.outcome.status]])),
      {
        'FP-20': ['artifacts', null, 'epic', 'in-progress', 'in-progress'],
        'FP-30': ['artifacts', 'pass', 'solo', 'done', 'done'],
        'FP-31': ['artifacts', 'pass', 'solo', 'review', 'in-review'],
        'FP-32': ['artifacts', null, 'solo', 'done', null],
        'FP-7': ['both', 'pass', 'solo', 'done', 'done'],
        'FP-8': ['both', 'partial', 'child', 'in-progress', 'in-review'],
        'FP-9': ['both', 'stuck', 'solo', 'backlog', 'backlog'],
      },
      'pipeline tickets: the symlinked FP-40 and the spec-less FP-33 absent; an epic child\'s state beside its own status',
    );
    const mtimeOf = (relative) => new Date(fs.lstatSync(path.join(world.tickets.pipeline, relative, '06-summary.md')).mtimeMs).toISOString();
    equal(p['FP-7'].outcome, {
      complexity: 'S',
      created: '2026-11-01',
      epic_folder: null,
      kind: 'solo',
      parent: null,
      review: { decisions: { accepted: 2, deferred: 1, dismissed: 1 }, fix_step: 'complete', label: 'reviewed', outcomes: { applied: 2, fix_failed: 0, not_attempted: 1 }, present: true, reviewers_ok: null },
      state: 'done',
      status: 'done',
      summary: { has_branch: true, pr: { number: 7, repo: 'fixture/repo' }, present: true, verdict: 'pass' },
      summary_mtime: mtimeOf('done/FP-7'),
      tests: { ...NO_TESTS, by: 'close', failed_criteria: false, state: 'ran' },
    }, 'FP-7: a pass with a close browser pass');
    near([p['FP-7'].weighted_units], [1760], 'FP-7 keeps its run units');
    equal([p['FP-7'].feature_versions, p['FP-7'].close_results.length], [['3.41.1', '3.41.2'], 3], 'FP-7 versions and close results');
    const fp8 = p['FP-8'].outcome;
    equal(
      [fp8.parent, fp8.epic_folder, fp8.complexity, fp8.review.label, fp8.review.reviewers_ok, fp8.review.outcomes, fp8.tests, fp8.summary.pr],
      ['FP-20', 'FP-20', 'M', 'reviewed-partial', 3, { ...NO_OUTCOMES, fix_failed: 2 }, { ...NO_TESTS, cause: 'app-unreachable', state: 'skipped' }, 'none'],
      'FP-8: a partial epic child with fix-failed findings and a skipped browser pass',
    );
    const fp9 = p['FP-9'].outcome;
    equal([fp9.review.label, fp9.review.fix_step, fp9.review.outcomes.not_attempted, fp9.tests.state, fp9.summary.has_branch], ['stuck', 'pending', 1, 'absent', false], 'FP-9: a stuck ticket');
    const fp20 = p['FP-20'];
    equal(
      [fp20.feature_versions, fp20.weighted_units, fp20.sessions, fp20.close_results, fp20.outcome.review, fp20.outcome.tests, fp20.outcome.summary, fp20.outcome.summary_mtime],
      [null, null, [], [], null, null, null, null],
      'FP-20: an epic with no session',
    );
    equal([p['FP-30'].outcome.review.label, p['FP-30'].outcome.tests.cause, p['FP-30'].outcome.summary.pr, p['FP-30'].outcome.summary.has_branch], ['skipped-trivial', 'no-ui-testing-flag', null, true], 'FP-30: artifacts only');
    equal([p['FP-31'].outcome.review.present, p['FP-31'].outcome.tests, p['FP-31'].outcome.summary.pr], [false, { ...NO_TESTS, by: 'ship', result: 'partial', state: 'ran' }, { number: 31, repo: 'fixture/repo' }], 'FP-31: a ship browser pass');
    equal(dataset.unrecognized.filter((item) => item.ticket !== 'FP-32'), [], 'only FP-32 is unrecognized');
    const repo = entriesOf(world.repo);
    equal([repo['FP-7'].source, repo['FP-7'].outcome, repo['FP-7'].verdict], ['sessions', null, null], 'a server-native project\'s run keeps no outcome and its tree is never read');
    equal(dataset.projects, [{ join: 'fs', path: pipeline }, { join: 'server-native', path: world.repo }], 'projects');
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
