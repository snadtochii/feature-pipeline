// The address-review thread-state reader's self-test.
//
// Every case is `[name, fn]`. The rules are exercised in-process over inline
// fixtures and stub `gh` runners; the command is exercised end to end as a
// child process against a stand-in `gh` on a temporary PATH. Nothing reaches
// GitHub, and every temporary directory is removed in a `finally`.
//
// Private to the implementation: only threads.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ComputeError, UsageError, render } from '../../../scripts/lib/output.mjs';
import { assert, equal, runNode, throwsKind, withTemp as withTempDir } from '../../../scripts/lib/selftest-kit.mjs';
import { MAX_DOCUMENT_BYTES, MAX_TEXT_CHARS, addressMarker, findings, parseArgv, parsePages, readAll, shapeDocument, threadStates } from './lib.mjs';

const ENTRY = fileURLToPath(new URL('./threads.mjs', import.meta.url));
const VIEWER = 'owner';
const REVIEW_FOOTER = `_— 🔎 review by Claude on behalf of ${VIEWER}_`;
const REVIEW_MARKER = '<!-- fp-review agent=claude head=aaaaaaa -->';
const ADDRESS_FOOTER = `_— 🛠️ addressed by Claude on behalf of ${VIEWER}_`;

const person = (login, type = 'User') => ({ login, type });
const at = (minute) => `2026-11-01T10:${String(minute).padStart(2, '0')}:00Z`;

/** A fresh PR: the viewer, the three surfaces and an id counter. */
function world() {
  let next = 1000;
  return { viewer: VIEWER, inline: [], reviews: [], issue: [], id: () => (next += 1) };
}

const surfaces = (w) => ({ viewer: w.viewer, inline: w.inline, reviews: w.reviews, issue: w.issue });

function addressBody({ re, hold = false, failed = false, answers, text = 'Fixed — guarded the empty case.' } = {}) {
  const keys = ['agent=claude', 'head=bbbbbbb', re && `re=${re}`, hold && 'hold=1', failed && 'failed=1', answers && `answers=${answers}`].filter(Boolean);
  return `${text}\n\n${ADDRESS_FOOTER}\n<!-- fp-address ${keys.join(' ')} -->`;
}

const reviewBody = (text) => `${text}\n\n${REVIEW_FOOTER}\n${REVIEW_MARKER}`;

function addReview(w, { login = VIEWER, body, state = 'COMMENTED', minute = 1 }) {
  const review = { id: w.id(), user: person(login), body, state, submitted_at: at(minute), html_url: 'https://github.com/o/r/pull/5#pullrequestreview' };
  w.reviews.push(review);
  return review;
}

function addInline(w, { login = VIEWER, body, minute = 1, reviewId = null, replyTo, type = 'User' }) {
  const comment = {
    id: w.id(),
    user: person(login, type),
    body,
    created_at: at(minute),
    path: 'src/a.js',
    line: 12,
    original_line: 10,
    pull_request_review_id: reviewId,
    html_url: 'https://github.com/o/r/pull/5#discussion',
  };
  if (replyTo !== undefined) {
    comment.in_reply_to_id = replyTo;
  }
  w.inline.push(comment);
  return comment;
}

function addIssue(w, { login = VIEWER, body, minute = 1, type = 'User' }) {
  const comment = { id: w.id(), user: person(login, type), body, created_at: at(minute), html_url: 'https://github.com/o/r/pull/5#issuecomment' };
  w.issue.push(comment);
  return comment;
}

/**
 * The thread shapes: each adds its source at minute 1 and returns the thread
 * key plus a `reply(options)` that posts a paired `fp-address` reply.
 */
const SHAPES = {
  'inline finding': (w) => {
    const review = addReview(w, { body: reviewBody('Two notes inline.') });
    const root = addInline(w, { login: 'reviewer', body: 'The empty input is not guarded.', reviewId: review.id });
    return { key: `inline:${root.id}`, shape: 'inline', source: 'review', root };
  },
  'human inline comment': (w) => {
    const review = addReview(w, { login: 'alice', body: '' });
    const root = addInline(w, { login: 'alice', body: 'Why a loop here?', reviewId: review.id });
    return { key: `inline:${root.id}`, shape: 'inline', source: 'human', root };
  },
  'review-summary finding': (w) => {
    const review = addReview(w, { body: reviewBody('**[F1]**\nFirst finding.\n\n**[F2]**\nSecond finding.') });
    return { key: `review:${review.id}#F2`, shape: 'review-summary', source: 'review' };
  },
  'issue-summary finding': (w) => {
    const note = addIssue(w, { body: reviewBody('[F1] src/a.js:3 — first finding\n[F2] src/b.js:4 — second finding') });
    return { key: `comment:${note.id}#F1`, shape: 'issue-summary', source: 'review' };
  },
  'human review summary': (w) => {
    const review = addReview(w, { login: 'alice', body: 'Please rename `foo` before merging.' });
    return { key: `review:${review.id}`, shape: 'human-review', source: 'human' };
  },
  'human issue comment': (w) => {
    const note = addIssue(w, { login: 'alice', body: 'Can this handle an empty list?' });
    return { key: `comment:${note.id}`, shape: 'human-issue', source: 'human' };
  },
};

/** Post a paired `fp-address` reply to `thread` from `login`. */
function reply(w, thread, { login = VIEWER, minute = 2, ...marker } = {}) {
  if (thread.root) {
    return addInline(w, { login, body: addressBody(marker), minute, replyTo: thread.root.id });
  }
  return addIssue(w, { login, body: addressBody({ re: thread.key, ...marker }), minute });
}

function stateOf(w, key) {
  const found = threadStates(surfaces(w)).threads.filter((thread) => thread.key === key);
  assert(found.length === 1, `expected one thread ${key}, found ${found.length}`);
  return found[0];
}

const keysOf = (w) => threadStates(surfaces(w)).threads.map((thread) => thread.key);

const REPLIES = { open: null, settled: {}, held: { hold: true }, 'fix-failed': { failed: true } };

function matrixCases() {
  const cases = [];
  for (const [shapeName, build] of Object.entries(SHAPES)) {
    for (const [state, marker] of Object.entries(REPLIES)) {
      cases.push([`matrix: ${shapeName} reads ${state}`, () => {
        const w = world();
        const thread = build(w);
        if (marker !== null) {
          reply(w, thread, marker);
        }
        const found = stateOf(w, thread.key);
        equal([found.state, found.shape, found.source], [state, thread.shape, thread.source], thread.key);
        const listedKeys = shapeDocument(threadStates(surfaces(w)), { repo: 'o/r', pr: 5 }).threads.map((item) => item.key);
        equal(listedKeys.includes(thread.key), state !== 'settled', `${thread.key} listed`);
      }]);
    }
  }
  return cases;
}

/** A stub `spawnSync` answering each `gh` argv from `routes`, keyed by endpoint. */
function stubRunner(routes, calls = []) {
  return (command, args) => {
    calls.push([command, ...args]);
    const endpoint = args[1];
    for (const [match, answer] of Object.entries(routes)) {
      if (endpoint === match || endpoint.startsWith(`${match}?`)) {
        return typeof answer === 'function' ? answer(args) : answer;
      }
    }
    return { status: 0, stdout: '[]', stderr: '' };
  };
}

const ok = (value) => ({ status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
const USER = ok({ login: VIEWER });
const ENDPOINTS = ['user', 'repos/o/r/pulls/5/comments', 'repos/o/r/pulls/5/reviews', 'repos/o/r/issues/5/comments'];

const withTemp = (label, fn) => withTempDir(`fp-threads-${label}`, fn);

/** The stand-in `gh`: answers `api <endpoint>` from fixture files in $FAKE_GH_DIR. */
const FAKE_GH = `#!/bin/sh
d="$FAKE_GH_DIR"
if [ "$1" != "api" ]; then echo "unexpected: $*" >&2; exit 3; fi
case "$2" in
  user) cat "$d/user.json"; exit 0 ;;
esac
if [ "$3" != "--paginate" ]; then echo "not paginated: $*" >&2; exit 4; fi
case "$2" in
  */pulls/*/comments\\?*) cat "$d/inline-1.json" "$d/inline-2.json" ;;
  */pulls/*/reviews\\?*) cat "$d/reviews.json" ;;
  */issues/*/comments\\?*) if [ -f "$d/issue-fail" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi; cat "$d/issue.json" ;;
  *) echo "unexpected: $*" >&2; exit 3 ;;
esac
`;

function fakeGh(dir, w) {
  const bin = path.join(dir, 'bin');
  const data = path.join(dir, 'data');
  fs.mkdirSync(bin);
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const half = Math.ceil(w.inline.length / 2);
  fs.writeFileSync(path.join(data, 'user.json'), JSON.stringify({ login: VIEWER }));
  fs.writeFileSync(path.join(data, 'inline-1.json'), JSON.stringify(w.inline.slice(0, half)));
  fs.writeFileSync(path.join(data, 'inline-2.json'), `${JSON.stringify(w.inline.slice(half))}\n`);
  fs.writeFileSync(path.join(data, 'reviews.json'), JSON.stringify(w.reviews));
  fs.writeFileSync(path.join(data, 'issue.json'), JSON.stringify(w.issue));
  return { bin, data };
}

const runEntry = (args, env) => runNode(ENTRY, args, env);

/** A PR with one settled inline finding and one open human issue comment. */
function smallPr() {
  const w = world();
  const thread = SHAPES['inline finding'](w);
  reply(w, thread);
  addInline(w, { login: 'alice', body: 'Agreed.', minute: 1, replyTo: thread.root.id });
  SHAPES['human issue comment'](w);
  return w;
}

const CASES = [
  ...matrixCases(),

  ['ordering: the newest paired reply wins', () => {
    const w = world();
    const thread = SHAPES['human review summary'](w);
    reply(w, thread, { minute: 2 });
    reply(w, thread, { minute: 3, hold: true });
    equal(stateOf(w, thread.key).state, 'held', 'plain then hold');
    const v = world();
    const other = SHAPES['inline finding'](v);
    reply(v, other, { minute: 2, hold: true });
    reply(v, other, { minute: 3 });
    equal(stateOf(v, other.key).state, 'settled', 'hold then plain');
  }],
  ['ordering: equal times break on the higher id', () => {
    const w = world();
    const thread = SHAPES['issue-summary finding'](w);
    reply(w, thread, { minute: 2 });
    reply(w, thread, { minute: 2, failed: true });
    equal(stateOf(w, thread.key).state, 'fix-failed', 'tie');
  }],
  ['re-open: a newer human inline reply re-opens a settled, held or fix-failed thread', () => {
    for (const marker of [{}, { hold: true }, { failed: true }]) {
      const w = world();
      const thread = SHAPES['inline finding'](w);
      reply(w, thread, { minute: 2, ...marker });
      const followup = addInline(w, { login: 'alice', body: 'Still broken for `null`.', minute: 3, replyTo: thread.root.id });
      const found = stateOf(w, thread.key);
      equal([found.state, found.followup.id, found.followup.text], ['open', followup.id, 'Still broken for `null`.'], JSON.stringify(marker));
      const doc = shapeDocument(threadStates(surfaces(w)), { repo: 'o/r', pr: 5 });
      equal([doc.threads[0].followup, doc.threads[0].followup_id], ['Still broken for `null`.', followup.id], 'listed followup');
    }
  }],
  ['re-open: an older human reply, a bot reply or another fp-address reply does not re-open', () => {
    const w = world();
    const thread = SHAPES['inline finding'](w);
    addInline(w, { login: 'alice', body: 'Before the fix.', minute: 2, replyTo: thread.root.id });
    reply(w, thread, { minute: 3 });
    addInline(w, { login: 'ci-bot', type: 'Bot', body: 'Coverage dropped.', minute: 4, replyTo: thread.root.id });
    reply(w, thread, { minute: 5, login: 'mallory' });
    addInline(w, { login: 'alice', body: addressBody({ text: 'Quoted marker.' }), minute: 6, replyTo: thread.root.id });
    addInline(w, { login: 'reviewer', body: reviewBody('A later review note.'), minute: 7, replyTo: thread.root.id });
    equal(stateOf(w, thread.key).state, 'settled', 'still settled');
    reply(w, thread, { minute: 8, hold: true });
    reply(w, thread, { minute: 9 });
    equal(stateOf(w, thread.key).state, 'settled', 'a newer fp-address reply decides, never re-opens');
  }],
  ['author filter: another account\'s fp-address reply changes nothing and is no thread', () => {
    for (const name of ['inline finding', 'human issue comment', 'review-summary finding']) {
      const w = world();
      const thread = SHAPES[name](w);
      const forged = reply(w, thread, { login: 'mallory' });
      equal(stateOf(w, thread.key).state, 'open', name);
      assert(!keysOf(w).some((key) => key.endsWith(`:${forged.id}`)), `${name}: the forged reply is not a thread`);
    }
  }],
  ['author filter: the viewer login matches case-insensitively', () => {
    const w = world();
    w.viewer = 'Owner';
    const thread = SHAPES['human issue comment'](w);
    reply(w, thread);
    equal(stateOf(w, thread.key).state, 'settled', 'mixed case');
  }],
  ['answers: an answers= key from another account is not honoured', () => {
    const w = world();
    const note = addIssue(w, { login: 'alice', body: 'Go with option A.' });
    addIssue(w, { login: 'mallory', body: addressBody({ re: 'review:1', answers: `comment:${note.id}` }), minute: 3 });
    equal(stateOf(w, `comment:${note.id}`).state, 'open', 'still its own thread');
  }],
  ['hold then a top-level answer: the answer settles the held thread and is never listed', () => {
    const w = world();
    const thread = SHAPES['human review summary'](w);
    reply(w, thread, { minute: 2, hold: true });
    const answer = addIssue(w, { login: 'alice', body: 'Option A, please.', minute: 3 });
    equal(stateOf(w, thread.key).state, 'held', 'held before the answer is applied');
    equal(stateOf(w, `comment:${answer.id}`).state, 'open', 'the answer is listed until applied');
    const held = shapeDocument(threadStates(surfaces(w)), { repo: 'o/r', pr: 5 }).threads.find((item) => item.key === thread.key);
    equal(held.reply_at, at(2), 'reply_at on a held thread');
    answer.author_association = 'NONE';
    const listedAnswer = shapeDocument(threadStates(surfaces(w)), { repo: 'o/r', pr: 5 }).threads.find((item) => item.key === `comment:${answer.id}`);
    equal([listedAnswer.author, listedAnswer.author_association], ['alice', 'NONE'], 'the answer carries its author');
    reply(w, thread, { minute: 4, answers: `comment:${answer.id}` });
    equal(stateOf(w, thread.key).state, 'settled', 'settled after the answer');
    assert(!keysOf(w).includes(`comment:${answer.id}`), 'the answering comment is not a thread');
  }],
  ['fix-failed then a fix: the Fixed reply settles the thread', () => {
    const w = world();
    const thread = SHAPES['review-summary finding'](w);
    reply(w, thread, { minute: 2, failed: true });
    equal(stateOf(w, thread.key).state, 'fix-failed', 'before');
    reply(w, thread, { minute: 3 });
    equal(stateOf(w, thread.key).state, 'settled', 'after');
  }],
  ['skipped: empty-review and limit notes, pending reviews, bots, fp-address replies and orphans give no thread', () => {
    const w = world();
    addIssue(w, { body: reviewBody('I reviewed this change and do not see blocking issues.') });
    addIssue(w, { body: `Stopped after 3 rounds.\n\n${REVIEW_FOOTER}\n<!-- fp-limit agent=claude -->` });
    addReview(w, { login: 'alice', body: 'Draft thoughts.', state: 'PENDING' });
    addReview(w, { login: 'alice', body: '', state: 'APPROVED' });
    addIssue(w, { login: 'ci-bot', type: 'Bot', body: 'Build passed.' });
    addIssue(w, { body: addressBody({ re: 'review:999#F1' }) });
    addIssue(w, { login: 'alice', body: null });
    addInline(w, { login: 'alice', body: 'Reply to a missing root.', replyTo: 424242 });
    equal(keysOf(w), [], 'no threads');
  }],
  ['shapes: a tagged body with no review marker is one human thread; the viewer\'s own unmarked comment is human', () => {
    const w = world();
    const review = addReview(w, { login: 'alice', body: '[F1] one\n[F2] two' });
    const mine = addIssue(w, { body: 'Note to self: check the docs.' });
    equal(keysOf(w), [`review:${review.id}`, `comment:${mine.id}`], 'keys');
    equal(stateOf(w, `comment:${mine.id}`).source, 'human', 'own comment');
  }],
  ['shapes: an inline comment carrying the review footer is a finding without a marked review', () => {
    const w = world();
    const root = addInline(w, { login: 'reviewer', body: reviewBody('Off by one.') });
    const found = stateOf(w, `inline:${root.id}`);
    equal([found.source, found.text, found.line], ['review', 'Off by one.', 12], 'inline');
  }],
  ['findings: split on tags, stop at the footer, fold a repeated ordinal', () => {
    const body = `intro\n**[F1]**\nalpha\n- [F2] beta\n[F1] more alpha\n\n${REVIEW_FOOTER}\n[F3] after the footer`;
    equal(findings(body), [{ k: 1, text: '**[F1]**\nalpha\n[F1] more alpha' }, { k: 2, text: '- [F2] beta' }], 'findings');
  }],
  ['markers: keys parse, malformed values read as absent, the last marker wins', () => {
    equal(addressMarker('no marker'), null, 'none');
    const parsed = addressMarker('x\n<!-- fp-address agent=claude head=1 re=review:7#F2 failed=1 -->');
    equal([parsed.re, parsed.failed, parsed.hold], ['review:7#F2', true, false], 'keys');
    equal(addressMarker('<!-- fp-address agent=claude head=1 re=review:x answers=issue:3 -->').re, undefined, 'bad re');
    equal(addressMarker('<!-- fp-address re=comment:1 -->\n<!-- fp-address re=comment:2 hold=1 -->').re, 'comment:2', 'last');
    equal(addressMarker('<!-- fp-address unterminated'), {}, 'unterminated');
  }],
  ['markers: a marker quoted inside a line is text, not a marker', () => {
    const w = world();
    const summary = addIssue(w, { body: reviewBody('[F1] the grammar line `<!-- fp-address agent=claude head=1 failed=1 -->` omits a key\n[F2] second finding') });
    const human = addIssue(w, { login: 'alice', body: 'Should `<!-- fp-review agent=claude head=1 -->` carry the round?' });
    equal(keysOf(w), [`comment:${summary.id}#F1`, `comment:${summary.id}#F2`, `comment:${human.id}`], 'quoted markers keep their threads');
    equal(addressMarker('see `<!-- fp-address re=comment:1 -->` here'), null, 'mid-line');
  }],
  ['pages: concatenated pages parse, strings may hold brackets, garbage is rejected', () => {
    equal(parsePages('[{"a":"]["}]\n[{"b":"\\"]"}]'), [{ a: '][' }, { b: '"]' }], 'two pages');
    equal(parsePages(''), [], 'empty');
    equal(parsePages('[]\n'), [], 'one empty page');
    for (const bad of ['{"a":1}', '[1] x', '[1', '[1]]', '"text"']) {
      throwsKind(() => parsePages(bad), ComputeError, 'unexpected gh output');
    }
  }],
  ['bound: long text is cut by characters', () => {
    const w = world();
    const note = addIssue(w, { login: 'alice', body: '😀'.repeat(MAX_TEXT_CHARS + 500) });
    const doc = shapeDocument(threadStates(surfaces(w)), { repo: 'o/r', pr: 5 });
    equal([doc.threads[0].id, doc.threads[0].cut, Array.from(doc.threads[0].text).length], [note.id, true, MAX_TEXT_CHARS], 'cut');
  }],
  ['bound: text is dropped from the last thread backwards', () => {
    const w = world();
    for (let index = 0; index < 20; index += 1) {
      addIssue(w, { login: 'alice', body: `${index} ${'x'.repeat(1400)}`, minute: index });
    }
    const doc = shapeDocument(threadStates(surfaces(w)), { repo: 'o/r', pr: 5 });
    assert(Buffer.byteLength(render(doc)) <= MAX_DOCUMENT_BYTES, 'within the bound');
    equal([doc.complete, doc.threads.length, doc.threads[0].text_omitted, doc.threads.at(-1).text_omitted], [true, 20, undefined, true], 'shape');
    const kept = doc.threads.filter((thread) => thread.text !== undefined).length;
    assert(kept > 0 && doc.threads.slice(0, kept).every((thread) => thread.text !== undefined), 'text kept on a prefix');
  }],
  ['bound: past the text-free listing, a prefix is listed with complete false', () => {
    const w = world();
    for (let index = 0; index < 300; index += 1) {
      addIssue(w, { login: 'alice', body: `ask ${index}` });
    }
    const doc = shapeDocument(threadStates(surfaces(w)), { repo: 'o/r', pr: 5 });
    assert(Buffer.byteLength(render(doc)) <= MAX_DOCUMENT_BYTES, 'within the bound');
    equal([doc.complete, doc.threads.length + doc.counts.unlisted, doc.counts.open], [false, 300, 300], 'prefix');
    assert(doc.threads.length > 0 && doc.threads.every((thread) => thread.text_omitted), 'text-free prefix');
    assert(render(doc).indexOf('"complete"') < render(doc).indexOf('"threads"'), 'complete sorts first');
  }],
  ['document: settled threads are a count only, keys and counts are as documented', () => {
    const w = world();
    const settled = SHAPES['inline finding'](w);
    reply(w, settled);
    const failed = SHAPES['human issue comment'](w);
    reply(w, failed, { failed: true });
    const doc = shapeDocument(threadStates(surfaces(w)), { repo: 'o/r', pr: 5 });
    equal(Object.keys(doc).sort(), ['complete', 'counts', 'ok', 'pr', 'repo', 'threads', 'viewer'], 'top-level keys');
    equal(doc.counts, { open: 0, settled: 1, held: 0, fix_failed: 1, unlisted: 0 }, 'counts');
    equal(doc.threads.map((thread) => [thread.key, thread.state, thread.reply_at]), [[failed.key, 'fix-failed', at(2)]], 'listed');
  }],
  ['args: the flags and the self-test flag parse', () => {
    equal(parseArgv(['--self-test']), { selfTest: true }, 'self-test');
    equal(parseArgv(['--pr', '7', '--repo', 'snadtochii/feature-pipeline']), { repo: 'snadtochii/feature-pipeline', pr: 7 }, 'flags');
  }],
  ['args: every bad invocation is a UsageError', () => {
    const bad = [
      [],
      ['--repo', 'o/r'],
      ['--pr', '1'],
      ['--repo', 'o/r', '--pr', '0'],
      ['--repo', 'o/r', '--pr', '1x'],
      ['--repo', '../..', '--pr', '1'],
      ['--repo', 'o/..', '--pr', '1'],
      ['--repo', 'o', '--pr', '1'],
      ['--repo', 'o/r;rm', '--pr', '1'],
      ['--repo', 'o/r', '--pr', '1', '--pr', '2'],
      ['--bogus', 'x'],
      ['--repo'],
      ['--self-test', '--repo', 'o/r'],
    ];
    for (const argv of bad) {
      throwsKind(() => parseArgv(argv), UsageError);
    }
  }],
  ['reads: four argv-array gh calls, paginated lists, two pages joined', () => {
    const calls = [];
    const runner = stubRunner({ user: USER, 'repos/o/r/pulls/5/comments': ok('[{"id":1}]\n[{"id":2}]') }, calls);
    const read = readAll({ repo: 'o/r', pr: 5, runner });
    equal([read.viewer, read.inline.length, read.reviews, read.issue], [VIEWER, 2, [], []], 'read');
    equal(calls.map((call) => call.slice(1).join(' ')), [
      'api user',
      'api repos/o/r/pulls/5/comments?per_page=100 --paginate',
      'api repos/o/r/pulls/5/reviews?per_page=100 --paginate',
      'api repos/o/r/issues/5/comments?per_page=100 --paginate',
    ], 'argv');
  }],
  ['reads: each failing read is a ComputeError', () => {
    for (const endpoint of ENDPOINTS) {
      const routes = { user: USER, [endpoint]: { status: 1, stdout: '', stderr: 'HTTP 404: Not Found\n' } };
      throwsKind(() => readAll({ repo: 'o/r', pr: 5, runner: stubRunner(routes) }), ComputeError, 'exited 1: HTTP 404: Not Found');
      const missing = { user: USER, [endpoint]: { error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) } };
      throwsKind(() => readAll({ repo: 'o/r', pr: 5, runner: stubRunner(missing) }), ComputeError, 'gh not found on PATH');
      const garbage = { user: USER, [endpoint]: ok('<html>') };
      throwsKind(() => readAll({ repo: 'o/r', pr: 5, runner: stubRunner(garbage) }), ComputeError, 'unexpected gh output');
    }
    throwsKind(() => readAll({ repo: 'o/r', pr: 5, runner: stubRunner({ user: ok({ login: '' }) }) }), ComputeError, 'no login');
  }],
  ['entry: a stand-in gh gives exit 0 and one ok document', () => withTemp('ok', async (dir) => {
    const { bin, data } = fakeGh(dir, smallPr());
    const run = await runEntry(['--repo', 'o/r', '--pr', '5'], { PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, FAKE_GH_DIR: data });
    equal([run.status, run.doc?.ok, run.doc?.counts, run.doc?.threads.map((thread) => thread.shape)], [0, true, { fix_failed: 0, held: 0, open: 1, settled: 1, unlisted: 0 }, ['human-issue']], `doc (stderr: ${run.stderr})`);
  })],
  ['entry: a failing read gives exit 1 and an error document', () => withTemp('fail', async (dir) => {
    const { bin, data } = fakeGh(dir, smallPr());
    fs.writeFileSync(path.join(data, 'issue-fail'), '');
    const run = await runEntry(['--repo', 'o/r', '--pr', '5'], { PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, FAKE_GH_DIR: data });
    equal([run.status, run.doc?.ok], [1, false], 'status');
    assert(run.doc.error.includes('issues/5/comments') && run.doc.error.includes('HTTP 502'), `error: ${run.doc.error}`);
  })],
  ['entry: a bad --pr gives exit 2', () => withTemp('usage', async (dir) => {
    const run = await runEntry(['--repo', 'o/r', '--pr', 'x'], { PATH: dir });
    equal([run.status, run.doc?.ok, typeof run.doc?.error], [2, false, 'string'], 'usage');
  })],
  ['entry: gh missing from PATH gives exit 1', () => withTemp('nogh', async (dir) => {
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);
    const run = await runEntry(['--repo', 'o/r', '--pr', '5'], { PATH: empty });
    equal([run.status, run.doc?.ok, run.doc?.error], [1, false, 'gh not found on PATH'], 'missing');
  })],
];

/** Run every case; return the document, or throw a ComputeError naming the first failure. */
export async function runSelfTest() {
  for (const [name, fn] of CASES) {
    try {
      await fn();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ComputeError(`self-test: ${name} — ${detail}`);
    }
  }
  return { cases: CASES.length, ok: true };
}
