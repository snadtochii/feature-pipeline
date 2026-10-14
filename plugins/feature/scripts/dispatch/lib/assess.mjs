// The decision pipeline both verbs share (CONTRACT.md §9–§10).
//
// configuration → server rows → open PRs → selection → open-PR count →
// admission. It writes nothing; `plan` prints its result and `run` records it.
//
// Private to the implementation: only dispatch.mjs is a command.

import { loadDispatchConfig } from './config.mjs';
import { countOpenPrs, listOpenPrs, prSlots } from './prs.mjs';
import { admit, selectCandidates } from './select.mjs';
import { listTickets, resolveServerAccess } from './server.mjs';

/**
 * Decide what a run would dispatch. `runs` is the runs.json history; a caller
 * that already read the configuration and resolved the server access passes
 * them as `config` and `access`, and their notes are then its own.
 * Returns `{ config, server, gh, candidates, admitted, notAdmitted, skips,
 * caps, notes }`; `gh` is `{ok, detail?}`. Throws ComputeError when the
 * configuration or the server says the answer cannot be computed.
 */
export async function assess({ projectRoot, env, now, runs, fetchImpl, config: loaded, access: resolved }) {
  const config = loaded ?? loadDispatchConfig(projectRoot);
  const access = resolved ?? resolveServerAccess(env, env.HOME);
  const listed = await listTickets({ access, projectId: config.project, ...(fetchImpl ? { fetchImpl } : {}) });
  const { tag, max_age_days: maxAgeDays, max_open_prs: maxOpenPrs, max_tickets_per_run: maxTicketsPerRun } = config.dispatch;
  const selection = selectCandidates(listed.rows, { tag, maxAgeDays, now });

  const prs = listOpenPrs({ projectRoot, env });
  let openPrs = null;
  if (prs.ok) {
    openPrs = countOpenPrs({ openPrs: prs.prs, runs, slots: prSlots(listed.rows, tag) }).count;
  }
  const admission = admit(selection.candidates, { openPrs, maxOpenPrs, maxTicketsPerRun });

  return {
    config,
    server: { ok: true, detail: `HTTP ${listed.status}, ${listed.rows.length} tickets` },
    gh: prs.ok ? { ok: true } : { ok: false, detail: prs.detail },
    candidates: selection.candidates,
    admitted: admission.admitted,
    notAdmitted: admission.notAdmitted,
    skips: selection.skips,
    caps: admission.caps,
    notes: [...(loaded ? [] : config.notes), ...listed.notes, ...selection.notes],
  };
}
