// Selection and admission for the dispatcher (CONTRACT.md §7–§8).
//
// Pure functions over plain data and an injected `now`: ticket rows in,
// candidates, skips and an admitted prefix out. Nothing here touches the
// network, the filesystem or a clock.
//
// Private to the implementation: only dispatch.mjs is a command.

const TERMINAL = new Set(['done', 'cancelled']);
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
 * `{id, kind, tickets, created_at}`, skips `{id, reason, detail}`, both in
 * `compareRows` order.
 */
export function selectCandidates(rows, { tag, maxAgeDays, now }) {
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
  const notes = [];

  const waitingOn = (ids) =>
    [...new Set(ids)]
      .filter((id) => !TERMINAL.has(byId.get(id)?.status))
      .sort(compareIds)
      .map((id) => `${id} (${byId.has(id) ? byId.get(id).status : 'not found'})`);

  const staleness = (row) => {
    const updated = Date.parse(row.updated_at);
    if (Number.isNaN(updated)) {
      notes.push(`${row.id}: unparseable updated_at — treated as stale`);
      return 'updated_at unparseable';
    }
    const ageDays = (nowMs - updated) / DAY_MS;
    return ageDays > maxAgeDays ? `updated ${Math.floor(ageDays)} days ago` : null;
  };

  const skip = (row, reason, detail = null) => skips.push({ id: row.id, reason, detail });
  const candidate = (row, tickets) => candidates.push({ id: row.id, kind: row.kind, tickets, created_at: row.created_at });

  for (const row of [...rows].sort(compareRows)) {
    if (!isTagged(row) || TERMINAL.has(row.status)) {
      continue;
    }
    if (row.kind === 'epic') {
      const children = childrenOf.get(row.id) ?? [];
      const backlog = children.filter((child) => child.status === 'backlog');
      if (backlog.length === 0) {
        skip(row, 'no backlog children');
        continue;
      }
      const inside = new Set(children.map((child) => child.id));
      const external = backlog.flatMap((child) => child.blocked_by.filter((id) => !inside.has(id)));
      const waiting = waitingOn([...row.blocked_by, ...external]);
      if (waiting.length > 0) {
        skip(row, 'blocked', `waiting on ${waiting.join(', ')}`);
        continue;
      }
      const stale = staleness(row);
      if (stale !== null) {
        skip(row, 'stale', stale);
        continue;
      }
      candidate(row, backlog.map((child) => child.id).sort(compareIds));
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
    const stale = staleness(row);
    if (stale !== null) {
      skip(row, 'stale', stale);
      continue;
    }
    candidate(row, [row.id]);
  }
  return { candidates, skips, notes };
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
  if (openPrs === null) {
    return {
      admitted,
      notAdmitted: candidates.map((item) => ({ id: item.id, reason: 'open PRs unknown' })),
      caps: caps(null, maxOpenPrs, 0, maxTicketsPerRun, 'open PRs could not be counted'),
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
  return { admitted, notAdmitted, caps: caps(openPrs, maxOpenPrs, tickets, maxTicketsPerRun, reason) };
}

function caps(openPrs, maxOpenPrs, ticketsAdmitted, maxTicketsPerRun, reason) {
  return {
    open_prs: openPrs,
    max_open_prs: maxOpenPrs,
    tickets_admitted: ticketsAdmitted,
    max_tickets_per_run: maxTicketsPerRun,
    reason,
  };
}
