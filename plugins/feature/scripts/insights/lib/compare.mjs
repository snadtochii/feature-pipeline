// The report's version comparison (../CONTRACT.md §9): the runs since a
// `feature` plugin version set against the same number of runs before it,
// nearest the boundary first, with a floor below which no figure is compared.
// Each side carries its verdict and findings figures beside its token and
// time figures. Pure and synchronous.
//
// Private to the implementation: only insights.mjs is a command.

import { isEpic, median, tallyOutcomes } from './aggregate.mjs';

export const MIN_COMPARE_RUNS = 5;
export const MIN_COMPARE_REASON =
  'at 2 to 5 runs per plugin version, 5 runs per side usually spans more than one version, and a median of 5 runs survives two outliers where one large ticket would dominate a smaller sample';

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const LEADING_VERSION = /^\d+\.\d+\.\d+/;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sum = (values) => values.reduce((total, value) => total + value, 0);

/** `[x, y, z]` of an `X.Y.Z` version, each part a safe integer; null otherwise. */
export function versionParts(text) {
  const match = VERSION.exec(text);
  if (match === null) {
    return null;
  }
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

/** `[x, y, z]` of the leading `X.Y.Z` of a version string; null when it has none. */
export function parseVersion(text) {
  const match = LEADING_VERSION.exec(String(text));
  return match === null ? null : versionParts(match[0]);
}

/** Negative, zero or positive as version parts `a` sort before, with or after `b`. */
export function cmpVersion(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }
  return 0;
}

/** `after` when every version is at or above `target`, `before` when every one is below it, else `straddling` or `unversioned`. */
export function sideOf(versions, target) {
  const parsed = (versions ?? []).map(parseVersion);
  if (parsed.length === 0 || parsed.some((parts) => parts === null)) {
    return 'unversioned';
  }
  if (parsed.every((parts) => cmpVersion(parts, target) >= 0)) {
    return 'after';
  }
  return parsed.every((parts) => cmpVersion(parts, target) < 0) ? 'before' : 'straddling';
}

/** A run's start: its earliest stage start, else its earliest session start. */
function startOf(ticket) {
  const stageStarts = ticket.sessions.flatMap((session) => session.stages.map((stage) => Date.parse(stage.start))).filter(Number.isFinite);
  const starts = stageStarts.length > 0 ? stageStarts : ticket.sessions.map((session) => Date.parse(session.start)).filter(Number.isFinite);
  return starts.length > 0 ? Math.min(...starts) : Number.POSITIVE_INFINITY;
}

function durationOf(ticket) {
  const durations = ticket.sessions.flatMap((session) => session.stages.map((stage) => stage.duration_ms)).filter(Number.isFinite);
  return durations.length > 0 ? sum(durations) : null;
}

function sideFigures(runs, pool, unrecognized) {
  const units = runs.map((ticket) => ticket.weighted_units ?? 0);
  const durations = runs.map(durationOf).filter((value) => value !== null);
  const { findings, verdicts } = tallyOutcomes(runs, unrecognized);
  return {
    duration_known: durations.length,
    duration_median_ms: median(durations),
    findings,
    pool,
    runs: runs.length,
    units_median: median(units),
    units_total: sum(units),
    verdicts,
  };
}

/**
 * Split `tickets` (run tickets of the report's scope) at `version`: each side
 * takes the k = min(after, before) runs nearest the boundary. Returns
 * `{state, min_runs, reason, version, after, before, excluded}`; `state` is
 * `insufficient` when k is below `minRuns`, its sides then carrying only
 * `runs` and `pool`.
 */
export function compareWindows({ tickets, version, unrecognized = new Set(), minRuns = MIN_COMPARE_RUNS }) {
  const target = parseVersion(version);
  const excluded = { epics: 0, straddling: 0, unversioned: 0 };
  const sides = { after: [], before: [] };
  for (const ticket of tickets) {
    if (isEpic(ticket)) {
      excluded.epics += 1;
      continue;
    }
    const side = sideOf(ticket.feature_versions, target);
    if (side === 'after' || side === 'before') {
      sides[side].push({ start: startOf(ticket), ticket });
    } else {
      excluded[side] += 1;
    }
  }
  const order = (a, b) => a.start - b.start || compare(a.ticket.ticket, b.ticket.ticket) || compare(a.ticket.project ?? '', b.ticket.project ?? '');
  const after = sides.after.sort(order).map((item) => item.ticket);
  const before = sides.before.sort(order).map((item) => item.ticket);
  const k = Math.min(after.length, before.length);
  const state = k >= minRuns ? 'shown' : 'insufficient';
  const figures = (runs, pool) => (state === 'shown' ? sideFigures(runs, pool, unrecognized) : { pool, runs: runs.length });
  return {
    after: figures(after.slice(0, k), after.length),
    before: figures(before.slice(before.length - k), before.length),
    excluded,
    min_runs: minRuns,
    reason: MIN_COMPARE_REASON,
    state,
    version,
  };
}
