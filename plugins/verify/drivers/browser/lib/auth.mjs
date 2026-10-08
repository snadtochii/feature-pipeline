// Storage-state import and status (CONTRACT.md §6).
//
// The file is Playwright's storage-state format: `cookies` (name, value,
// domain, path, expires in epoch seconds or -1, httpOnly, secure, sameSite)
// and `origins` (origin plus a localStorage list of name/value pairs). The
// driver reads it and never copies or prints its contents. Values reach the
// page only as JSON-encoded literals.
//
// Private to the implementation: only cli.mjs is a command.

import fs from 'node:fs';

import { connect } from './cdp.mjs';
import { ComputeError } from './output.mjs';

const SAME_SITE = new Set(['Strict', 'Lax', 'None']);

/** Parse a storage-state file, or throw a ComputeError when unreadable. */
export function readStorageState(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ComputeError(`auth storage state unreadable: ${file} (${err.code || 'not valid JSON'})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ComputeError(`auth storage state unreadable: ${file} (not an object)`);
  }
  const cookies = Array.isArray(parsed.cookies) ? parsed.cookies.filter((c) => c && typeof c.name === 'string' && typeof c.value === 'string') : [];
  const origins = Array.isArray(parsed.origins) ? parsed.origins.filter((o) => o && typeof o.origin === 'string') : [];
  return { cookies, origins };
}

function isExpired(cookie, nowSec) {
  return typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires < nowSec;
}

function domainMatches(cookieDomain, host) {
  if (typeof cookieDomain !== 'string' || cookieDomain === '') {
    return false;
  }
  const domain = cookieDomain.replace(/^\./, '').toLowerCase();
  const h = host.toLowerCase();
  return h === domain || h.endsWith(`.${domain}`);
}

function localStorageList(origin) {
  return Array.isArray(origin.localStorage)
    ? origin.localStorage.filter((e) => e && typeof e.name === 'string' && typeof e.value === 'string')
    : [];
}

/**
 * `"absent"` when no file is declared, `"unreadable"` when it does not parse,
 * `"valid"` when it holds an unexpired cookie for the url's host or a
 * localStorage entry for its origin, `"expired"` otherwise.
 */
export function authStatus(file, url) {
  if (file === null || file === undefined) {
    return 'absent';
  }
  let state;
  try {
    state = readStorageState(file);
  } catch {
    return 'unreadable';
  }
  const target = new URL(url);
  const nowSec = Date.now() / 1000;
  const live = state.cookies.some((c) => domainMatches(c.domain, target.hostname) && !isExpired(c, nowSec));
  const stored = state.origins.some((o) => o.origin === target.origin && localStorageList(o).length > 0);
  return live || stored ? 'valid' : 'expired';
}

async function navigate(cdp, url) {
  const loaded = cdp.waitFor('Page.loadEventFired', 15000);
  const res = await cdp.send('Page.navigate', { url });
  if (res.errorText) {
    loaded.catch(() => {});
    throw new ComputeError(`auth import: cannot open ${url}: ${res.errorText}`);
  }
  await loaded.catch(() => {
    throw new ComputeError(`auth import: ${url} did not finish loading`);
  });
}

/** Import a storage-state file into the session page's browser context. */
export async function importAuth(pageWsUrl, file) {
  const state = readStorageState(file);
  const cdp = await connect(pageWsUrl);
  try {
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    const nowSec = Date.now() / 1000;
    const cookies = state.cookies
      .filter((c) => !isExpired(c, nowSec) && typeof c.domain === 'string')
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: typeof c.path === 'string' ? c.path : '/',
        expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : undefined,
        httpOnly: c.httpOnly === true,
        secure: c.secure === true,
        sameSite: SAME_SITE.has(c.sameSite) ? c.sameSite : undefined,
      }));
    if (cookies.length > 0) {
      await cdp.send('Network.setCookies', { cookies });
    }
    for (const origin of state.origins) {
      const entries = localStorageList(origin);
      if (entries.length === 0) {
        continue;
      }
      await navigate(cdp, origin.origin);
      const expression = `(() => { const entries = ${JSON.stringify(entries)}; for (const e of entries) { localStorage.setItem(e.name, e.value); } return entries.length; })()`;
      const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
      if (res.exceptionDetails) {
        throw new ComputeError(`auth import: cannot write localStorage for ${origin.origin}`);
      }
    }
    if (state.origins.some((o) => localStorageList(o).length > 0)) {
      await navigate(cdp, 'about:blank');
    }
  } finally {
    cdp.close();
  }
}
