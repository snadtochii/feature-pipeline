// Ticket outcomes joined to runs (../CONTRACT.md §7): every run ticket of
// `ticketRuns` beside its fs-native ticket's classified artifacts, keyed on
// (project, ticket ID), plus one entry per ticket whose sessions are gone.
// Read time only: nothing here is cached, so an artifact rewritten after its
// close is read as it now stands.
//
// Private to the implementation: only insights.mjs is a command.

import { ticketRuns } from './runs.mjs';
import { readTicketTree, storageModeOf } from './tickets.mjs';

const JOIN_STATES = ['fs', 'missing', 'server-native', 'unknown-mode'];

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const emptyTree = (join) => ({ duplicates: 0, join, skipped_folders: 0, tickets: new Map() });

/** A project's join state and, for an fs-native project whose store reads, its ticket tree. */
export function defaultReadTree(root) {
  const mode = storageModeOf(root);
  if (mode !== 'fs') {
    return emptyTree(mode);
  }
  const tree = readTicketTree(root);
  return tree === null ? emptyTree('missing') : { ...tree, join: 'fs' };
}

function outcomeOf(record) {
  return {
    complexity: record.complexity,
    created: record.created,
    epic_folder: record.epic_folder,
    kind: record.kind,
    parent: record.parent,
    review: record.review,
    state: record.state,
    status: record.status,
    summary: record.summary,
    summary_mtime: record.summary_mtime,
    tests: record.tests,
  };
}

const versionsOf = (run) => [...new Set(run.sessions.flatMap((session) => session.stages.flatMap((stage) => stage.feature_versions)))].sort();

function lastCloseVerdict(run) {
  const verdicts = run.close_results.map((result) => result.close_result?.verdict ?? null).filter((verdict) => verdict !== null);
  return verdicts.at(-1) ?? null;
}

function zeroCounts() {
  return {
    artifacts_only: 0,
    duplicates: 0,
    joined: 0,
    projects_by_join: Object.fromEntries(JOIN_STATES.map((state) => [state, 0])),
    sessions_only: 0,
    skipped_folders: 0,
    unmapped_runs: 0,
    unrecognized_total: 0,
    verdict_mismatch: 0,
  };
}

/**
 * Join `runs` (the result of `ticketRuns`) to `trees`, a Map from project path
 * to `{join, tickets, duplicates, skipped_folders}`. A run ticket whose
 * project's join is `fs` and whose tree holds its ID is `source: both`; every
 * other run is `sessions`; a tree ticket no run names is `artifacts`. Pure.
 */
export function joinOutcomes(runs, trees) {
  const counts = zeroCounts();
  const joinedKeys = new Set();
  const entries = runs.tickets.map((run) => {
    const tree = run.project === null ? undefined : trees.get(run.project);
    const record = tree?.join === 'fs' ? tree.tickets.get(run.ticket) : undefined;
    const verdict = record?.summary?.verdict ?? null;
    if (record === undefined) {
      counts[run.project === null ? 'unmapped_runs' : 'sessions_only'] += 1;
    } else {
      joinedKeys.add(JSON.stringify([run.project, run.ticket]));
      counts.joined += 1;
      const closeVerdict = lastCloseVerdict(run);
      if (verdict !== null && closeVerdict !== null && verdict !== closeVerdict) {
        counts.verdict_mismatch += 1;
      }
    }
    return {
      ...run,
      feature_versions: versionsOf(run),
      outcome: record === undefined ? null : outcomeOf(record),
      source: record === undefined ? 'sessions' : 'both',
      verdict,
    };
  });
  const projects = [...trees.keys()].sort(compare);
  const unrecognized = [];
  for (const project of projects) {
    const tree = trees.get(project);
    counts.projects_by_join[tree.join] += 1;
    counts.duplicates += tree.duplicates;
    counts.skipped_folders += tree.skipped_folders;
    for (const [ticket, record] of [...tree.tickets].sort(([a], [b]) => compare(a, b))) {
      record.unrecognized.forEach((artifact) => unrecognized.push({ artifact, project, ticket }));
      if (joinedKeys.has(JSON.stringify([project, ticket]))) {
        continue;
      }
      counts.artifacts_only += 1;
      entries.push({
        by_role: {},
        close_results: [],
        feature_versions: null,
        outcome: outcomeOf(record),
        project,
        sessions: [],
        source: 'artifacts',
        ticket,
        verdict: record.summary?.verdict ?? null,
        weighted_units: null,
      });
    }
  }
  entries.sort((a, b) => compare(a.project ?? '', b.project ?? '') || compare(a.ticket, b.ticket));
  unrecognized.sort((a, b) => compare(a.project, b.project) || compare(a.ticket, b.ticket) || compare(a.artifact, b.artifact));
  counts.unrecognized_total = unrecognized.length;
  return {
    counts,
    projects: projects.map((project) => ({ join: trees.get(project).join, path: project })),
    tickets: entries,
    unrecognized,
    without_recognition: runs.without_recognition,
  };
}

/**
 * The ticket dataset of `digests`: every distinct project the digests name,
 * its tree read through `readTree`, joined to the digests' run tickets.
 * Returns `{counts, projects, tickets, unrecognized, without_recognition}`.
 */
export function ticketDataset(digests, { readTree = defaultReadTree } = {}) {
  const projects = [...new Set(digests.map((digest) => digest.project).filter((project) => typeof project === 'string'))].sort(compare);
  const trees = new Map(projects.map((project) => [project, readTree(project)]));
  return joinOutcomes(ticketRuns(digests), trees);
}
