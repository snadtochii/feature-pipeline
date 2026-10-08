// `doctor` (CONTRACT.md §6).
//
// Reports readiness as distinct fields. Without a session it answers about the
// environment only — Chrome, Node, the install and its version — so a caller can
// run it before any launch. With a session it adds whether the app, the
// session's Chrome and the declared auth state are usable. Whatever it finds is
// an answer (exit 0); only an unknown session is exit 1.
//
// Private to the implementation: only cli.mjs is a command.

import fs from 'node:fs';

import { authStatus } from './auth.mjs';
import { chromeStatus } from './chrome.mjs';
import { installPath, installedVersion, isOlder, pluginManifestVersion } from './install.mjs';
import { probe } from './server.mjs';
import { readState } from './session.mjs';

async function cdpReachable(port) {
  if (!Number.isInteger(port)) {
    return false;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    await res.body?.cancel().catch(() => {});
    return res.ok;
  } catch {
    return false;
  }
}

export async function doctor({ session }) {
  const chrome = chromeStatus();
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeOk = nodeMajor >= 22 && typeof globalThis.WebSocket === 'function';
  const target = installPath();
  const installMissing = target === null || !fs.existsSync(target);
  const installed = installMissing ? null : installedVersion(target);
  const pluginVersion = pluginManifestVersion();
  const versionLag = installed !== null && pluginVersion !== null ? isOlder(installed, pluginVersion) : null;
  const doc = {
    chrome_missing: chrome.missing,
    chrome_path: chrome.path,
    install_missing: installMissing,
    installed_version: installed,
    node_ok: nodeOk,
    plugin_version: pluginVersion,
    version_lag: versionLag,
  };
  let ok = !chrome.missing && nodeOk && !installMissing && versionLag !== true;
  if (session !== undefined) {
    const { state } = readState(session);
    const urlReachable = await probe(state.url);
    const cdpOk = await cdpReachable(state.cdp_port);
    const auth = authStatus(state.entry ? state.entry.storage_state : null, state.url);
    doc.session = session;
    doc.url_reachable = urlReachable;
    doc.cdp_reachable = cdpOk;
    doc.auth = auth;
    ok = ok && urlReachable && cdpOk && (auth === 'absent' || auth === 'valid');
  }
  doc.ok = ok;
  return doc;
}
