// Chrome discovery, scratch launch, page creation and shutdown
// (CONTRACT.md §1, §9, §12).
//
// Chrome is CHROME_PATH or the macOS default path — nothing else is searched.
// It always runs headless with a scratch --user-data-dir inside the session
// directory and --remote-debugging-port=0, so the system picks a free loopback
// port that Chrome writes to <profile>/DevToolsActivePort. It is spawned
// detached, so its process id is also its process group id.
//
// Private to the implementation: only cli.mjs is a command.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { connect } from './cdp.mjs';
import { ComputeError, logTail } from './output.mjs';
import { isAlive, stopGroup, waitExit } from './server.mjs';

export const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `{ path, missing }` for the Chrome executable this environment selects. */
export function chromeStatus() {
  const chromePath = process.env.CHROME_PATH ? process.env.CHROME_PATH : DEFAULT_CHROME_PATH;
  let missing = true;
  try {
    missing = !fs.statSync(chromePath).isFile();
    if (!missing) {
      fs.accessSync(chromePath, fs.constants.X_OK);
    }
  } catch {
    missing = true;
  }
  return { path: chromePath, missing };
}

/** The argument vector Chrome runs with for a session directory. */
export function chromeArgs(dir) {
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${path.join(dir, 'profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];
}

/**
 * Start Chrome for a session and wait for its debugging endpoint.
 * Returns `{ pid, port, browserWs }`.
 */
export async function startChrome(chromePath, dir, { timeoutMs = 15000 } = {}) {
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const logFile = path.join(dir, 'chrome.log');
  const log = fs.openSync(logFile, 'a', 0o600);
  let child;
  try {
    child = spawn(chromePath, chromeArgs(dir), { detached: true, stdio: ['ignore', log, log] });
  } finally {
    fs.closeSync(log);
  }
  let spawnError = null;
  let exited = false;
  child.on('error', (err) => {
    spawnError = err;
  });
  child.on('exit', () => {
    exited = true;
  });
  child.unref();
  const portFile = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError !== null) {
      throw new ComputeError(`cannot start Chrome at ${chromePath}: ${spawnError.code || spawnError.message}`);
    }
    let lines = null;
    try {
      lines = fs.readFileSync(portFile, 'utf8').split('\n');
    } catch {
      lines = null;
    }
    if (lines !== null && /^[0-9]+$/.test(lines[0]) && lines[1] && lines[1].startsWith('/devtools/browser/')) {
      const port = Number(lines[0]);
      return { pid: child.pid, port, browserWs: `ws://127.0.0.1:${port}${lines[1].trim()}` };
    }
    if (exited) {
      throw Object.assign(new ComputeError(`Chrome exited before opening its debugging port; chrome.log: ${logTail(logFile)}`), { chromePid: child.pid });
    }
    await sleep(100);
  }
  throw Object.assign(new ComputeError(`Chrome did not open its debugging port within ${timeoutMs} ms; chrome.log: ${logTail(logFile)}`), { chromePid: child.pid });
}

/** Create the session's page target; returns its target id. */
export async function createPage(browserWs) {
  const cdp = await connect(browserWs);
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    return targetId;
  } finally {
    cdp.close();
  }
}

/** The page target's WebSocket URL. */
export function pageWs(port, targetId) {
  return `ws://127.0.0.1:${port}/devtools/page/${targetId}`;
}

/** True when `pid`'s command line names this session's scratch profile. */
export function isSessionChrome(pid, dir) {
  if (!isAlive(pid)) {
    return false;
  }
  const res = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return res.status === 0 && res.stdout.includes(`--user-data-dir=${path.join(dir, 'profile')}`);
}

/**
 * Close a session's Chrome: Browser.close over CDP, then SIGTERM to its process
 * group if still alive. Returns true when the process is gone.
 */
export async function closeChrome(pid, browserWs, dir) {
  if (!isAlive(pid)) {
    return true;
  }
  if (!isSessionChrome(pid, dir)) {
    // The recorded id now belongs to another process: never signal it.
    return true;
  }
  if (browserWs) {
    try {
      const cdp = await connect(browserWs, { timeoutMs: 3000 });
      await cdp.send('Browser.close', {}, { timeoutMs: 3000 }).catch(() => {});
      cdp.close();
    } catch {
      // fall through to the signal
    }
    if (await waitExit(pid, 5000)) {
      return true;
    }
  }
  return stopGroup(pid, 10000);
}
