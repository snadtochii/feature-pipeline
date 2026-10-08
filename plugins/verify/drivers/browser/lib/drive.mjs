// `drive` (CONTRACT.md §7).
//
// drive attaches to the session's persistent page, re-applies the stored
// viewport, runs the validated steps in order and reports per-step results,
// console errors and failed requests. Finding targets and polling live in
// locate.mjs, input events in input.mjs, the capture write in evidence.mjs; a
// lost socket is exit 1.
//
// Private to the implementation: only cli.mjs is a command.

import fs from 'node:fs';

import { CdpError, connect, requireWebSocket } from './cdp.mjs';
import { writeCapture } from './evidence.mjs';
import { clickAt, insertText, pressKey } from './input.mjs';
import { StepFailure, locate, waitUrl } from './locate.mjs';
import { ComputeError } from './output.mjs';
import { isAlive } from './server.mjs';
import { readState, writeState } from './session.mjs';
import { SUFFIX_WIDTH, nameSuffix } from './steps.mjs';

export const DRIVE_CAP_MS = 480000;
const SETTLE_MS = 100;
const MAX_REPORTED = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  await clickAt(cdp, rect.x + rect.width / 2, rect.y + rect.height / 2);
}

async function fill(cdp, step) {
  await locate(cdp, 'testid', step.testid, 'focus', step.timeout_ms);
  if (step.value === '') {
    await pressKey(cdp, 'Backspace');
    return;
  }
  await insertText(cdp, step.value);
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
  try {
    return writeCapture(ctx.dir, ctx.evidenceDir, step.name, Buffer.from(shot.data, 'base64'), state.viewport);
  } catch (err) {
    throw new StepFailure(`cannot write ${step.name} into ${ctx.evidenceDir}: ${err.code || err.message}`);
  }
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
    await sleep(SETTLE_MS);
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
