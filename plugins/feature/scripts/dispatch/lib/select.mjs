// Selection and admission for the dispatcher (CONTRACT.md §7–§8).
//
// Pure functions over plain data and an injected `now`: ticket rows in,
// candidates, skips, the untagged rows eligible if tagged, and an admitted
// prefix out. Both selections run one §7 table. Nothing here touches the
// network, the filesystem or a clock.
//
// Private to the implementation: only dispatch.mjs is a command.

export const TERMINAL = new Set(['done', 'cancelled']);
const DAY_MS = 86_400_000;
const ID_PARTS = /^(.*?)(\d+)$/;

/** Order ticket ids by prefix, then ticket number, then code unit. */
export function compareIds(a, b) {
  const ma = ID_PARTS.exec(a);
  const mb = ID_PARTS.exec(b);
  if (ma !== null && mb !== null && ma[1] === mb[1]) {
    const diff = Number(ma[2]) - Number(mb[2]);
    if (diff !== 0) {
      return diff;
    }
  }
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Order rows by `created_at` ascending (unparseable last), ties by id. */
export function compareRows(a, b) {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  const ka = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta;
  const kb = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb;
  if (ka !== kb) {
    return ka < kb ? -1 : 1;
  }
  return compareIds(a.id, b.id);
}

/**
 * Split the tagged, non-terminal rows into candidates and skips.
 * Returns `{ candidates, skips, notes }`; candidates are
 * `{id, kind, tickets, others, created_at}`, skips `{id, reason, detail}`, both
 * in `compareRows` order. `others` holds an epic's non-terminal children outside
 * `tickets`, which the same `ship` session walks.
 */
export function selectCandidates(rows, options) {
  const { candidates: pool, skips } = partition(rows, options, 'tagged');
  const candidates = [];
  const notes = [];
  for (const { stale, ...item } of pool) {
    if (stale === null) {
      candidates.push(item);
      continue;
    }
    if (stale === UNPARSEABLE) {
      notes.push(`${item.id}: unparseable updated_at — treated as stale`);
    }
    skips.push({ id: item.id, reason: 'stale', detail: stale });
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  skips.sort((a, b) => compareRows(byId.get(a.id), byId.get(b.id)));
  return { candidates, skips, notes };
}

/**
 * The untagged, non-terminal rows that would be candidates if each were tagged,
 * in `compareRows` order. Each item is a candidate plus `stale`: the staleness
 * detail, or null. Writing the tag refreshes `updated_at`, so staleness is
 * reported rather than judged.
 */
export function selectEligible(rows, options) {
  return partition(rows, options, 'untagged').candidates;
}

const UNPARSEABLE = 'updated_at unparseable';

/**
 * Run the §7 table, staleness aside, over the `pool` of rows: `'tagged'` or
 * `'untagged'`. A child of a tagged epic is covered whichever pool it is in.
 * Every candidate carries `stale`, the staleness detail or null, and the caller
 * decides what a stale candidate costs. Returns `{ candidates, skips }`, both in
 * `compareRows` order.
 */
function partition(rows, { tag, maxAgeDays, now }, pool) {
  const tagged = pool === 'tagged';
  const nowMs = now.getTime();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const childrenOf = new Map();
  for (const row of rows) {
    if (row.parent_id !== null) {
      if (!childrenOf.has(row.parent_id)) {
        childrenOf.set(row.parent_id, []);
      }
      childrenOf.get(row.parent_id).push(row);
    }
  }
  const isTagged = (row) => row.tags.includes(tag);
  const candidates = [];
  const skips = [];

  const waitingOn = (ids) =>
    [...new Set(ids)]
      .filter((id) => !TERMINAL.has(byId.get(id)?.status))
      .sort(compareIds)
      .map((id) => `${id} (${byId.has(id) ? byId.get(id).status : 'not found'})`);

  const staleness = (row) => {
    const updated = Date.parse(row.updated_at);
    if (Number.isNaN(updated)) {
      return UNPARSEABLE;
    }
    const ageDays = (nowMs - updated) / DAY_MS;
    return ageDays > maxAgeDays ? `updated ${Math.floor(ageDays)} days ago` : null;
  };

  const skip = (row, reason, detail = null) => skips.push({ id: row.id, reason, detail });
  const candidate = (row, tickets, others) =>
    candidates.push({ id: row.id, kind: row.kind, tickets, others, created_at: row.created_at, stale: staleness(row) });

  for (const row of [...rows].sort(compareRows)) {
    if (isTagged(row) !== tagged || TERMINAL.has(row.status)) {
      continue;
    }
    if (row.kind === 'epic') {
      const children = childrenOf.get(row.id) ?? [];
      const backlog = children.filter((child) => child.status === 'backlog');
      if (backlog.length === 0) {
        const open = waitingOn(children.map((child) => child.id));
        skip(row, 'no backlog children', open.length > 0 ? `still open: ${open.join(', ')}` : null);
        continue;
      }
      const inside = new Set(children.map((child) => child.id));
      const external = backlog.flatMap((child) => child.blocked_by.filter((id) => !inside.has(id)));
      const waiting = waitingOn([...row.blocked_by, ...external]);
      if (waiting.length > 0) {
        skip(row, 'blocked', `waiting on ${waiting.join(', ')}`);
        continue;
      }
      const others = children.filter((child) => child.status !== 'backlog' && !TERMINAL.has(child.status));
      candidate(row, backlog.map((child) => child.id).sort(compareIds), others.map((child) => child.id).sort(compareIds));
      continue;
    }
    const parent = row.parent_id !== null ? byId.get(row.parent_id) : undefined;
    if (parent !== undefined && parent.kind === 'epic' && isTagged(parent)) {
      skip(row, `covered by epic ${parent.id}`);
      continue;
    }
    if (row.status !== 'backlog') {
      skip(row, 'not backlog');
      continue;
    }
    const waiting = waitingOn(row.blocked_by);
    if (waiting.length > 0) {
      skip(row, 'blocked', `waiting on ${waiting.join(', ')}`);
      continue;
    }
    candidate(row, [row.id], []);
  }
  return { candidates, skips };
}

/**
 * Admit a prefix of `candidates` under both caps (CONTRACT.md §8).
 * `openPrs` is the open-PR count, or null when it could not be computed.
 * Returns `{ admitted, notAdmitted, caps }`.
 */
export function admit(candidates, { openPrs, maxOpenPrs, maxTicketsPerRun }) {
  const admitted = [];
  const notAdmitted = [];
  let tickets = 0;
  let reason = null;
  const ticketsTagged = candidates.reduce((sum, item) => sum + item.tickets.length, 0);
  if (openPrs === null) {
    return {
      admitted,
      notAdmitted: candidates.map((item) => ({ id: item.id, reason: 'open PRs unknown' })),
      caps: caps(null, maxOpenPrs, 0, ticketsTagged, maxTicketsPerRun, 'open PRs could not be counted'),
    };
  }
  if (openPrs >= maxOpenPrs) {
    reason = `max_open_prs reached (${openPrs}/${maxOpenPrs})`;
  }
  let stopped = null;
  for (const item of candidates) {
    if (stopped === null && openPrs + admitted.length >= maxOpenPrs) {
      stopped = 'pr cap';
      reason = `max_open_prs reached (${openPrs + admitted.length}/${maxOpenPrs})`;
    }
    const weight = item.tickets.length;
    if (stopped === null && admitted.length > 0 && tickets + weight > maxTicketsPerRun) {
      stopped = 'ticket cap';
      reason =
        tickets >= maxTicketsPerRun
          ? `max_tickets_per_run reached (${tickets}/${maxTicketsPerRun})`
          : `max_tickets_per_run has no room for ${item.id} (${tickets}/${maxTicketsPerRun}, needs ${weight})`;
    }
    if (stopped !== null) {
      notAdmitted.push({ id: item.id, reason: stopped });
      continue;
    }
    admitted.push(item);
    tickets += weight;
  }
  return { admitted, notAdmitted, caps: caps(openPrs, maxOpenPrs, tickets, ticketsTagged, maxTicketsPerRun, reason) };
}

function caps(openPrs, maxOpenPrs, ticketsAdmitted, ticketsTagged, maxTicketsPerRun, reason) {
  return {
    open_prs: openPrs,
    max_open_prs: maxOpenPrs,
    free_pr_slots: openPrs === null ? null : Math.max(0, maxOpenPrs - openPrs),
    tickets_admitted: ticketsAdmitted,
    tickets_tagged: ticketsTagged,
    max_tickets_per_run: maxTicketsPerRun,
    reason,
  };
}
