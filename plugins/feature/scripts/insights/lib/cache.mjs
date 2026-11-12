// The transcript store scan and the digest cache (../CONTRACT.md §2, §6).
//
// The store is `$HOME/.claude/projects`, read only. The cache is one JSON
// digest per main session under `$HOME/.feature-pipeline/insights/digests/
// <slug>/<session-id>.json`; a digest's own `sources` list is its cache key.
// Every name taken from the store passes a character-class check before a
// cache path is built from it, and symlinks are never followed.
//
// Private to the implementation: only insights.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';

import { ComputeError, render } from '../../lib/output.mjs';
import { writeAtomic } from '../../lib/write-atomic.mjs';

export const SCHEMA_VERSION = 1;

const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const SESSION_FILE = /^([A-Za-z0-9_-][A-Za-z0-9._-]*)\.jsonl$/;
const AGENT_JSONL = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;
const AGENT_META = /^agent-([A-Za-z0-9_-]+)\.meta\.json$/;
const AGENT_PREFIX = /^agent-[A-Za-z0-9_-]+\.prefix\.json$/;
const DIGEST_FILE = /^([A-Za-z0-9_-][A-Za-z0-9._-]*)\.json$/;
const SUBAGENTS_DIR = 'subagents';

/** `{ storeDir, cacheRoot }` for `home`; an unset `home` is a ComputeError. */
export function pathsFor(home) {
  if (typeof home !== 'string' || home === '') {
    throw new ComputeError('HOME is not set');
  }
  return {
    cacheRoot: path.join(home, '.feature-pipeline', 'insights', 'digests'),
    storeDir: path.join(home, '.claude', 'projects'),
  };
}

/** Create the cache root (mode 0700) when absent. */
export function ensureCacheRoot(cacheRoot) {
  try {
    fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(cacheRoot), 0o700);
    fs.chmodSync(cacheRoot, 0o700);
  } catch (err) {
    throw new ComputeError(`cannot create the cache directory ${cacheRoot} (${err.code ?? 'error'})`);
  }
}

function readDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    return null;
  }
}

function sourceOf(file, relative) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() ? { mtime_ms: Math.trunc(stat.mtimeMs), path: relative, size: stat.size } : null;
  } catch {
    return null;
  }
}

function byPath(a, b) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** `'missing'`, `'dir'` for a real directory, or `'other'` for a symlink, a file or an unreadable entry. */
function dirKind(dir) {
  try {
    return fs.lstatSync(dir).isDirectory() ? 'dir' : 'other';
  } catch (err) {
    return err.code === 'ENOENT' ? 'missing' : 'other';
  }
}

function scanSubagents(dir, relative, counts) {
  const jsonl = new Map();
  const meta = new Map();
  const kind = dirKind(dir);
  const entries = kind === 'dir' ? readDir(dir) : kind === 'missing' ? [] : null;
  if (entries === null) {
    counts.skipped += 1;
    return { agents: [], orphanMeta: 0 };
  }
  for (const entry of entries) {
    const jsonlMatch = entry.isFile() ? AGENT_JSONL.exec(entry.name) : null;
    const metaMatch = entry.isFile() ? AGENT_META.exec(entry.name) : null;
    if (jsonlMatch !== null) {
      jsonl.set(jsonlMatch[1], entry.name);
    } else if (metaMatch !== null) {
      meta.set(metaMatch[1], entry.name);
    } else if (entry.isFile() && AGENT_PREFIX.test(entry.name)) {
      continue;
    } else {
      counts.skipped += 1;
    }
  }
  const agents = [...jsonl.keys()].sort().map((agentId) => ({
    agentId,
    jsonl: { file: path.join(dir, jsonl.get(agentId)), relative: `${relative}/${jsonl.get(agentId)}` },
    meta: meta.has(agentId) ? { file: path.join(dir, meta.get(agentId)), relative: `${relative}/${meta.get(agentId)}` } : null,
  }));
  const orphanMeta = [...meta.keys()].filter((agentId) => !jsonl.has(agentId)).length;
  return { agents, orphanMeta };
}

function scanSlug(storeDir, slug, counts) {
  const slugDir = path.join(storeDir, slug);
  const entries = readDir(slugDir);
  if (entries === null) {
    counts.skipped += 1;
    return [];
  }
  const mains = new Map();
  const dirs = new Set();
  for (const entry of entries) {
    const match = entry.isFile() ? SESSION_FILE.exec(entry.name) : null;
    if (match !== null) {
      mains.set(match[1], entry.name);
    } else if (entry.isDirectory() && NAME.test(entry.name)) {
      dirs.add(entry.name);
    } else {
      counts.skipped += 1;
    }
  }
  for (const dir of dirs) {
    if (!mains.has(dir)) {
      counts.skipped += 1;
    }
  }
  const sessions = [];
  for (const [sessionId, fileName] of [...mains].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const transcript = `${slug}/${fileName}`;
    const main = sourceOf(path.join(slugDir, fileName), transcript);
    if (main === null) {
      counts.skipped += 1;
      continue;
    }
    const sub = dirs.has(sessionId)
      ? scanSubagents(path.join(slugDir, sessionId, SUBAGENTS_DIR), `${slug}/${sessionId}/${SUBAGENTS_DIR}`, counts)
      : { agents: [], orphanMeta: 0 };
    const sources = [main];
    const agents = [];
    for (const agent of sub.agents) {
      const jsonlSource = sourceOf(agent.jsonl.file, agent.jsonl.relative);
      if (jsonlSource === null) {
        counts.skipped += 1;
        continue;
      }
      sources.push(jsonlSource);
      const metaSource = agent.meta === null ? null : sourceOf(agent.meta.file, agent.meta.relative);
      if (metaSource !== null) {
        sources.push(metaSource);
      }
      agents.push({ agentId: agent.agentId, jsonlFile: agent.jsonl.file, metaFile: metaSource === null ? null : agent.meta.file });
    }
    sessions.push({
      agents,
      key: `${slug}/${sessionId}`,
      mainFile: path.join(slugDir, fileName),
      orphanMeta: sub.orphanMeta,
      sessionId,
      slug,
      sources: sources.sort(byPath),
      transcript,
    });
  }
  return sessions;
}

/**
 * Every main session in the store, with its subagent files and its source
 * keys captured before anything is read. A missing store holds no sessions.
 * Returns `{ sessions, skipped }`.
 */
export function scanStore(storeDir) {
  const counts = { skipped: 0 };
  const entries = readDir(storeDir);
  if (entries === null) {
    throw new ComputeError(`cannot read the transcript store ${storeDir}`);
  }
  const sessions = [];
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) {
      counts.skipped += 1;
      continue;
    }
    sessions.push(...scanSlug(storeDir, entry.name, counts));
  }
  return { sessions, skipped: counts.skipped };
}

/** The digest file of `slug`/`sessionId`, contained under `cacheRoot`. */
export function digestPathFor(cacheRoot, slug, sessionId) {
  const file = path.join(cacheRoot, slug, `${sessionId}.json`);
  if (!NAME.test(slug) || !NAME.test(sessionId) || path.dirname(path.dirname(file)) !== cacheRoot) {
    throw new ComputeError(`a session name escapes the cache root: ${JSON.stringify(`${slug}/${sessionId}`.slice(0, 80))}`);
  }
  return file;
}

function isSource(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.path === 'string' &&
    Number.isSafeInteger(value.size) &&
    Number.isSafeInteger(value.mtime_ms)
  );
}

function isDigest(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.sources) && value.sources.every(isSource);
}

/** `{ state: 'missing' | 'corrupt' }` or `{ state: 'ok', digest }`. */
export function readDigest(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { state: err.code === 'ENOENT' ? 'missing' : 'corrupt' };
  }
  let digest;
  try {
    digest = JSON.parse(text);
  } catch {
    return { state: 'corrupt' };
  }
  return isDigest(digest) ? { digest, state: 'ok' } : { state: 'corrupt' };
}

/** Whether two source lists name the same files with the same sizes and modification times. */
export function sourcesEqual(a, b) {
  return a.length === b.length && a.every((source, index) => source.path === b[index].path && source.size === b[index].size && source.mtime_ms === b[index].mtime_ms);
}

/** Write `digest` to `file` atomically (mode 0600), creating its slug directory (mode 0700). */
export function writeDigest(file, digest) {
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    fs.chmodSync(dir, 0o700);
    writeAtomic(file, render(digest));
  } catch (err) {
    throw new ComputeError(`cannot write the digest ${file} (${err.code ?? 'error'})`);
  }
}

/** Every `<slug>/<session-id>` key with a digest file under `cacheRoot`. */
export function digestKeys(cacheRoot) {
  const keys = [];
  for (const slug of readDir(cacheRoot) ?? []) {
    if (!slug.isDirectory() || !NAME.test(slug.name)) {
      continue;
    }
    for (const entry of readDir(path.join(cacheRoot, slug.name)) ?? []) {
      const match = entry.isFile() ? DIGEST_FILE.exec(entry.name) : null;
      if (match !== null) {
        keys.push(`${slug.name}/${match[1]}`);
      }
    }
  }
  return keys.sort();
}

/** Every readable digest under `cacheRoot`, ordered by transcript path. Corrupt files are left out. */
export function loadDigests(cacheRoot) {
  const digests = [];
  for (const key of digestKeys(cacheRoot)) {
    const [slug, sessionId] = key.split('/');
    const read = readDigest(path.join(cacheRoot, slug, `${sessionId}.json`));
    if (read.state === 'ok') {
      digests.push(read.digest);
    }
  }
  return digests;
}
