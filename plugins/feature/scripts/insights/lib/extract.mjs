// The `extract` verb (../CONTRACT.md §6, §7): scan the store, reuse or
// re-parse each main session's digest, write each one as soon as it is
// parsed, keep every digest whose transcript is gone, and return the bounded
// summary document.
//
// Private to the implementation: only insights.mjs is a command.

import fs from 'node:fs';

import { SCHEMA_VERSION, digestKeys, digestPathFor, ensureCacheRoot, pathsFor, readDigest, scanStore, sourcesEqual, writeDigest } from './cache.mjs';
import { defaultProbe, makeMapper } from './project.mjs';
import { ROOT_ROLE, findTicket, recognizeSession, roleOf } from './recognize.mjs';
import { addTokens, countInto, finishAgentWithSignals, isoOf, newAgent, readTranscript, sortedObject, zeroFriction, zeroTokens } from './transcript.mjs';

const MAX_LISTED_SESSIONS = 20;
const ROOT_AGENT_ID = 'root';

function readMeta(file) {
  try {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    return meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? meta : null;
  } catch {
    return null;
  }
}

function recognitionOf(meta) {
  if (meta === null) {
    return { ownTicket: null, role: null, walks: false };
  }
  return { ownTicket: findTicket(String(meta.description ?? '')), role: roleOf(meta.agentType, meta.description), walks: true };
}

async function parseAgents(session) {
  const root = newAgent(ROOT_AGENT_ID, null);
  await readTranscript(session.mainFile, root);
  const finished = [{ ...finishAgentWithSignals(root), recognition: { ownTicket: null, role: ROOT_ROLE, walks: true } }];
  for (const sub of session.agents) {
    const meta = sub.metaFile === null ? null : readMeta(sub.metaFile);
    const recognition = recognitionOf(meta);
    const acc = newAgent(sub.agentId, meta);
    if (sub.metaFile === null) {
      countInto(acc.anomalies, 'orphan_jsonl');
    } else if (meta === null) {
      countInto(acc.anomalies, 'bad_meta');
    }
    await readTranscript(sub.jsonlFile, acc);
    finished.push({ ...finishAgentWithSignals(acc), recognition });
  }
  const agents = finished.map(({ entry }) => entry);
  return recognizeSession(agents, finished.map(({ recognition, signals }) => ({ ...signals, ...recognition })));
}

function rollUp(agents, extraAnomalies) {
  const tokens = zeroTokens();
  const friction = zeroFriction();
  const skills = new Map();
  const anomalies = new Map(extraAnomalies);
  const models = new Set();
  const versions = new Set();
  let malformed = 0;
  let firstMs = null;
  let lastMs = null;
  for (const agent of agents) {
    addTokens(tokens, agent.tokens);
    for (const key of Object.keys(friction)) {
      friction[key] += agent.friction[key];
    }
    for (const [name, count] of Object.entries(agent.skills)) {
      countInto(skills, name, count);
    }
    for (const [name, count] of Object.entries(agent.anomalies)) {
      countInto(anomalies, name, count);
    }
    agent.models.forEach((model) => models.add(model));
    agent.feature_versions.forEach((version) => versions.add(version));
    malformed += agent.malformed_lines;
    if (agent.start !== null) {
      const start = Date.parse(agent.start);
      const end = Date.parse(agent.end);
      firstMs = firstMs === null ? start : Math.min(firstMs, start);
      lastMs = lastMs === null ? end : Math.max(lastMs, end);
    }
  }
  return {
    anomalies: sortedObject(anomalies),
    duration_ms: firstMs === null ? null : lastMs - firstMs,
    end: isoOf(lastMs),
    feature_versions: [...versions].sort(),
    friction,
    malformed_lines: malformed,
    models: [...models].sort(),
    skills: sortedObject(skills),
    start: isoOf(firstMs),
    tokens,
  };
}

async function parseSession(session, mapper) {
  const agents = await parseAgents(session);
  const cwd = agents[0].cwd;
  const extra = session.orphanMeta > 0 ? [['orphan_meta', session.orphanMeta]] : [];
  return {
    ...rollUp(agents, extra),
    ...mapper(cwd),
    agents,
    cwd,
    schema_version: SCHEMA_VERSION,
    session_id: session.sessionId,
    sources: session.sources,
    transcript: session.transcript,
  };
}

function hasMissingSource(digest, session) {
  const present = new Set(session.sources.map((source) => source.path));
  return digest.sources.some((source) => !present.has(source.path));
}

function emptySummary(cacheRoot, skipped) {
  return {
    anomalies: new Map(),
    cache_dir: cacheRoot,
    malformedLines: 0,
    malformedSessions: [],
    schema_version: SCHEMA_VERSION,
    sessions: { cache_corrupt: 0, kept_stale: 0, kept_without_transcript: 0, mapped: 0, parsed: 0, remapped: 0, reused: 0, seen: 0, unmapped: 0 },
    skipped_entries: skipped,
    subagents: { orphan_jsonl: 0, orphan_meta: 0, parsed: 0 },
  };
}

function tally(summary, session, digest) {
  summary.sessions[digest.project === null || digest.project === undefined ? 'unmapped' : 'mapped'] += 1;
  summary.subagents.orphan_meta += session.orphanMeta;
  summary.subagents.orphan_jsonl += session.agents.filter((agent) => agent.metaFile === null).length;
  const malformed = Number.isSafeInteger(digest.malformed_lines) ? digest.malformed_lines : 0;
  summary.malformedLines += malformed;
  if (malformed > 0) {
    summary.malformedSessions.push(session.transcript);
  }
  if (digest.anomalies !== null && typeof digest.anomalies === 'object') {
    for (const [name, count] of Object.entries(digest.anomalies)) {
      if (Number.isSafeInteger(count)) {
        countInto(summary.anomalies, name, count);
      }
    }
  }
}

async function processSession(session, cacheRoot, mapper, summary) {
  const file = digestPathFor(cacheRoot, session.slug, session.sessionId);
  const existing = readDigest(file);
  if (existing.state === 'ok') {
    const digest = existing.digest;
    if (hasMissingSource(digest, session)) {
      summary.sessions.kept_stale += 1;
      return digest;
    }
    if (digest.schema_version === SCHEMA_VERSION && sourcesEqual(digest.sources, session.sources)) {
      summary.sessions.reused += 1;
      const mapping = mapper(digest.cwd);
      if (mapping.project === digest.project && mapping.project_via === digest.project_via) {
        return digest;
      }
      const remapped = { ...digest, ...mapping };
      writeDigest(file, remapped);
      summary.sessions.remapped += 1;
      return remapped;
    }
  } else if (existing.state === 'corrupt') {
    summary.sessions.cache_corrupt += 1;
  }
  const digest = await parseSession(session, mapper);
  writeDigest(file, digest);
  summary.sessions.parsed += 1;
  summary.subagents.parsed += session.agents.length;
  return digest;
}

/** Run `extract` for `home`; returns the summary document. */
export async function extract({ home, probe = defaultProbe }) {
  const { cacheRoot, storeDir } = pathsFor(home);
  const { sessions, skipped } = scanStore(storeDir);
  ensureCacheRoot(cacheRoot);
  const mapper = makeMapper(probe);
  const summary = emptySummary(cacheRoot, skipped);
  for (const session of sessions) {
    summary.sessions.seen += 1;
    const digest = await processSession(session, cacheRoot, mapper, summary);
    tally(summary, session, digest);
  }
  const seen = new Set(sessions.map((session) => session.key));
  summary.sessions.kept_without_transcript = digestKeys(cacheRoot).filter((key) => !seen.has(key)).length;
  const listed = summary.malformedSessions.sort();
  return {
    anomalies: sortedObject(summary.anomalies),
    cache_dir: summary.cache_dir,
    malformed_lines: summary.malformedLines,
    malformed_sessions: listed.slice(0, MAX_LISTED_SESSIONS),
    malformed_sessions_total: listed.length,
    schema_version: summary.schema_version,
    sessions: summary.sessions,
    skipped_entries: summary.skipped_entries,
    subagents: summary.subagents,
  };
}
