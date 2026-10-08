// `launch` and `cleanup` (CONTRACT.md §5, §9).
//
// launch: resolve Chrome → create the session → probe the app → boot it when
// down and a `start` is declared → start a scratch Chrome → create the session
// page → import auth → record state.json. Any failure after something started
// tears it down and removes the session directory before exiting 1.
//
// cleanup: stop only what launch recorded for the session, then remove the
// session directory. Evidence is never touched.
//
// Private to the implementation: only cli.mjs is a command.

import { importAuth } from './auth.mjs';
import { requireWebSocket } from './cdp.mjs';
import { chromeStatus, closeChrome, createPage, pageWs, startChrome } from './chrome.mjs';
import { ComputeError, logTail } from './output.mjs';
import { bootServer, processStart, probe, stopGroup, waitReachable } from './server.mjs';
import { createSession, isOwnSessionDir, listSessions, removeSession, sessionDir, tryReadState, writeState } from './session.mjs';

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const SERVER_STOP_WAIT_MS = 30000;

async function teardown(started) {
  let chromeExited = true;
  if (started.chrome_pid) {
    chromeExited = await closeChrome(started.chrome_pid, started.browser_ws, started.dir);
  }
  let serverExited = null;
  if (started.server === 'booted' && started.server_pid) {
    const sameProcess = started.server_started !== null && processStart(started.server_pid) === started.server_started;
    // A boot process that is gone, or whose id now belongs to another process,
    // is never signalled.
    serverExited = sameProcess ? await stopGroup(started.server_pid, SERVER_STOP_WAIT_MS) : true;
  }
  return { chromeExited, serverExited };
}

export async function launch({ entry }) {
  requireWebSocket();
  const chrome = chromeStatus();
  if (chrome.missing) {
    throw new ComputeError(`Chrome not found at ${chrome.path} (set CHROME_PATH to its executable)`);
  }
  const { id, dir } = createSession();
  const started = { dir, server: 'already-running', server_pid: null, server_started: null, chrome_pid: null, browser_ws: null };
  try {
    if (!(await probe(entry.url))) {
      if (entry.start === null) {
        throw new ComputeError(`app unreachable at ${entry.url} and the entry declares no start`);
      }
      started.server_pid = bootServer(entry, dir);
      started.server_started = processStart(started.server_pid);
      started.server = 'booted';
      if (!(await waitReachable(entry.url, entry.start_timeout))) {
        throw new ComputeError(`app unreachable at ${entry.url} after ${entry.start_timeout} s of start; server.log: ${logTail(`${dir}/server.log`)}`);
      }
    }
    let browser;
    try {
      browser = await startChrome(chrome.path, dir);
    } catch (err) {
      started.chrome_pid = err.chromePid || null;
      throw err;
    }
    started.chrome_pid = browser.pid;
    started.browser_ws = browser.browserWs;
    const targetId = await createPage(browser.browserWs);
    const page = pageWs(browser.port, targetId);
    if (entry.storage_state !== null) {
      await importAuth(page, entry.storage_state);
    }
    const state = {
      browser_ws: browser.browserWs,
      cdp_port: browser.port,
      chrome_pid: browser.pid,
      entry: {
        cwd: entry.cwd,
        start: entry.start,
        start_timeout: entry.start_timeout,
        storage_state: entry.storage_state,
        url: entry.url,
      },
      page_ws: page,
      server: started.server,
      server_pid: started.server_pid,
      server_started: started.server_started,
      target_id: targetId,
      url: entry.url,
      viewport: { ...DEFAULT_VIEWPORT },
    };
    writeState(dir, state);
    return {
      cdp_port: browser.port,
      chrome_pid: browser.pid,
      notes: entry.notes,
      ok: true,
      server: started.server,
      server_pid: started.server_pid,
      session: id,
      session_dir: dir,
      stale_sessions: listSessions().filter((other) => other !== id),
      url: entry.url,
      viewport: { ...DEFAULT_VIEWPORT },
    };
  } catch (err) {
    await teardown(started);
    removeSession(dir);
    throw err;
  }
}

async function cleanupOne(id) {
  const dir = sessionDir(id);
  if (!isOwnSessionDir(dir)) {
    throw new ComputeError(`no such session: ${id}`);
  }
  const state = tryReadState(dir);
  const started = {
    dir,
    server: state ? state.server : null,
    server_pid: state ? state.server_pid : null,
    server_started: state && typeof state.server_started === 'string' ? state.server_started : null,
    chrome_pid: state ? state.chrome_pid : null,
    browser_ws: state ? state.browser_ws : null,
  };
  const { chromeExited, serverExited } = await teardown(started);
  removeSession(dir);
  return {
    chrome_exited: chromeExited,
    ok: chromeExited && serverExited !== false,
    server: started.server,
    server_exited: serverExited,
    session: id,
  };
}

export async function cleanup({ session, all }) {
  if (all) {
    const sessions = [];
    for (const id of listSessions()) {
      try {
        sessions.push(await cleanupOne(id));
      } catch (err) {
        // One session that cannot be torn down does not stop the sweep.
        sessions.push({ chrome_exited: null, error: err.message, ok: false, server: null, server_exited: null, session: id });
      }
    }
    return { ok: sessions.every((s) => s.ok), sessions };
  }
  return cleanupOne(session);
}
