// Finding targets in the page and polling conditions (CONTRACT.md §7).
//
// Targets reach the page only as JSON-encoded literals. Conditions are polled
// every 100 ms up to the step's timeout; a protocol error during a poll (a
// navigation destroying the context) is retried, anything else propagates.
//
// Private to the implementation: only cli.mjs is a command.

import { CdpError } from './cdp.mjs';
import { sleep } from './proc.mjs';

const POLL_MS = 100;

/** A step did not succeed; the run records it and does not exit non-zero. */
export class StepFailure extends Error {}

// Runs in the page. `kind` is 'testid' or 'text'; `action` is 'locate',
// 'scroll' (locate after scrolling into view) or 'focus'. Returns
// { count, rect } where count is the number of visible matches.
const PAGE_FIND = `function (kind, value, action) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) { return false; }
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  let matches = [];
  if (kind === 'testid') {
    matches = Array.from(document.querySelectorAll('[data-testid="' + CSS.escape(value) + '"]')).filter(visible);
  } else {
    const want = norm(value);
    // The pre-filter ignores case and whitespace: rendered text (innerText)
    // carries CSS text-transform and block separators that the DOM text
    // (textContent) lacks, so a stricter filter could drop a real match.
    const key = (s) => String(s || '').replace(/\\s+/g, '').toLowerCase();
    const wantKey = key(want);
    const candidates = Array.from(document.querySelectorAll('body, body *'))
      .filter((el) => key(el.textContent).includes(wantKey));
    // Innermost first: descendants follow their ancestors in document order,
    // so walking backwards visits them first and every ancestor of a match is
    // skipped without measuring its text.
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const el = candidates[i];
      if (matches.some((m) => el.contains(m))) { continue; }
      if (visible(el) && (norm(el.innerText) === want || norm(el.textContent) === want)) {
        matches.push(el);
      }
    }
    matches.reverse();
  }
  const count = matches.length;
  if (count === 0) { return { count: 0, rect: null }; }
  const el = matches[0];
  if (action === 'scroll' || action === 'focus') {
    el.scrollIntoView({ block: 'center', inline: 'center' });
  }
  if (action === 'focus') {
    el.focus();
    if (typeof el.select === 'function') {
      el.select();
    } else if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
  const r = el.getBoundingClientRect();
  return { count, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
}`;

async function evaluate(cdp, expression, timeoutMs) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }, { timeoutMs });
  if (res.exceptionDetails) {
    const text = res.exceptionDetails.exception && res.exceptionDetails.exception.description
      ? res.exceptionDetails.exception.description
      : res.exceptionDetails.text;
    throw new CdpError('Runtime.evaluate', { message: text });
  }
  return res.result ? res.result.value : undefined;
}

function find(cdp, kind, value, action) {
  const expression = `(${PAGE_FIND})(${JSON.stringify(kind)}, ${JSON.stringify(value)}, ${JSON.stringify(action)})`;
  return evaluate(cdp, expression, 5000);
}

/**
 * Poll `check` until it returns { done: true, value } or the timeout passes.
 * A CdpError counts as "not yet"; anything else propagates.
 */
async function poll(timeoutMs, check) {
  const deadline = Date.now() + timeoutMs;
  let reason = 'condition not met';
  for (;;) {
    try {
      const out = await check();
      if (out.done) {
        return out.value;
      }
      reason = out.reason;
    } catch (err) {
      if (!(err instanceof CdpError)) {
        throw err;
      }
      reason = err.message;
    }
    if (Date.now() >= deadline) {
      throw new StepFailure(`${reason} after ${timeoutMs} ms`);
    }
    await sleep(POLL_MS);
  }
}

function describe(kind, value) {
  return `${kind} ${JSON.stringify(value)}`;
}

/** Wait for exactly one visible testid match, or the first visible text match. */
export function locate(cdp, kind, value, action, timeoutMs) {
  return poll(timeoutMs, async () => {
    const found = await find(cdp, kind, value, action);
    if (!found || found.count === 0) {
      return { done: false, reason: `no visible element for ${describe(kind, value)}` };
    }
    if (kind === 'testid' && found.count > 1) {
      return { done: false, reason: `${found.count} visible elements for ${describe(kind, value)}` };
    }
    return { done: true, value: found.rect };
  });
}

/** Wait until the page URL equals `want`. */
export function waitUrl(cdp, want, timeoutMs) {
  return poll(timeoutMs, async () => {
    const href = await evaluate(cdp, 'location.href', 5000);
    return href === want ? { done: true } : { done: false, reason: `page URL is ${href}, not ${want}` };
  });
}
