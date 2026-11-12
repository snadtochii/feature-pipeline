// Reading runs (../CONTRACT.md §6): digests turned into weighted token units
// per ticket and per role, and into each run ticket's pipeline runs across
// sessions — one entry per stage head, with its span, plugin versions,
// models, failed check runs, units and close result. Pure and synchronous:
// callers load the digests with cache.mjs's loadDigests first. Units are
// weighted here, on read, with measure-session.py's weights and left
// unrounded.
//
// Private to the implementation: only insights.mjs is a command.

import { ROOT_AGENT_ID, lineage } from './agents.mjs';
import { SCHEMA_VERSION } from './cache.mjs';
import { STAGE_OF_ROLE, UNATTRIBUTED, weightedUnits } from './recognize.mjs';
import { compare, msOf } from './util.mjs';

/** Whether a digest carries recognition: the current schema and an `agents` array. */
export const recognized = (digest) => digest.schema_version === SCHEMA_VERSION && Array.isArray(digest.agents);

function emptyBucket() {
  return { cache_read_tokens: 0, cache_write_tokens: 0, count: 0, input_tokens: 0, output_tokens: 0, turns: 0, weighted_units: 0 };
}

/** measure-session.py group_totals: per key, agent count, turns, the four token sums and weighted units. */
function groupTotals(agents, key) {
  const groups = new Map();
  for (const agent of agents) {
    const name = agent[key] ?? UNATTRIBUTED;
    if (!groups.has(name)) {
      groups.set(name, emptyBucket());
    }
    const bucket = groups.get(name);
    bucket.count += 1;
    bucket.turns += agent.turns;
    bucket.input_tokens += agent.tokens.input;
    bucket.cache_write_tokens += agent.tokens.cache_write;
    bucket.cache_read_tokens += agent.tokens.cache_read;
    bucket.output_tokens += agent.tokens.output;
    bucket.weighted_units += weightedUnits(agent.tokens);
  }
  return [...groups]
    .map(([name, bucket]) => ({ [key]: name, ...bucket }))
    .sort((a, b) => b.weighted_units - a.weighted_units || compare(a[key], b[key]));
}

/** One session's totals keyed by `'ticket'` or `'role'`, a null value bucketed as `unattributed`. */
export function sessionTotals(digest, key) {
  return groupTotals(digest.agents, key);
}

/** Role totals across every digest that carries recognition. */
export function roleTotals(digests) {
  return groupTotals(digests.filter(recognized).flatMap((digest) => digest.agents), 'role');
}

const isStageHead = (agent) => (agent.agent_id === ROOT_AGENT_ID ? agent.stage !== null : STAGE_OF_ROLE[agent.role] !== undefined);

/** The agent's nearest self-or-ancestor stage head, or null when its stage is unresolved. */
function owningHead(agent, byId) {
  if (agent.stage === null) {
    return null;
  }
  return [...lineage(agent, byId)].find(isStageHead) ?? null;
}

/** The plugin versions of the head's nearest ancestor that has any, else the session's. */
function inheritedVersions(head, byId, digest) {
  return [...lineage(head, byId)].find((agent) => agent !== head && agent.feature_versions.length > 0)?.feature_versions ?? digest.feature_versions ?? [];
}

function stageEntry(head, subtree, byId, digest, heads) {
  const versions = [...new Set(subtree.flatMap((agent) => agent.feature_versions))].sort();
  let end = head.end;
  if (head.agent_id === ROOT_AGENT_ID && head.stage === 'implement') {
    const firstChild = Math.min(...heads.filter((other) => other !== head && other.start !== null).map((other) => msOf(other.start)));
    if (Number.isFinite(firstChild) && end !== null && firstChild < msOf(end)) {
      end = new Date(firstChild).toISOString();
    }
  }
  return {
    agent_id: head.agent_id,
    check_runs: subtree.reduce(
      (sum, agent) => ({ failed: sum.failed + (agent.check_runs?.failed ?? 0), total: sum.total + (agent.check_runs?.total ?? 0) }),
      { failed: 0, total: 0 },
    ),
    close_result: head.close_result,
    duration_ms: head.start === null || end === null ? null : msOf(end) - msOf(head.start),
    end,
    feature_versions: versions.length > 0 ? versions : [...inheritedVersions(head, byId, digest)].sort(),
    models: [...new Set(subtree.flatMap((agent) => agent.models))].sort(),
    role: head.role,
    stage: head.stage,
    start: head.start,
    weighted_units: subtree.reduce((sum, agent) => sum + weightedUnits(agent.tokens), 0),
  };
}

function sessionStages(digest) {
  const byId = new Map(digest.agents.map((agent) => [agent.agent_id, agent]));
  const heads = digest.agents.filter(isStageHead);
  const subtrees = new Map(heads.map((head) => [head, []]));
  for (const agent of digest.agents) {
    const head = owningHead(agent, byId);
    if (head !== null && head.run_ticket === agent.run_ticket) {
      subtrees.get(head).push(agent);
    }
  }
  return heads.map((head) => ({ entry: stageEntry(head, subtrees.get(head), byId, digest, heads), ticket: head.run_ticket }));
}

const byStart = (a, b) => compare(a.start ?? '', b.start ?? '') || compare(a.agent_id ?? a.session_id, b.agent_id ?? b.session_id);

/**
 * Every recognized run ticket across `digests`, grouped on (project,
 * run_ticket): its weighted units in total and by role, one entry per session
 * holding the ticket's stage heads in start order, and its close results in
 * start order. Each session adds its own digest's units, so turns a forked or
 * resumed root repeats from an earlier session count once per session.
 * Digests without recognition are counted, never read.
 */
export function ticketRuns(digests) {
  const tickets = new Map();
  let withoutRecognition = 0;
  for (const digest of digests) {
    if (!recognized(digest)) {
      withoutRecognition += 1;
      continue;
    }
    const project = digest.project ?? null;
    const stagesByTicket = new Map();
    for (const { entry, ticket } of sessionStages(digest)) {
      if (ticket !== null) {
        stagesByTicket.set(ticket, [...(stagesByTicket.get(ticket) ?? []), entry]);
      }
    }
    const agentsByTicket = new Map();
    for (const agent of digest.agents) {
      if (agent.run_ticket !== null) {
        agentsByTicket.set(agent.run_ticket, [...(agentsByTicket.get(agent.run_ticket) ?? []), agent]);
      }
    }
    for (const [ticket, agents] of agentsByTicket) {
      const key = JSON.stringify([project, ticket]);
      if (!tickets.has(key)) {
        tickets.set(key, { by_role: new Map(), project, sessions: [], ticket, weighted_units: 0 });
      }
      const run = tickets.get(key);
      const starts = agents.map((agent) => agent.start).filter((value) => value !== null).sort();
      const ends = agents.map((agent) => agent.end).filter((value) => value !== null).sort();
      let units = 0;
      for (const agent of agents) {
        const agentUnits = weightedUnits(agent.tokens);
        units += agentUnits;
        const role = agent.role ?? UNATTRIBUTED;
        run.by_role.set(role, (run.by_role.get(role) ?? 0) + agentUnits);
      }
      run.weighted_units += units;
      run.sessions.push({
        end: ends.at(-1) ?? null,
        session_id: digest.session_id,
        stages: (stagesByTicket.get(ticket) ?? []).sort(byStart),
        start: starts[0] ?? null,
        transcript: digest.transcript,
        weighted_units: units,
      });
    }
  }
  const runs = [...tickets.values()].map((run) => {
    const sessions = run.sessions.sort(byStart);
    return {
      by_role: Object.fromEntries([...run.by_role].sort(([a], [b]) => compare(a, b))),
      close_results: sessions.flatMap((session) =>
        session.stages.filter((stage) => stage.stage === 'close').map((stage) => ({ agent_id: stage.agent_id, close_result: stage.close_result, session_id: session.session_id })),
      ),
      project: run.project,
      sessions,
      ticket: run.ticket,
      weighted_units: run.weighted_units,
    };
  });
  runs.sort((a, b) => compare(a.project ?? '', b.project ?? '') || compare(a.ticket, b.ticket));
  return { tickets: runs, without_recognition: withoutRecognition };
}
