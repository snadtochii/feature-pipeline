// The insights self-test's ticket-outcome cases (../CONTRACT.md §11): the
// artifact classifiers, the ticket-tree reader and the in-memory join. Each
// case reads the world and changes nothing in it.
//
// Private to the implementation: only insights.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';
import { equal } from '../../lib/selftest-kit.mjs';
import { SENTINEL } from './fixtures.mjs';
import { defaultReadTree, joinOutcomes, ticketDataset } from './outcomes.mjs';
import { classifyReview, classifySummary, classifyTests, kindOf, parseFrontmatter, readTicketTree, storageModeOf } from './tickets.mjs';
import { NO_DECISIONS, NO_OUTCOMES, NO_TESTS, treeRecord, runOf } from './selftest-world.mjs';

export const TICKET_CASES = [
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
      `- [F1] [security] ${SENTINEL}`,
      '- decision: accepted — x',
      `- [F2] ${SENTINEL}`,
      '  - decision: accepted',
      `  - [F3] ${SENTINEL}`,
      '\t- decision: dismissed — y',
      `- [F4] ${SENTINEL}`,
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
    const prose = review('verdict: reviewed', '## Summary', `2 applied, 0 dismissed ${SENTINEL}`, `- [F1] ${SENTINEL}`, `- [F2] ${SENTINEL}`);
    equal([prose.label, prose.decisions, prose.outcomes, prose.unrecognized], ['reviewed', NO_DECISIONS, NO_OUTCOMES, true], 'counts written only as prose under an intact label');
    const undecided = review('verdict: reviewed', `- [F1] ${SENTINEL}`, '  - decision: accepted', `- [F2] ${SENTINEL}`);
    equal([undecided.decisions, undecided.unrecognized], [{ ...NO_DECISIONS, accepted: 1 }, true], 'a finding line without its decision line');
    equal(review('verdict: skipped (trivial diff)', '# Review').unrecognized, false, 'a review with no findings');
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
        storageModeOf(withConfig('no-key', 'prefix: FP\n')),
        storageModeOf(withConfig('odd', `mode: ${SENTINEL}\n`)),
        storageModeOf(withConfig('typo', 'mode: fs_native\n')),
        storageModeOf(withConfig('empty', 'mode:\n')),
        storageModeOf(configDir),
        storageModeOf(configLink),
        storageModeOf(path.join(base, 'gone')),
        storageModeOf('relative/dir'),
      ],
      ['fs', 'fs', 'server-native', 'fs', 'unknown-mode', 'unknown-mode', 'unknown-mode', 'missing', 'missing', 'missing', 'missing'],
      'modes: any other mode value is never guessed',
    );
    equal(defaultReadTree(path.join(base, 'odd')), { duplicates: 0, join: 'unknown-mode', skipped_folders: 0, tickets: new Map() }, 'an unknown mode reads no tree');
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
      ['/s', { duplicates: 0, join: 'unknown-mode', skipped_folders: 0, tickets: new Map() }],
    ]);
    const runs = {
      tickets: [runOf('/p', 'FP-1', ['pass', 'partial', undefined], [['3.2.0'], ['3.1.0', '3.2.0']]), runOf('/p', 'FP-2'), runOf('/q', 'FP-4'), runOf('/r', 'FP-1'), runOf('/s', 'FP-1'), runOf(null, 'FP-1')],
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
      ['/s', 'FP-1', 'sessions', null],
    ], 'sources; a server-native, missing or unknown-mode project, and another project\'s ID, are never joined');
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
      artifacts_only: 1, duplicates: 1, joined: 1, projects_by_join: { fs: 1, missing: 1, 'server-native': 1, 'unknown-mode': 1 }, sessions_only: 4, skipped_folders: 2, unmapped_runs: 1, unrecognized_total: 1, verdict_mismatch: 1,
    }, 'counts: the last non-null close verdict partial against the artifact pass');
    equal([joined.unrecognized, joined.without_recognition], [[{ artifact: '04-review.md', project: '/p', ticket: 'FP-4' }], 2], 'unrecognized artifacts listed by ID and name');
    equal(joined.projects, [{ join: 'fs', path: '/p' }, { join: 'server-native', path: '/q' }, { join: 'missing', path: '/r' }, { join: 'unknown-mode', path: '/s' }], 'projects');
    const calls = [];
    const readTree = (root) => {
      calls.push(root);
      return { duplicates: 0, join: 'missing', skipped_folders: 0, tickets: new Map() };
    };
    const dataset = ticketDataset([{ project: '/b', schema_version: 1 }, { project: '/a', schema_version: 1 }, { project: '/b', schema_version: 1 }, { project: null, schema_version: 1 }], { readTree });
    equal([calls, dataset.projects.map((project) => project.path), dataset.without_recognition], [['/a', '/b'], ['/a', '/b'], 4], 'every distinct project read once, digests without recognition included');
  }],
];
