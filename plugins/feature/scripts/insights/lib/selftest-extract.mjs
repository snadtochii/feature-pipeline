// The insights self-test's extraction cases (../CONTRACT.md §11): argument
// parsing, the transcript rules, recognition and project mapping. Each case
// reads the world and changes nothing in it.
//
// Private to the implementation: only insights.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from '../../lib/output.mjs';
import { assert, equal, throwsKind } from '../../lib/selftest-kit.mjs';
import { parseArgv } from './args.mjs';
import { SCHEMA_VERSION } from './cache.mjs';
import { SENTINEL } from './fixtures.mjs';
import { makeMapper, mapProject } from './project.mjs';
import { UNATTRIBUTED_MARK, closeResultOf, commandTicketOf, findTicket, isCheckRun, recognizeSession, roleOf, rootStageOf, slashBuildTicket, validCloseResult, validRole, validStage, validTicket } from './recognize.mjs';
import { sessionTotals, ticketRuns } from './runs.mjs';
import { consumeLine, finishAgent, newAgent, readTranscript } from './transcript.mjs';
import { childEnv, runEntry, rootOfA, agentOfLines, at, near, NO_FLAGS } from './selftest-world.mjs';

export const EXTRACT_CASES = [
  ['args: extract, report and --self-test parse, anything else is a usage error', async () => {
    equal(parseArgv(['extract']), { verb: 'extract' }, 'extract');
    equal(parseArgv(['--self-test']), { selfTest: true }, 'self-test');
    equal(parseArgv(['report']), { flags: NO_FLAGS, verb: 'report' }, 'bare report');
    equal(
      parseArgv(['report', '--cwd', '/x', '--compare', '3.42.0', '--since', '2028-02-29', '--project', 'all']).flags,
      { compare: '3.42.0', cwd: '/x', project: 'all', since: '2028-02-29' },
      'every report flag',
    );
    const invalid = [
      [], ['bogus'], ['extract', '--x'], ['extract', 'more'], ['extract', '--self-test'], ['--self-test', 'extract'], ['--flag=1'],
      ['report', '--project'], ['report', '--project', '--since'], ['report', '--project', ''], ['report', '--project', 'x'.repeat(4097)],
      ['report', '--since', '2026-13-01'], ['report', '--since', '2026-02-30'], ['report', '--since', '26-01-01'],
      ['report', '--compare', '3.42'], ['report', '--compare', 'v3.42.0'], ['report', '--compare', '3.42.0-beta'], ['report', '--cwd', 'relative/dir'],
      ['report', '--project', 'a', '--project', 'b'], ['report', '--since=2026-01-01'], ['report', 'extra'], ['report', '--bogus', 'x'],
    ];
    for (const argv of invalid) {
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
];
