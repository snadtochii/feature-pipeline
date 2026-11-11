// The incident log reader's self-test (../references/log-query.md §7).
//
// Every case is `[name, fn]`. Pure rules are exercised in-process over inline
// fixtures; the verbs are exercised end to end as child processes with a
// minimal environment, a redirected HOME, temporary directories and a
// loopback stand-in for Grafana. Nothing reaches beyond the loopback
// interface, every temporary directory and server is removed in a `finally`,
// and every child run is checked for the fixture token in its stdout and
// stderr.
//
// Private to the implementation: only incident.mjs is a command.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ComputeError,
  UsageError,
  exitCodeFor,
  fitLines,
  parseArgv,
  parseCredentialFile,
  parseMiniYaml,
  readCredentialFile,
  reportGate,
  resolveAccess,
  shapeStreams,
  takeQuery,
  validateConfig,
} from './lib.mjs';

const ENTRY = fileURLToPath(new URL('./incident.mjs', import.meta.url));
const TOKEN = 'glsa_selftest_7f3c9e10';
const ORIGIN = 'https://grafana.example.invalid';
const DATASOURCE = 'loki-uid';
const CREDENTIALS = '~/.config/feature-incident/grafana.credentials';

class CaseFailure extends Error {}

function assert(condition, detail) {
  if (!condition) {
    throw new CaseFailure(detail);
  }
}

function equal(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${label}: expected ${e}, got ${a}`);
}

function throwsKind(fn, Kind, fragment) {
  try {
    fn();
  } catch (err) {
    assert(err instanceof Kind, `expected a ${Kind.name}, got ${err.constructor.name}: ${err.message}`);
    if (fragment !== undefined) {
      assert(err.message.includes(fragment), `expected the error to mention "${fragment}", got: ${err.message}`);
    }
    return err;
  }
  throw new CaseFailure(`expected a ${Kind.name}, nothing was thrown`);
}

async function withTemp(label, fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `fp-incident-${label}-`)));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function configText({ url = ORIGIN, datasource = DATASOURCE, tokenFile = CREDENTIALS } = {}) {
  const lines = ['prefix: FP', 'incident:'];
  if (url !== null) {
    lines.push(`  grafana_url: ${url}`);
  }
  if (datasource !== null) {
    lines.push(`  datasource: ${datasource}`);
  }
  if (tokenFile !== null) {
    lines.push(`  token_file: ${tokenFile}`);
  }
  lines.push('  services:', '    api:', '      repo: api', "      selector: '{app=\"api\"}'", '      runbook: docs/alerts.md', '');
  return lines.join('\n');
}

const configOf = (options, home = '/home/selftest') => validateConfig(parseMiniYaml(configText(options)), home);

function writeConfig(root, text) {
  const dir = path.join(root, 'claudedocs', 'tickets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), text);
}

function writeCredentials(file, text = `INCIDENT_GRAFANA_URL=${ORIGIN}\nINCIDENT_GRAFANA_TOKEN=${TOKEN}\n`, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, mode);
  return file;
}

function gitBinDir() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir !== '' && fs.existsSync(path.join(dir, 'git'))) {
      return dir;
    }
  }
  return null;
}

function childEnv(home, extra = {}) {
  const dirs = [gitBinDir(), '/usr/bin', '/bin'].filter(Boolean);
  return { PATH: dirs.join(path.delimiter), HOME: home, ...extra };
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const res = spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', dir], { encoding: 'utf8' });
  assert(res.status === 0, `git init failed: ${res.stderr}`);
  return dir;
}

function commitAll(repo) {
  for (const args of [['add', '-A'], ['commit', '-q', '-m', 'fixture']]) {
    const res = spawnSync(
      'git',
      ['-C', repo, '-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', '-c', 'commit.gpgsign=false', ...args],
      { encoding: 'utf8' },
    );
    assert(res.status === 0, `git ${args[0]} failed: ${res.stderr}`);
  }
}

/** A workspace with a config, and a home holding the credential file. */
function world(dir, { url = ORIGIN, credentialUrl = url } = {}) {
  const root = path.join(dir, 'workspace');
  const home = path.join(dir, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  writeConfig(root, configText({ url }));
  writeCredentials(path.join(home, CREDENTIALS.slice(2)), `INCIDENT_GRAFANA_URL=${credentialUrl}\nINCIDENT_GRAFANA_TOKEN=${TOKEN}\n`);
  return { root, home, env: childEnv(home) };
}

/** Run the entry as a child; the fixture token must reach neither stream. */
function runEntry(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      if (stdout.includes(TOKEN) || stderr.includes(TOKEN)) {
        reject(new CaseFailure(`the token reached the output of: ${args.join(' ')}`));
        return;
      }
      let doc = null;
      try {
        doc = JSON.parse(stdout);
      } catch {
        doc = null;
      }
      resolve({ status, stdout, stderr, doc });
    });
  });
}

const CASES = [
  ['args: the verbs and the self-test flag parse', () => {
    equal(parseArgv(['--self-test']), { selfTest: true }, 'self-test');
    equal(parseArgv(['preflight', '--project-root', '/w']), { verb: 'preflight', projectRoot: '/w' }, 'preflight');
    equal(parseArgv(['preflight', '--repo', '.', '--project-root', '/w']).repo, '.', 'repo "."');
    equal(parseArgv(['preflight', '--project-root', '/w', '--repo', 'my-api']).repo, 'my-api', 'repo name');
  }],
  ['args: a bad invocation is a usage error', () => {
    const bad = [
      [],
      ['explode'],
      ['--self-test', 'extra'],
      ['preflight'],
      ['preflight', '--project-root'],
      ['preflight', '--project-root', 'relative/root'],
      ['preflight', '--project-root', '/w', '--project-root', '/w'],
      ['preflight', '--project-root', '/w', '--nope', 'x'],
      ['preflight', '--project-root', '/w', '--repo', '..'],
      ['preflight', '--project-root', '/w', '--repo', 'a/b'],
      ['preflight', '--project-root', '/w', '--repo', ''],
    ];
    for (const argv of bad) {
      equal(exitCodeFor(throwsKind(() => parseArgv(argv), UsageError)), 2, `exit code for ${JSON.stringify(argv)}`);
    }
  }],
  ['config: the block is read and the services mapping is skipped', () => {
    const doc = parseMiniYaml(configText());
    equal(doc.incident.grafana_url, ORIGIN, 'grafana_url');
    equal(doc.incident.datasource, DATASOURCE, 'datasource');
    assert(!Object.hasOwn(doc.incident, 'repo') && !Object.hasOwn(doc.incident, 'api'), 'a nested services key leaked into the block');
    equal(
      configOf(),
      { base: ORIGIN, origin: ORIGIN, datasource: DATASOURCE, tokenFile: '/home/selftest/.config/feature-incident/grafana.credentials' },
      'validated config',
    );
    equal(configOf({ url: 'https://grafana.example.invalid/grafana/' }).base, 'https://grafana.example.invalid/grafana', 'base keeps a sub-path');
    equal(configOf({ tokenFile: null }).tokenFile, undefined, 'token_file is optional');
    equal(configOf({ url: 'http://127.0.0.1:3000' }).origin, 'http://127.0.0.1:3000', 'loopback may use http');
  }],
  ['config: a missing or malformed key is named', () => {
    throwsKind(() => validateConfig(parseMiniYaml('prefix: FP\n'), '/h'), ComputeError, 'no incident: block');
    throwsKind(() => validateConfig(parseMiniYaml('incident: yes\n'), '/h'), ComputeError, 'incident must be a mapping');
    throwsKind(() => configOf({ url: null }), ComputeError, 'incident.grafana_url is not set');
    throwsKind(() => configOf({ datasource: null }), ComputeError, 'incident.datasource is not set');
    throwsKind(() => configOf({ datasource: 'loki/uid' }), ComputeError, 'incident.datasource');
    throwsKind(() => configOf({ url: 'http://grafana.example.invalid' }), ComputeError, 'must use https');
    throwsKind(() => configOf({ url: 'ftp://grafana.example.invalid' }), ComputeError, 'incident.grafana_url');
    const secret = throwsKind(() => configOf({ url: 'https://user:hunter2@grafana.example.invalid' }), ComputeError, 'incident.grafana_url');
    assert(!secret.message.includes('hunter2'), 'the URL error echoed its userinfo');
    throwsKind(() => configOf({ url: 'https://grafana.example.invalid/?orgId=1' }), ComputeError, 'incident.grafana_url');
  }],
  ['config: the token location is absolute or ~/ and never a dotenv file', () => {
    equal(configOf({ tokenFile: '/etc/incident/grafana.credentials' }).tokenFile, '/etc/incident/grafana.credentials', 'absolute path');
    throwsKind(() => configOf({ tokenFile: 'grafana.credentials' }), ComputeError, 'incident.token_file must be an absolute path');
    throwsKind(() => validateConfig(parseMiniYaml(configText()), undefined), ComputeError, 'HOME is not set');
    for (const name of ['~/.env', '~/app/.env.local', '/srv/prod.env']) {
      throwsKind(() => configOf({ tokenFile: name }), ComputeError, 'dotenv-family');
    }
  }],
  ['credentials: the environment pair wins and must be complete', () => {
    const config = configOf({ tokenFile: '/nonexistent/grafana.credentials' });
    equal(resolveAccess({ INCIDENT_GRAFANA_URL: ORIGIN, INCIDENT_GRAFANA_TOKEN: TOKEN }, config), { token: TOKEN, source: 'env' }, 'env pair');
    const onlyToken = throwsKind(() => resolveAccess({ INCIDENT_GRAFANA_TOKEN: TOKEN }, config), ComputeError, 'INCIDENT_GRAFANA_URL is not');
    assert(!onlyToken.message.includes(TOKEN), 'the incomplete-pair error echoed the token');
    throwsKind(() => resolveAccess({ INCIDENT_GRAFANA_URL: ORIGIN }, config), ComputeError, 'INCIDENT_GRAFANA_TOKEN is not');
    const none = throwsKind(() => resolveAccess({}, configOf({ tokenFile: null })), ComputeError, 'incident.token_file');
    assert(none.message.includes('INCIDENT_GRAFANA_URL') && none.message.includes('INCIDENT_GRAFANA_TOKEN'), 'the no-source error must name both variables');
  }],
  ['credentials: a token is bound to the origin stored beside it', () => {
    const config = configOf();
    const other = throwsKind(
      () => resolveAccess({ INCIDENT_GRAFANA_URL: 'https://other.example.invalid', INCIDENT_GRAFANA_TOKEN: TOKEN }, config),
      ComputeError,
      'https://other.example.invalid',
    );
    assert(other.message.includes(ORIGIN) && other.message.includes('the environment'), 'the mismatch must name both origins and the source');
    assert(!other.message.includes(TOKEN), 'the mismatch error echoed the token');
    throwsKind(() => resolveAccess({ INCIDENT_GRAFANA_URL: 'not a url', INCIDENT_GRAFANA_TOKEN: TOKEN }, config), ComputeError, 'INCIDENT_GRAFANA_URL');
    throwsKind(() => resolveAccess({ INCIDENT_GRAFANA_URL: ORIGIN, INCIDENT_GRAFANA_TOKEN: 'two words' }, config), ComputeError, 'whitespace');
    equal(
      resolveAccess({ INCIDENT_GRAFANA_URL: `${ORIGIN}/some/path`, INCIDENT_GRAFANA_TOKEN: TOKEN }, config).source,
      'env',
      'the binding compares origins, not paths',
    );
  }],
  ['credential file: the line grammar names a path and a line number only', () => {
    const file = '/h/grafana.credentials';
    equal(
      parseCredentialFile(`# comment\nexport INCIDENT_GRAFANA_URL="${ORIGIN}"\nOTHER=anything at all\nINCIDENT_GRAFANA_TOKEN='${TOKEN}'\n`, file),
      { INCIDENT_GRAFANA_URL: ORIGIN, INCIDENT_GRAFANA_TOKEN: TOKEN },
      'parsed pair',
    );
    const err = throwsKind(() => parseCredentialFile(`INCIDENT_GRAFANA_URL=${ORIGIN}\nINCIDENT_GRAFANA_TOKEN=${TOKEN} trailing\n`, file), ComputeError, `${file}:2`);
    assert(!err.message.includes(TOKEN), 'the malformed-line error echoed the line');
    throwsKind(() => parseCredentialFile('just some words\n', file), ComputeError, `${file}:1`);
    throwsKind(() => parseCredentialFile(`INCIDENT_GRAFANA_TOKEN="${TOKEN}\n`, file), ComputeError, `${file}:1`);
  }],
  ['credential file: one descriptor, a regular file, mode 0600, at most 64 KiB', () =>
    withTemp('cred', (dir) => {
      const good = writeCredentials(path.join(dir, 'grafana.credentials'));
      equal(readCredentialFile(good), { INCIDENT_GRAFANA_URL: ORIGIN, INCIDENT_GRAFANA_TOKEN: TOKEN }, 'file pair');
      equal(resolveAccess({}, { origin: ORIGIN, tokenFile: good }), { token: TOKEN, source: 'file' }, 'file source');
      throwsKind(() => readCredentialFile(path.join(dir, 'absent.credentials')), ComputeError, 'does not exist');
      throwsKind(() => readCredentialFile(dir), ComputeError, 'not a regular file');
      const loose = writeCredentials(path.join(dir, 'loose.credentials'), undefined, 0o644);
      throwsKind(() => readCredentialFile(loose), ComputeError, 'mode 0600');
      const big = writeCredentials(path.join(dir, 'big.credentials'), `#${'x'.repeat(64 * 1024)}\n`);
      throwsKind(() => readCredentialFile(big), ComputeError, 'larger than 64 KiB');
      const partial = writeCredentials(path.join(dir, 'partial.credentials'), `INCIDENT_GRAFANA_TOKEN=${TOKEN}\n`);
      throwsKind(() => resolveAccess({}, { origin: ORIGIN, tokenFile: partial }), ComputeError, 'does not set INCIDENT_GRAFANA_URL');
      const foreign = writeCredentials(path.join(dir, 'foreign.credentials'), `INCIDENT_GRAFANA_URL=https://other.example.invalid\nINCIDENT_GRAFANA_TOKEN=${TOKEN}\n`);
      const err = throwsKind(() => resolveAccess({}, { origin: ORIGIN, tokenFile: foreign }), ComputeError, foreign);
      assert(err.message.includes('https://other.example.invalid') && err.message.includes(ORIGIN), 'the mismatch must name both origins');
    })],
  ['report gate: writable outside a work tree, and inside one only when ignored', () =>
    withTemp('gate', (dir) => {
      const env = childEnv(dir);
      const plain = path.join(dir, 'plain');
      fs.mkdirSync(plain);
      equal(reportGate(plain, env).writable, true, 'not a git work tree');
      const ignoring = initRepo(path.join(dir, 'ignoring'));
      fs.writeFileSync(path.join(ignoring, '.gitignore'), 'claudedocs/\n');
      equal(reportGate(ignoring, env).writable, true, 'claudedocs/ ignored');
      const committing = initRepo(path.join(dir, 'committing'));
      const closed = reportGate(committing, env);
      equal(closed.writable, false, 'claudedocs/ not ignored');
      assert(closed.reason.includes('does not ignore'), `unexpected reason: ${closed.reason}`);
      const empty = path.join(dir, 'empty-bin');
      fs.mkdirSync(empty);
      equal(reportGate(ignoring, { PATH: empty, HOME: dir }).writable, false, 'git not on PATH fails closed');
    })],
  ['preflight: one document with the clock, the gate and the repository head', () =>
    withTemp('preflight', async (dir) => {
      const { root, env } = world(dir);
      const api = initRepo(path.join(root, 'api'));
      fs.writeFileSync(path.join(api, 'main.go'), 'package main\n');
      commitAll(api);
      const res = await runEntry(['preflight', '--project-root', root, '--repo', 'api'], env);
      equal(res.status, 0, 'exit status');
      const { doc } = res;
      equal([doc.ok, doc.verb, doc.token, doc.grafana], [true, 'preflight', { source: 'file' }, { datasource: DATASOURCE, origin: ORIGIN }], 'document');
      assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(doc.now), `now is not RFC3339 UTC: ${doc.now}`);
      assert(/^\d{8}-\d{6}$/.test(doc.stamp), `stamp is not yyyyMMdd-HHmmss: ${doc.stamp}`);
      equal(doc.stamp, doc.now.replace(/[-:Z]/g, '').replace('T', '-'), 'stamp follows now');
      assert(doc.run.startsWith(`${doc.stamp}-`) && /^\d{8}-\d{6}-[0-9a-f]{8}$/.test(doc.run), `run is not <stamp>-<8 hex>: ${doc.run}`);
      equal(doc.report.writable, true, 'the workspace is not a git work tree');
      equal(doc.repo.dir, api, 'repo dir');
      assert(/^[0-9a-f]{40,64}$/.test(doc.repo.head), `head is not a commit: ${doc.repo.head}`);
      equal(res.stdout, `${JSON.stringify(doc, Object.keys(flatKeys(doc)).sort(), 2)}\n`, 'sorted-key document');

      const plain = await runEntry(['preflight', '--project-root', root, '--repo', 'missing'], env);
      equal([plain.status, plain.doc.repo.head], [0, null], 'a directory with no repository has a null head');
      const bare = await runEntry(['preflight', '--project-root', root], env);
      assert(!Object.hasOwn(bare.doc, 'repo'), 'repo must be absent without --repo');
      assert(bare.doc.run !== doc.run, 'two preflight runs must not share a run value');
      const viaEnv = await runEntry(['preflight', '--project-root', root], { ...env, INCIDENT_GRAFANA_URL: ORIGIN, INCIDENT_GRAFANA_TOKEN: TOKEN });
      equal(viaEnv.doc.token, { source: 'env' }, 'the exported pair wins');
    })],
  ['preflight: a query file an interrupted run left is removed after an hour', () =>
    withTemp('sweep', async (dir) => {
      const { root, env } = world(dir);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const stale = writeQuery(root, QUERY, OTHER_RUN);
      const fresh = writeQuery(root);
      const report = path.join(root, 'claudedocs', 'incidents', '20260101-000000-alert.md');
      fs.writeFileSync(report, '# Incident\n');
      const target = path.join(dir, 'target.txt');
      fs.writeFileSync(target, 'kept');
      const link = path.join(root, 'claudedocs', 'incidents', '.query-20260101-000000-0000beef.logql');
      fs.symlinkSync(target, link);
      for (const file of [stale, report, target]) {
        fs.utimesSync(file, twoHoursAgo, twoHoursAgo);
      }
      fs.lutimesSync(link, twoHoursAgo, twoHoursAgo);
      const res = await runEntry(['preflight', '--project-root', root], env);
      equal(res.status, 0, 'exit status');
      equal(
        [fs.existsSync(stale), fs.existsSync(fresh), fs.existsSync(report), fs.lstatSync(link).isSymbolicLink(), fs.existsSync(target)],
        [false, true, true, true, true],
        'only the old regular query file is removed',
      );
    })],
  ['preflight: a failure exits 1 or 2 with one error document', () =>
    withTemp('failure', async (dir) => {
      const { root, home, env } = world(dir, { credentialUrl: 'https://other.example.invalid' });
      const mismatch = await runEntry(['preflight', '--project-root', root], env);
      equal([mismatch.status, mismatch.doc.ok], [1, false], 'origin mismatch');
      assert(mismatch.doc.error.includes('https://other.example.invalid'), `unexpected error: ${mismatch.doc.error}`);
      const noConfig = await runEntry(['preflight', '--project-root', path.join(dir, 'nowhere')], env);
      equal(noConfig.status, 1, 'no config.yaml');
      assert(noConfig.doc.error.includes('config.yaml'), `unexpected error: ${noConfig.doc.error}`);
      fs.chmodSync(path.join(home, CREDENTIALS.slice(2)), 0o640);
      const loose = await runEntry(['preflight', '--project-root', root], env);
      equal(loose.status, 1, 'group-readable credential file');
      assert(loose.doc.error.includes('mode 0600'), `unexpected error: ${loose.doc.error}`);
      const usage = await runEntry(['preflight', '--project-root', 'relative'], env);
      equal([usage.status, usage.doc.ok], [2, false], 'bad invocation');
    })],
  ['args: query takes a bounded window, limit and direction', () => {
    const run = ['query', '--project-root', '/w', '--run', RUN];
    equal(
      parseArgv([...run, '--start', START, '--end', '2026-11-11T06:08:00+02:00']),
      { verb: 'query', projectRoot: '/w', run: RUN, start: '2026-11-11T03:53:00.000Z', end: '2026-11-11T04:08:00.000Z', limit: 200, direction: 'backward' },
      'defaults and normalized instants',
    );
    const tuned = parseArgv([...windowArgs('/w'), '--limit', '1000', '--direction', 'forward']);
    equal([tuned.limit, tuned.direction], [1000, 'forward'], 'explicit limit and direction');
    equal(
      parseArgv([...run, '--start', '2026-11-11T03:53:00.123456789Z', '--end', END]).start,
      '2026-11-11T03:53:00.123Z',
      'a nanosecond fraction is cut to milliseconds',
    );
    equal(parseArgv([...run, '--start', '2028-02-29T23:59:59-23:59', '--end', '2028-03-02T00:00:00Z']).start, '2028-03-01T23:58:59.000Z', 'a leap day at an offset');
    const bad = [
      ['query', '--project-root', '/w', '--start', START, '--end', END],
      ['query', '--project-root', '/w', '--run', '20261111-040300', '--start', START, '--end', END],
      ['query', '--project-root', '/w', '--run', '../20261111-040300-0123abcd', '--start', START, '--end', END],
      run,
      [...run, '--start', START],
      [...run, '--start', END, '--end', START],
      [...run, '--start', START, '--end', START],
      [...run, '--start', '2026-11-11 03:53:00Z', '--end', END],
      [...run, '--start', '2026-11-11T03:53:00', '--end', END],
      [...run, '--start', 'yesterday', '--end', END],
      [...run, '--start', '2026-02-30T00:00:00Z', '--end', '2026-03-03T00:00:00Z'],
      [...run, '--start', '2027-02-29T00:00:00Z', '--end', '2027-03-03T00:00:00Z'],
      [...run, '--start', START, '--end', '2026-11-11T24:00:00Z'],
      [...run, '--start', START, '--end', '2026-11-11T04:08:00+24:00'],
      [...run, '--start', START, '--end', '2026-11-11T04:08:00-02:60'],
      [...windowArgs('/w'), '--limit', '0'],
      [...windowArgs('/w'), '--limit', '1001'],
      [...windowArgs('/w'), '--limit', '1e2'],
      [...windowArgs('/w'), '--direction', 'sideways'],
      [...windowArgs('/w'), '--repo', 'api'],
      ['preflight', '--project-root', '/w', '--start', START],
    ];
    for (const argv of bad) {
      equal(exitCodeFor(throwsKind(() => parseArgv(argv), UsageError)), 2, `exit code for ${JSON.stringify(argv)}`);
    }
  }],
  ['query file: one per run, required, bounded, consumed, and never a symbolic link', () =>
    withTemp('queryfile', (dir) => {
      throwsKind(() => takeQuery(dir, RUN), ComputeError, 'does not exist');
      const file = writeQuery(dir, '  {app="api"}\n');
      const other = writeQuery(dir, '{app="worker"}', OTHER_RUN);
      assert(file !== other, 'two runs must not share a query file');
      equal([takeQuery(dir, RUN), fs.existsSync(file), fs.existsSync(other)], ['{app="api"}', false, true], 'trimmed text, own file removed, the other run\'s file kept');
      throwsKind(() => takeQuery(dir, RUN), ComputeError, 'does not exist');
      equal([takeQuery(dir, OTHER_RUN), fs.existsSync(other)], ['{app="worker"}', false], 'the other run reads its own query');
      writeQuery(dir, ' \n');
      throwsKind(() => takeQuery(dir, RUN), ComputeError, 'is empty');
      equal(fs.existsSync(file), false, 'an empty file is removed');
      writeQuery(dir, 'x'.repeat(8 * 1024 + 1));
      throwsKind(() => takeQuery(dir, RUN), ComputeError, 'larger than 8 KiB');
      equal(fs.existsSync(file), false, 'an oversized file is removed');
      const target = path.join(dir, 'target.txt');
      fs.writeFileSync(target, 'never sent');
      fs.symlinkSync(target, file);
      throwsKind(() => takeQuery(dir, RUN), ComputeError, 'symbolic link');
      assert(fs.existsSync(target) && fs.lstatSync(file).isSymbolicLink(), 'a symbolic link must be left alone');
    })],
  ['query: the request carries the proxy path, the parameters and the bearer header', async () => {
    const api = {
      stream: { app: 'api', level: 'error' },
      values: [[nanos('2026-11-11T04:03:00.500Z'), 'second'], [nanos('2026-11-11T04:02:59.000Z'), 'first']],
    };
    const worker = { stream: { app: 'worker', attempt: 3 }, values: [[nanos('2026-11-11T04:03:01.000Z'), 'third']] };
    const res = await queryAgainst(reply(200, streamsBody(api, worker)));
    equal([res.status, res.requests.length], [0, 1], 'exit status and request count');
    const sent = new URL(res.requests[0].url, res.origin);
    equal(sent.pathname, `/api/datasources/proxy/uid/${DATASOURCE}/loki/api/v1/query_range`, 'path');
    equal(
      Object.fromEntries(sent.searchParams),
      { query: QUERY, start: '2026-11-11T03:53:00.000Z', end: '2026-11-11T04:08:00.000Z', limit: '200', direction: 'backward' },
      'parameters',
    );
    equal(res.requests[0].authorization, `Bearer ${TOKEN}`, 'authorization header');
    equal(
      res.doc.lines,
      [
        { line: 'first', stream: 0, ts: '2026-11-11T04:02:59.000Z' },
        { line: 'second', stream: 0, ts: '2026-11-11T04:03:00.500Z' },
        { line: 'third', stream: 1, ts: '2026-11-11T04:03:01.000Z' },
      ],
      'lines oldest first, each naming its stream',
    );
    equal(res.doc.streams, [{ app: 'api', level: 'error' }, { app: 'worker' }], 'each stream once, string labels only');
    equal(
      [res.doc.ok, res.doc.verb, res.doc.count, res.doc.omitted, res.doc.skipped, res.doc.truncated, res.doc.origin, res.doc.datasource],
      [true, 'query', 3, 0, 0, false, res.origin, DATASOURCE],
      'document',
    );
    equal(res.doc.window, { end: '2026-11-11T04:08:00.000Z', start: '2026-11-11T03:53:00.000Z' }, 'window');
    equal(res.queryFileLeft, false, 'the query file is removed');
  }],
  ['query: truncation, cut lines, skipped entries and an empty result', async () => {
    const stream = {
      stream: { app: 'api' },
      values: [
        [nanos('2026-11-11T04:03:00.000Z'), 'x'.repeat(4500)],
        ['not-a-number', 'dropped'],
        [nanos('2026-11-11T04:03:01.000Z'), 42],
        [nanos('2026-11-11T04:03:02.000Z'), 'kept'],
      ],
    };
    const res = await queryAgainst(reply(200, streamsBody(stream)), { limit: 4 });
    equal([res.status, res.doc.count, res.doc.skipped, res.doc.truncated], [0, 2, 2, true], 'counts');
    equal(res.doc.lines.map((entry) => [entry.line.length, entry.cut === true]), [[4000, true], [4, false]], 'cut marker');
    const empty = await queryAgainst(reply(200, streamsBody()));
    equal([empty.status, empty.doc.count, empty.doc.truncated, empty.doc.lines], [0, 0, false, []], 'an empty result answers');
    equal(shapeStreams([{ values: 'nope' }, null]), { lines: [], streams: [], received: 0, skipped: 0 }, 'malformed streams');
  }],
  ['query: a result larger than 16 KiB keeps the lines its direction keeps and says how many it left out', async () => {
    const second = (index) => nanos(`2026-11-11T04:0${Math.floor(index / 60)}:${String(index % 60).padStart(2, '0')}.000Z`);
    const values = (from, to) => Array.from({ length: to - from }, (unused, offset) => [second(from + offset), `${from + offset} ${'x'.repeat(420)}`]);
    const older = { stream: { app: 'api' }, values: values(0, 100) };
    const newer = { stream: { app: 'worker' }, values: values(100, 200) };
    const numberOf = (entry) => Number(entry.line.split(' ')[0]);
    for (const [direction, firstKept, streams] of [['backward', (doc) => 200 - doc.count, [{ app: 'worker' }]], ['forward', () => 0, [{ app: 'api' }]]]) {
      const res = await queryAgainst(reply(200, streamsBody(older, newer)), { limit: 500, direction });
      const { doc } = res;
      equal(res.status, 0, `${direction}: exit status`);
      assert(Buffer.byteLength(res.stdout) <= 16 * 1024, `${direction}: the document is ${Buffer.byteLength(res.stdout)} bytes`);
      assert(doc.count >= 20 && doc.count < 100, `${direction}: unexpected count ${doc.count}`);
      equal([doc.count + doc.omitted, doc.truncated, doc.lines.length], [200, true, doc.count], `${direction}: counts`);
      equal(doc.lines.map(numberOf), Array.from({ length: doc.count }, (unused, offset) => firstKept(doc) + offset), `${direction}: the kept lines`);
      equal([doc.streams, new Set(doc.lines.map((entry) => entry.stream)).size], [streams, 1], `${direction}: only the streams the kept lines name`);
    }
    const lines = [{ line: '\u0001'.repeat(4000), stream: 1, ts: '2026-11-11T04:03:00.000Z' }, { line: 'next', stream: 0, ts: '2026-11-11T04:03:01.000Z' }];
    const one = fitLines({ lines, streams: [{ app: 'api' }, { app: 'worker' }] }, 'forward', 1024);
    equal([one.lines.length, one.lines[0].stream, one.streams, one.omitted], [1, 0, [{ app: 'worker' }], 1], 'one line is kept whatever its size');
    equal(fitLines({ lines: [], streams: [] }, 'backward', 1024), { lines: [], streams: [], omitted: 0 }, 'nothing to keep');
  }],
  ['query: a refused answer names the status and the origin, never the request', async () => {
    const text = { 'content-type': 'text/plain' };
    const refusals = [
      [reply(401, '{"message":"Unauthorized"}'), 'HTTP 401', 'service account'],
      [reply(403, '{"message":"Forbidden"}'), 'HTTP 403', `datasource ${DATASOURCE}`],
      [reply(500, 'boom', text), 'HTTP 500'],
      [reply(400, 'parse error at line 1, col 9: syntax error', text), 'HTTP 400', 'parse error at line 1'],
      [reply(400, `rejected ${TOKEN}`, text), 'HTTP 400', 'rejected [token]'],
      [reply(200, '<html>login</html>', { 'content-type': 'text/html' }), 'not JSON'],
      [reply(200, JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: [] } })), 'resultType: matrix'],
      [reply(200, '{"status":"success"}'), 'not Loki streams'],
    ];
    for (const [respond, ...fragments] of refusals) {
      const res = await queryAgainst(respond);
      equal([res.status, res.doc.ok, res.requests.length], [1, false, 1], `exit for ${fragments[0]}`);
      for (const fragment of [res.origin, ...fragments]) {
        assert(res.doc.error.includes(fragment), `expected "${fragment}" in: ${res.doc.error}`);
      }
      assert(!/[?]|Bearer|query_range/.test(res.stdout + res.stderr), `the failure leaked the request: ${res.stdout}`);
      equal(res.queryFileLeft, false, 'the query file is removed on a failed query');
    }
  }],
  ['query: a redirect is reported and never followed', async () => {
    const res = await queryAgainst((req, out) => {
      if (req.url.startsWith('/elsewhere')) {
        reply(200, streamsBody())(req, out);
        return;
      }
      out.writeHead(302, { location: '/elsewhere' });
      out.end();
    });
    equal([res.status, res.requests.length], [1, 1], 'exit 1 after one request');
    assert(res.doc.error.includes('HTTP 302') && res.doc.error.includes(res.origin), `unexpected error: ${res.doc.error}`);
  }],
  ['query: an oversized answer and a refused connection name the origin only', async () => {
    const big = await queryAgainst((req, out) => {
      out.writeHead(200, { 'content-type': 'application/json' });
      out.end(Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    });
    equal(big.status, 1, 'oversized answer');
    assert(big.doc.error.includes('16 MiB') && big.doc.error.includes(big.origin), `unexpected error: ${big.doc.error}`);
    await withTemp('refused', async (dir) => {
      const closed = await withStub(() => {}, async (url) => url);
      const { root, env } = world(dir, { url: closed });
      writeQuery(root);
      const res = await runEntry(windowArgs(root), env);
      equal(res.status, 1, 'refused connection');
      assert(res.doc.error.includes(`could not reach ${closed}`), `unexpected error: ${res.doc.error}`);
      assert(!res.doc.error.includes('?'), `the failure leaked the request: ${res.doc.error}`);
    });
  }],
  ['query: nothing is sent without a query file or with a token bound elsewhere', () =>
    withTemp('unsent', (dir) => {
      let calls = 0;
      const count = (req, out) => {
        calls += 1;
        reply(200, streamsBody())(req, out);
      };
      return withStub(count, async (url) => {
        const { root, env } = world(dir, { url, credentialUrl: 'https://other.example.invalid' });
        const noFile = await runEntry(windowArgs(root), env);
        equal(noFile.status, 1, 'no query file');
        assert(noFile.doc.error.includes(`.query-${RUN}.logql`), `unexpected error: ${noFile.doc.error}`);
        const file = writeQuery(root);
        const foreign = await runEntry(windowArgs(root), env);
        equal([foreign.status, fs.existsSync(file)], [1, false], 'token bound to another origin');
        assert(foreign.doc.error.includes('https://other.example.invalid'), `unexpected error: ${foreign.doc.error}`);
        equal(calls, 0, 'requests reaching the server');
      });
    })],
];

const START = '2026-11-11T03:53:00Z';
const END = '2026-11-11T04:08:00Z';
const QUERY = '{app="api"} |= "error"';
const RUN = '20261111-040300-0123abcd';
const OTHER_RUN = '20261111-040300-89abcdef';

const windowArgs = (root) => ['query', '--project-root', root, '--run', RUN, '--start', START, '--end', END];
const nanos = (iso) => String(BigInt(Date.parse(iso)) * 1_000_000n);
const streamsBody = (...result) => JSON.stringify({ status: 'success', data: { resultType: 'streams', result } });

const reply = (status, body = '', headers = { 'content-type': 'application/json' }) => (req, out) => {
  out.writeHead(status, headers);
  out.end(body);
};

function writeQuery(root, text = QUERY, run = RUN) {
  const dir = path.join(root, 'claudedocs', 'incidents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `.query-${run}.logql`);
  fs.writeFileSync(file, text);
  return file;
}

/** A loopback stand-in for Grafana; `handler(req, res)` answers. */
async function withStub(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** One `query` child run against a stand-in that answers every request with `respond`. */
function queryAgainst(respond, { limit, direction } = {}) {
  return withTemp('query', (dir) => {
    const requests = [];
    const record = (req, out) => {
      requests.push({ url: req.url, authorization: req.headers.authorization });
      respond(req, out);
    };
    return withStub(record, async (url) => {
      const { root, env } = world(dir, { url });
      const file = writeQuery(root);
      const args = [
        ...windowArgs(root),
        ...(limit === undefined ? [] : ['--limit', String(limit)]),
        ...(direction === undefined ? [] : ['--direction', direction]),
      ];
      const res = await runEntry(args, env);
      return { ...res, requests, origin: url, queryFileLeft: fs.existsSync(file) };
    });
  });
}

/** Every key at every depth of `doc`, as the replacer list a sorted render needs. */
function flatKeys(doc, out = {}) {
  if (doc !== null && typeof doc === 'object') {
    for (const [key, value] of Object.entries(doc)) {
      if (!Array.isArray(doc)) {
        out[key] = true;
      }
      flatKeys(value, out);
    }
  }
  return out;
}

/** Run every case; return the document, or throw a ComputeError naming the first failure. */
export async function runSelfTest() {
  for (const [name, fn] of CASES) {
    try {
      await fn();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ComputeError(`self-test: ${name} — ${detail}`);
    }
  }
  return { cases: CASES.length, ok: true };
}
