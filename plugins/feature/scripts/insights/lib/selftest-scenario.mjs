// The insights self-test's cache scenario (../CONTRACT.md §11): `extract` run
// end to end over one world, in order. The first run fills the cache; the
// cases after it read that cache, and the reruns then change the store
// step by step — reuse, remap, a grown transcript, a schema change, a
// missing subagent file, a transcript gone — each building on the state
// the one before it left. The list is ordered and runs as a whole.
//
// Private to the implementation: only insights.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';
import { render } from '../../lib/output.mjs';
import { assert, equal } from '../../lib/selftest-kit.mjs';
import { SCHEMA_VERSION, loadDigests } from './cache.mjs';
import { SENTINEL } from './fixtures.mjs';
import { ticketDataset } from './outcomes.mjs';
import { sessionTotals, ticketRuns } from './runs.mjs';
import { SESSIONS, transcriptOf, extractRun, NO_OUTCOMES, NO_TESTS, digestOf, digestFile, at, near, SESSION_COUNTS } from './selftest-world.mjs';

export const SCENARIO_CASES = [
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
      projects_by_join: { fs: 1, missing: 0, 'server-native': 1, 'unknown-mode': 0 },
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
