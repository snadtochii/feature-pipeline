// The report page (../CONTRACT.md §9): one self-contained HTML document with
// inline styles and inline SVG charts, no script, no external asset and no
// URL. Every section and every box is emitted in a fixed order whatever the
// data holds, a box without data carrying a state message in the place of its
// chart or table, so the page keeps one skeleton in the populated, empty,
// error and disabled-comparison states. Every interpolated value is
// entity-escaped. Pure.
//
// Private to the implementation: only insights.mjs is a command.

import { FRICTION_KEYS, STAGES, VERDICTS, foldRows } from './aggregate.mjs';
import { MIN_COMPARE_REASON, MIN_COMPARE_RUNS } from './compare.mjs';

export const MAX_SKILL_ROWS = 15;

const ENTITIES = { '"': '&quot;', '&': '&amp;', "'": '&#39;', '<': '&lt;', '>': '&gt;' };
const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#b07aa1', '#e15759', '#76b7b2'];
const STAGE_COLORS = Object.fromEntries(STAGES.map((stage, index) => [stage, PALETTE[index]]));
const CHART_WIDTH = 640;
const MAX_LABEL = 28;

const FRICTION_LABELS = {
  failed_checks: 'Failed check runs',
  interrupts: 'Interrupts',
  permission_denials: 'Permission denials',
  rejections: 'Rejected tool calls',
  tool_errors: 'Tool errors',
};

const STYLE = `
*{box-sizing:border-box}
body{margin:0;padding:24px;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2328;background:#ffffff}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:17px;margin:28px 0 8px}
.meta,.note{color:#59636e;margin:4px 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.box{min-height:260px;min-width:0;border:1px solid #d1d9e0;border-radius:8px;padding:12px;background:#f6f8fa}
.box[data-box="status-summary"],.box[data-box="gaps-table"]{min-height:180px}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
caption{text-align:left;font-weight:600;padding:0 0 6px}
th,td{padding:4px 8px;border-bottom:1px solid #d1d9e0;text-align:right;white-space:nowrap}
thead th:first-child,th[scope="row"]{text-align:left}
th[scope="row"]{white-space:normal;overflow-wrap:anywhere;min-width:8em;font-weight:normal}
.chart{display:block;width:100%;height:auto}
.state{display:flex;align-items:center;justify-content:center;min-height:220px;margin:0;color:#59636e;text-align:center}
.state[data-state="error"]{color:#a40e26}
dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;margin:0}
dt{font-weight:600}
dd{margin:0;overflow-wrap:anywhere}
@media (max-width: 640px){body{padding:12px}.grid{grid-template-columns:1fr}.box{min-height:220px}}
`;

/** `value` as text with `& < > " '` entity-escaped. */
export const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ENTITIES[char]);

const sum = (values) => values.reduce((total, value) => total + value, 0);

/** Weighted units rounded, with thousands separators; a dash when unknown. */
export function fmtUnits(value) {
  return Number.isFinite(value) ? String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '—';
}

/** A duration in ms as `Hh Mm`, `Mm` or `Ss`; a dash when unknown. */
export function fmtDuration(ms) {
  if (!Number.isFinite(ms)) {
    return '—';
  }
  const sign = ms < 0 ? '-' : '';
  const seconds = Math.round(Math.abs(ms) / 1000);
  if (seconds < 60) {
    return `${sign}${seconds}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${sign}${hours}h ${minutes}m` : `${sign}${minutes}m`;
}

const signed = (text, value) => (value > 0 ? `+${text}` : text);
const shortLabel = (text) => (text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text);
const weekLabel = (week) => (week.partial ? `${week.week} (partial)` : week.week);

const stateBox = (state, text) => `<p class="state" data-state="${esc(state)}">${esc(text)}</p>`;
const box = (name, body) => `<div class="box" data-box="${esc(name)}">${body}</div>`;
const note = (text) => `<p class="note">${esc(text)}</p>`;

function section(id, title, intro, boxes) {
  return `<section id="${esc(id)}"><h2>${esc(title)}</h2>${intro === null ? '' : note(intro)}<div class="grid">${boxes.join('')}</div></section>`;
}

function table(caption, headers, rows) {
  const head = headers.map((header) => `<th scope="col">${esc(header)}</th>`).join('');
  const body = rows.map((row) => `<tr>${row.map((cell, index) => (index === 0 ? `<th scope="row">${esc(cell)}</th>` : `<td>${esc(cell)}</td>`)).join('')}</tr>`).join('');
  return `<div class="scroll"><table><caption>${esc(caption)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const svgOpen = (height, title) => `<svg class="chart" viewBox="0 0 ${CHART_WIDTH} ${height}" width="100%" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>`;
const text = (x, y, anchor, body) => `<text x="${x}" y="${y}" font-size="11" fill="currentColor" text-anchor="${anchor}">${esc(body)}</text>`;
const round = (value) => Math.round(value * 10) / 10;

/** A stacked column chart: one column per week, one coloured segment per series, each segment a `<rect>` even at zero height. */
export function columnChart(title, weeks, series) {
  const height = 260;
  const [left, right, top, bottom] = [64, 8, 30, 36];
  const plotWidth = CHART_WIDTH - left - right;
  const plotHeight = height - top - bottom;
  const slot = plotWidth / Math.max(weeks.length, 1);
  const barWidth = round(slot * 0.7);
  const totals = weeks.map((_, index) => sum(series.map((item) => item.values[index])));
  const max = Math.max(0, ...totals);
  const scale = max > 0 ? plotHeight / max : 0;
  const parts = [svgOpen(height, title)];
  series.forEach((item, index) => {
    const x = left + index * 130;
    parts.push(`<rect x="${x}" y="8" width="10" height="10" fill="${item.color}"></rect>`, text(x + 14, 17, 'start', shortLabel(item.name)));
  });
  parts.push(`<line x1="${left}" y1="${top + plotHeight}" x2="${CHART_WIDTH - right}" y2="${top + plotHeight}" stroke="currentColor" stroke-width="1"></line>`);
  parts.push(text(left - 6, top + 4, 'end', fmtUnits(max)), text(left - 6, top + plotHeight, 'end', '0'));
  const labelEvery = Math.max(1, Math.ceil(weeks.length / 8));
  weeks.forEach((week, index) => {
    const x = round(left + index * slot + (slot - barWidth) / 2);
    let stacked = 0;
    for (const item of series) {
      const value = item.values[index];
      const segment = round(value * scale);
      stacked += segment;
      parts.push(`<rect x="${x}" y="${round(top + plotHeight - stacked)}" width="${barWidth}" height="${segment}" fill="${item.color}"><title>${esc(`${item.name}, week of ${week.week}: ${fmtUnits(value)}`)}</title></rect>`);
    }
    if (index % labelEvery === 0) {
      parts.push(text(round(x + barWidth / 2), height - 14, 'middle', week.week.slice(5)));
    }
  });
  parts.push('</svg>');
  return parts.join('');
}

/** A horizontal bar chart, one labelled bar with its value per row. */
export function barChart(title, rows, format) {
  const rowHeight = 22;
  const height = rows.length * rowHeight + 12;
  const [labelWidth, valueWidth] = [184, 72];
  const plotWidth = CHART_WIDTH - labelWidth - valueWidth;
  const max = Math.max(0, ...rows.map((row) => row.value));
  const scale = max > 0 ? plotWidth / max : 0;
  const parts = [svgOpen(height, title)];
  rows.forEach((row, index) => {
    const y = 6 + index * rowHeight;
    const width = round(row.value * scale);
    parts.push(
      text(labelWidth - 8, y + 14, 'end', shortLabel(row.label)),
      `<rect x="${labelWidth}" y="${y + 3}" width="${width}" height="${rowHeight - 6}" fill="${row.color ?? PALETTE[0]}"><title>${esc(`${row.label}: ${format(row.value)}`)}</title></rect>`,
      text(round(labelWidth + width + 6), y + 14, 'start', format(row.value)),
    );
  });
  parts.push('</svg>');
  return parts.join('');
}

/** `populated` when the scope holds a session, a run or an artifact-only ticket in the window; else `empty`. */
export function pageState(agg) {
  return agg.counts.sessions > 0 || agg.counts.runs > 0 || agg.counts.artifacts_only > 0 ? 'populated' : 'empty';
}

function statusBox(meta, agg, state) {
  const rows = [
    ['Extract', meta.extract_error === null ? 'ok' : `failed — ${meta.extract_error}`],
    ['Scope', meta.label === 'all' ? `all projects (${agg.scope.projects.length})` : meta.label],
    ['Projects', agg.scope.projects.length > 0 ? agg.scope.projects.join(', ') : 'none'],
    ['Window', `${agg.scope.since} to ${agg.scope.until} (UTC), ${agg.weeks.length} ISO weeks starting Monday`],
    ['Generated', meta.generated],
    ['Durations', 'wall-clock spans of each stage, verdict-gate waits included'],
  ];
  const list = `<dl>${rows.map(([term, detail]) => `<dt>${esc(term)}</dt><dd>${esc(detail)}</dd>`).join('')}</dl>`;
  const message =
    meta.extract_error !== null
      ? stateBox('error', 'The extract failed; the figures below come from the digests already cached.')
      : state === 'empty'
        ? stateBox('empty', 'No sessions and no tickets in this scope and window.')
        : '';
  return box('status-summary', `${list}${message}`);
}

function emptyBox(meta, name, what) {
  return box(name, meta.extract_error === null ? stateBox('empty', `No ${what} in this scope and window.`) : stateBox('error', `No ${what}: the extract failed, see the status panel.`));
}

function stageSection(meta, agg) {
  const hasRuns = agg.stages.some((row) => row.count > 0);
  const series = agg.stages.map((row) => ({ color: STAGE_COLORS[row.stage], name: row.stage, values: row.weeks.map((week) => week.units) }));
  const chart = hasRuns ? box('stage-chart', columnChart('Weighted units per stage, by week', agg.weeks, series)) : emptyBox(meta, 'stage-chart', 'stage runs');
  const totals = hasRuns
    ? box(
        'stage-table',
        table(
          'Per stage, whole window',
          ['Stage', 'Runs', 'Weighted units', 'Wall-clock total', 'Wall-clock median', 'Duration unknown'],
          agg.stages.map((row) => [row.stage, row.count, fmtUnits(row.units), fmtDuration(row.duration_ms), fmtDuration(row.duration_median_ms), row.duration_unknown]),
        ),
      )
    : emptyBox(meta, 'stage-table', 'stage runs');
  const headers = ['Week', ...agg.stages.flatMap((row) => [`${row.stage} units`, `${row.stage} time`])];
  const weekly = hasRuns
    ? box(
        'stage-weeks',
        table(
          'Per stage, by week',
          headers,
          agg.weeks.map((week, index) => [weekLabel(week), ...agg.stages.flatMap((row) => [fmtUnits(row.weeks[index].units), fmtDuration(row.weeks[index].duration_ms)])]),
        ),
      )
    : emptyBox(meta, 'stage-weeks', 'stage runs');
  return section('stage-time', 'Tokens and time per stage', 'Weighted units are input-token equivalents; each stage counts its head agent and the agents it spawned for the same ticket.', [chart, totals, weekly]);
}

function projectSection(meta, agg) {
  const has = agg.projects.length > 0;
  const series = [
    { color: PALETTE[0], name: 'in a stage', values: agg.weeks.map((_, index) => sum(agg.projects.map((row) => row.weeks[index].stage_units))) },
    { color: PALETTE[5], name: 'other', values: agg.weeks.map((_, index) => sum(agg.projects.map((row) => row.weeks[index].other_units))) },
  ];
  const chart = has ? box('project-chart', columnChart('Weighted units by week, in a recognized stage and other', agg.weeks, series)) : emptyBox(meta, 'project-chart', 'sessions');
  const totals = has
    ? box(
        'project-table',
        table(
          'Per project, whole window',
          ['Project', 'Sessions', 'Weighted units', 'In a stage', 'Other', 'Stage wall-clock'],
          agg.projects.map((row) => [row.project, row.sessions, fmtUnits(row.units), fmtUnits(row.stage_units), fmtUnits(row.other_units), fmtDuration(row.stage_duration_ms)]),
        ),
      )
    : emptyBox(meta, 'project-table', 'sessions');
  const weekly = has
    ? box(
        'project-weeks',
        table(
          'Per project, by week',
          ['Week', 'Project', 'Sessions', 'Weighted units', 'In a stage', 'Stage wall-clock'],
          agg.weeks.flatMap((week, index) =>
            agg.projects.map((row) => [weekLabel(week), row.project, row.weeks[index].sessions, fmtUnits(row.weeks[index].units), fmtUnits(row.weeks[index].stage_units), fmtDuration(row.weeks[index].stage_duration_ms)]),
          ),
        ),
      )
    : emptyBox(meta, 'project-weeks', 'sessions');
  return section('project-time', 'Tokens and time per project', 'Every session in the window counts; the stage share is the part spent inside a recognized pipeline stage.', [chart, totals, weekly]);
}

function frictionTable(caption, first, rows) {
  return table(caption, [first, ...FRICTION_KEYS.map((key) => FRICTION_LABELS[key]), 'Check runs', 'Total'], rows.map((row) => [row.name, ...FRICTION_KEYS.map((key) => row[key]), row.check_runs, row.total]));
}

function frictionSection(meta, agg) {
  const skills = foldRows(agg.friction.by_skill, MAX_SKILL_ROWS);
  const has = skills.length > 0;
  const chart = has
    ? box('friction-chart', barChart('Friction events per skill', skills.map((row) => ({ label: row.name, value: row.total })), String))
    : emptyBox(meta, 'friction-chart', 'agents');
  const bySkill = has ? box('friction-skill-table', frictionTable(`Per skill (top ${MAX_SKILL_ROWS}, then other)`, 'Skill', skills)) : emptyBox(meta, 'friction-skill-table', 'agents');
  const byStage = agg.friction.by_stage.length > 0 ? box('friction-stage-table', frictionTable('Per stage', 'Stage', agg.friction.by_stage)) : emptyBox(meta, 'friction-stage-table', 'agents');
  return section('friction', 'Friction per skill and stage', "An agent's friction counts toward the first skill it, or its nearest ancestor, invoked.", [chart, bySkill, byStage]);
}

function outcomeSection(meta, agg) {
  const { browser, findings, tickets, verdicts } = agg.outcomes;
  const has = tickets > 0;
  const chart = has
    ? box('verdict-chart', barChart('Tickets per verdict', VERDICTS.map((verdict, index) => ({ color: PALETTE[index + 2] ?? PALETTE[0], label: verdict, value: verdicts[verdict] })), String))
    : emptyBox(meta, 'verdict-chart', 'tickets');
  const findingsBox = has
    ? box(
        'findings-table',
        table('Review findings', ['Findings', 'Count'], [
          ['Accepted', findings.accepted],
          ['Dismissed', findings.dismissed],
          ['Deferred', findings.deferred],
          ['Known for', `${findings.known_for} of ${findings.of} tickets`],
        ]),
      )
    : emptyBox(meta, 'findings-table', 'tickets');
  const browserRows = [
    ['Ran (close stage)', browser.ran.close],
    ['Ran (ship)', browser.ran.ship],
    ...Object.entries(browser.skipped).map(([cause, count]) => [`Skipped: ${cause}`, count]),
    ['No 05-tests.md', browser.absent],
    ['Unrecognized', browser.unrecognized],
    ['Unknown (no ticket artifacts)', browser.unknown],
  ];
  const browserBox = has ? box('browser-table', table('Browser pass', ['Browser pass', 'Tickets'], browserRows)) : emptyBox(meta, 'browser-table', 'tickets');
  return section('outcomes', 'Outcomes', "A verdict is the ticket's 06-summary.md, else its last close result, else unknown; findings are unknown, never zero, without a recognized 04-review.md.", [
    chart,
    findingsBox,
    browserBox,
  ]);
}

function gapsSection(agg) {
  const rows = [
    ['Unmapped sessions (machine-wide)', agg.counts.unmapped_sessions],
    ['Artifact-only tickets', agg.counts.artifacts_only],
    ['Unrecognized artifact labels', agg.counts.unrecognized],
    ['Sessions without recognition', agg.counts.without_recognition],
    ['Left out as undated', agg.counts.excluded_undated],
  ];
  return section('gaps', 'Coverage gaps', 'Unmapped sessions are counted across the machine, in the window; every other figure is for the selected scope.', [
    box('gaps-table', table('Coverage gaps', ['Gap', 'Count'], rows)),
  ]);
}

const floorNote = (minRuns, reason) => note(`The comparison needs at least ${minRuns} runs on each side: ${reason}.`);

function excludedNote(excluded) {
  return note(`Left out: ${excluded.straddling} runs spanning the boundary version, ${excluded.unversioned} runs without a plugin version, ${excluded.epics} epic runs.`);
}

const delta = (after, before, format) => (Number.isFinite(after) && Number.isFinite(before) ? signed(format(after - before), after - before) : '—');

/** The comparison box: token and time differences appear only here, and only beside both sides' run counts, verdicts and findings. */
export function compareBlock(compare) {
  if (compare === null) {
    return box('compare-table', `${stateBox('off', 'Not requested. Run with --compare X.Y.Z to set the runs since a plugin version against as many runs before it.')}${floorNote(MIN_COMPARE_RUNS, MIN_COMPARE_REASON)}`);
  }
  const { after, before, version } = compare;
  if (compare.state !== 'shown') {
    const message = `Insufficient: ${after.pool} runs since ${version}, ${before.pool} before; ${after.runs} on each side can be compared.`;
    return box('compare-table', `${stateBox('disabled', message)}${floorNote(compare.min_runs, compare.reason)}${excludedNote(compare.excluded)}`);
  }
  const rows = [
    ['Runs compared', before.runs, after.runs, '—'],
    ['Runs available', before.pool, after.pool, '—'],
    ['Median weighted units', fmtUnits(before.units_median), fmtUnits(after.units_median), delta(after.units_median, before.units_median, fmtUnits)],
    ['Total weighted units', fmtUnits(before.units_total), fmtUnits(after.units_total), delta(after.units_total, before.units_total, fmtUnits)],
    ['Median stage wall-clock', fmtDuration(before.duration_median_ms), fmtDuration(after.duration_median_ms), delta(after.duration_median_ms, before.duration_median_ms, fmtDuration)],
    ['Wall-clock known for', `${before.duration_known} runs`, `${after.duration_known} runs`, '—'],
    ...VERDICTS.map((verdict) => [`Verdict ${verdict}`, before.verdicts[verdict], after.verdicts[verdict], '—']),
    ['Findings accepted', before.findings.accepted, after.findings.accepted, '—'],
    ['Findings dismissed', before.findings.dismissed, after.findings.dismissed, '—'],
    ['Findings deferred', before.findings.deferred, after.findings.deferred, '—'],
    ['Findings known for', `${before.findings.known_for} of ${before.runs} runs`, `${after.findings.known_for} of ${after.runs} runs`, '—'],
  ];
  const body = table(`Runs before ${version} against runs since it, nearest the boundary`, ['Figure', `Before ${version}`, `Since ${version}`, 'Difference'], rows);
  return box('compare-table', `${body}${floorNote(compare.min_runs, compare.reason)}${excludedNote(compare.excluded)}`);
}

function compareSection(compare) {
  return section('compare', 'Plugin version comparison', 'A token or time difference is never shown without the verdict and findings figures of both sides beside it.', [compareBlock(compare)]);
}

/**
 * The whole page. `meta` is `{extract_error, generated, label}`; `agg` is
 * aggregate's result; `compare` is compareWindows' result, or null when no
 * comparison was asked for.
 */
export function renderPage({ agg, compare, meta }) {
  const state = pageState(agg);
  const bodyState = meta.extract_error === null ? state : 'error';
  const compareState = compare === null ? 'off' : compare.state;
  const scope = meta.label === 'all' ? 'all projects' : meta.label;
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(`Pipeline insights — ${scope}`)}</title>`,
    `<style>${STYLE}</style></head>`,
    `<body data-state="${esc(bodyState)}" data-compare="${esc(compareState)}">`,
    `<header><h1>Pipeline insights</h1><p class="meta">${esc(`${scope}, ${agg.scope.since} to ${agg.scope.until}`)}</p></header>`,
    '<main>',
    section('status', 'Status', null, [statusBox(meta, agg, state)]),
    stageSection(meta, agg),
    projectSection(meta, agg),
    frictionSection(meta, agg),
    outcomeSection(meta, agg),
    gapsSection(agg),
    compareSection(compare),
    '</main></body></html>',
    '',
  ].join('\n');
}

/** The ordered `id="…"` and `data-box="…"` values of a page: its skeleton. */
export function skeletonSignature(html) {
  return [...html.matchAll(/\s(id|data-box)="([^"]*)"/g)].map((match) => `${match[1]}:${match[2]}`);
}
