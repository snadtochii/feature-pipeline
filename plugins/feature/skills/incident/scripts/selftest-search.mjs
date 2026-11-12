// The incident log reader's `search` self-test (../references/log-query.md §8):
// the flags, the search file, the three scopes, the walk's exclusions and its
// bounds. Every child run goes through the shared fixtures' token check.
//
// Private to the implementation: only incident.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';

import { ComputeError, UsageError, exitCodeFor } from '../../../scripts/lib/output.mjs';
import { assert, equal, throwsKind } from '../../../scripts/lib/selftest-kit.mjs';
import { parseArgv, searchFile } from './lib.mjs';
import { takePatterns } from './search.mjs';
import { OTHER_RUN, RUN, configText, runEntry, withTemp, world, writeConfig, writeCredentials } from './selftest-fixtures.mjs';

function put(root, rel, content) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function writeSearch(root, patterns) {
  const file = searchFile(root, RUN);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Array.isArray(patterns) ? patterns.join('\n') : patterns);
  return file;
}

async function searchIn(root, env, patterns, ...args) {
  const file = writeSearch(root, patterns);
  const res = await runEntry(['search', '--project-root', root, '--run', RUN, ...args], env);
  return { ...res, searchFileLeft: fs.existsSync(file) };
}

const pathsOf = (doc) => doc.matches.map((match) => match.path);

export const SEARCH_CASES = [
  ['args: search takes a run, a scope, the repository for the repo scope and an output', () => {
    const base = ['search', '--project-root', '/w', '--run', RUN];
    const parsed = parseArgv([...base, '--scope', 'repo', '--repo', 'api']);
    equal([parsed.verb, parsed.scope, parsed.repo, parsed.output], ['search', 'repo', 'api', 'lines'], 'repo scope, lines by default');
    equal(parseArgv([...base, '--scope', 'repo', '--repo', '.']).repo, '.', 'the project root');
    equal(parseArgv([...base, '--scope', 'tickets', '--output', 'files']).output, 'files', 'files output');
    const bad = [
      ['search', '--project-root', '/w', '--scope', 'incidents'],
      ['search', '--project-root', '/w', '--run', 'today', '--scope', 'incidents'],
      base,
      [...base, '--scope', 'everything'],
      [...base, '--scope', 'repo'],
      [...base, '--scope', 'tickets', '--repo', 'api'],
      [...base, '--scope', 'repo', '--repo', '..'],
      [...base, '--scope', 'repo', '--repo', 'a/b'],
      [...base, '--scope', 'incidents', '--output', 'paths'],
      [...base, '--scope', 'incidents', '--pattern', 'waybill'],
    ];
    for (const argv of bad) {
      equal(exitCodeFor(throwsKind(() => parseArgv(argv), UsageError)), 2, `exit code for ${JSON.stringify(argv)}`);
    }
  }],
  ['search file: one per run, required, bounded, consumed, 1 to 20 patterns of 3 to 200 characters, never a symbolic link', () =>
    withTemp('searchfile', (dir) => {
      throwsKind(() => takePatterns(dir, RUN), ComputeError, 'does not exist');
      const file = writeSearch(dir, ['  waybill  ', '', 'decode', 'waybill', 'Waybill\r']);
      equal([takePatterns(dir, RUN), fs.existsSync(file)], [['waybill', 'decode', 'Waybill'], false], 'trimmed, blank and repeated lines dropped, file removed');
      const refusals = [
        [' \n\n', 'is empty'],
        [Array.from({ length: 21 }, (unused, index) => `pattern-${index}`), 'more than 20 patterns'],
        [['waybill', 'Q7'], 'pattern 2 must be 3 to 200 characters'],
        [['Z'.repeat(201)], 'pattern 1 must be'],
        ['Y'.repeat(4 * 1024 + 1), 'larger than 4 KiB'],
      ];
      for (const [patterns, fragment] of refusals) {
        writeSearch(dir, patterns);
        const err = throwsKind(() => takePatterns(dir, RUN), ComputeError, fragment);
        assert(!/Q7|ZZZ|YYY|pattern-1/.test(err.message), `the refusal echoed a pattern: ${err.message}`);
        equal(fs.existsSync(file), false, `the file is removed after: ${fragment}`);
      }
      const target = put(dir, 'target.txt', 'waybill');
      fs.symlinkSync(target, file);
      throwsKind(() => takePatterns(dir, RUN), ComputeError, 'symbolic link');
      assert(fs.lstatSync(file).isSymbolicLink() && fs.existsSync(target), 'a symbolic link must be left alone');
    })],
  ['search: the repo scope reports content lines and path matches, case-insensitively and literally', () =>
    withTemp('search-repo', async (dir) => {
      const { root, env } = world(dir);
      put(root, 'api/src/waybill.go', 'package waybill\n\nfunc Delete() error {\n\treturn fmt.Errorf("nova poshta waybill delete failed: %w", err)\n}\n');
      put(root, 'api/src/regex.txt', 'axb( is not a match\nbut a.b( is\n');
      put(root, 'api/src/many.txt', Array.from({ length: 5 }, (unused, index) => `NOVA POSHTA line ${index}`).join('\n'));
      const res = await searchIn(root, env, ['nova poshta', 'waybill.go', 'a.b('], '--scope', 'repo', '--repo', 'api');
      equal([res.status, res.searchFileLeft, res.doc.scope, res.doc.root, res.doc.exists], [0, false, 'repo', path.join(root, 'api'), true], 'exit and root');
      equal(
        res.doc.matches,
        [
          { line: 1, path: 'src/many.txt', pattern: 0, text: 'NOVA POSHTA line 0' },
          { line: 2, path: 'src/many.txt', pattern: 0, text: 'NOVA POSHTA line 1' },
          { line: 3, path: 'src/many.txt', pattern: 0, text: 'NOVA POSHTA line 2' },
          { line: 2, path: 'src/regex.txt', pattern: 2, text: 'but a.b( is' },
          { line: 0, path: 'src/waybill.go', pattern: 1 },
          { line: 4, path: 'src/waybill.go', pattern: 0, text: 'return fmt.Errorf("nova poshta waybill delete failed: %w", err)' },
        ],
        'matches sorted by path, line and pattern',
      );
      equal(
        [res.doc.count, res.doc.omitted, res.doc.truncated, res.doc.partial, res.doc.scanned, res.doc.patterns],
        [6, 2, true, null, { files: 3, skipped: 0 }, ['nova poshta', 'waybill.go', 'a.b(']],
        'counts',
      );
    })],
  ['search: symbolic links, secret files, skipped directories and the credential file are never read', () =>
    withTemp('search-contain', async (dir) => {
      const { root, env } = world(dir);
      const api = path.join(root, 'api');
      put(api, 'kept.txt', 'INCIDENT_GRAFANA marker');
      const outside = put(dir, 'outside/leak.txt', 'INCIDENT_GRAFANA outside');
      fs.symlinkSync(outside, path.join(api, 'linked.txt'));
      fs.symlinkSync(path.dirname(outside), path.join(api, 'linked-dir'));
      for (const rel of ['.git/config', 'node_modules/pkg/index.js', 'deploy/server.pem', 'keys/id_rsa', 'ops/aws_credentials.txt', '.config/gh/hosts.yml']) {
        put(api, rel, 'INCIDENT_GRAFANA hidden');
      }
      const credential = writeCredentials(path.join(api, 'ops', 'grafana.cred'));
      fs.linkSync(credential, path.join(api, 'ops', 'grafana-copy.txt'));
      writeConfig(root, configText({ tokenFile: credential }));
      const res = await searchIn(root, env, ['INCIDENT_GRAFANA', 'grafana'], '--scope', 'repo', '--repo', 'api');
      equal([res.status, res.doc.matches.map((match) => [match.path, match.pattern])], [0, [['kept.txt', 0], ['kept.txt', 1]]], 'only the plain file');
      assert(!/grafana\.cred|grafana-copy|aws_credentials|id_rsa|server\.pem|hosts\.yml|leak/.test(res.stdout), `an excluded file was named: ${res.stdout}`);
      fs.symlinkSync(path.dirname(outside), path.join(root, 'elsewhere'));
      const escaped = await searchIn(root, env, ['INCIDENT_GRAFANA'], '--scope', 'repo', '--repo', 'elsewhere');
      equal([escaped.status, escaped.searchFileLeft], [1, false], 'a root outside the project');
      assert(escaped.doc.error.includes('outside the project root'), `unexpected error: ${escaped.doc.error}`);
      put(root, '.git/config', 'INCIDENT_GRAFANA hidden');
      put(root, '.config/gh/hosts.yml', 'INCIDENT_GRAFANA hidden');
      put(root, '.config/tool.txt', 'INCIDENT_GRAFANA kept');
      fs.symlinkSync(path.join(root, '.git'), path.join(root, 'gitdir'));
      for (const named of ['.git', 'gitdir']) {
        const refused = await searchIn(root, env, ['INCIDENT_GRAFANA'], '--scope', 'repo', '--repo', named);
        equal([refused.status, refused.searchFileLeft], [1, false], `a root inside .git through ${named}`);
        assert(refused.doc.error.includes('never reads'), `unexpected error: ${refused.doc.error}`);
      }
      const config = await searchIn(root, env, ['INCIDENT_GRAFANA'], '--scope', 'repo', '--repo', '.config');
      equal([config.status, config.doc.matches.map((match) => match.path)], [0, ['tool.txt']], 'a .config root still leaves gh/ out');
    })],
  ['search: the project-root repository leaves claudedocs/ out', () =>
    withTemp('search-root', async (dir) => {
      const { root, env } = world(dir);
      put(root, 'notes.md', 'grafana_url is documented here');
      put(root, 'claudedocs/incidents/20261112-040300-bl-api-5xx.md', 'grafana_url');
      const res = await searchIn(root, env, ['grafana_url'], '--scope', 'repo', '--repo', '.');
      equal([res.status, pathsOf(res.doc)], [0, ['notes.md']], 'claudedocs/ is not searched');
    })],
  ['search: the incidents scope reads the top-level reports only', () =>
    withTemp('search-incidents', async (dir) => {
      const { root, env } = world(dir);
      const signature = 'Signature: api | bl-api-5xx | waybill delete failed |';
      put(root, 'claudedocs/incidents/20261112-040300-bl-api-5xx.md', `# Incident\n\n${signature} decode\n`);
      put(root, 'claudedocs/incidents/20261112-040300-bl-api-5xx-2.md', '# Incident\n\nSignature: api | bl-api-5xx | other |\n');
      put(root, 'claudedocs/incidents/old/20261101-000000-bl-api-5xx.md', `${signature}\n`);
      put(root, `claudedocs/incidents/.query-${OTHER_RUN}.logql`, signature);
      const res = await searchIn(root, env, [signature], '--scope', 'incidents');
      equal([res.status, res.doc.matches.map((match) => [match.path, match.line])], [0, [['20261112-040300-bl-api-5xx.md', 3]]], 'one report');
      const names = await searchIn(root, env, ['20261112-040300-bl'], '--scope', 'incidents', '--output', 'files');
      equal(
        [names.status, names.doc.files],
        [0, [{ path: '20261112-040300-bl-api-5xx-2.md', patterns: [0] }, { path: '20261112-040300-bl-api-5xx.md', patterns: [0] }]],
        'report names',
      );
    })],
  ['search: the tickets scope reads every spec and PRD and lists the patterns each matched', () =>
    withTemp('search-tickets', async (dir) => {
      const { root, env } = world(dir);
      put(root, 'claudedocs/tickets/backlog/FP-1/01-spec.md', 'title: waybill retry\n');
      put(root, 'claudedocs/tickets/backlog/FP-1/02-plan.md', 'waybill decode\n');
      put(root, 'claudedocs/tickets/in-progress/FP-2/prd.md', 'Waybill deletion, decode errors\n');
      put(root, 'claudedocs/tickets/in-progress/FP-2/tasks/FP-3/01-spec.md', 'decode the carrier answer\n');
      const res = await searchIn(root, env, ['waybill', 'decode'], '--scope', 'tickets', '--output', 'files');
      equal(
        [res.status, res.doc.files],
        [
          0,
          [
            { path: 'backlog/FP-1/01-spec.md', patterns: [0] },
            { path: 'in-progress/FP-2/prd.md', patterns: [0, 1] },
            { path: 'in-progress/FP-2/tasks/FP-3/01-spec.md', patterns: [1] },
          ],
        ],
        'files and their patterns',
      );
      assert(!Object.hasOwn(res.doc, 'matches'), 'the files output carries no matches');
    })],
  ['search: the document stays within 16 KiB, and binary and oversized files are skipped', () =>
    withTemp('search-bound', async (dir) => {
      const { root, env } = world(dir);
      for (let index = 0; index < 60; index += 1) {
        put(root, `api/logs/file-${String(index).padStart(2, '0')}.txt`, `${'x'.repeat(300)} waybill ${'y'.repeat(300)}\n`.repeat(4));
      }
      put(root, 'api/blob.bin', Buffer.concat([Buffer.from('waybill'), Buffer.alloc(16)]));
      put(root, 'api/huge.txt', `waybill ${'z'.repeat(1024 * 1024)}`);
      const res = await searchIn(root, env, ['waybill'], '--scope', 'repo', '--repo', 'api');
      equal(res.status, 0, 'exit status');
      assert(Buffer.byteLength(res.stdout) <= 16 * 1024, `the document is ${Buffer.byteLength(res.stdout)} bytes`);
      equal([res.doc.truncated, res.doc.scanned], [true, { files: 60, skipped: 2 }], 'truncated, and the two skipped files');
      assert(res.doc.count > 0 && res.doc.omitted > 60 && res.doc.count + res.doc.omitted === 240, `counts: ${res.doc.count} + ${res.doc.omitted}`);
      assert(res.doc.matches.every((match) => match.cut === true && match.text.length <= 400), 'windows are cut to 400 characters');
    })],
  ['search: a missing root answers with nothing, and preflight sweeps an old search file', () =>
    withTemp('search-missing', async (dir) => {
      const { root, env } = world(dir);
      const res = await searchIn(root, env, ['waybill'], '--scope', 'repo', '--repo', 'missing');
      equal(
        [res.status, res.doc.exists, res.doc.count, res.doc.matches, res.doc.scanned, res.searchFileLeft],
        [0, false, 0, [], { files: 0, skipped: 0 }, false],
        'a missing root',
      );
      const stale = writeSearch(root, ['waybill']);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);
      const fresh = put(root, `claudedocs/incidents/.search-${OTHER_RUN}.txt`, 'decode');
      equal((await runEntry(['preflight', '--project-root', root], env)).status, 0, 'preflight');
      equal([fs.existsSync(stale), fs.existsSync(fresh)], [false, true], 'only the old search file is removed');
    })],
];
