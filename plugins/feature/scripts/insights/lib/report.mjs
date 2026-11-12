// The `report` verb (../CONTRACT.md §9): resolve the project scope from
// `--project` or the working directory, bring the cache up to date in
// process, reduce it to the report's figures, render the page, write it under
// `$HOME/.feature-pipeline/insights/reports/` and return the bounded report
// document with its summary lines. An extractor failure is explained in the
// page rather than failing the run.
//
// Private to the implementation: only insights.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';

import { ComputeError, UsageError, oneLine } from '../../lib/output.mjs';
import { writeAtomic } from '../../lib/write-atomic.mjs';
import { dateMs, shown } from './args.mjs';
import { aggregate, defaultSinceMs, runTickets, unrecognizedReviews } from './aggregate.mjs';
import { ensureReportsDir, loadDigests, pathsFor } from './cache.mjs';
import { compareWindows } from './compare.mjs';
import { runExtract } from './extract.mjs';
import { pageState, renderPage } from './html.mjs';
import { ticketDataset } from './outcomes.mjs';
import { defaultProbe, mapProject } from './project.mjs';

const MAX_LISTED = 20;
const MAX_REASON = 200;
const SLUG_UNSAFE = /[^A-Za-z0-9._-]/g;

/**
 * The scope a report asks for, decided before the extract runs: `{ kind:
 * 'all' }`, `{ kind: 'name', name }` for `--project <name>`, or `{ kind:
 * 'path', project }` for the project the working directory maps to. A
 * directory mapping to no project, with no `--project`, is a usage error.
 */
export function resolveScope({ flags, cwd, probe = defaultProbe }) {
  if (flags.project === 'all') {
    return { kind: 'all' };
  }
  if (flags.project !== null) {
    return { kind: 'name', name: flags.project };
  }
  const dir = flags.cwd ?? cwd;
  const { project } = mapProject(dir, probe);
  if (project === null) {
    throw new UsageError(`the directory ${dir} belongs to no project (no claudedocs/tickets/ above it); pass --project <name> or --project all`);
  }
  return { kind: 'path', project };
}

/**
 * The project paths `scope` selects among `projects`, the distinct mapped
 * project paths of the digests, as `{ label, projects }`. A name is an exact
 * absolute path or an exact base name; none or several matching is a usage
 * error. A working-directory project selects itself, digests or not.
 */
export function matchProject(scope, projects) {
  if (scope.kind === 'all') {
    return { label: 'all', projects: [...projects] };
  }
  if (scope.kind === 'path') {
    return { label: path.basename(scope.project), projects: [scope.project] };
  }
  const matches = path.isAbsolute(scope.name) ? projects.filter((project) => project === scope.name) : projects.filter((project) => path.basename(project) === scope.name);
  if (matches.length === 1) {
    return { label: path.basename(matches[0]), projects: matches };
  }
  if (matches.length > 1) {
    throw new UsageError(`project name ${shown(scope.name)} is ambiguous: ${matches.slice(0, MAX_LISTED).join(', ')}; pass its absolute path`);
  }
  const known = [...new Set(projects.map((project) => path.basename(project)))].sort().slice(0, MAX_LISTED);
  throw new UsageError(`unknown project ${shown(scope.name)}; known: ${known.length > 0 ? known.join(', ') : 'none'}`);
}

/** `<YYYYMMDDTHHMMSSZ>-<slug>.html` under `dir`, suffixed `-2`, `-3`, … past any existing name. */
export function reportFile(dir, now, label) {
  const stamp = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  const slug = label.replace(SLUG_UNSAFE, '') || 'project';
  const base = `${stamp}-${slug}`;
  let name = `${base}.html`;
  for (let index = 2; fs.existsSync(path.join(dir, name)); index += 1) {
    name = `${base}-${index}.html`;
  }
  return path.join(dir, name);
}

const percent = (part, whole) => Math.round((100 * part) / whole);

function compareLine(compare) {
  if (compare === null) {
    return 'compare: not requested';
  }
  if (compare.state === 'shown') {
    return `compare ${compare.version}: shown, ${compare.before.runs} vs ${compare.after.runs} runs — figures in the report`;
  }
  return `compare ${compare.version}: insufficient, ${compare.after.pool} after, ${compare.before.pool} before, minimum ${compare.min_runs}`;
}

/** The ten fixed summary lines, built from counts, names and versions only; the report path last. */
export function summaryLines({ agg, compare, extractError, file, label }) {
  const { browser, findings, verdicts } = agg.outcomes;
  const topStage = [...agg.stages].sort((a, b) => b.units - a.units)[0];
  const stagePart = agg.totals.stage_units > 0 ? `top stage ${topStage.stage} (${percent(topStage.units, agg.totals.stage_units)}%)` : 'top stage none';
  const topSkill = agg.friction.by_skill.find((row) => row.total > 0);
  const skipped = Object.entries(browser.skipped);
  const skippedTotal = skipped.reduce((total, [, count]) => total + count, 0);
  const extract = extractError === null ? 'ok' : `failed — ${extractError.slice(0, MAX_REASON)}`;
  return [
    `scope: ${label === 'all' ? `all projects (${agg.scope.projects.length})` : label}, since ${agg.scope.since}`,
    `sessions: ${agg.counts.sessions} in scope, ${agg.counts.runs} pipeline runs; extract: ${extract}`,
    `tokens: ${Math.round(agg.totals.units)} weighted units, ${Math.round(agg.totals.stage_units)} in stages; ${stagePart}`,
    `friction: ${agg.totals.friction} events; ${topSkill === undefined ? 'top none' : `top ${topSkill.name} (${topSkill.total})`}`,
    `verdicts: pass ${verdicts.pass}, partial ${verdicts.partial}, stuck ${verdicts.stuck}, unknown ${verdicts.unknown}`,
    `findings: accepted ${findings.accepted}, dismissed ${findings.dismissed}, deferred ${findings.deferred} (known for ${findings.known_for} of ${findings.of} tickets)`,
    `browser pass: ran ${browser.ran.close + browser.ran.ship}, skipped ${skippedTotal}${skipped.length > 0 ? ` (top cause ${skipped[0][0]})` : ''}, absent ${browser.absent}`,
    `gaps: unmapped ${agg.counts.unmapped_sessions} (machine-wide), artifact-only ${agg.counts.artifacts_only}, unrecognized labels ${agg.counts.unrecognized}`,
    compareLine(compare),
    `report: ${file}`,
  ];
}

async function loadData({ cacheRoot, home, probe, runExtractFn }) {
  try {
    const { dataset, digests } = await runExtractFn({ home, probe });
    return { dataset, digests, extractError: null };
  } catch (err) {
    if (!(err instanceof ComputeError)) {
      throw err;
    }
    const digests = loadDigests(cacheRoot);
    return { dataset: ticketDataset(digests), digests, extractError: oneLine(err.message) };
  }
}

/**
 * Run `report` for parsed `flags` at `now` (ms): returns `{compare,
 * extract_error, report, state, summary}`. `HOME` unset and an uncreatable
 * reports directory are ComputeErrors; a bad scope is a UsageError and
 * writes nothing. `runExtractFn` replaces the in-process extract in the
 * self-test.
 */
export async function report({ flags, home, cwd, now, probe = defaultProbe, runExtractFn = runExtract }) {
  const { cacheRoot, reportsDir } = pathsFor(home);
  const scope = resolveScope({ cwd, flags, probe });
  const { dataset, digests, extractError } = await loadData({ cacheRoot, home, probe, runExtractFn });
  const { label, projects } = matchProject(scope, dataset.projects.map((project) => project.path));
  const since = flags.since === null ? defaultSinceMs(now) : dateMs(flags.since);
  const agg = aggregate({ dataset, digests, now, projects, since });
  const compare =
    flags.compare === null
      ? null
      : compareWindows({ tickets: runTickets(dataset, projects, flags.since === null ? null : since), unrecognized: unrecognizedReviews(dataset), version: flags.compare });
  const html = renderPage({ agg, compare, meta: { extract_error: extractError, generated: new Date(now).toISOString(), label } });
  ensureReportsDir(reportsDir);
  const file = reportFile(reportsDir, now, label);
  try {
    writeAtomic(file, html, 0o600);
  } catch (err) {
    throw new ComputeError(`cannot write the report ${file} (${err.code ?? 'error'})`);
  }
  return {
    compare: compare === null ? 'off' : compare.state,
    extract_error: extractError,
    report: file,
    state: pageState(agg),
    summary: summaryLines({ agg, compare, extractError, file, label }),
  };
}
