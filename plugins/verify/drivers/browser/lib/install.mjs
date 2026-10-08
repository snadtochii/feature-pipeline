// `install` and the version file (CONTRACT.md §10).
//
// The driver is installed to the fixed location ~/.feature-pipeline/verify/ —
// cli.mjs, lib/ and CONTRACT.md plus a `version` file holding the plugin
// manifest's version. The copy is staged in a sibling directory and swapped in
// by rename, so an interrupted install leaves the previous copy intact. Only the
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

function removePrefixed(root, prefix) {
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith(prefix)) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
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
    removePrefixed(root, STAGING_PREFIX);
    removePrefixed(root, RETIRED_PREFIX);
    fs.mkdirSync(staging);
    fs.copyFileSync(path.join(DRIVER_DIR, 'cli.mjs'), path.join(staging, 'cli.mjs'));
    fs.chmodSync(path.join(staging, 'cli.mjs'), 0o755);
    fs.copyFileSync(path.join(DRIVER_DIR, 'CONTRACT.md'), path.join(staging, 'CONTRACT.md'));
    fs.cpSync(path.join(DRIVER_DIR, 'lib'), path.join(staging, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'version'), `${version}\n`);
    const replaced = fs.existsSync(target) ? installedVersion(target) : null;
    if (fs.existsSync(target)) {
      const retired = path.join(root, `${RETIRED_PREFIX}${rand}`);
      fs.renameSync(target, retired);
      fs.renameSync(staging, target);
      fs.rmSync(retired, { recursive: true, force: true });
    } else {
      fs.renameSync(staging, target);
    }
    return { installed_path: target, ok: true, replaced_version: replaced, version };
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (err instanceof ComputeError) {
      throw err;
    }
    throw new ComputeError(`install into ${target} failed: ${err.code || err.message}`);
  }
}
