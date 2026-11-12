// The insights self-test's report cases (../CONTRACT.md §11): weeks, friction,
// outcomes, the window, the comparison and the page in memory, then the
// `report` verb. They run after the cache scenario: the end-to-end report
// case reads the cache the scenario's last rerun left.
//
// Private to the implementation: only insights.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';
import { ComputeError, UsageError } from '../../lib/output.mjs';
import { assert, equal, rejectsKind, throwsKind } from '../../lib/selftest-kit.mjs';
import { writeExclusive } from '../../lib/write-atomic.mjs';
import { NO_SKILL, aggregate, dayOf, defaultSinceMs, findingsOf, isoWeekStart, skillOf, verdictOf } from './aggregate.mjs';
import { MIN_COMPARE_RUNS, compareWindows } from './compare.mjs';
import { esc, renderPage, skeletonSignature } from './html.mjs';
import { publishReport, report } from './report.mjs';
import { SENTINEL } from './fixtures.mjs';
import { childEnv, runEntry, listing, checkCache, ticketListings, NO_DECISIONS, NO_TESTS, at, NO_FLAGS, NO_FRICTION, EMPTY_DATASET, NOV, isoNov, synthAgent, synthDigest, runTicket, days, bodyMarkers, boxOf } from './selftest-world.mjs';

export const REPORT_CASES = [
  ['report weeks: ISO weeks start Monday in UTC across a year boundary; the default window is 30 days', () => {
    equal(
      ['2027-01-01T05:00:00.000Z', '2026-12-27T23:59:59.000Z', '2026-12-28T00:00:00.000Z', '2026-11-12T10:00:00.000Z'].map(isoWeekStart),
      ['2026-12-28', '2026-12-21', '2026-12-28', '2026-11-09'],
      'week starts',
    );
    equal(dayOf(defaultSinceMs(NOV(12, 23))), '2026-10-13', 'default window start');
    const agg = aggregate({ dataset: EMPTY_DATASET, digests: [], now: NOV(12), projects: [], since: Date.UTC(2026, 9, 13) });
    equal(agg.weeks.map((week) => [week.week, week.partial]), [
      ['2026-10-12', true], ['2026-10-19', false], ['2026-10-26', false], ['2026-11-02', false], ['2026-11-09', true],
    ], 'an empty window still lists its weeks, the first and last partial');
    equal(agg.stages.map((row) => [row.stage, row.count, row.weeks.length]), [['plan', 0, 5], ['implement', 0, 5], ['review', 0, 5], ['close', 0, 5]], 'zero stage rows');
  }],
  ['report friction: own skill command past a built-in one, nearest ancestor, missing parent, cycle and no skill; per stage too', () => {
    const agents = [
      synthAgent('root', null, { commands: [{ ids: [], name: '/clear' }, { ids: [], name: '/feature:flow' }], friction: { ...NO_FRICTION, interrupts: 1 }, skills: { 'feature:flow': 1 } }),
      synthAgent('a1', 'root', { friction: { ...NO_FRICTION, rejections: 2 }, stage: 'plan' }),
      synthAgent('a2', 'a1', { check_runs: { failed: 1, total: 3 }, commands: [{ ids: ['FP-1'], name: 'feature:build' }], skills: { 'feature:build': 1 }, stage: 'implement' }),
      synthAgent('a3', 'gone', { friction: { ...NO_FRICTION, tool_errors: 1 } }),
      synthAgent('a4', 'a5', { friction: { ...NO_FRICTION, permission_denials: 1 } }),
      synthAgent('a5', 'a4'),
    ];
    const byId = new Map(agents.map((agent) => [agent.agent_id, agent]));
    equal(agents.map((agent) => skillOf(agent, byId)), ['feature:flow', 'feature:flow', 'feature:build', 'feature:flow', NO_SKILL, NO_SKILL], 'skill per agent');
    const bare = synthAgent('root', null);
    equal(skillOf(bare, new Map([['root', bare]])), NO_SKILL, 'no command anywhere up the chain');
    const builtIn = synthAgent('root', null, { commands: [{ ids: [], name: '/model' }] });
    equal(skillOf(builtIn, new Map([['root', builtIn]])), NO_SKILL, 'a built-in command that loaded no skill');
    const digests = [synthDigest('/p', isoNov(10), agents), synthDigest(null, isoNov(11), [synthAgent('root', null)]), synthDigest('/p', null, [synthAgent('root', null)], 'undated')];
    const agg = aggregate({ dataset: EMPTY_DATASET, digests, now: NOV(12), projects: ['/p'], since: NOV(1, 0) });
    assert(!JSON.stringify(agg).includes(SENTINEL), 'the sentinel reached the aggregate');
    equal(agg.friction.by_skill.map((row) => [row.name, row.total]), [['feature:flow', 4], [NO_SKILL, 1], ['feature:build', 1]], 'friction per skill, heaviest first');
    equal(agg.friction.by_skill[2].check_runs, 3, 'check runs beside the failed ones');
    equal(agg.friction.by_stage.map((row) => [row.name, row.total]), [['(no stage)', 3], ['plan', 2], ['implement', 1]], 'friction per stage');
    equal(
      [agg.counts.sessions, agg.counts.unmapped_sessions, agg.counts.excluded_undated, agg.totals.units, agg.projects.map((row) => [row.project, row.other_units])],
      [1, 1, 1, 150, [['/p', 150]]],
      'an unmapped session counted machine-wide, never tabled; an undated session left out and counted',
    );
  }],
  ['report outcomes: the artifact verdict, else the last close result; unknown findings never count as zero', () => {
    const closes = (...verdicts) => verdicts.map((verdict) => ({ close_result: verdict === null ? null : { ending: 'caller', verdict } }));
    equal(verdictOf({ close_results: closes('pass', 'partial', null), verdict: null }), 'partial', 'the last close-result verdict');
    equal(verdictOf({ close_results: closes('partial'), verdict: 'pass' }), 'pass', 'the artifact verdict wins');
    equal(verdictOf({ close_results: closes(null), verdict: null }), 'unknown', 'no verdict anywhere');
    const reviewed = (label, present = true, decisions = NO_DECISIONS) => ({ outcome: { review: { decisions, label, present } }, project: '/p', ticket: 'FP-1' });
    equal(findingsOf(reviewed('skipped-trivial'), new Set()), NO_DECISIONS, 'a trivial-diff skip is a real zero');
    equal(findingsOf(reviewed(null, false), new Set()), null, 'no 04-review.md is unknown');
    equal(findingsOf(reviewed('failed-all'), new Set()), null, 'every reviewer failed is unknown');
    equal(findingsOf(reviewed('reviewed', true, { ...NO_DECISIONS, accepted: 2 }), new Set([JSON.stringify(['/p', 'FP-1'])])), null, 'an unrecognized review is unknown');
    equal(findingsOf({ outcome: null, project: '/p', ticket: 'FP-1' }, new Set()), null, 'a sessions-only ticket is unknown');
    const session = { session_id: 's', stages: [], start: isoNov(10) };
    const outcome = (fields) => ({ created: null, kind: 'solo', review: null, summary_mtime: null, tests: null, ...fields });
    const dataset = {
      ...EMPTY_DATASET,
      tickets: [
        { close_results: [], outcome: outcome({ review: { decisions: NO_DECISIONS, label: 'skipped-trivial', present: true }, tests: { ...NO_TESTS, by: 'close', state: 'ran' } }), project: '/p', sessions: [session], source: 'both', ticket: 'FP-1', verdict: 'pass' },
        { close_results: closes('partial'), outcome: null, project: '/p', sessions: [session], source: 'sessions', ticket: 'FP-2', verdict: null },
        { close_results: [], outcome: outcome({ created: '2026-11-05', review: { decisions: { ...NO_DECISIONS, accepted: 2 }, label: 'reviewed', present: true }, tests: { ...NO_TESTS, cause: 'no-ui-work', state: 'skipped' } }), project: '/p', sessions: [], source: 'artifacts', ticket: 'FP-3', verdict: 'stuck' },
        { close_results: [], outcome: outcome({}), project: '/p', sessions: [], source: 'artifacts', ticket: 'FP-4', verdict: 'pass' },
        { close_results: [], outcome: outcome({ created: '2026-11-06', kind: 'epic' }), project: '/p', sessions: [], source: 'artifacts', ticket: 'FP-5', verdict: null },
        { close_results: [], outcome: outcome({ created: '2026-11-06' }), project: '/other', sessions: [], source: 'artifacts', ticket: 'FP-6', verdict: 'pass' },
      ],
    };
    const agg = aggregate({ dataset, digests: [synthDigest('/p', isoNov(10), [synthAgent('root', null)], 's')], now: NOV(12), projects: ['/p'], since: NOV(1, 0) });
    equal(agg.outcomes.verdicts, { pass: 1, partial: 1, stuck: 1, unknown: 0 },'verdicts: epics, undated and other projects left out');
    equal(agg.outcomes.findings, { accepted: 2, deferred: 0, dismissed: 0, known_for: 2, of: 3 }, 'findings with their coverage');
    equal(agg.outcomes.browser, { absent: 0, ran: { close: 1, ship: 0 }, skipped: { 'no-ui-work': 1 }, unknown: 1, unrecognized: 0 }, 'browser pass');
    equal([agg.counts.runs, agg.counts.artifacts_only, agg.counts.excluded_undated], [2, 2, 1], 'runs, artifact-only tickets and the undated one');
  }],
  ['report window: a session counts whole, its stages with it and in its week; session wall-clock beside stage time', () => {
    const stage = (name, start, units, duration) => ({ agent_id: 'root', duration_ms: duration, stage: name, start, weighted_units: units });
    const before = { ...synthDigest('/p', isoNov(1, 22), [synthAgent('root', null)], 'a'), duration_ms: 18_000_000 };
    const sunday = { ...synthDigest('/p', isoNov(8, 22), [synthAgent('root', null)], 'b'), duration_ms: 7_200_000 };
    const sessions = [
      { session_id: 'a', stages: [stage('implement', isoNov(2, 1), 1000, 600_000)], start: isoNov(2, 1) },
      { session_id: 'b', stages: [stage('review', isoNov(9, 1), 40, 3_600_000)], start: isoNov(9, 1) },
    ];
    const dataset = { ...EMPTY_DATASET, tickets: [{ close_results: [], outcome: null, project: '/p', sessions, source: 'sessions', ticket: 'FP-1', verdict: null }] };
    const agg = aggregate({ dataset, digests: [before, sunday], now: NOV(12), projects: ['/p'], since: NOV(2, 0) });
    equal([agg.totals.units, agg.totals.stage_units, agg.counts.runs], [150, 40, 1], 'a stage of a session started before the window is left out with it');
    equal(agg.weeks.map((week) => week.week), ['2026-11-02', '2026-11-09'], 'weeks');
    const byStage = Object.fromEntries(agg.stages.map((row) => [row.stage, [row.count, row.units, row.weeks.map((week) => week.units)]]));
    equal([byStage.implement, byStage.review], [[0, 0, [0, 0]], [1, 40, [40, 0]]], "a stage counts in its session's week");
    const [row] = agg.projects;
    equal(
      [row.sessions, row.units, row.stage_units, row.other_units, row.session_duration_ms, row.stage_duration_ms],
      [1, 150, 40, 110, 7_200_000, 3_600_000],
      'the project row: session wall-clock beside the stage wall-clock',
    );
    equal(row.weeks.map((week) => [week.stage_units, week.session_duration_ms]), [[40, 7_200_000], [0, 0]], 'the weekly project rows');
    const total = (values) => values.reduce((acc, value) => acc + value, 0);
    agg.weeks.forEach((_, index) => equal(total(agg.stages.map((item) => item.weeks[index].units)), total(agg.projects.map((item) => item.weeks[index].stage_units)), `week ${index} stage units agree across the tables`));
  }],
  ['report compare: equal windows nearest the boundary, the floor of 5, exclusions', () => {
    equal(MIN_COMPARE_RUNS, 5, 'the floor');
    const before = days(1, 9).map((day) => runTicket(`B-${day}`, ['3.41.0'], day));
    const after = days(10, 14).map((day) => runTicket(`A-${day}`, day === 14 ? ['3.42.1', '3.42.0'] : ['3.42.0'], day, day === 14 ? { outcome: { kind: 'solo', review: null, tests: null } } : {}));
    const extra = [runTicket('S-1', ['3.41.9', '3.42.0'], 20), runTicket('U-1', [], 21), runTicket('E-1', ['3.42.0'], 22, { outcome: { kind: 'epic', review: null, tests: null } })];
    const shown = compareWindows({ tickets: [...after, ...extra, ...before], version: '3.42.0' });
    equal([shown.state, shown.before.runs, shown.before.pool, shown.after.runs, shown.after.pool], ['shown', 5, 9, 5, 5], 'k = 5 on each side is shown');
    equal(shown.excluded, { epics: 1, straddling: 1, unversioned: 1 }, 'excluded runs');
    equal([shown.before.units_median, shown.before.units_total, shown.after.units_median], [70, 350, 120], 'the before side takes the 5 runs nearest the boundary');
    equal([shown.before.findings.known_for, shown.after.findings.known_for, shown.after.findings.accepted], [5, 4, 4], 'an unknown review is left out of the coverage, never added as 0');
    equal([shown.before.verdicts.pass, shown.after.duration_median_ms], [5, 12_000], 'verdicts and wall-clock beside the units');
    const short = compareWindows({ tickets: [...after.slice(0, 4), ...before], version: '3.42.0' });
    equal([short.state, short.after, short.before], ['insufficient', { pool: 4, runs: 4 }, { pool: 9, runs: 4 }], 'k = 4 is insufficient and carries no figure');
    equal(compareWindows({ tickets: before, version: '9.0.0' }).after, { pool: 0, runs: 0 }, 'a version newer than any run');
    const tied = [runTicket('Z-1', ['1.0.0'], 1), runTicket('A-1', ['1.0.0'], 1, { weighted_units: 1000 }), ...days(2, 5).map((day) => runTicket(`T-${day}`, ['1.0.0'], day))];
    const later = days(6, 10).map((day) => runTicket(`L-${day}`, ['2.0.0'], day));
    equal(compareWindows({ tickets: [...later, ...tied], version: '2.0.0' }).before.units_total, 150, 'equal starts order by ticket ID');
  }],
  ['report page: values escaped, one skeleton in every state, no script, asset or URL', () => {
    equal(esc(`<x>&"'`), '&lt;x&gt;&amp;&quot;&#39;', 'the escaper');
    const odd = `/w/<x>&"'/proj`;
    const since = NOV(1, 0);
    const agg = aggregate({ dataset: EMPTY_DATASET, digests: [synthDigest(odd, isoNov(10), [synthAgent('root', null, { commands: [{ ids: [], name: 'feature:flow' }] })])], now: NOV(12), projects: [odd], since });
    const emptyAgg = aggregate({ dataset: EMPTY_DATASET, digests: [], now: NOV(12), projects: [odd], since });
    const meta = (extractError = null) => ({ extract_error: extractError, generated: '2026-11-12T10:00:00.000Z', label: 'proj' });
    const shownCompare = compareWindows({ tickets: [...days(1, 5).map((day) => runTicket(`B-${day}`, ['1.0.0'], day)), ...days(6, 10).map((day) => runTicket(`A-${day}`, ['2.0.0'], day))], version: '2.0.0' });
    const pages = {
      disabled: renderPage({ agg, compare: compareWindows({ tickets: [], version: '2.0.0' }), meta: meta() }),
      empty: renderPage({ agg: emptyAgg, compare: null, meta: meta() }),
      error: renderPage({ agg: emptyAgg, compare: null, meta: meta('store unreadable') }),
      populated: renderPage({ agg, compare: shownCompare, meta: meta() }),
    };
    equal(
      Object.fromEntries(Object.entries(pages).map(([name, html]) => [name, bodyMarkers(html)])),
      { disabled: ['populated', 'insufficient'], empty: ['empty', 'off'], error: ['error', 'off'], populated: ['populated', 'shown'] },
      'page and comparison state markers',
    );
    const signature = skeletonSignature(pages.populated);
    equal(signature.length, 22, 'seven sections and fifteen boxes');
    for (const [name, html] of Object.entries(pages)) {
      equal(skeletonSignature(html), signature, `${name} page skeleton`);
      assert(!/<script|<link|src=|url\(|@import|https?:/i.test(html), `${name} page holds a script, an asset or a URL`);
      assert(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">') && html.includes('@media (max-width: 640px)'), `${name} page lacks the viewport meta or the narrow-width query`);
      assert(!html.includes(SENTINEL), `the sentinel reached the ${name} page`);
      assert(!/NaN|undefined|Infinity/.test(html), `the ${name} page renders a missing number`);
    }
    assert(pages.populated.includes('<div class="scroll"><svg class="chart"') && pages.populated.includes('.chart{display:block;width:100%;min-width:560px'), 'a chart keeps a minimum width and scrolls below it');
    assert(!pages.populated.includes(`<x>&"`) && pages.populated.includes('/w/&lt;x&gt;&amp;&quot;&#39;/proj'), 'the project path appears only escaped');
    assert(boxOf(pages.empty, 'stage-chart').includes('data-state="empty"') && boxOf(pages.error, 'stage-chart').includes('data-state="error"'), 'empty and error boxes carry their state');
    assert(boxOf(pages.disabled, 'compare-table').includes('data-state="disabled"') && boxOf(pages.empty, 'compare-table').includes('data-state="off"'), 'disabled and off comparisons carry their state');
    const compared = boxOf(pages.populated, 'compare-table');
    assert(['Difference', 'Verdict pass', 'Findings accepted', 'Findings known for'].every((label) => compared.includes(label)), 'the differences sit beside the verdict and findings rows');
    assert(pages.disabled.includes('at least 5 runs on each side') && pages.empty.includes('at least 5 runs on each side'), 'the floor is stated on the page');
  }],
  ['report: an end-to-end run writes one page under reports/ and prints the bounded summary', async (world) => {
    const pipeline = path.join(world.ws, 'pipeline');
    const reports = path.join(world.home, '.feature-pipeline', 'insights', 'reports');
    const storeBefore = listing(world.store);
    const ticketsBefore = ticketListings(world);
    const env = childEnv(world.home);
    const result = await runEntry(['report', '--project', 'all', '--since', '2000-01-01', '--cwd', pipeline], env);
    equal(result.status, 0, `report exit (stdout ${result.stdout.slice(0, 200)})`);
    equal(result.stderr, '', 'report stderr');
    const doc = result.doc;
    equal([path.dirname(doc.report), doc.state, doc.compare, doc.extract_error], [reports, 'populated', 'off', null], 'report document');
    assert(doc.summary.length <= 10, `summary has ${doc.summary.length} lines`);
    equal(doc.summary.at(-1), `report: ${doc.report}`, 'the report path last');
    equal(doc.summary[0], 'scope: all projects (3), since 2000-01-01', 'scope line');
    const html = fs.readFileSync(doc.report, 'utf8');
    assert(html.includes('data-box="stage-chart"><div class="scroll"><svg') && html.includes('<th scope="row">plan</th>'), 'the stage section holds the fixture stages');
    assert(!/NaN|undefined|Infinity/.test(html), 'the fixture page renders a missing number');
    const compared = await runEntry(['report', '--project', 'all', '--since', '2000-01-01', '--compare', '0.0.1', '--cwd', pipeline], env);
    equal([compared.status, compared.doc.compare], [0, 'insufficient'], 'a comparison with nothing before it');
    assert(compared.doc.report !== doc.report && fs.readFileSync(compared.doc.report, 'utf8').includes('data-compare="insufficient"'), 'a second report is its own file');
    const named = await runEntry(['report', '--project', 'pipeline', '--since', '2000-01-01'], env);
    equal([named.status, named.doc.summary[0]], [0, 'scope: pipeline, since 2000-01-01'], 'a project by base name');
    const written = fs.readdirSync(reports).sort();
    const outside = await runEntry(['report', '--cwd', world.home], env);
    equal(outside.status, 2, 'a directory in no project, without --project');
    assert(outside.doc.error.includes('--project all'), `the error names --project: ${outside.stdout}`);
    const unknown = await runEntry(['report', '--project', 'no-such-project', '--cwd', pipeline], env);
    equal(unknown.status, 2, 'an unknown project');
    equal(fs.readdirSync(reports).sort(), written, 'a usage error writes no report');
    equal((await runEntry(['report', '--project', 'all'], childEnv(null))).status, 1, 'HOME unset');
    equal(listing(world.store), storeBefore, 'store listing after report');
    equal(ticketListings(world), ticketsBefore, 'ticket tree listings after report');
    checkCache(world);
  }],
  ['report: an extractor failure still renders a page that explains it; the reports directory must be one', async (world) => {
    const home = path.join(world.dir, 'home-error');
    fs.mkdirSync(home);
    const failing = () => {
      throw new ComputeError('store unreadable');
    };
    const run = (overrides) => report({ cwd: world.dir, flags: { ...NO_FLAGS, project: 'all' }, home, now: NOV(12, 0), runExtractFn: failing, ...overrides });
    const doc = await run({});
    equal([doc.extract_error, doc.state, doc.compare, path.basename(doc.report)], ['store unreadable', 'empty', 'off', '20261112T000000Z-all.html'], 'error document');
    equal(doc.summary[1], 'sessions: 0 in scope, 0 pipeline runs; extract: failed — store unreadable', 'the summary names the failure');
    assert(fs.readFileSync(doc.report, 'utf8').includes('<body data-state="error"'), 'the page carries the error state');
    equal(path.basename((await run({})).report), '20261112T000000Z-all-2.html', 'a second report in the same second');
    const unexpected = await run({ runExtractFn: () => { throw Object.assign(new TypeError(`boom ${SENTINEL}`), { code: 'ERR_BOOM' }); } });
    equal([unexpected.extract_error, unexpected.state], ['unexpected TypeError (ERR_BOOM)', 'empty'], 'an unexpected extractor exception is explained by its class and code');
    const unexpectedPage = fs.readFileSync(unexpected.report, 'utf8');
    assert(unexpectedPage.includes('<body data-state="error"') && !unexpectedPage.includes('boom') && !unexpected.summary.join('\n').includes('boom'), 'the unexpected failure is explained without its message');
    const blocked = path.join(world.dir, 'home-blocked');
    fs.mkdirSync(path.join(blocked, '.feature-pipeline', 'insights'), { recursive: true });
    fs.writeFileSync(path.join(blocked, '.feature-pipeline', 'insights', 'reports'), '');
    await rejectsKind(() => run({ home: blocked, runExtractFn: async () => ({ dataset: EMPTY_DATASET, digests: [] }) }), ComputeError, 'reports directory');
    await rejectsKind(() => run({ home: '' }), ComputeError, 'HOME');
    await rejectsKind(() => run({ flags: NO_FLAGS }), UsageError, 'belongs to no project');
  }],
  ['report publish: a name another run already took is never replaced; the next suffix is taken', (world) => {
    const dir = path.join(world.dir, 'reports-race');
    fs.mkdirSync(dir, { mode: 0o700 });
    const target = path.join(dir, 'taken.html');
    fs.writeFileSync(target, 'first run');
    throwsKind(() => writeExclusive(target, 'second run'), Error, 'EEXIST');
    equal([fs.readFileSync(target, 'utf8'), fs.readdirSync(dir)], ['first run', ['taken.html']], 'the taken name keeps its report and no temporary file is left');
    fs.writeFileSync(path.join(dir, '20261112T000000Z-all.html'), 'run one');
    fs.writeFileSync(path.join(dir, '20261112T000000Z-all-2.html'), 'run two');
    const file = publishReport(dir, NOV(12, 0), 'all', 'run three');
    equal(path.basename(file), '20261112T000000Z-all-3.html', 'the first free suffix');
    equal(
      ['20261112T000000Z-all.html', '20261112T000000Z-all-2.html', '20261112T000000Z-all-3.html'].map((name) => fs.readFileSync(path.join(dir, name), 'utf8')),
      ['run one', 'run two', 'run three'],
      'every report keeps its own contents',
    );
    equal(fs.statSync(file).mode & 0o777, 0o600, 'mode of the published report');
  }],
];
