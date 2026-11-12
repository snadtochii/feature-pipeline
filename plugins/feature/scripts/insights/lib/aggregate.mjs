// The report's figures (../CONTRACT.md §9): the cached digests and their
// ticket dataset (§6, §7) reduced, for one project scope and one window, to
// the stage and project tables by ISO week, friction per skill and per stage,
// outcomes and the coverage-gap counts. Pure and synchronous; every list
// sorted, and an empty input gives the same shape with zeros.
//
// Private to the implementation: only insights.mjs is a command.

import { SCHEMA_VERSION } from './cache.mjs';
import { lastCloseVerdict } from './outcomes.mjs';
import { weightedUnits } from './recognize.mjs';

export const STAGES = ['plan', 'implement', 'review', 'close'];
export const VERDICTS = ['pass', 'partial', 'stuck', 'unknown'];
export const NO_SKILL = '(no skill)';
export const NO_STAGE = '(no stage)';
export const FRICTION_KEYS = ['interrupts', 'rejections', 'permission_denials', 'tool_errors', 'failed_checks'];

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const DEFAULT_WINDOW_DAYS = 30;
const ROOT_AGENT_ID = 'root';
const UNKNOWN_REVIEW_LABELS = new Set(['failed-all']);

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sum = (values) => values.reduce((total, value) => total + value, 0);
const msOf = (iso) => (typeof iso === 'string' ? Date.parse(iso) : Number.NaN);
const inWindow = (iso, since) => {
  const ms = msOf(iso);
  return Number.isFinite(ms) && ms >= since;
};
const keyOf = (project, ticket) => JSON.stringify([project, ticket]);
const recognized = (digest) => digest.schema_version === SCHEMA_VERSION && Array.isArray(digest.agents);
const unitsOf = (tokens) => (tokens !== null && typeof tokens === 'object' ? weightedUnits(tokens) : 0);

/** The `YYYY-MM-DD` UTC date of `ms`. */
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The UTC midnight of the Monday starting the ISO week holding `ms`. */
export function weekStartMs(ms) {
  const date = new Date(ms);
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - sinceMonday);
}

/** The Monday `YYYY-MM-DD` of the ISO week holding an ISO time. */
export const isoWeekStart = (iso) => dayOf(weekStartMs(Date.parse(iso)));

/** The default window start: 00:00 UTC of the day 30 days before `now`'s UTC date. */
export function defaultSinceMs(now) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - DEFAULT_WINDOW_DAYS);
}

/** The median of `values`, the mean of the middle two for an even count; null for none. */
export function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A ticket's verdict: the artifact's, else its last close-result verdict, else `unknown`. */
export function verdictOf(ticket) {
  if (VERDICTS.includes(ticket.verdict) && ticket.verdict !== 'unknown') {
    return ticket.verdict;
  }
  return lastCloseVerdict(ticket) ?? 'unknown';
}

/** The (project, ticket) keys whose `04-review.md` the dataset lists unrecognized. */
export function unrecognizedReviews(dataset) {
  return new Set(dataset.unrecognized.filter((item) => item.artifact === '04-review.md').map((item) => keyOf(item.project, item.ticket)));
}

/** A ticket's review decisions `{accepted, dismissed, deferred}`, or null when no recognized review says them. */
export function findingsOf(ticket, unrecognized) {
  const review = ticket.outcome?.review ?? null;
  if (review === null || !review.present || review.label === null || UNKNOWN_REVIEW_LABELS.has(review.label) || unrecognized.has(keyOf(ticket.project, ticket.ticket))) {
    return null;
  }
  return review.decisions;
}

export const isEpic = (ticket) => ticket.outcome?.kind === 'epic';

/** The run tickets of `projects`: source `both` or `sessions`, with a session starting at or after `since` (any session when `since` is null). */
export function runTickets(dataset, projects, since) {
  const inScope = new Set(projects);
  return dataset.tickets.filter(
    (ticket) => (ticket.source === 'both' || ticket.source === 'sessions') && inScope.has(ticket.project) && ticket.sessions.some((session) => since === null || inWindow(session.start, since)),
  );
}

/** An agent's first command that loaded a skill, a leading `/` stripped: a built-in command such as `/clear` loads none. */
function firstSkillCommand(agent) {
  const skills = agent.skills !== null && typeof agent.skills === 'object' ? agent.skills : {};
  const names = (Array.isArray(agent.commands) ? agent.commands : []).map((command) => (typeof command?.name === 'string' ? command.name.replace(/^\//, '') : ''));
  return names.find((name) => name !== '' && Object.hasOwn(skills, name)) ?? null;
}

/** The skill an agent's friction counts toward: its first skill command, else its nearest ancestor's, else `(no skill)`. */
export function skillOf(agent, byId) {
  const seen = new Set();
  let cursor = agent;
  while (cursor !== null && !seen.has(cursor.agent_id)) {
    const name = firstSkillCommand(cursor);
    if (name !== null) {
      return name;
    }
    seen.add(cursor.agent_id);
    cursor = cursor.agent_id === ROOT_AGENT_ID ? null : (byId.get(cursor.parent_agent_id) ?? byId.get(ROOT_AGENT_ID) ?? null);
  }
  return NO_SKILL;
}

function frictionRow(name) {
  return { check_runs: 0, failed_checks: 0, interrupts: 0, name, permission_denials: 0, rejections: 0, tool_errors: 0, total: 0 };
}

function addFriction(rows, name, agent) {
  if (!rows.has(name)) {
    rows.set(name, frictionRow(name));
  }
  const row = rows.get(name);
  const friction = agent.friction ?? {};
  for (const key of ['interrupts', 'rejections', 'permission_denials', 'tool_errors']) {
    row[key] += Number.isSafeInteger(friction[key]) ? friction[key] : 0;
  }
  row.failed_checks += Number.isSafeInteger(agent.check_runs?.failed) ? agent.check_runs.failed : 0;
  row.check_runs += Number.isSafeInteger(agent.check_runs?.total) ? agent.check_runs.total : 0;
  row.total = sum(FRICTION_KEYS.map((key) => row[key]));
}

const byTotal = (rows) => [...rows.values()].sort((a, b) => b.total - a.total || compare(a.name, b.name));

/** The first `limit` rows, then one `other` row summing the rest when there are more. */
export function foldRows(rows, limit) {
  if (rows.length <= limit) {
    return rows;
  }
  const other = frictionRow('other');
  for (const row of rows.slice(limit)) {
    for (const key of [...FRICTION_KEYS, 'check_runs', 'total']) {
      other[key] += row[key];
    }
  }
  return [...rows.slice(0, limit), { ...other, other: true }];
}

function frictionOf(digests) {
  const bySkill = new Map();
  const byStage = new Map();
  for (const digest of digests) {
    const byId = new Map(digest.agents.map((agent) => [agent.agent_id, agent]));
    for (const agent of digest.agents) {
      addFriction(bySkill, skillOf(agent, byId), agent);
      addFriction(byStage, agent.stage ?? NO_STAGE, agent);
    }
  }
  return { by_skill: byTotal(bySkill), by_stage: byTotal(byStage) };
}

function windowWeeks(since, now, starts) {
  const first = weekStartMs(starts.length > 0 ? Math.max(since, Math.min(...starts)) : since);
  const last = weekStartMs(Math.max(now, ...starts));
  const weeks = [];
  for (let ms = first; ms <= last; ms += WEEK_MS) {
    weeks.push({ partial: (ms < since && since < ms + WEEK_MS) || (ms <= now && now < ms + WEEK_MS), week: dayOf(ms) });
  }
  return weeks;
}

function stageFigures(entries) {
  const durations = entries.map((entry) => entry.duration_ms).filter(Number.isFinite);
  return {
    count: entries.length,
    duration_median_ms: median(durations),
    duration_ms: sum(durations),
    duration_unknown: entries.length - durations.length,
    units: sum(entries.map((entry) => entry.weighted_units ?? 0)),
  };
}

function stageTable(entries, weeks) {
  return STAGES.map((stage) => {
    const ofStage = entries.filter((entry) => entry.stage === stage);
    return {
      stage,
      ...stageFigures(ofStage),
      weeks: weeks.map(({ week }) => ({ week, ...stageFigures(ofStage.filter((entry) => entry.week === week)) })),
    };
  });
}

function projectFigures(digests, stageBySession) {
  const units = sum(digests.map((digest) => unitsOf(digest.tokens)));
  const staged = digests.map((digest) => stageBySession.get(keyOf(digest.project, digest.session_id)) ?? { duration_ms: 0, units: 0 });
  const stageUnits = sum(staged.map((item) => item.units));
  return { other_units: Math.max(0, units - stageUnits), sessions: digests.length, stage_duration_ms: sum(staged.map((item) => item.duration_ms)), stage_units: stageUnits, units };
}

function projectTable(digests, entries, weeks) {
  const stageBySession = new Map();
  for (const entry of entries) {
    const key = keyOf(entry.project, entry.session_id);
    const item = stageBySession.get(key) ?? { duration_ms: 0, units: 0 };
    item.units += entry.weighted_units ?? 0;
    item.duration_ms += Number.isFinite(entry.duration_ms) ? entry.duration_ms : 0;
    stageBySession.set(key, item);
  }
  const projects = [...new Set(digests.map((digest) => digest.project))].sort(compare);
  return projects.map((project) => {
    const ofProject = digests.filter((digest) => digest.project === project);
    return {
      project,
      ...projectFigures(ofProject, stageBySession),
      weeks: weeks.map(({ week }) => ({ week, ...projectFigures(ofProject.filter((digest) => isoWeekStart(digest.start) === week), stageBySession) })),
    };
  });
}

/** The verdict counts and the summed review findings of `tickets`, with the number of tickets the findings are known for. */
export function tallyOutcomes(tickets, unrecognized) {
  const verdicts = Object.fromEntries(VERDICTS.map((verdict) => [verdict, 0]));
  const findings = { accepted: 0, deferred: 0, dismissed: 0, known_for: 0 };
  for (const ticket of tickets) {
    verdicts[verdictOf(ticket)] += 1;
    const decisions = findingsOf(ticket, unrecognized);
    if (decisions !== null) {
      findings.known_for += 1;
      findings.accepted += decisions.accepted;
      findings.dismissed += decisions.dismissed;
      findings.deferred += decisions.deferred;
    }
  }
  return { findings, verdicts };
}

function outcomesOf(tickets, unrecognized) {
  const tally = tallyOutcomes(tickets, unrecognized);
  const findings = { ...tally.findings, of: tickets.length };
  const browser = { absent: 0, ran: { close: 0, ship: 0 }, skipped: {}, unknown: 0, unrecognized: 0 };
  for (const ticket of tickets) {
    const tests = ticket.outcome?.tests ?? null;
    if (tests === null) {
      browser.unknown += 1;
    } else if (tests.state === 'ran') {
      browser.ran[tests.by === 'ship' ? 'ship' : 'close'] += 1;
    } else if (tests.state === 'skipped') {
      browser.skipped[tests.cause] = (browser.skipped[tests.cause] ?? 0) + 1;
    } else if (tests.state === 'absent') {
      browser.absent += 1;
    } else {
      browser.unrecognized += 1;
    }
  }
  browser.skipped = Object.fromEntries(Object.entries(browser.skipped).sort(([a, x], [b, y]) => y - x || compare(a, b)));
  return { browser, findings, tickets: tickets.length, verdicts: tally.verdicts };
}

const artifactDate = (ticket) => ticket.outcome?.summary_mtime ?? ticket.outcome?.created ?? null;

/**
 * Every figure the report shows for `projects` (absolute paths) from `since`
 * to `now` (ms): `{counts, friction, outcomes, projects, scope, stages,
 * totals, weeks}`.
 */
export function aggregate({ digests, dataset, projects, since, now }) {
  const inScope = new Set(projects);
  const windowDigests = digests.filter((digest) => inWindow(digest.start, since));
  const scoped = windowDigests.filter((digest) => inScope.has(digest.project));
  const runs = runTickets(dataset, projects, since);
  const entries = runs.flatMap((ticket) =>
    ticket.sessions.flatMap((session) =>
      session.stages
        .filter((stage) => STAGES.includes(stage.stage) && inWindow(stage.start, since))
        .map((stage) => ({ ...stage, project: ticket.project, session_id: session.session_id, week: isoWeekStart(stage.start) })),
    ),
  );
  const starts = [...scoped.map((digest) => msOf(digest.start)), ...entries.map((entry) => msOf(entry.start))];
  const weeks = windowWeeks(since, now, starts);
  const artifacts = dataset.tickets.filter((ticket) => ticket.source === 'artifacts' && inScope.has(ticket.project));
  const datedArtifacts = artifacts.filter((ticket) => inWindow(artifactDate(ticket), since));
  const undated = digests.filter((digest) => inScope.has(digest.project) && !Number.isFinite(msOf(digest.start))).length + artifacts.filter((ticket) => !Number.isFinite(msOf(artifactDate(ticket)))).length;
  const outcomeTickets = [...runs, ...datedArtifacts].filter((ticket) => !isEpic(ticket));
  const listed = new Set([...runs, ...datedArtifacts].map((ticket) => keyOf(ticket.project, ticket.ticket)));
  const unrecognized = unrecognizedReviews(dataset);
  const stages = stageTable(entries, weeks);
  const projectRows = projectTable(scoped, entries, weeks);
  const friction = frictionOf(scoped.filter(recognized));
  return {
    counts: {
      artifacts_only: datedArtifacts.length,
      excluded_undated: undated,
      runs: runs.length,
      sessions: scoped.length,
      unmapped_sessions: windowDigests.filter((digest) => digest.project === null || digest.project === undefined).length,
      unrecognized: dataset.unrecognized.filter((item) => listed.has(keyOf(item.project, item.ticket))).length,
      without_recognition: scoped.filter((digest) => !recognized(digest)).length,
    },
    friction,
    outcomes: outcomesOf(outcomeTickets, unrecognized),
    projects: projectRows,
    scope: { projects: [...projects].sort(compare), since: dayOf(since), until: dayOf(now) },
    stages,
    totals: {
      friction: sum(friction.by_skill.map((row) => row.total)),
      stage_units: sum(stages.map((row) => row.units)),
      units: sum(projectRows.map((row) => row.units)),
    },
    weeks,
  };
}
