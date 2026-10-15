// The run report (CONTRACT.md §12).
//
// A pure renderer: one run's facts in, Markdown out, with the sections
// Outcome, Sync, Dispatched, Skips, Caps, Preconditions and Notes in that
// order. Every value is collapsed to one line and table cells escape `|`,
// because ids and notes come from the server. The report never carries a
// token, a credential-file line or a server URL.
//
// Private to the implementation: only dispatch.mjs is a command.

import { resumeHint, summaryLine } from './finish.mjs';
import { oneLine } from './output.mjs';

const NONE = 'None.';
const DASH = '—';

const text = (value) => (value === null || value === undefined || value === '' ? DASH : oneLine(value));
const cell = (value) => text(value).replace(/\|/g, '\\|');

/** One `sync` session's line: `- <label>: ok — session …` or `not run`. */
function syncLine(label, entry) {
  if (entry === null || entry === undefined) {
    return `- ${label}: not run`;
  }
  const state = entry.ok ? 'ok' : `FAILED (${text(entry.reason)})`;
  return `- ${label}: ${state} ${DASH} session ${text(entry.session_id)}, exit ${text(entry.exit_code)}, cost ${text(entry.cost_usd)} USD, log ${text(entry.log)}`;
}

/**
 * Render a report from
 * `{ run_id, project, started, finished, outcome, error, sync, items,
 *    not_admitted, skips, caps, preconditions, notes }`; missing parts render
 * as `None.`, a `sync` session that did not run as `not run`.
 */
export function renderReport(report) {
  const lines = [];
  const items = report.items ?? [];
  const notAdmitted = report.not_admitted ?? [];
  const skips = report.skips ?? [];
  const preconditions = report.preconditions ?? [];
  const notes = report.notes ?? [];
  const project = report.project ?? {};

  lines.push(`# Dispatch run ${text(report.run_id)}`, '');
  lines.push(`- project: ${text(project.name)} (${text(project.id)})`);
  lines.push(`- started: ${text(report.started)}`);
  lines.push(`- finished: ${text(report.finished)}`, '');

  lines.push('## Outcome', '', text(report.outcome), '');
  lines.push(summaryLine({ runId: report.run_id, items, skips, notAdmitted }));
  if (report.error) {
    lines.push('', `Error: ${text(report.error)}`);
  }
  lines.push('');

  lines.push('## Sync', '');
  lines.push(syncLine('before', report.sync?.before), syncLine('after', report.sync?.after), '');

  lines.push('## Dispatched', '');
  if (items.length === 0) {
    lines.push(NONE);
  } else {
    lines.push(
      '| Item | Kind | Tickets | Outcome | Reason | Pull request | Session | Exit | Cost (USD) | Rate-limit retries | Log |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const item of items) {
      const cells = [
        item.id,
        item.kind,
        (item.tickets ?? []).join(', '),
        item.outcome,
        item.reason,
        item.pr_url,
        item.session_id,
        item.exit_code,
        item.cost_usd,
        item.rate_limit_retries,
        item.log,
      ];
      lines.push(`| ${cells.map(cell).join(' | ')} |`);
    }
    const resumable = items.filter((item) => item.outcome === 'stuck' && item.session_id);
    if (resumable.length > 0) {
      lines.push('');
      for (const item of resumable) {
        lines.push(`- Resume ${text(item.id)}: ${text(resumeHint(item.session_id))}`);
      }
    }
  }
  if (notAdmitted.length > 0) {
    lines.push('', 'Not admitted:', '');
    for (const entry of notAdmitted) {
      lines.push(`- ${text(entry.id)} ${DASH} ${text(entry.reason)}`);
    }
  }
  lines.push('');

  lines.push('## Skips', '');
  if (skips.length === 0) {
    lines.push(NONE);
  } else {
    for (const entry of skips) {
      lines.push(`- ${text(entry.id)} ${DASH} ${text(entry.reason)}${entry.detail ? ` (${text(entry.detail)})` : ''}`);
    }
  }
  lines.push('');

  lines.push('## Caps', '');
  if (report.caps) {
    const caps = report.caps;
    lines.push(`- open PRs: ${caps.open_prs === null ? 'unknown' : caps.open_prs} / ${text(caps.max_open_prs)}`);
    lines.push(`- tickets admitted: ${text(caps.tickets_admitted)} / ${text(caps.max_tickets_per_run)}`);
    lines.push(`- reason: ${caps.reason ? text(caps.reason) : 'none'}`);
  } else {
    lines.push(NONE);
  }
  lines.push('');

  lines.push('## Preconditions', '');
  if (preconditions.length === 0) {
    lines.push(NONE);
  } else {
    for (const check of preconditions) {
      lines.push(`- ${check.ok ? 'ok' : 'FAILED'} ${text(check.name)} ${DASH} ${text(check.detail)}`);
    }
  }
  lines.push('');

  lines.push('## Notes', '');
  if (notes.length === 0) {
    lines.push(NONE);
  } else {
    for (const note of notes) {
      lines.push(`- ${text(note)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
