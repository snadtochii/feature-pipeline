// `cli.mjs --self-test` (CONTRACT.md §13).
//
// Exercises the pure rules without starting Chrome or the app: the step-file
// schema, the evidence-name grammar, entry validation and start_timeout
// fallback, flag parsing, the exit-code mapping and the sorted-key document
// shape, and the step runner's failure handling and dialog replies against a
// stand-in connection — plus a few end-to-end invocations of cli.mjs itself that must exit 2
// before anything runs. A failing case throws a ComputeError naming it.
//
// Private to the implementation: only cli.mjs is a command.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgv } from './args.mjs';
import { authStatus } from './auth.mjs';
import { CdpError } from './cdp.mjs';
import { closeChrome, sessionChromeState } from './chrome.mjs';
import { dialogReply, run, watchDialogs } from './drive.mjs';
import { writeCapture } from './evidence.mjs';
import { normaliseStartTimeout, validateEntry } from './entry.mjs';
import { isOlder, parseSemver, swapInto } from './install.mjs';
import { ComputeError, UsageError, exitCodeFor, render } from './output.mjs';
import { isAlive, processStart, stopGroup, waitExit } from './proc.mjs';
import { isValidId, newId } from './session.mjs';
import { DEFAULT_TIMEOUT_MS, isValidName, validateSteps } from './steps.mjs';
import { VERBS } from './verbs.mjs';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));

class CaseFailure extends Error {}

function assert(condition, detail) {
  if (!condition) {
    throw new CaseFailure(detail);
  }
}

function throwsUsage(fn, fragment) {
  try {
    fn();
  } catch (err) {
    assert(err instanceof UsageError, `expected a UsageError, got ${err.constructor.name}: ${err.message}`);
    if (fragment !== undefined) {
      assert(err.message.includes(fragment), `expected the error to mention "${fragment}", got: ${err.message}`);
    }
    return;
  }
  throw new CaseFailure('expected a UsageError, nothing was thrown');
}

function runCli(args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 20000 });
  let doc = null;
  try {
    doc = JSON.parse(res.stdout);
  } catch {
    doc = null;
  }
  return { status: res.status, stdout: res.stdout, doc };
}

const ALL_STEPS = [
  { step: 'goto', url: '/' },
  { step: 'click', testid: 'save' },
  { step: 'click', text: 'Save' },
  { step: 'fill', testid: 'email', value: 'a@b.c' },
  { step: 'press', key: 'Enter' },
  { step: 'press', key: 'a', testid: 'email' },
  { step: 'wait', text: 'Saved' },
  { step: 'wait', url: 'http://127.0.0.1:7727/done' },
  { step: 'wait', ms: 250 },
  { step: 'expect', text: 'Saved' },
  { step: 'expect', testid: 'toast' },
  { step: 'expect', url: '/done', timeout_ms: 1000 },
  { step: 'viewport', width: 390, height: 844 },
  { step: 'screenshot', name: 'AC-1-mobile.png' },
];

// A stand-in for a CDP connection: `reply(method)` returns a result or throws,
// `emit` delivers an event to the subscribed listeners, `sent` records calls.
function fakeCdp(reply) {
  const listeners = new Map();
  const sent = [];
  return {
    sent,
    on(method, fn) {
      listeners.set(method, fn);
      return () => listeners.delete(method);
    },
    emit(method, params) {
      listeners.get(method)(params);
    },
    async send(method, params = {}) {
      sent.push({ method, params });
      return reply(method, params);
    },
  };
}

function fakeCtx(cdp) {
  return {
    cdp,
    state: { url: 'http://127.0.0.1:7727', viewport: { width: 1280, height: 800 } },
    dir: '/nonexistent',
    evidenceDir: '/nonexistent',
    current: 0,
    dialogs: { entries: [], dropped: 0 },
  };
}

// Every element lookup finds one visible match.
const FOUND = { result: { value: { count: 1, rect: { x: 0, y: 0, width: 10, height: 10 } } } };

const CASES = [
  ['steps: every verb of the closed set is accepted', () => {
    const steps = validateSteps(ALL_STEPS);
    assert(steps.length === ALL_STEPS.length, 'step count changed');
    assert(steps[0].timeout_ms === DEFAULT_TIMEOUT_MS, 'timeout_ms not defaulted');
    assert(steps[11].timeout_ms === 1000, 'explicit timeout_ms not kept');
  }],
  ['steps: unknown verb names its index', () => throwsUsage(() => validateSteps([{ step: 'goto', url: '/' }, { step: 'hover', testid: 'x' }]), 'step 1')],
  ['steps: unknown field', () => throwsUsage(() => validateSteps([{ step: 'goto', url: '/', selector: '#x' }]), 'step 0')],
  ['steps: two targets', () => throwsUsage(() => validateSteps([{ step: 'click', testid: 'a', text: 'A' }]), 'exactly one')],
  ['steps: missing target', () => throwsUsage(() => validateSteps([{ step: 'expect' }]), 'exactly one')],
  ['steps: missing required field', () => throwsUsage(() => validateSteps([{ step: 'fill', testid: 'a' }]), 'needs value')],
  ['steps: empty array and non-array', () => {
    throwsUsage(() => validateSteps([]), 'empty');
    throwsUsage(() => validateSteps({ step: 'goto' }), 'array');
    throwsUsage(() => validateSteps([null]), 'step 0');
  }],
  ['steps: goto accepts paths and http(s) only', () => {
    validateSteps([{ step: 'goto', url: '/items?q=1' }, { step: 'goto', url: 'https://example.test/' }]);
    throwsUsage(() => validateSteps([{ step: 'goto', url: 'javascript:alert(1)' }]), 'step 0');
    throwsUsage(() => validateSteps([{ step: 'goto', url: '//evil.test/' }]), 'step 0');
    throwsUsage(() => validateSteps([{ step: 'goto', url: 'file:///etc/passwd' }]), 'step 0');
  }],
  ['steps: press keys and value types', () => {
    throwsUsage(() => validateSteps([{ step: 'press', key: 'F13' }]), 'key');
    throwsUsage(() => validateSteps([{ step: 'viewport', width: 1280.5, height: 800 }]), 'width');
    throwsUsage(() => validateSteps([{ step: 'wait', ms: 0 }]), 'ms');
    throwsUsage(() => validateSteps([{ step: 'goto', url: '/', timeout_ms: 60001 }]), 'timeout_ms');
    throwsUsage(() => validateSteps([{ step: 'click', testid: '  ' }]), 'testid');
  }],
  ['names: the grammar accepts the pipeline capture names', () => {
    for (const name of ['AC-1-desktop.png', 'AC-12-mobile.png', 'APP-12-AC-3-mobile.png', 'login-form-error-mobile.png', 'home-empty-desktop.png', 'WEB-4-settings-disabled-desktop.png']) {
      assert(isValidName(name), `rejected ${name}`);
    }
  }],
  ['names: the grammar rejects everything else', () => {
    for (const name of ['ac-1-desktop.png', '../x.png', 'shot.png', 'a b-empty-desktop.png', 'x-empty-tablet.png', 'AC-1-desktop.jpg', 'x/AC-1-desktop.png', 'home-loading-desktop.png', 'AC-1-desktop.png\n']) {
      assert(!isValidName(name), `accepted ${JSON.stringify(name)}`);
    }
    throwsUsage(() => validateSteps([{ step: 'screenshot', name: 'shot.png' }]), 'grammar');
  }],
  ['entry: start_timeout fallback', () => {
    assert(normaliseStartTimeout(undefined).value === 60 && normaliseStartTimeout(undefined).note === null, 'absent');
    assert(normaliseStartTimeout(300).value === 300 && normaliseStartTimeout(300).note === null, '300');
    for (const raw of [0, 541, '60', -5, 1.5, null]) {
      const out = normaliseStartTimeout(raw);
      assert(out.value === 60 && typeof out.note === 'string', `fallback for ${JSON.stringify(raw)}`);
    }
  }],
  ['entry: shape rules', () => {
    const ok = validateEntry({ url: 'http://127.0.0.1:7727', start: 'npm run dev', cwd: '/srv/app', start_timeout: 0, auth: { storage_state: '/tmp/state.json' } });
    assert(ok.start_timeout === 60 && ok.notes.length === 1, 'fallback note missing');
    assert(ok.storage_state === '/tmp/state.json', 'storage_state not kept');
    throwsUsage(() => validateEntry({ url: 'http://x', start: 'npm run dev', cwd: 'app' }), 'cwd');
    throwsUsage(() => validateEntry({ url: 'http://x', start: 'npm run dev' }), 'start needs cwd');
    throwsUsage(() => validateEntry({ url: 'http://x', port: 3000 }), 'unknown key');
    throwsUsage(() => validateEntry({ url: 'ftp://x' }), 'url');
    throwsUsage(() => validateEntry({ url: 'http://x', auth: { storage_state: 'state.json' } }), 'storage_state');
    throwsUsage(() => validateEntry([]), 'object');
  }],
  ['output: exit-code mapping', () => {
    assert(exitCodeFor(new UsageError('x')) === 2, 'UsageError');
    assert(exitCodeFor(new ComputeError('x')) === 1, 'ComputeError');
    assert(exitCodeFor(new Error('x')) === 1, 'Error');
  }],
  ['output: sorted keys, ordered arrays, one newline', () => {
    const got = render({ b: 1, a: { d: [{ z: 1, y: 2 }, 3], c: null } });
    const want = '{\n  "a": {\n    "c": null,\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      },\n      3\n    ]\n  },\n  "b": 1\n}\n';
    assert(got === want, `got ${JSON.stringify(got)}`);
  }],
  ['args: both flag forms and the verb table', () => {
    const parsed = parseArgv(['drive', '--session=0123456789ab', '--steps', '/s.json', '--evidence=/e']);
    assert(parsed.verb === 'drive' && parsed.flags.session === '0123456789ab' && parsed.flags.steps === '/s.json' && parsed.flags.evidence === '/e', 'parsed flags');
    assert(parseArgv(['cleanup', '--all']).flags.all === true, '--all');
    assert(parseArgv(['--self-test']).selfTest === true, '--self-test');
    throwsUsage(() => parseArgv([]), 'no verb');
    throwsUsage(() => parseArgv(['--session', 'x']), 'no verb');
    throwsUsage(() => parseArgv(['frobnicate']), 'unknown verb');
    throwsUsage(() => parseArgv(['doctor', '--verbose']), 'unknown flag');
    throwsUsage(() => parseArgv(['doctor', '--session', '0123456789ab', '--session', '0123456789ab']), 'twice');
    throwsUsage(() => parseArgv(['cleanup', '--all=yes']), 'no value');
    throwsUsage(() => parseArgv(['cleanup']), 'exactly one');
    throwsUsage(() => parseArgv(['cleanup', '--all', '--session', '0123456789ab']), 'exactly one');
    throwsUsage(() => parseArgv(['launch', '--entry', 'entry.json']), 'absolute');
    throwsUsage(() => parseArgv(['evidence', '--session', '../../etc']), 'session');
    throwsUsage(() => parseArgv(['launch', '--self-test']), '--self-test');
    throwsUsage(() => parseArgv(['--self-test', 'launch']), '--self-test');
    throwsUsage(() => parseArgv(['drive', '--session', '0123456789ab', '--steps']), 'needs a value');
  }],
  ['verbs: every entry is complete and names only its own flags', () => {
    assert(Object.keys(VERBS).sort().join(',') === 'cleanup,doctor,drive,evidence,install,launch', `verbs: ${Object.keys(VERBS).join(',')}`);
    for (const [name, spec] of Object.entries(VERBS)) {
      assert(typeof spec.load === 'function' && typeof spec.run === 'function', `${name}: load/run`);
      for (const flag of [...spec.required, ...(spec.exactlyOne || [])]) {
        assert(Object.hasOwn(spec.flags, flag), `${name}: --${flag} is not one of its flags`);
      }
    }
    const loaded = VERBS.evidence.load({ session: '0123456789ab' });
    assert(loaded.session === '0123456789ab', 'a verb without input files keeps its flags');
  }],
  ['install: version comparison', () => {
    assert(isOlder('0.1.0', '0.2.0') === true && isOlder('0.10.0', '0.9.9') === false && isOlder('1.0.0', '1.0.0') === false, 'ordering');
    assert(isOlder('0.1', '0.2.0') === null && isOlder('0.1.0', 'v0.2.0') === null, 'unparsable is null');
    assert(parseSemver('1.2.3').join('.') === '1.2.3' && parseSemver('1.2.3-rc.1') === null, 'parseSemver');
  }],
  ['install: a failed swap restores the previous copy', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-verify-selftest-'));
    try {
      const target = path.join(dir, 'verify');
      const staging = path.join(dir, 'verify.tmp-1');
      const retired = path.join(dir, 'verify.old-1');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'version'), '0.0.1\n');
      fs.mkdirSync(staging);
      let calls = 0;
      const failSecond = (from, to) => {
        calls += 1;
        if (calls === 2) {
          throw Object.assign(new Error('rename refused'), { code: 'EIO' });
        }
        fs.renameSync(from, to);
      };
      let threw = false;
      try {
        swapInto(staging, target, retired, failSecond);
      } catch {
        threw = true;
      }
      assert(threw, 'the failed swap did not throw');
      assert(fs.readFileSync(path.join(target, 'version'), 'utf8') === '0.0.1\n', 'the previous copy is not back in place');
      assert(!fs.existsSync(retired), 'the retired copy is still under its retired name');
      swapInto(staging, target, retired);
      assert(fs.readdirSync(dir).join(',') === 'verify' && !fs.existsSync(path.join(target, 'version')), 'the swap did not replace the copy');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }],
  ['install: a copy a killed install left retired is restored, not swept', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-verify-selftest-'));
    try {
      const root = path.join(home, '.feature-pipeline');
      fs.mkdirSync(path.join(root, 'verify.old-0badc0de'), { recursive: true });
      fs.writeFileSync(path.join(root, 'verify.old-0badc0de', 'version'), '0.0.1\n');
      const res = spawnSync(process.execPath, [CLI, 'install'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, HOME: home } });
      assert(res.status === 0, `install exit ${res.status}: ${res.stdout}`);
      const doc = JSON.parse(res.stdout);
      assert(doc.replaced_version === '0.0.1', `replaced_version ${JSON.stringify(doc.replaced_version)}`);
      assert(fs.readdirSync(root).join(',') === 'verify', `left in ${root}: ${fs.readdirSync(root).join(',')}`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }],
  ['auth: storage-state status', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-verify-selftest-'));
    try {
      const write = (name, value) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
        return file;
      };
      const url = 'http://app.example.test:3000/home';
      const future = Date.now() / 1000 + 3600;
      const past = Date.now() / 1000 - 3600;
      assert(authStatus(null, url) === 'absent', 'absent');
      assert(authStatus(write('bad.json', '{'), url) === 'unreadable', 'unreadable');
      assert(authStatus(write('live.json', { cookies: [{ name: 's', value: 'v', domain: '.example.test', expires: future }], origins: [] }), url) === 'valid', 'live cookie');
      assert(authStatus(write('session.json', { cookies: [{ name: 's', value: 'v', domain: 'app.example.test', expires: -1 }], origins: [] }), url) === 'valid', 'session cookie');
      assert(authStatus(write('ls.json', { cookies: [], origins: [{ origin: 'http://app.example.test:3000', localStorage: [{ name: 't', value: 'x' }] }] }), url) === 'valid', 'localStorage');
      assert(authStatus(write('old.json', { cookies: [{ name: 's', value: 'v', domain: 'app.example.test', expires: past }], origins: [] }), url) === 'expired', 'expired cookie');
      assert(authStatus(write('other.json', { cookies: [{ name: 's', value: 'v', domain: 'other.test', expires: future }], origins: [] }), url) === 'expired', 'nothing for this host');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }],
  ['session: ids', () => {
    const id = newId();
    assert(isValidId(id), `generated ${id}`);
    assert(!isValidId('0123456789AB') && !isValidId('0123456789a') && !isValidId('../0123456789'), 'accepted a bad id');
  }],
  ['drive: a protocol error fails the step and stops the run', async () => {
    const cdp = fakeCdp((method) => {
      if (method === 'Runtime.evaluate') {
        return FOUND;
      }
      throw new CdpError(method, { message: 'no reply within 30000 ms' });
    });
    const steps = validateSteps([{ step: 'click', testid: 'save' }, { step: 'expect', testid: 'toast' }]);
    const results = await run(fakeCtx(cdp), steps);
    assert(results.length === 2, `got ${results.length} results`);
    assert(results[0].status === 'failed' && results[0].error.includes('Input.dispatchMouseEvent'), `step 0: ${JSON.stringify(results[0])}`);
    assert(results[1].status === 'skipped', `step 1: ${JSON.stringify(results[1])}`);
  }],
  ['drive: a lost connection is still exit 1', async () => {
    const cdp = fakeCdp((method) => {
      if (method === 'Runtime.evaluate') {
        return FOUND;
      }
      throw new ComputeError(`CDP connection lost during ${method}`);
    });
    try {
      await run(fakeCtx(cdp), validateSteps([{ step: 'click', testid: 'save' }]));
    } catch (err) {
      assert(err instanceof ComputeError, `expected a ComputeError, got ${err.constructor.name}`);
      return;
    }
    throw new CaseFailure('the run returned instead of throwing');
  }],
  ['drive: every dialog is accepted and recorded', () => {
    assert(dialogReply({ type: 'confirm' }).accept === true, 'confirm');
    assert(dialogReply({ type: 'prompt', defaultPrompt: 'x' }).promptText === 'x', 'prompt default');
    assert(dialogReply({ type: 'prompt' }).promptText === '', 'prompt without default');
    const cdp = fakeCdp(() => ({}));
    const ctx = fakeCtx(cdp);
    ctx.current = 3;
    watchDialogs(ctx);
    cdp.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete?' });
    const entry = ctx.dialogs.entries[0];
    assert(entry && entry.step === 3 && entry.type === 'confirm' && entry.accepted === true && entry.message === 'Delete?', `recorded ${JSON.stringify(entry)}`);
    const answer = cdp.sent.find((c) => c.method === 'Page.handleJavaScriptDialog');
    assert(answer && answer.params.accept === true, 'dialog not answered');
  }],
  ['evidence: a capture replaces a symlink at its name, never writes through it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-verify-selftest-'));
    try {
      const target = path.join(dir, 'target.txt');
      fs.writeFileSync(target, 'untouched');
      const evidenceDir = path.join(dir, 'evidence');
      fs.mkdirSync(evidenceDir);
      fs.symlinkSync(target, path.join(evidenceDir, 'AC-1-desktop.png'));
      const file = writeCapture(dir, evidenceDir, 'AC-1-desktop.png', Buffer.from('png'), { width: 1280, height: 800 });
      assert(fs.readFileSync(target, 'utf8') === 'untouched', 'the symlink target was written');
      assert(fs.lstatSync(file).isFile() && fs.readFileSync(file, 'utf8') === 'png', 'the capture is not a regular file holding the bytes');
      assert(fs.readdirSync(evidenceDir).join(',') === 'AC-1-desktop.png', `left behind: ${fs.readdirSync(evidenceDir).join(',')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }],
  ['proc: liveness, start-time identity and teardown of a gone process', async () => {
    assert(isAlive(process.pid) === true, 'this process is not alive');
    assert(isAlive(0) === false && isAlive(-1) === false && isAlive(1.5) === false, 'a non-pid is alive');
    const start = processStart(process.pid);
    assert(typeof start === 'string' && start === processStart(process.pid), `unstable start time ${JSON.stringify(start)}`);
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    assert(processStart(gone) === null, 'an exited process has a start time');
    assert(await waitExit(gone, 1000) === true, 'waitExit on an exited process');
    assert(await stopGroup(gone, 1000) === true, 'stopGroup on an exited process');
  }],
  ['chrome: an unreadable identity is never signalled and never counts as exited', async () => {
    const dir = path.join(os.tmpdir(), 'fp-verify-selftest-identity');
    const psFails = () => ({ status: 1, stdout: '' });
    const psOther = () => ({ status: 0, stdout: 'node something-else\n' });
    const psSession = () => ({ status: 0, stdout: `chrome --user-data-dir=${path.join(dir, 'profile')}\n` });
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    assert(sessionChromeState(gone, dir, psFails) === 'gone', 'an exited process is not gone');
    assert(sessionChromeState(process.pid, dir, psFails) === 'unknown', 'a failed ps is not unknown');
    assert(sessionChromeState(process.pid, dir, psOther) === 'other', 'another command line is not other');
    assert(sessionChromeState(process.pid, dir, psSession) === 'session', 'the session profile is not session');
    assert(await closeChrome(process.pid, null, dir, { run: psFails }) === false, 'an unreadable identity counts as exited');
    assert(await closeChrome(process.pid, null, dir, { run: psOther }) === true, 'a recycled id does not count as exited');
    assert(isAlive(process.pid), 'this process was signalled');
  }],
  ['cli: invocation errors exit 2 with an error document', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-verify-selftest-'));
    try {
      const badSteps = path.join(dir, 'steps.json');
      fs.writeFileSync(badSteps, JSON.stringify([{ step: 'goto', url: '/' }, { step: 'hover', testid: 'x' }]));
      const notJson = path.join(dir, 'entry.json');
      fs.writeFileSync(notJson, '{ url: ');
      const checks = [
        [['frobnicate'], 'unknown verb'],
        [['drive', '--session', '0123456789ab', '--steps', badSteps, '--evidence', dir], 'step 1'],
        [['launch', '--entry', path.join(dir, 'missing.json')], 'cannot read'],
        [['launch', '--entry', notJson], 'not valid JSON'],
        [['evidence', '--session', 'nope'], 'session'],
      ];
      for (const [args, fragment] of checks) {
        const res = runCli(args);
        assert(res.status === 2, `${args[0]}: exit ${res.status}, stdout ${JSON.stringify(res.stdout)}`);
        assert(res.doc !== null && Object.keys(res.doc).length === 1 && typeof res.doc.error === 'string', `${args[0]}: not an error document: ${JSON.stringify(res.stdout)}`);
        assert(res.doc.error.includes(fragment), `${args[0]}: error does not mention "${fragment}": ${res.doc.error}`);
        assert(res.stdout.endsWith('}\n') && !res.stdout.endsWith('\n\n'), `${args[0]}: not one trailing newline`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }],
];

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
