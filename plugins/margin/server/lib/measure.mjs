// The measurement rules of the overview data (CONTRACT §14): per listed file its line count,
// churn over the last six months, summed indentation, in-scope imports and outside specifiers,
// plus the hotspot table the explorer reads. It reads only the listed files, `tsconfig.json`
// files at or below the root, and `git` output.

import { git, listFiles, readSource } from './files.mjs';
import { createResolver, isScriptPath } from './imports.mjs';
import { RunError } from './session.mjs';

const CHURN_WINDOW = '6 months ago';
const HOTSPOT_HEADER = ['path', 'churn', 'lines', 'indentation', 'churn_x_lines', 'churn_x_indentation'];

export function countLines(text) {
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function isBlank(line) {
  return line.trim() === '';
}

export function detectWidth(texts) {
  const counts = new Map();
  for (const text of texts) {
    for (const line of text.split('\n')) {
      const run = /^ +/.exec(line);
      if (run !== null && !isBlank(line)) {
        counts.set(run[0].length, (counts.get(run[0].length) ?? 0) + 1);
      }
    }
  }
  let width = 0;
  let best = 0;
  for (const [length, count] of counts) {
    if (count > best || (count === best && length < width)) {
      width = length;
      best = count;
    }
  }
  if (width === 0) {
    return 1;
  }
  while (width % 2 === 0 && (counts.get(width / 2) ?? 0) * 2 >= best) {
    width /= 2;
  }
  return width;
}

export function indentation(text, width) {
  let total = 0;
  for (const line of text.split('\n')) {
    if (isBlank(line)) {
      continue;
    }
    const lead = /^[\t ]*/.exec(line)[0];
    const tabs = lead.length - lead.replaceAll('\t', '').length;
    total += tabs + Math.floor((lead.length - tabs) / width);
  }
  return total;
}

function gitPrefix(root) {
  try {
    return git(root, ['rev-parse', '--show-prefix']).trim();
  } catch {
    return null;
  }
}

function hasCommits(root) {
  try {
    git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

function churnCounts(root, targets) {
  const counts = new Map();
  const log = git(root, ['log', `--since=${CHURN_WINDOW}`, '--no-renames', '-z', '--name-only', '--format=', '--relative', '--', ...targets]);
  for (const path of log.split('\0')) {
    if (path !== '') {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return counts;
}

function hotspotTable(files) {
  const rows = files
    .filter((file) => file.lines !== null && !/[\t\n]/.test(file.path))
    .map((file) => {
      const churn = file.churn ?? 0;
      return { path: file.path, values: [churn, file.lines, file.indentation, churn * file.lines, churn * file.indentation] };
    })
    .sort((a, b) => b.values[4] - a.values[4] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return [HOTSPOT_HEADER, ...rows.map((row) => [row.path, ...row.values])].map((cells) => `${cells.join('\t')}\n`).join('');
}

export function measureScope({ root, scope, ownFiles = [] }) {
  const paths = listFiles(root, scope, ownFiles);
  if (paths.length === 0) {
    throw new RunError(`no files under ${scope.join(', ') || root}`, 1);
  }
  const texts = new Map();
  for (const path of paths) {
    const source = readSource(root, path);
    if (typeof source?.text === 'string') {
      texts.set(path, source.text);
    }
  }
  const width = detectWidth(texts.values());
  const prefix = gitPrefix(root);
  const targets = scope.length > 0 ? scope : ['.'];
  const churn = prefix === null ? null : hasCommits(root) ? churnCounts(root, targets) : new Map();
  const resolver = createResolver(root, paths);
  const files = paths.map((path) => {
    const text = texts.get(path);
    const links = text !== undefined && isScriptPath(path) ? resolver.resolveImports(path, text) : { imports: [], outside: [] };
    return {
      path,
      lines: text === undefined ? null : countLines(text),
      churn: churn === null ? null : churn.get(path) ?? 0,
      indentation: text === undefined ? null : indentation(text, width),
      imports: links.imports,
      outside: links.outside,
    };
  });
  return {
    document: { version: 1, root, scope: targets, prefix, files },
    tsv: hotspotTable(files),
    warnings: resolver.warnings,
    summary: { files: files.length, churn: prefix === null ? null : 'git' },
  };
}
