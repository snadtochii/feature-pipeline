// The import rule of the overview data (CONTRACT §14): which listed files a JS or TS file
// imports, and which specifiers point outside the scope. The scan is a heuristic over the source
// text, not a parser. A target counts only when it is a listed file, so resolution never probes
// the disk for one; the only files read are `tsconfig.json` files at or below the root.

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import { isRegularFile } from './files.mjs';

const JS_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'];

const PROBE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const TS_SIBLINGS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx', '.ts'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
const MAX_EXTENDS_DEPTH = 8;

const SPECIFIER_FORMS = [
  /(?:^|[^\w$.])(?:import|export)\s[^'";]*?\bfrom\s*(['"])([^'"\n]+)\1/g,
  /(?:^|[^\w$.])import\s*(['"])([^'"\n]+)\1/g,
  /(?:^|[^\w$.])import\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  /(?:^|[^\w$.])require\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];

export function isScriptPath(path) {
  return JS_EXTENSIONS.includes(posix.extname(path));
}

export function scanSpecifiers(text) {
  const code = withoutComments(text);
  const found = [];
  for (const form of SPECIFIER_FORMS) {
    for (const match of code.matchAll(form)) {
      found.push({ index: match.index, spec: match[2] });
    }
  }
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.spec);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRelativeSpecifier(spec) {
  return spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');
}

const QUOTES = new Set(["'", '"', '`']);

function stringEnd(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length && text[i] !== quote && (quote === '`' || text[i] !== '\n')) {
    i += text[i] === '\\' ? 2 : 1;
  }
  return Math.min(i + 1, text.length);
}

function withoutComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (QUOTES.has(text[i])) {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      out += ' ';
      i = end === -1 ? text.length : end + 2;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

function withoutTrailingCommas(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (text[i] !== ',' || !/^\s*[}\]]/.test(text.slice(i + 1))) {
      out += text[i];
    }
    i += 1;
  }
  return out;
}

export function parseJsonc(text) {
  return JSON.parse(withoutTrailingCommas(withoutComments(text)));
}

export function createResolver(root, listing) {
  const listed = new Set(listing);
  const aliasesByDir = new Map();
  const warnings = [];

  const toRootRelative = (abs) => relative(root, abs).split(sep).join('/');
  const isInsideRoot = (abs) => {
    const rel = relative(root, abs);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  const isReallyInsideRoot = (abs) => {
    try {
      return realpathSync(abs).startsWith(`${realpathSync(root)}${sep}`);
    } catch {
      return false;
    }
  };

  function loadConfig(abs, chain) {
    const label = toRootRelative(abs);
    let parsed;
    try {
      parsed = parseJsonc(readFileSync(abs, 'utf8'));
    } catch (err) {
      warnings.push(`tsconfig ${label}: ignored, it could not be parsed (${err?.code ?? err?.message})`);
      return null;
    }
    if (!isObject(parsed)) {
      warnings.push(`tsconfig ${label}: ignored, it is not a JSON object`);
      return null;
    }
    const config = { baseUrl: null, paths: null, pathsDir: null };
    const bases = typeof parsed.extends === 'string' ? [parsed.extends] : Array.isArray(parsed.extends) ? parsed.extends : [];
    for (const base of bases) {
      if (typeof base !== 'string' || !base.startsWith('.')) {
        continue;
      }
      const target = base.endsWith('.json') ? resolve(dirname(abs), base) : resolve(dirname(abs), `${base}.json`);
      let skipped = null;
      if (!isInsideRoot(target)) {
        skipped = 'resolves outside the root';
      } else if (chain.includes(target)) {
        skipped = 'forms a cycle';
      } else if (chain.length > MAX_EXTENDS_DEPTH) {
        skipped = `is more than ${MAX_EXTENDS_DEPTH} levels deep`;
      } else if (!isRegularFile(target)) {
        skipped = 'was not found';
      } else if (!isReallyInsideRoot(target)) {
        skipped = 'resolves outside the root';
      }
      if (skipped !== null) {
        warnings.push(`tsconfig ${label}: extends ${base} skipped, it ${skipped}`);
        continue;
      }
      const inherited = loadConfig(target, [...chain, target]);
      if (inherited !== null) {
        config.baseUrl = inherited.baseUrl ?? config.baseUrl;
        if (inherited.paths !== null) {
          config.paths = inherited.paths;
          config.pathsDir = inherited.pathsDir;
        }
      }
    }
    const options = isObject(parsed.compilerOptions) ? parsed.compilerOptions : {};
    if (typeof options.baseUrl === 'string') {
      config.baseUrl = resolve(dirname(abs), options.baseUrl);
    }
    if (isObject(options.paths)) {
      config.paths = options.paths;
      config.pathsDir = dirname(abs);
    }
    return config;
  }

  function compileAliases(config) {
    const exact = new Map();
    const wildcard = [];
    for (const [pattern, targets] of Object.entries(config.paths ?? {})) {
      if (!Array.isArray(targets)) {
        continue;
      }
      const strings = targets.filter((target) => typeof target === 'string');
      const star = pattern.indexOf('*');
      if (star === -1) {
        exact.set(pattern, strings);
      } else if (pattern.indexOf('*', star + 1) === -1) {
        wildcard.push({ prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), targets: strings });
      }
    }
    wildcard.sort((a, b) => b.prefix.length - a.prefix.length);
    return { base: config.baseUrl ?? config.pathsDir, exact, wildcard };
  }

  function aliasesFor(dir) {
    if (aliasesByDir.has(dir)) {
      return aliasesByDir.get(dir);
    }
    const abs = join(root, dir, 'tsconfig.json');
    const config = isRegularFile(abs) ? loadConfig(abs, [abs]) : null;
    let aliases = null;
    if (config !== null) {
      aliases = compileAliases(config);
    } else if (dir !== '') {
      const parent = posix.dirname(dir);
      aliases = aliasesFor(parent === '.' ? '' : parent);
    }
    aliasesByDir.set(dir, aliases);
    return aliases;
  }

  function probe(base) {
    const candidates = [];
    const ext = posix.extname(base);
    for (const sibling of TS_SIBLINGS[ext] ?? []) {
      candidates.push(`${base.slice(0, -ext.length)}${sibling}`);
    }
    candidates.push(base);
    for (const extension of PROBE_EXTENSIONS) {
      candidates.push(`${base}${extension}`);
    }
    const indexDir = base === '' || base === '.' ? '' : `${base}/`;
    for (const extension of PROBE_EXTENSIONS) {
      candidates.push(`${indexDir}index${extension}`);
    }
    return candidates.find((candidate) => listed.has(candidate)) ?? null;
  }

  function aliasTargets(aliases, spec) {
    if (aliases.exact.has(spec)) {
      return aliases.exact.get(spec);
    }
    const match = aliases.wildcard.find(({ prefix, suffix }) => spec.length >= prefix.length + suffix.length
      && spec.startsWith(prefix) && spec.endsWith(suffix));
    if (match === undefined) {
      return [];
    }
    const captured = spec.slice(match.prefix.length, spec.length - match.suffix.length);
    return match.targets.map((target) => target.replace('*', captured));
  }

  function resolveSpecifier(path, spec) {
    const bare = spec.replace(/[?#].*$/, '');
    if (bare === '') {
      return null;
    }
    if (isRelativeSpecifier(bare)) {
      const joined = posix.normalize(posix.join(posix.dirname(path), bare)).replace(/\/+$/, '');
      return joined === '..' || joined.startsWith('../') ? null : probe(joined);
    }
    const dir = posix.dirname(path);
    const aliases = aliasesFor(dir === '.' ? '' : dir);
    if (aliases === null) {
      return null;
    }
    for (const target of aliasTargets(aliases, bare)) {
      const abs = resolve(aliases.base, target);
      if (!isInsideRoot(abs)) {
        continue;
      }
      const hit = probe(toRootRelative(abs));
      if (hit !== null) {
        return hit;
      }
    }
    return null;
  }

  function resolveImports(path, text) {
    const imports = [];
    const outside = [];
    for (const spec of scanSpecifiers(text)) {
      const target = resolveSpecifier(path, spec);
      if (target === path) {
        continue;
      }
      const [list, value] = target === null ? [outside, spec] : [imports, target];
      if (!list.includes(value)) {
        list.push(value);
      }
    }
    return { imports, outside };
  }

  return { warnings, resolveImports };
}
