// `install` and the version file (CONTRACT.md §10).
//
// The driver is installed to the fixed location ~/.feature-pipeline/verify/ —
// cli.mjs, lib/ and CONTRACT.md plus a `version` file holding the plugin
// manifest's version. The copy is staged in a sibling directory and swapped in
// by two renames — the current copy out to a retired name, the staged copy in.
// A failure between them renames the retired copy back; a kill between them
// leaves it retired, and the next install restores it before sweeping. Only the
// plugin copy can install: the installed copy has no manifest beside it.
//
// Private to the implementation: only cli.mjs is a command.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ComputeError } from './output.mjs';

/** The directory holding the running cli.mjs. */
export const DRIVER_DIR = path.dirname(fileURLToPath(new URL('../cli.mjs', import.meta.url)));

const STAGING_PREFIX = 'verify.tmp-';
const RETIRED_PREFIX = 'verify.old-';

/** The `verify` plugin manifest's version, or null when not run from the plugin copy. */
export function pluginManifestVersion() {
  const manifest = path.join(DRIVER_DIR, '..', '..', '.claude-plugin', 'plugin.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (parsed && parsed.name === 'verify' && typeof parsed.version === 'string') {
      return parsed.version;
    }
  } catch {
    // not the plugin copy
  }
  return null;
}

/** ~/.feature-pipeline, or null when HOME is unset. */
export function installRoot() {
  const home = process.env.HOME;
  return home ? path.join(home, '.feature-pipeline') : null;
}

/** ~/.feature-pipeline/verify, or null when HOME is unset. */
export function installPath() {
  const root = installRoot();
  return root === null ? null : path.join(root, 'verify');
}

/** The installed `version` file's content, or null when absent or empty. */
export function installedVersion(target) {
  try {
    const text = fs.readFileSync(path.join(target, 'version'), 'utf8').trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

/** `[major, minor, patch]` for a strict semver triple, else null. */
export function parseSemver(version) {
  const m = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(String(version));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `a` is older than `b`, false when not, null when either is unparsable. */
export function isOlder(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) {
    return null;
  }
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) {
      return pa[i] < pb[i];
    }
  }
  return false;
}

function prefixed(root, prefix) {
  return fs.readdirSync(root).filter((name) => name.startsWith(prefix)).map((name) => path.join(root, name));
}

function removePrefixed(root, prefix) {
  for (const entry of prefixed(root, prefix)) {
    fs.rmSync(entry, { recursive: true, force: true });
  }
}

/**
 * Put back a previous copy an install killed between its two renames left
 * retired, so the sweep that follows never deletes the only copy. The most
 * recently retired one wins.
 */
function restoreRetired(root, target) {
  if (fs.existsSync(target)) {
    return;
  }
  const retired = prefixed(root, RETIRED_PREFIX)
    .map((entry) => ({ entry, ctime: fs.statSync(entry).ctimeMs }))
    .sort((a, b) => b.ctime - a.ctime);
  if (retired.length > 0) {
    fs.renameSync(retired[0].entry, target);
  }
}

/**
 * Swap `staging` into `target`, retiring the current copy to `retired` first.
 * When the second rename fails, the retired copy is renamed back before the
 * error propagates, so `target` is never left empty by a failure. `rename` is
 * injectable for the self-test.
 */
export function swapInto(staging, target, retired, rename = fs.renameSync) {
  if (!fs.existsSync(target)) {
    rename(staging, target);
    return;
  }
  rename(target, retired);
  try {
    rename(staging, target);
  } catch (err) {
    rename(retired, target);
    throw err;
  }
  // The new copy is in place; a retired copy that cannot be removed now is
  // swept by the next install.
  try {
    fs.rmSync(retired, { recursive: true, force: true });
  } catch {
    // left for the next install's sweep
  }
}

export async function install() {
  const version = pluginManifestVersion();
  if (version === null) {
    throw new ComputeError('install runs only from the verify plugin copy: no plugin manifest beside this driver');
  }
  const root = installRoot();
  if (root === null) {
    throw new ComputeError('HOME is not set, so the install location cannot be resolved');
  }
  const target = path.join(root, 'verify');
  const rand = crypto.randomBytes(4).toString('hex');
  const staging = path.join(root, `${STAGING_PREFIX}${rand}`);
  try {
    fs.mkdirSync(root, { recursive: true });
    restoreRetired(root, target);
    removePrefixed(root, STAGING_PREFIX);
    removePrefixed(root, RETIRED_PREFIX);
    fs.mkdirSync(staging);
    fs.copyFileSync(path.join(DRIVER_DIR, 'cli.mjs'), path.join(staging, 'cli.mjs'));
    fs.chmodSync(path.join(staging, 'cli.mjs'), 0o755);
    fs.copyFileSync(path.join(DRIVER_DIR, 'CONTRACT.md'), path.join(staging, 'CONTRACT.md'));
    fs.cpSync(path.join(DRIVER_DIR, 'lib'), path.join(staging, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'version'), `${version}\n`);
    const replaced = fs.existsSync(target) ? installedVersion(target) : null;
    swapInto(staging, target, path.join(root, `${RETIRED_PREFIX}${rand}`));
    return { installed_path: target, ok: true, replaced_version: replaced, version };
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (err instanceof ComputeError) {
      throw err;
    }
    throw new ComputeError(`install into ${target} failed: ${err.code || err.message}`);
  }
}
