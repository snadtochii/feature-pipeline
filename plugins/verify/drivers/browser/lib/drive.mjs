// `drive` and `evidence` (CONTRACT.md §7, §8, §11).
//
// drive attaches to the session's persistent page, re-applies the stored
// viewport, runs the validated steps in order and reports per-step results,
// console errors and failed requests. Targets reach the page only as
// JSON-encoded literals. Conditions are polled every 100 ms up to the step's
// timeout; a protocol error during a poll (a navigation destroying the
// context) is retried, a lost socket is exit 1.
//
// Private to the implementation: only cli.mjs is a command.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CdpError, connect, requireWebSocket } from './cdp.mjs';
import { ComputeError } from './output.mjs';
import { isAlive } from './server.mjs';
import { appendLedger, readLedger, readState, writeState } from './session.mjs';
import { SUFFIX_WIDTH, UPLOAD_NAME_RE, nameSuffix } from './steps.mjs';

export const DRIVE_CAP_MS = 480000;
const POLL_MS = 100;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_REPORTED = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A step did not succeed; the run records it and does not exit non-zero. */
class StepFailure extends Error {}

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

const KEY_DEFS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

function keyDef(key) {
  if (Object.hasOwn(KEY_DEFS, key)) {
    return KEY_DEFS[key];
  }
  const upper = key.toUpperCase();
  const keyCode = /^[A-Z0-9]$/.test(upper) ? upper.charCodeAt(0) : 0;
  return { key, keyCode, text: key };
}

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
function locate(cdp, kind, value, action, timeoutMs) {
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

async function currentUrl(cdp) {
  return evaluate(cdp, 'location.href', 5000);
}

function waitUrl(cdp, want, timeoutMs) {
  return poll(timeoutMs, async () => {
    const href = await currentUrl(cdp);
    return href === want ? { done: true } : { done: false, reason: `page URL is ${href}, not ${want}` };
  });
}

async function applyViewport(cdp, viewport) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function goto(cdp, url, timeoutMs) {
  const loaded = cdp.waitFor('Page.loadEventFired', timeoutMs);
  loaded.catch(() => {});
  let res;
  try {
    res = await cdp.send('Page.navigate', { url }, { timeoutMs });
  } catch (err) {
    if (err instanceof CdpError) {
      throw new StepFailure(`navigation to ${url} failed: ${err.message}`);
    }
    throw err;
  }
  if (res.errorText) {
    throw new StepFailure(`navigation to ${url} failed: ${res.errorText}`);
  }
  if (res.loaderId === undefined) {
    return; // same-document navigation: no load event follows
  }
  try {
    await loaded;
  } catch {
    throw new StepFailure(`${url} did not finish loading within ${timeoutMs} ms`);
  }
}

async function click(cdp, step) {
  const kind = step.testid !== undefined ? 'testid' : 'text';
  const rect = await locate(cdp, kind, step[kind], 'scroll', step.timeout_ms);
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function pressKey(cdp, key) {
  const def = keyDef(key);
  const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode };
  await cdp.send('Input.dispatchKeyEvent', { type: def.text ? 'keyDown' : 'rawKeyDown', ...base, text: def.text, unmodifiedText: def.text });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function fill(cdp, step) {
  await locate(cdp, 'testid', step.testid, 'focus', step.timeout_ms);
  if (step.value === '') {
    await pressKey(cdp, 'Backspace');
    return;
  }
  await cdp.send('Input.insertText', { text: step.value });
}

async function press(cdp, step) {
  if (step.testid !== undefined) {
    await locate(cdp, 'testid', step.testid, 'focus', step.timeout_ms);
  }
  await pressKey(cdp, step.key);
}

async function screenshot(ctx, step) {
  const { cdp, state } = ctx;
  const suffix = nameSuffix(step.name);
  const want = SUFFIX_WIDTH[suffix];
  if (state.viewport.width !== want) {
    throw new StepFailure(`${step.name} needs a viewport width of ${want} (${suffix}); the viewport is ${state.viewport.width}×${state.viewport.height}`);
  }
  const metrics = await cdp.send('Page.getLayoutMetrics', {}, { timeoutMs: step.timeout_ms });
  const size = metrics.cssContentSize || metrics.contentSize;
  const width = Math.max(1, Math.ceil(Math.max(size.width, state.viewport.width)));
  const height = Math.max(1, Math.ceil(Math.max(size.height, state.viewport.height)));
  let shot;
  try {
    shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    }, { timeoutMs: Math.max(step.timeout_ms, 30000) });
  } catch (err) {
    if (err instanceof CdpError) {
      throw new StepFailure(`capture failed: ${err.message}`);
    }
    throw err;
  }
  const file = path.join(ctx.evidenceDir, step.name);
  try {
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  } catch (err) {
    throw new StepFailure(`cannot write ${file}: ${err.code || err.message}`);
  }
  appendLedger(ctx.dir, { name: step.name, path: file, viewport: { ...state.viewport } });
  return file;
}

async function runStep(ctx, step) {
  const { cdp, state } = ctx;
  const resolve = (url) => new URL(url, state.url).href;
  switch (step.step) {
    case 'goto':
      await goto(cdp, resolve(step.url), step.timeout_ms);
      return null;
    case 'click':
      await click(cdp, step);
      return null;
    case 'fill':
      await fill(cdp, step);
      return null;
    case 'press':
      await press(cdp, step);
      return null;
    case 'wait':
      if (step.ms !== undefined) {
        await sleep(step.ms);
      } else if (step.url !== undefined) {
        await waitUrl(cdp, resolve(step.url), step.timeout_ms);
      } else {
        await locate(cdp, 'text', step.text, 'locate', step.timeout_ms);
      }
      return null;
    case 'expect':
      if (step.url !== undefined) {
        await waitUrl(cdp, resolve(step.url), step.timeout_ms);
      } else if (step.testid !== undefined) {
        await locate(cdp, 'testid', step.testid, 'locate', step.timeout_ms);
      } else {
        await locate(cdp, 'text', step.text, 'locate', step.timeout_ms);
      }
      return null;
    case 'viewport':
      state.viewport = { width: step.width, height: step.height };
      await applyViewport(cdp, state.viewport);
      writeState(ctx.dir, state);
      return null;
    case 'screenshot':
      return screenshot(ctx, step);
    default:
      throw new StepFailure(`unknown step ${step.step}`);
  }
}

function consoleText(args) {
  return (args || []).map((arg) => {
    if (arg.value !== undefined) {
      return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
    }
    return arg.description || arg.type;
  }).join(' ');
}

// Append to a reported list, keeping at most MAX_REPORTED entries; the rest
// are only counted, so a page that errors in a loop cannot flood the document.
function report(list, entry) {
  if (list.entries.length < MAX_REPORTED) {
    list.entries.push(entry);
  } else {
    list.dropped += 1;
  }
}

// Collect console errors and failed requests, attributed to the step running
// when each arrives. Entries buffered before this drive started are ignored.
function collect(ctx, startMs) {
  const { cdp } = ctx;
  const fresh = (timestamp) => typeof timestamp !== 'number' || timestamp >= startMs - 1000;
  const requests = new Map();
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' && fresh(p.timestamp)) {
      report(ctx.consoleErrors, { step: ctx.current, text: consoleText(p.args) });
    }
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    if (fresh(p.timestamp)) {
      const d = p.exceptionDetails || {};
      const text = d.exception && d.exception.description ? d.exception.description : d.text;
      report(ctx.consoleErrors, { step: ctx.current, text: String(text || 'uncaught exception').split('\n')[0] });
    }
  });
  cdp.on('Log.entryAdded', (p) => {
    const entry = p.entry || {};
    if (entry.level === 'error' && fresh(entry.timestamp)) {
      report(ctx.consoleErrors, { step: ctx.current, text: entry.text || '' });
    }
  });
  cdp.on('Network.requestWillBeSent', (p) => {
    requests.set(p.requestId, p.request ? p.request.url : '');
  });
  cdp.on('Network.loadingFailed', (p) => {
    if (p.canceled || p.errorText === 'net::ERR_ABORTED') {
      return;
    }
    report(ctx.failedRequests, { error_text: p.errorText || 'failed', status: null, step: ctx.current, url: requests.get(p.requestId) || '' });
  });
  cdp.on('Network.responseReceived', (p) => {
    if (p.response && p.response.status >= 400) {
      report(ctx.failedRequests, { error_text: null, status: p.response.status, step: ctx.current, url: p.response.url });
    }
  });
}

async function attach(state) {
  try {
    return await connect(state.page_ws);
  } catch (err) {
    if (!isAlive(state.chrome_pid)) {
      throw new ComputeError(`session page gone: Chrome (pid ${state.chrome_pid}) is not running`);
    }
    throw new ComputeError(`session page gone: ${err.message}`);
  }
}

async function run(ctx, steps) {
  const results = [];
  let stopped = false;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (stopped) {
      results.push({ error: null, index, screenshot: null, status: 'skipped', step: step.step });
      continue;
    }
    ctx.current = index;
    try {
      const shot = await runStep(ctx, step);
      results.push({ error: null, index, screenshot: shot, status: 'ok', step: step.step });
    } catch (err) {
      if (!(err instanceof StepFailure)) {
        throw err;
      }
      results.push({ error: err.message, index, screenshot: null, status: 'failed', step: step.step });
      if (step.step !== 'expect') {
        stopped = true;
      }
    }
  }
  return results;
}

export async function drive({ session, steps, evidence: evidenceDir }) {
  requireWebSocket();
  const { dir, state } = readState(session);
  try {
    fs.mkdirSync(evidenceDir, { recursive: true });
  } catch (err) {
    throw new ComputeError(`cannot create evidence directory ${evidenceDir}: ${err.code || err.message}`);
  }
  const startMs = Date.now();
  const cdp = await attach(state);
  const ctx = {
    cdp,
    state,
    dir,
    evidenceDir,
    current: 0,
    consoleErrors: { entries: [], dropped: 0 },
    failedRequests: { entries: [], dropped: 0 },
  };
  let capTimer;
  const cap = new Promise((_, reject) => {
    capTimer = setTimeout(() => {
      cdp.close();
      reject(new ComputeError(`drive exceeded its ${DRIVE_CAP_MS / 1000} s cap`));
    }, DRIVE_CAP_MS);
  });
  try {
    const work = (async () => {
      collect(ctx, startMs);
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Log.enable');
      await cdp.send('Network.enable');
      await applyViewport(cdp, state.viewport);
      return run(ctx, steps);
    })();
    const results = await Promise.race([work, cap]);
    // Let events already in flight for the last step arrive.
    await sleep(POLL_MS);
    return {
      console_errors: ctx.consoleErrors.entries,
      console_errors_dropped: ctx.consoleErrors.dropped,
      evidence_dir: evidenceDir,
      failed_requests: ctx.failedRequests.entries,
      failed_requests_dropped: ctx.failedRequests.dropped,
      ok: results.every((r) => r.status === 'ok'),
      session,
      steps: results,
    };
  } finally {
    clearTimeout(capTimer);
    cdp.close();
  }
}

export async function evidence({ session }) {
  const { dir } = readState(session);
  const latest = new Map();
  for (const entry of readLedger(dir)) {
    if (entry && typeof entry.path === 'string') {
      latest.set(entry.path, entry);
    }
  }
  const entries = [...latest.keys()].sort().map((file) => {
    const entry = latest.get(file);
    let data = null;
    try {
      data = fs.readFileSync(file);
    } catch {
      data = null;
    }
    const bytes = data === null ? null : data.length;
    return {
      bytes,
      missing: data === null,
      name: entry.name,
      path: file,
      sha256: data === null ? null : crypto.createHash('sha256').update(data).digest('hex'),
      uploadable: data !== null && bytes >= 1 && bytes <= MAX_UPLOAD_BYTES && UPLOAD_NAME_RE.test(entry.name),
      viewport: entry.viewport,
    };
  });
  return { evidence: entries, session };
}
