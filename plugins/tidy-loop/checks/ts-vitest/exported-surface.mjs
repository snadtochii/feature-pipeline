#!/usr/bin/env node
// `exported-surface` for the ts-vitest stack — see ../CONTRACT.md §6.
//
// What: a sha256 digest of the declarations the repository's own TypeScript
// emits for every source module, keyed through a rename map so a moved module
// compares under its new name; plus, for every symbol the map tracks, the list
// of files whose exported surface declares it — resolved through the type
// checker's module exports, so a private same-named helper does not count and
// a re-export is attributed to the declaring file.
//
// Why: "the public surface did not change" and "the symbol moved rather than
// being copied" are the two questions a structural refactor has to answer
// mechanically. A digest per module answers the first; a declaration count per
// symbol answers the second.
//
// Declarations are emitted in memory through the compiler API, with emit
// settings overridden for this run only. Nothing is written into the
// repository — a repository that sets `noEmit` still gets answered, and no
// build-info file is left behind.
//
// Usage: node exported-surface.mjs --repo <abs-path> --rename-map <json-path>
//                                  [--tsconfig <path>] [--out <dir>]
//                                  [--prelude "<line>"]
//
// Relative path flags, per CONTRACT.md §4: `--tsconfig` names a file inside the
// repository and resolves against `--repo`; `--rename-map` and `--out` are the
// caller's own input and output and resolve against the caller's working
// directory. `--tsconfig` is stack-local — see ./README.md.
// Exit:  0 document on stdout; 1 typescript unresolvable, tsconfig missing,
//        declaration emit failed, or the surface came out empty; 2 bad flags
//        or an unusable rename map.

import fs from 'node:fs';
import path from 'node:path';

import {
  EXIT_BAD_USAGE,
  EXIT_CANNOT_COMPUTE,
  emit,
  fail,
  main,
  makeTempDir,
  parseArgs,
  requireFromRepo,
  resolveRepo,
  sha256,
  toRepoRelative,
} from './lib/common.mjs';

main(() => {
  const flags = parseArgs(process.argv.slice(2), {
    repo: { required: true },
    'rename-map': { required: true },
    tsconfig: {},
    out: {},
    prelude: {},
  });
  const repo = resolveRepo(flags.repo);
  const renameMap = readRenameMap(flags['rename-map']);
  const ts = requireFromRepo(repo, 'typescript');
  const rootConfig = path.resolve(repo, flags.tsconfig ?? 'tsconfig.json');
  if (!fs.existsSync(rootConfig)) {
    fail(`tsconfig not found: ${rootConfig}`, EXIT_CANNOT_COMPUTE);
  }

  const context = {
    declared: new Map(),
    declarationDir: path.join(makeTempDir(), 'declarations'),
    outDir: flags.out === undefined ? null : path.resolve(flags.out),
    renameMap,
    repo,
    surface: new Map(),
    ts,
    visited: new Set(),
  };
  collectProject(context, rootConfig);
  const { surface, declared } = context;

  if (surface.size === 0) {
    fail(
      `no modules were compiled from ${toRepoRelative(repo, rootConfig)} — nothing to digest`,
      EXIT_CANNOT_COMPUTE,
    );
  }

  const surfaceDocument = {};
  for (const [key, digest] of surface) {
    surfaceDocument[key] = digest;
  }
  const declaredDocument = {};
  for (const name of Object.values(renameMap.symbols)) {
    declaredDocument[name] = [...(declared.get(name) ?? [])].sort();
  }
  emit({ declaredOnce: declaredDocument, surface: surfaceDocument });
});

/**
 * Read and validate the rename map. Its two top-level keys are required so a
 * typo becomes an invocation error rather than a silently empty map.
 *
 * @param {string} value the --rename-map flag
 * @returns {{modules: Record<string, string>, symbols: Record<string, string>}}
 */
function readRenameMap(value) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(value), 'utf8'));
  } catch (error) {
    return fail(`cannot read --rename-map ${value}: ${error.message}`, EXIT_BAD_USAGE);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('--rename-map must be a JSON object', EXIT_BAD_USAGE);
  }
  for (const key of ['modules', 'symbols']) {
    const section = parsed[key];
    if (section === null || typeof section !== 'object' || Array.isArray(section)) {
      return fail(`--rename-map is missing an object under "${key}"`, EXIT_BAD_USAGE);
    }
    for (const [from, to] of Object.entries(section)) {
      if (typeof to !== 'string') {
        return fail(`--rename-map ${key}."${from}" must map to a string`, EXIT_BAD_USAGE);
      }
    }
  }
  return { modules: parsed.modules, symbols: parsed.symbols };
}

/**
 * Compile one tsconfig and merge its answers into the accumulators. A config
 * that contributes no files of its own but declares project references is a
 * solution-style root: recurse into each reference and union the results.
 *
 * @param {{ts: any, repo: string, declarationDir: string, outDir: string | null,
 *           renameMap: {modules: Record<string, string>, symbols: Record<string, string>},
 *           surface: Map<string, string>, declared: Map<string, Set<string>>,
 *           visited: Set<string>}} context
 * @param {string} configPath absolute tsconfig path
 */
function collectProject(context, configPath) {
  const { ts, repo, declarationDir, outDir, renameMap, surface, declared, visited } = context;
  const real = fs.realpathSync(configPath);
  if (visited.has(real)) {
    return;
  }
  visited.add(real);

  const read = ts.readConfigFile(real, ts.sys.readFile);
  if (read.error) {
    fail(`cannot parse ${toRepoRelative(repo, real)}: ${flatten(ts, read.error)}`, EXIT_CANNOT_COMPUTE);
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(real), undefined, real);
  if (parsed.errors?.length) {
    const fatal = parsed.errors.find((error) => error.category === ts.DiagnosticCategory.Error);
    if (fatal && parsed.fileNames.length === 0 && !parsed.projectReferences?.length) {
      fail(`cannot parse ${toRepoRelative(repo, real)}: ${flatten(ts, fatal)}`, EXIT_CANNOT_COMPUTE);
    }
  }

  if (parsed.fileNames.length === 0 && parsed.projectReferences?.length) {
    for (const reference of parsed.projectReferences) {
      collectProject(context, resolveReferencePath(reference.path));
    }
    return;
  }
  if (parsed.fileNames.length === 0) {
    return;
  }

  const options = {
    ...parsed.options,
    composite: false,
    declaration: true,
    declarationDir,
    declarationMap: false,
    emitDeclarationOnly: true,
    incremental: false,
    newLine: ts.NewLineKind.LineFeed,
    noEmit: false,
    noEmitOnError: false,
    tsBuildInfoFile: undefined,
  };
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options,
    projectReferences: undefined,
  });

  const writes = [];
  const emitResult = program.emit(
    undefined,
    (fileName, text, _writeByteOrderMark, _onError, sourceFiles) => {
      writes.push({ fileName, text, sourceFiles: sourceFiles ?? [] });
    },
    undefined,
    true,
  );
  const emitDiagnostic = emitResult.diagnostics?.[0];
  if (emitResult.emitSkipped || emitDiagnostic) {
    fail(
      `declaration emit failed for ${toRepoRelative(repo, real)}: ${
        emitDiagnostic ? flatten(ts, emitDiagnostic) : 'emit was skipped'
      }`,
      EXIT_CANNOT_COMPUTE,
    );
  }

  for (const write of writes) {
    if (write.sourceFiles.length !== 1) {
      fail(
        `bundled declaration output is not supported (${write.sourceFiles.length} sources for one file)`,
        EXIT_CANNOT_COMPUTE,
      );
    }
    const source = write.sourceFiles[0];
    if (!isRepoSource(repo, source.fileName)) {
      continue;
    }
    surface.set(moduleKey(repo, source.fileName, renameMap), sha256(write.text));
    if (outDir) {
      const destination = path.join(outDir, path.relative(declarationDir, write.fileName));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, write.text);
    }
  }

  const checker = program.getTypeChecker();
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || !isRepoSource(repo, source.fileName)) {
      continue;
    }
    for (const { name, file } of exportedDeclarations(ts, checker, repo, source)) {
      for (const [from, to] of Object.entries(renameMap.symbols)) {
        if (name === from || name === to) {
          if (!declared.has(to)) {
            declared.set(to, new Set());
          }
          declared.get(to).add(file);
        }
      }
    }
  }
}

/**
 * A referenced project path may name a directory or the config file itself.
 *
 * @param {string} value
 * @returns {string}
 */
function resolveReferencePath(value) {
  const resolved = path.resolve(value);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return path.join(resolved, 'tsconfig.json');
  }
  return resolved;
}

/**
 * Source files outside the repository, and dependency sources inside it, are
 * not this repository's surface.
 *
 * @param {string} repo
 * @param {string} fileName
 * @returns {boolean}
 */
function isRepoSource(repo, fileName) {
  const resolved = path.resolve(fileName);
  const relative = path.relative(repo, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  return !relative.split(path.sep).includes('node_modules');
}

/**
 * The document key for a module: its repo-relative path, rewritten to the
 * rename map's new path only when this tree has the old path and not the new
 * one. A tree holding both keeps both keys, so the stale module shows up as a
 * difference (CONTRACT.md §6).
 *
 * @param {string} repo
 * @param {string} fileName
 * @param {{modules: Record<string, string>}} renameMap
 * @returns {string}
 */
function moduleKey(repo, fileName, renameMap) {
  const relative = toRepoRelative(repo, fileName);
  const renamed = renameMap.modules[relative];
  if (renamed === undefined || renamed === relative) {
    return relative;
  }
  if (fs.existsSync(path.join(repo, renamed))) {
    return relative;
  }
  return renamed;
}

/**
 * The declarations behind a module's exports — the granularity `declaredOnce`
 * counts at. Each entry pairs a name with the repo-relative file holding the
 * declaration it resolves to.
 *
 * Only the exported surface is walked: a same-named helper that a module keeps
 * private is not a copy of the tracked symbol and must not block a move. An
 * alias (`export { x }`, `export { x as y }`, a re-export, `export *`) resolves
 * to the declaration it points at, so a barrel is attributed to the file that
 * declares the symbol rather than counted as a second declaration. Every name
 * the export is reachable by — the export name, the resolved symbol's name,
 * and the declaration's own identifier (`export default function clamp`) — is
 * reported, so the rename map can name the symbol as the code does.
 *
 * @param {any} ts
 * @param {any} checker
 * @param {string} repo
 * @param {any} source
 * @returns {{name: string, file: string}[]}
 */
function exportedDeclarations(ts, checker, repo, source) {
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) {
    return [];
  }
  const found = [];
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const resolved =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    for (const declaration of resolved.declarations ?? []) {
      const declaringFile = declaration.getSourceFile();
      if (declaringFile.isDeclarationFile || !isRepoSource(repo, declaringFile.fileName)) {
        continue;
      }
      const file = toRepoRelative(repo, declaringFile.fileName);
      const names = new Set([exported.name, resolved.name]);
      if (declaration.name && ts.isIdentifier(declaration.name)) {
        names.add(declaration.name.text);
      }
      for (const name of names) {
        found.push({ name, file });
      }
    }
  }
  return found;
}

/**
 * @param {any} ts
 * @param {any} diagnostic
 * @returns {string}
 */
function flatten(ts, diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
}
