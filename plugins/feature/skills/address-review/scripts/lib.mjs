// The address-review thread-state reader's rules: argument parsing, the `gh`
// reads, the item parser, the marker and finding parsers, the thread-state
// classifier (../../review/references/pr-comments.md §9) and the bounded
// output document (../SKILL.md Step 2). The output contract and the `gh`
// runner are the plugin's shared script modules.
//
// Private to the implementation: only threads.mjs is a command.

import { spawnSync } from 'node:child_process';

import { ghStdout } from '../../../scripts/lib/gh.mjs';
import { ComputeError, UsageError, errorDoc as errorLine, largestFit, oneLine, render } from '../../../scripts/lib/output.mjs';

const USAGE = 'usage: threads.mjs --repo <owner>/<repo> --pr <number> | threads.mjs --self-test';

const FLAGS = { '--repo': 'repo', '--pr': 'pr' };
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR_NUMBER = /^[1-9][0-9]{0,9}$/;

export const MAX_DOCUMENT_BYTES = 16 * 1024;
export const MAX_TEXT_CHARS = 1500;

const REVIEW_FOOTER = /^_— 🔎/u;
const ANY_FOOTER = /^_— (?:🔎|🛠)/u;
const MARKER_LINE = /^<!-- (fp-[a-z]+)(?:[ \t]+([^\n]*?))?[ \t]*-->$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const FINDING_TAG = /^\s*(?:[-*]\s+)?(?:\*\*)?\[F([1-9][0-9]*)\]/;
const RE_KEY = /^(?:review|comment):[0-9]+(?:#F[0-9]+)?$/;
const ANSWERS_KEY = /^comment:[0-9]+$/;

/** The failure document for a thrown error: its message on one line, and `ok: false`. */
export function errorDoc(err) {
  return { ...errorLine(err), ok: false };
}

/** Parse the command line into `{ selfTest }` or `{ repo, pr }`. Pure. */
export function parseArgv(argv) {
  if (argv.length === 1 && argv[0] === '--self-test') {
    return { selfTest: true };
  }
  if (argv.length === 0) {
    throw new UsageError(USAGE);
  }
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!Object.hasOwn(FLAGS, flag)) {
      throw new UsageError(`unknown argument ${oneLine(flag).slice(0, 40)}; ${USAGE}`);
    }
    const field = FLAGS[flag];
    const value = argv[index + 1];
    if (typeof value !== 'string' || value === '') {
      throw new UsageError(`${flag} needs a value`);
    }
    if (Object.hasOwn(parsed, field)) {
      throw new UsageError(`${flag} given twice`);
    }
    parsed[field] = value;
  }
  for (const flag of Object.keys(FLAGS)) {
    if (parsed[FLAGS[flag]] === undefined) {
      throw new UsageError(`${flag} is required`);
    }
  }
  const segments = parsed.repo.split('/');
  if (!REPO.test(parsed.repo) || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new UsageError('--repo must be <owner>/<repo>');
  }
  if (!PR_NUMBER.test(parsed.pr)) {
    throw new UsageError('--pr must be a pull-request number');
  }
  return { repo: parsed.repo, pr: Number(parsed.pr) };
}

const UNEXPECTED = 'unexpected gh output';

/**
 * The items `gh api --paginate --jq '.[]'` prints, one compact JSON object per
 * line. Empty output is no items; a line that is not a JSON object is a
 * ComputeError. Pure.
 */
export function parseItems(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        throw new ComputeError(UNEXPECTED);
      }
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new ComputeError(UNEXPECTED);
      }
      return item;
    });
}

function readViewer(runner) {
  let login;
  try {
    login = JSON.parse(ghStdout(['api', 'user'], { runner })).login;
  } catch (err) {
    if (err instanceof ComputeError) {
      throw err;
    }
    throw new ComputeError(UNEXPECTED);
  }
  if (typeof login !== 'string' || login === '') {
    throw new ComputeError('gh api user returned no login');
  }
  return login;
}

const readList = (endpoint, runner) => parseItems(ghStdout(['api', `${endpoint}?per_page=100`, '--paginate', '--jq', '.[]'], { runner }));

/** The viewer and the PR's three comment surfaces, read through `gh api`. */
export function readAll({ repo, pr, runner = spawnSync }) {
  return {
    viewer: readViewer(runner),
    inline: readList(`repos/${repo}/pulls/${pr}/comments`, runner),
    reviews: readList(`repos/${repo}/pulls/${pr}/reviews`, runner),
    issue: readList(`repos/${repo}/issues/${pr}/comments`, runner),
  };
}

const bodyOf = (item) => (typeof item?.body === 'string' ? item.body : '');

/**
 * Each line of `body` with whether it sits inside a fenced code block, the
 * fence lines themselves counted as fenced. Pure.
 */
function scanLines(body) {
  const out = [];
  let fence = null;
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (fence === null) {
      const open = FENCE_OPEN.exec(line);
      if (open) {
        fence = open[1];
      }
      out.push({ line, fenced: fence !== null });
      continue;
    }
    const close = FENCE_CLOSE.exec(line);
    if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
      fence = null;
    }
    out.push({ line, fenced: true });
  }
  return out;
}

/**
 * Where an automated post signs itself, over `scanLines` output: its last
 * non-blank line outside a fence, which is the hidden marker when it has one,
 * and the line before a trailing marker, which is the footer.
 * `{ marker, footer, markerAt, footerAt }` — each line and its index in
 * `scanned`, or null. A marker or footer anywhere else is text. Pure.
 */
function signatureOf(scanned) {
  const lines = scanned.map((entry, index) => ({ ...entry, index })).filter((entry) => entry.line.trim() !== '');
  const none = { marker: null, footer: null, markerAt: null, footerAt: null };
  const last = lines.at(-1);
  if (last === undefined || last.fenced) {
    return none;
  }
  const tail = last.line.trim();
  if (!MARKER_LINE.test(tail)) {
    return ANY_FOOTER.test(tail) ? { ...none, footer: tail, footerAt: last.index } : none;
  }
  const before = lines.at(-2);
  if (before !== undefined && !before.fenced && ANY_FOOTER.test(before.line.trim())) {
    return { marker: tail, footer: before.line.trim(), markerAt: last.index, footerAt: before.index };
  }
  return { ...none, marker: tail, markerAt: last.index };
}

const signature = (body) => signatureOf(scanLines(body));

/** The index of the first signature line of `scanned`, or its length when it has none. */
function signatureStart(scanned) {
  const { markerAt, footerAt } = signatureOf(scanned);
  return footerAt ?? markerAt ?? scanned.length;
}

/** The kind (`fp-address`, `fp-review`, …) and key text of `body`'s trailing marker, or null. Pure. */
function trailingMarker(body) {
  const { marker } = signature(body);
  const match = marker === null ? null : MARKER_LINE.exec(marker);
  return match === null ? null : { kind: match[1], keys: match[2] ?? '' };
}

/** Whether `body` signs itself with an fp footer or an fp marker. Pure. */
export function isMarked(body) {
  const { marker, footer } = signature(body);
  return marker !== null || footer !== null;
}

/** Whether `body` signs itself with a review footer or an `fp-review` marker. Pure. */
export function isReviewMarked(body) {
  const { footer } = signature(body);
  return trailingMarker(body)?.kind === 'fp-review' || (footer !== null && REVIEW_FOOTER.test(footer));
}

/**
 * The keys of `body`'s trailing `fp-address` marker, or null when it does not
 * end with a complete one. A malformed `re=` or `answers=` value reads as
 * absent. Pure.
 */
export function addressMarker(body) {
  const marker = trailingMarker(body);
  if (marker === null || marker.kind !== 'fp-address') {
    return null;
  }
  const keys = {};
  for (const token of marker.keys.split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq > 0) {
      keys[token.slice(0, eq)] = token.slice(eq + 1);
    }
  }
  return {
    agent: keys.agent,
    head: keys.head,
    re: RE_KEY.test(keys.re ?? '') ? keys.re : undefined,
    answers: ANSWERS_KEY.test(keys.answers ?? '') ? keys.answers : undefined,
    hold: keys.hold === '1',
    failed: keys.failed === '1',
  };
}

/** `body` without its signature lines, trimmed. Pure. */
export function visibleText(body) {
  const scanned = scanLines(body);
  return scanned
    .slice(0, signatureStart(scanned))
    .map((entry) => entry.line)
    .join('\n')
    .trim();
}

/**
 * The `[F<k>]` findings of a review summary, in order: `{ k, text }`, each
 * running to the next unfenced tag and stopping at the signature. A repeated
 * ordinal is folded into its first occurrence. Pure.
 */
export function findings(body) {
  const found = new Map();
  let current = null;
  const scanned = scanLines(body);
  for (const { line, fenced } of scanned.slice(0, signatureStart(scanned))) {
    const tag = fenced ? null : FINDING_TAG.exec(line);
    if (tag) {
      const k = Number(tag[1]);
      current = found.get(k) ?? { k, lines: [] };
      found.set(k, current);
    }
    if (current) {
      current.lines.push(line);
    }
  }
  return [...found.values()].map(({ k, lines }) => ({ k, text: lines.join('\n').trim() }));
}

const isBot = (item) => item?.user?.type === 'Bot';
const loginOf = (item) => String(item?.user?.login ?? '').toLowerCase();

/** Compare two `{ at, id }` records oldest first, ties broken by numeric id. */
function byTime(a, b) {
  if (a.at !== b.at) {
    return a.at < b.at ? -1 : 1;
  }
  return a.id - b.id;
}

const newest = (records) => records.reduce((best, record) => (best === null || byTime(record, best) > 0 ? record : best), null);

function stateOf(reply) {
  if (reply === null) {
    return 'open';
  }
  if (reply.marker.failed) {
    return 'fix-failed';
  }
  if (reply.marker.hold) {
    return 'held';
  }
  return 'settled';
}

/** The root id of an inline comment's thread, or null when the root is not in the read set. */
function rootOf(comment, byId) {
  let node = comment;
  const seen = new Set();
  while (node.in_reply_to_id !== undefined && node.in_reply_to_id !== null) {
    if (seen.has(node.id)) {
      return null;
    }
    seen.add(node.id);
    node = byId.get(node.in_reply_to_id);
    if (node === undefined) {
      return null;
    }
  }
  return node.id;
}

function record(item, at) {
  return {
    at: String(at ?? ''),
    id: Number(item.id),
    url: item.html_url,
    author: String(item?.user?.login ?? ''),
    association: String(item?.author_association ?? ''),
  };
}

/**
 * Every thread on the PR with its state, per pr-comments.md §9: the newest
 * `fp-address` reply the viewer posted that pairs with the thread decides it,
 * and on an inline thread a newer unmarked comment re-opens it. Pure.
 */
export function threadStates({ viewer, inline, reviews, issue }) {
  const me = String(viewer).toLowerCase();
  const people = (list) => list.filter((item) => item && !isBot(item));
  const comments = inline.filter(Boolean);
  const notes = people(issue);
  const summaries = people(reviews).filter((review) => review.state !== 'PENDING');

  const isAddress = (item) => addressMarker(bodyOf(item)) !== null;
  const mine = (item) => loginOf(item) === me;

  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const inlineReplies = new Map();
  const inlineFollowups = new Map();
  for (const comment of people(comments)) {
    if (comment.in_reply_to_id === undefined || comment.in_reply_to_id === null) {
      continue;
    }
    const root = rootOf(comment, byId);
    if (root === null) {
      continue;
    }
    if (isAddress(comment)) {
      if (mine(comment)) {
        const list = inlineReplies.get(root) ?? [];
        list.push({ ...record(comment, comment.created_at), marker: addressMarker(bodyOf(comment)) });
        inlineReplies.set(root, list);
      }
    } else if (!isMarked(bodyOf(comment))) {
      const list = inlineFollowups.get(root) ?? [];
      list.push({ ...record(comment, comment.created_at), text: visibleText(bodyOf(comment)) });
      inlineFollowups.set(root, list);
    }
  }

  const topReplies = new Map();
  const answered = new Set();
  for (const note of notes) {
    if (!isAddress(note) || !mine(note)) {
      continue;
    }
    const marker = addressMarker(bodyOf(note));
    if (marker.answers) {
      answered.add(marker.answers);
    }
    if (marker.re) {
      const list = topReplies.get(marker.re) ?? [];
      list.push({ ...record(note, note.created_at), marker });
      topReplies.set(marker.re, list);
    }
  }

  const reviewMarked = new Map(summaries.map((review) => [review.id, isReviewMarked(bodyOf(review))]));
  const threads = [];

  for (const comment of comments) {
    if ((comment.in_reply_to_id !== undefined && comment.in_reply_to_id !== null) || isAddress(comment)) {
      continue;
    }
    const followups = inlineFollowups.get(comment.id) ?? [];
    const bot = isBot(comment);
    if (bot && followups.length === 0) {
      continue;
    }
    const body = bodyOf(comment);
    const automated = !bot && (isReviewMarked(body) || reviewMarked.get(comment.pull_request_review_id) === true);
    threads.push({
      ...record(comment, comment.created_at),
      key: `inline:${comment.id}`,
      shape: 'inline',
      source: automated ? 'review' : 'human',
      path: comment.path,
      line: comment.line ?? comment.original_line ?? null,
      text: visibleText(body),
      replies: inlineReplies.get(comment.id) ?? [],
      followups,
    });
  }

  for (const review of summaries) {
    const body = bodyOf(review);
    if (body.trim() === '' || isAddress(review)) {
      continue;
    }
    if (reviewMarked.get(review.id)) {
      for (const { k, text } of findings(body)) {
        const key = `review:${review.id}#F${k}`;
        threads.push({ ...record(review, review.submitted_at), key, k, shape: 'review-summary', source: 'review', text, replies: topReplies.get(key) ?? [] });
      }
    } else if (!isMarked(body)) {
      const key = `review:${review.id}`;
      threads.push({ ...record(review, review.submitted_at), key, shape: 'human-review', source: 'human', text: visibleText(body), replies: topReplies.get(key) ?? [] });
    }
  }

  for (const note of notes) {
    const body = bodyOf(note);
    if (isAddress(note)) {
      continue;
    }
    if (isReviewMarked(body)) {
      for (const { k, text } of findings(body)) {
        const key = `comment:${note.id}#F${k}`;
        threads.push({ ...record(note, note.created_at), key, k, shape: 'issue-summary', source: 'review', text, replies: topReplies.get(key) ?? [] });
      }
    } else if (!isMarked(body) && body.trim() !== '' && !answered.has(`comment:${note.id}`)) {
      const key = `comment:${note.id}`;
      threads.push({ ...record(note, note.created_at), key, shape: 'human-issue', source: 'human', text: visibleText(body), replies: topReplies.get(key) ?? [] });
    }
  }

  const counts = { open: 0, settled: 0, held: 0, fix_failed: 0 };
  const result = threads.map(({ replies, followups = [], ...thread }) => {
    const reply = newest(replies);
    const unanswered = followups.filter((item) => reply === null || byTime(item, reply) > 0).sort(byTime);
    const state = reply !== null && unanswered.length > 0 ? 'open' : stateOf(reply);
    counts[state === 'fix-failed' ? 'fix_failed' : state] += 1;
    return { ...thread, state, reply, followups: unanswered };
  });
  result.sort((a, b) => byTime(a, b) || (a.k ?? 0) - (b.k ?? 0));
  return { viewer, threads: result, counts };
}

function capped(text) {
  const chars = Array.from(text);
  return chars.length > MAX_TEXT_CHARS ? { text: chars.slice(0, MAX_TEXT_CHARS).join(''), cut: true } : { text, cut: false };
}

function listed(thread, withText) {
  const out = {
    key: thread.key,
    shape: thread.shape,
    source: thread.source,
    state: thread.state,
    id: thread.id,
    k: thread.k,
    at: thread.at,
    url: thread.url,
    author: thread.author,
    author_association: thread.association,
    path: thread.path,
    line: thread.line,
  };
  if (thread.reply !== null) {
    out.reply_at = thread.reply.at;
    out.reply_url = thread.reply.url;
  }
  if (thread.followups?.length > 0) {
    out.followups = thread.followups.map((followup) => {
      const entry = { id: followup.id, at: followup.at, author: followup.author, author_association: followup.association };
      if (withText) {
        const text = capped(followup.text);
        entry.text = text.text;
        if (text.cut) {
          entry.cut = true;
        }
      }
      return entry;
    });
  }
  if (!withText) {
    out.text_omitted = true;
    return out;
  }
  const text = capped(thread.text);
  out.text = text.text;
  if (text.cut) {
    out.cut = true;
  }
  return out;
}

/**
 * The output document for a `threadStates` result: settled threads as a count,
 * every other thread listed oldest first, bounded to MAX_DOCUMENT_BYTES by
 * dropping text from the last thread backwards and then, when even that does
 * not fit, listing only the first threads. Pure.
 */
export function shapeDocument(result, { repo, pr }) {
  const open = result.threads.filter((thread) => thread.state !== 'settled');
  const build = (count, withTextCount) => ({
    ok: true,
    repo,
    pr,
    viewer: result.viewer,
    complete: count === open.length,
    counts: { ...result.counts, unlisted: open.length - count },
    threads: open.slice(0, count).map((thread, index) => listed(thread, index < withTextCount)),
  });
  const fits = (doc) => Buffer.byteLength(render(doc)) <= MAX_DOCUMENT_BYTES;
  const textCount = largestFit(open.length, (n) => fits(build(open.length, n)));
  if (fits(build(open.length, textCount))) {
    return build(open.length, textCount);
  }
  return build(largestFit(open.length, (n) => fits(build(n, 0))), 0);
}
