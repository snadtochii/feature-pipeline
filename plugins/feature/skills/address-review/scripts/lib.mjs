// The address-review thread-state reader's rules: argument parsing, the `gh`
// reads, the page parser, the marker and finding parsers, the thread-state
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

const REVIEW_FOOTER = /^_— 🔎/mu;
const ANY_FOOTER = /^_— (?:🔎|🛠)/mu;
const FP_MARKER = /^[ \t]*<!-- fp-/m;
const REVIEW_MARKER = /^[ \t]*<!-- fp-review[\s>]/m;
const ADDRESS_MARKER_LINE = /^[ \t]*<!-- fp-address[ \t]([^\n]*?)[ \t]*-->[ \t\r]*$/gm;
const ADDRESS_MARKER = /^[ \t]*<!-- fp-address[\s>]/m;
const FINDING_TAG = /^\s*(?:[-*]\s+)?(?:\*\*)?\[F([1-9][0-9]*)\]/;
const HIDDEN_LINE = /^\s*<!-- fp-[^\n]*-->\s*$/;
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
 * The items of the JSON arrays `text` holds one after another, as
 * `gh api --paginate` prints them. Empty output is no items; anything that is
 * not a run of arrays is a ComputeError. Pure.
 */
export function parsePages(text) {
  const items = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (depth === 0) {
      if (/\s/.test(char)) {
        continue;
      }
      if (char !== '[') {
        throw new ComputeError(UNEXPECTED);
      }
      start = index;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '[' || char === '{') {
      depth += 1;
    } else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        let page;
        try {
          page = JSON.parse(text.slice(start, index + 1));
        } catch {
          throw new ComputeError(UNEXPECTED);
        }
        if (!Array.isArray(page)) {
          throw new ComputeError(UNEXPECTED);
        }
        items.push(...page);
      }
    }
  }
  if (depth !== 0 || inString) {
    throw new ComputeError(UNEXPECTED);
  }
  return items;
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

const readList = (endpoint, runner) => parsePages(ghStdout(['api', `${endpoint}?per_page=100`, '--paginate'], { runner }));

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

/** Whether `body` carries an fp footer or an fp marker. Pure. */
export function isMarked(body) {
  return ANY_FOOTER.test(body) || FP_MARKER.test(body);
}

/** Whether `body` carries a review footer or an `fp-review` marker. Pure. */
export function isReviewMarked(body) {
  return REVIEW_FOOTER.test(body) || REVIEW_MARKER.test(body);
}

/**
 * The keys of the last `fp-address` marker line in `body`, or null when it has
 * none. A malformed `re=` or `answers=` value reads as absent. Pure.
 */
export function addressMarker(body) {
  const lines = [...body.matchAll(ADDRESS_MARKER_LINE)];
  if (lines.length === 0) {
    return ADDRESS_MARKER.test(body) ? {} : null;
  }
  const keys = {};
  for (const token of lines.at(-1)[1].split(/\s+/)) {
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

/** `body` without its footer and hidden-marker lines, trimmed. Pure. */
export function visibleText(body) {
  return body
    .split('\n')
    .filter((line) => !ANY_FOOTER.test(line) && !HIDDEN_LINE.test(line))
    .join('\n')
    .trim();
}

/**
 * The `[F<k>]` findings of a review summary, in order: `{ k, text }`, each
 * running to the next tag and stopping at the footer. A repeated ordinal is
 * folded into its first occurrence. Pure.
 */
export function findings(body) {
  const found = new Map();
  let current = null;
  for (const line of body.split('\n')) {
    if (ANY_FOOTER.test(line)) {
      break;
    }
    if (HIDDEN_LINE.test(line)) {
      continue;
    }
    const tag = FINDING_TAG.exec(line);
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
  const comments = people(inline);
  const notes = people(issue);
  const summaries = people(reviews).filter((review) => review.state !== 'PENDING');

  const isAddress = (item) => addressMarker(bodyOf(item)) !== null;
  const mine = (item) => loginOf(item) === me;

  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const inlineReplies = new Map();
  const inlineFollowups = new Map();
  for (const comment of comments) {
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
    const body = bodyOf(comment);
    const automated = isReviewMarked(body) || reviewMarked.get(comment.pull_request_review_id) === true;
    threads.push({
      ...record(comment, comment.created_at),
      key: `inline:${comment.id}`,
      shape: 'inline',
      source: automated ? 'review' : 'human',
      path: comment.path,
      line: comment.line ?? comment.original_line ?? null,
      text: visibleText(body),
      replies: inlineReplies.get(comment.id) ?? [],
      followups: inlineFollowups.get(comment.id) ?? [],
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
  const result = threads.map(({ replies, followups, ...thread }) => {
    const reply = newest(replies);
    let state = stateOf(reply);
    let followup = null;
    if (reply !== null && followups !== undefined) {
      followup = newest(followups.filter((item) => byTime(item, reply) > 0));
      if (followup !== null) {
        state = 'open';
      }
    }
    counts[state === 'fix-failed' ? 'fix_failed' : state] += 1;
    return { ...thread, state, reply, followup };
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
  if (thread.followup !== null) {
    out.followup_id = thread.followup.id;
    out.followup_at = thread.followup.at;
    out.followup_author = thread.followup.author;
    out.followup_author_association = thread.followup.association;
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
  if (thread.followup !== null) {
    const followup = capped(thread.followup.text);
    out.followup = followup.text;
    if (followup.cut) {
      out.followup_cut = true;
    }
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
