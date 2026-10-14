// The self-test's child-session cases (CONTRACT.md §13).
//
// Stream parsing over fixture lines, the finish predicate over fixture ticket
// states, the argument vectors, the preconditions on a temporary repository,
// the session runner against the stand-in `claude` with millisecond caps, the
// synchronous inbox helper, and end-to-end runs that ship, get stuck, fail
// their first `sync`, refuse a dirty tree, survive a failed inbox capture, and
// are signalled mid-session.
// The shared helpers come in as `kit` from selftest.mjs, so neither module
// imports the other's bindings at load time. No case starts a real `claude`.
//
// Private to the implementation: only dispatch.mjs is a command.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { ITEM_ID_RE, shipArgv, syncArgv } from './dispatch.mjs';
import { decideItem, inboxBody, resumeHint, summaryLine, syncStatus } from './finish.mjs';
import { checkPreconditions, gitBase, gitClean } from './preconditions.mjs';
import { sendInboxSync } from './server.mjs';
import { MAX_TIMER_MS, startSession, timerDelay } from './session.mjs';
import { applyLine, newSessionFacts, parseJsonResult } from './stream.mjs';

const FORBIDDEN_FLAGS = ['--merge', '--parallel', '--bare', '--settings', '--allowedTools', '--permission-mode'];
const PR = 'https://github.com/acme/my-app/pull/7';

/** Fold lines into fresh facts. */
function fold(lines) {
  let facts = newSessionFacts();
  let rateLimitEvents = 0;
  for (const line of lines) {
    const applied = applyLine(facts, line);
    facts = applied.facts;
    rateLimitEvents += applied.rateLimitEvent ? 1 : 0;
  }
  return { facts, rateLimitEvents };
}

/** A session runner result with a clean `result`, adjusted by `over`. */
function session(over = {}, factsOver = {}) {
  const result = { subtype: 'success', is_error: false, session_id: 's-1', total_cost_usd: 2, permission_denials: [] };
  return {
    exit_code: 0,
    signal: null,
    cap: null,
    spawnError: null,
    ...over,
    facts: { ...newSessionFacts(), session_id: 's-1', result, ...factsOver },
  };
}

const inReview = (fields = {}, pr = 'OPEN') => ({ row: { status: 'in-review', kind: 'solo', pr_url: PR, ...fields }, pr });

/** Wait until `test()` holds or `ms` pass. */
async function until(test, ms) {
  const started = Date.now();
  while (!test() && Date.now() - started < ms) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return test();
}

function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return ps.status === 0 && ps.stdout.trim() !== '' && !ps.stdout.trim().startsWith('Z');
}

export function sessionCases(kit) {
  const { assert, equal, tempDir, initRepo, writeConfig, commitAll, fakeBin, childEnv, world, worldEnv, withStub, stubHandler, runEntry, e2eRows, shippedRow, jsonl, initEvent, resultEvent, rateLimitEvent, PROJECT_ID, TOKEN } = kit;

  const readRuns = (w) => JSON.parse(fs.readFileSync(path.join(w.stateDir, 'runs.json'), 'utf8'));
  const claudeCalls = (w) =>
    fs.existsSync(w.files.FAKE_CLAUDE_ARGS)
      ? fs.readFileSync(w.files.FAKE_CLAUDE_ARGS, 'utf8').split('--\n').filter(Boolean).map((call) => call.split('\n').filter(Boolean))
      : [];
  const twoItems = `mode: server-native\nproject: ${PROJECT_ID}\ndispatch:\n  max_tickets_per_run: 2\n`;

  return [
    ['stream: fixture lines fold into session facts', () => {
      const { facts, rateLimitEvents } = fold([
        JSON.stringify(rateLimitEvent('abc-123')),
        JSON.stringify(initEvent('abc-999')),
        `${JSON.stringify({ type: 'system', subtype: 'api_retry', error: 'overloaded', session_id: 'abc-123' })}\r`,
        JSON.stringify(rateLimitEvent('abc-123')),
        JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '{"type":"result","subtype":"success"}' }] } }),
        'not json at all',
        '',
        JSON.stringify(resultEvent('abc-123', { subtype: 'error_during_execution', is_error: true })),
        JSON.stringify(resultEvent('abc-123', { total_cost_usd: undefined, permission_denials: [{ tool_name: 'Edit' }, {}] })),
      ]);
      equal(facts.session_id, 'abc-123', 'a session id seen first on api_retry is kept, and the result agrees');
      equal([facts.rate_limit_retries, rateLimitEvents], [2, 2], 'only rate_limit retries count');
      equal(facts.permission_denied, ['Bash'], 'permission_denied events');
      equal([facts.unparsed_lines, facts.events], [1, 8], 'unparsed and parsed counts; blank lines ignored');
      equal(facts.result, { subtype: 'success', is_error: false, session_id: 'abc-123', total_cost_usd: null, permission_denials: ['Edit', 'unknown'] }, 'the last result wins; missing cost is null');
      equal(fold([JSON.stringify(initEvent('../../etc; rm'))]).facts.session_id, null, 'an unsafe session id is not taken');
      equal(fold([]).facts, newSessionFacts(), 'empty stream');
      equal(parseJsonResult(`  ${JSON.stringify(resultEvent('sync-1'))}\n`), { subtype: 'success', is_error: false, session_id: 'sync-1', total_cost_usd: 1.25, permission_denials: [] }, 'json document');
      equal([parseJsonResult(''), parseJsonResult('[]'), parseJsonResult('{"type":"assistant"}')], [null, null, null], 'not a result document');
    }],

    ['finish: the predicate and every stuck reason, in precedence', () => {
      const decide = (s, t) => {
        const d = decideItem({ session: s, ticket: t });
        return d.outcome === 'shipped' ? 'shipped' : d.reason;
      };
      const matrix = [
        ['shipped', session(), inReview(), 'shipped'],
        ['epic row', session(), inReview({ kind: 'epic' }), 'shipped'],
        ['closed PR', session(), inReview({}, 'CLOSED'), 'pull request not open'],
        ['no pr_url', session(), inReview({ pr_url: null }, null), 'pull request not open'],
        ['not in review', session(), inReview({ status: 'in-progress' }), 'not in review (in-progress)'],
        ['state unknown', session(), null, 'state unknown'],
        ['PR state unknown', session(), { ...inReview(), pr: null, unknown: true }, 'state unknown'],
        ['denied, not shipped', session({}, { permission_denied: ['Bash'] }), inReview({ status: 'in-progress' }), 'permission_denied'],
        ['result subtype', session({}, { result: { ...session().facts.result, subtype: 'error_max_turns' } }), inReview(), 'result error_max_turns'],
        ['result error', session({}, { result: { ...session().facts.result, is_error: true, subtype: 'error_max_turns' } }), inReview(), 'result error'],
        ['no result', session({}, { result: null }), inReview(), 'no result'],
        ['no session id', session({}, { session_id: null, result: null }), inReview(), 'no session'],
        ['spawn error', session({ exit_code: null, spawnError: 'ENOENT' }), inReview(), 'no session'],
        ['exit 1', session({ exit_code: 1 }, { result: null }), inReview(), 'exit 1'],
        ['SIGTERM', session({ exit_code: 143 }, { result: null, session_id: null }), inReview(), 'SIGTERM'],
        ['rate limited exit', session({ exit_code: 1 }, { rate_limit_retries: 3 }), inReview(), 'rate_limit'],
        ['interrupted', session({ exit_code: 130, cap: 'interrupted' }), inReview(), 'interrupted'],
        ['rate-limit cap', session({ exit_code: 130, cap: 'rate_limit' }), inReview(), 'rate_limit'],
        ['timeout', session({ exit_code: 143, cap: 'timeout' }, { rate_limit_retries: 2, result: null }), null, 'timeout'],
      ];
      for (const [label, s, t, want] of matrix) {
        equal(decide(s, t), want, label);
      }
      const noted = decideItem({ session: session({}, { permission_denied: ['WebFetch'], result: { ...session().facts.result, permission_denials: ['Bash', 'WebFetch'] } }), ticket: inReview() });
      equal([noted.outcome, noted.note], ['shipped', 'shipped with permission denials: Bash, WebFetch'], 'shipped with denials is noted');
      equal(decideItem({ session: session({ exit_code: 1 }), ticket: inReview() }).pr_url, PR, 'a stuck item keeps the row\'s pr_url');
      equal(decideItem({ session: session(), ticket: { ...inReview({}, null), unknown: true } }).pr_url, PR, 'an unknown pull request state keeps the row\'s pr_url');

      const sync = (s, r) => syncStatus({ session: s, result: r });
      const ok = session().facts.result;
      equal(sync(session(), ok), { ok: true, reason: null }, 'sync ok');
      equal(sync(session({ exit_code: 1 }), ok).reason, 'exit 1', 'sync exit');
      equal(sync(session(), null).reason, 'no result', 'sync output not parsed');
      equal(sync(session(), { ...ok, is_error: true }).reason, 'result error', 'sync is_error');
      equal(sync(session(), { ...ok, subtype: 'error_max_turns' }).reason, 'result error_max_turns', 'sync subtype');
      equal(sync(session(), { ...ok, permission_denials: ['Bash'] }).reason, 'permission_denied', 'sync denials');
      equal(sync(session({ cap: 'timeout' }), ok).reason, 'timeout', 'sync timeout');
      equal(sync(session({ exit_code: null, spawnError: 'ENOENT' }), null).reason, 'no session', 'sync spawn error');

      const items = [{ outcome: 'shipped' }, { outcome: 'stuck' }, { outcome: 'not dispatched' }];
      const line = summaryLine({ runId: '2026-10-14-a1b2c3', items, skips: [{}, {}], notAdmitted: [{}] });
      equal(line, 'Night dispatch 2026-10-14-a1b2c3: 1 shipped, 1 stuck, 4 skipped', 'summary line');
      equal(inboxBody(line, '# Dispatch run\n').split('\n').slice(0, 3), [line, '', '# Dispatch run'], 'inbox body shape');
      equal(resumeHint('abc-123'), 'claude --resume abc-123', 'resume hint');
    }],

    ['dispatch: the exact argument vectors', () => {
      equal(syncArgv(), ['-p', '/feature:sync', '--output-format', 'json', '--permission-prompts', 'none'], 'sync vector');
      equal(shipArgv('ABC-12', '/home/me'), ['-p', '/feature:ship ABC-12 --worktree', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', '--add-dir', path.join('/home/me', '.feature-pipeline')], 'ship vector');
      for (const flag of FORBIDDEN_FLAGS) {
        assert(!syncArgv().includes(flag) && !shipArgv('ABC-12', '/h').includes(flag), `${flag} in a vector`);
      }
      for (const bad of ['ABC-1 --merge', 'ABC-1;rm', '-x', '', 'a/b', '../x']) {
        assert(!ITEM_ID_RE.test(bad), `id accepted: ${JSON.stringify(bad)}`);
        let threw = false;
        try {
          shipArgv(bad, '/h');
        } catch {
          threw = true;
        }
        assert(threw, `shipArgv took ${JSON.stringify(bad)}`);
      }
    }],

    ['preconditions: dirty tree, off base, unset origin/HEAD, detached HEAD, gh auth', () => {
      const dir = tempDir('pre');
      try {
        const repo = initRepo(dir);
        writeConfig(repo, 'mode: server-native\n');
        commitAll(repo);
        const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
        const env = process.env;
        equal(gitClean(repo, env), { ok: true, detail: 'working tree clean' }, 'clean');
        equal(gitBase(repo, env), { ok: true, detail: 'on main' }, 'on base');
        fs.writeFileSync(path.join(repo, 'stray.txt'), 'x');
        const dirty = gitClean(repo, env);
        assert(!dirty.ok && dirty.detail.includes('stray.txt'), `untracked file counts: ${JSON.stringify(dirty)}`);
        fs.rmSync(path.join(repo, 'stray.txt'));
        git('checkout', '-q', '-b', 'feature');
        equal(gitBase(repo, env), { ok: false, detail: 'on feature, base branch is main' }, 'off base');
        git('checkout', '-q', 'main');
        git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
        equal(gitBase(repo, env).detail, 'origin/HEAD not set — git remote set-head origin --auto', 'unset origin/HEAD');
        git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
        git('checkout', '-q', '--detach');
        equal(gitBase(repo, env).detail, 'HEAD is detached', 'detached HEAD');
        git('checkout', '-q', 'main');

        const bin = fakeBin(dir);
        const check = (extra, env = childEnv({ bin, home: dir, extra })) =>
          checkPreconditions({
            env,
            projectRoot: repo,
            server: { ok: true, detail: 'stub' },
            stateDir: { ok: true, detail: 'stub' },
            config: { project: PROJECT_ID },
          }).find((c) => c.name === 'gh');
        equal(check({ FAKE_GH_AUTH_STATUS: '1' }), { name: 'gh', ok: false, detail: 'gh auth status failed' }, 'gh auth failing');
        equal(check({}).ok, true, 'gh auth passing');
        equal(check({}, { PATH: path.join(dir, 'no-bin'), HOME: dir }).detail, 'not found on PATH', 'gh missing');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }],

    ['session: runner close, caps, escalation and logs against the stand-in', async () => {
      const dir = tempDir('session');
      const pids = [];
      try {
        const bin = fakeBin(dir);
        const out = path.join(dir, 'ship.jsonl');
        fs.writeFileSync(out, jsonl(initEvent('sess-a'), rateLimitEvent('sess-a'), rateLimitEvent('sess-a'), resultEvent('sess-a')));
        const start = (name, extra, opts = {}) => {
          const pidFile = path.join(dir, `${name}.pid`);
          const handle = startSession({
            command: path.join(bin, 'claude'),
            argv: ['-p', '/feature:ship ABC-1 --worktree'],
            cwd: dir,
            env: { ...process.env, FAKE_CLAUDE_SHIP_OUT: out, FAKE_CLAUDE_PID: pidFile, ...extra },
            logPath: path.join(dir, `${name}.jsonl`),
            stderrPath: path.join(dir, `${name}.stderr.log`),
            capMs: 60_000,
            ...opts,
          });
          return { handle, pidFile };
        };

        const normal = await start('normal', {}).handle.done;
        equal([normal.exit_code, normal.cap, normal.facts.session_id, normal.facts.rate_limit_retries, normal.facts.result?.subtype], [0, null, 'sess-a', 2, 'success'], 'normal close');
        equal(fs.readFileSync(normal.log, 'utf8').trim().split('\n').length, 4, 'every line logged');
        equal((fs.statSync(normal.log).mode & 0o777).toString(8), '600', 'log mode');

        const timed = await start('timeout', { FAKE_CLAUDE_HANG: '1' }, { capMs: 200, graceMs: 5_000, drainMs: 300 }).handle.done;
        equal([timed.exit_code, timed.cap], [130, 'timeout'], 'the time cap sends SIGINT');

        const limited = await start('limit', { FAKE_CLAUDE_HANG: '1' }, { maxRateLimitRetries: 1, graceMs: 5_000, drainMs: 300 }).handle.done;
        equal([limited.exit_code, limited.cap, limited.facts.rate_limit_retries], [130, 'rate_limit', 2], 'the retry cap sends SIGINT');

        const stubborn = start('stubborn', { FAKE_CLAUDE_HANG: 'stubborn' }, { capMs: 600, graceMs: 200, killMs: 200, drainMs: 300 });
        const killed = await stubborn.handle.done;
        equal([killed.exit_code, killed.signal, killed.cap], [137, 'SIGKILL', 'timeout'], 'SIGTERM ignored: the backstop kills the group');

        const stopped = start('stop', { FAKE_CLAUDE_HANG: '1' }, { drainMs: 300 });
        assert(await until(() => fs.existsSync(stopped.pidFile) && stopped.handle.facts().result !== null, 5_000), 'stand-in never started');
        pids.push(Number(fs.readFileSync(stopped.pidFile, 'utf8')));
        const seen = stopped.handle.stopNow();
        equal(seen.session_id, 'sess-a', 'stopNow returns the facts seen so far');
        const after = await stopped.handle.done;
        equal(after.cap, 'interrupted', 'stopNow marks the session interrupted');
        assert(await until(() => !alive(pids[0]), 5_000), 'stopNow left the stand-in running');

        const orphan = start('orphan', { FAKE_CLAUDE_HANG: 'orphan' }, { capMs: 1_000, graceMs: 5_000, drainMs: 5_000 });
        const childFile = `${orphan.pidFile}.child`;
        const childStarted = await until(() => fs.existsSync(childFile) && fs.readFileSync(childFile, 'utf8').trim() !== '', 5_000);
        pids.push(Number(fs.readFileSync(orphan.pidFile, 'utf8')));
        assert(childStarted, 'the orphan stand-in never started its grandchild');
        const grandchild = Number(fs.readFileSync(childFile, 'utf8'));
        const orphaned = await orphan.handle.done;
        equal([orphaned.exit_code, orphaned.cap], [130, 'timeout'], 'the orphan stand-in is capped');
        assert(await until(() => !alive(grandchild), 1_000), 'a capped session left a process of its group running');

        equal([timerDelay(3e9), timerDelay(1_000)], [MAX_TIMER_MS, 1_000], 'a cap past the timer range is clamped');
        const long = start('long', { FAKE_CLAUDE_HANG: '1' }, { capMs: 3e9, drainMs: 300 });
        assert(await until(() => fs.existsSync(long.pidFile), 5_000), 'the long-cap stand-in never started');
        pids.push(Number(fs.readFileSync(long.pidFile, 'utf8')));
        await new Promise((resolve) => setTimeout(resolve, 300));
        long.handle.stopNow();
        equal((await long.handle.done).cap, 'interrupted', 'a cap past the timer range does not fire at once');

        const missing = await startSession({ command: null, argv: [], cwd: dir, env: process.env, logPath: path.join(dir, 'n.jsonl'), stderrPath: path.join(dir, 'n.err'), capMs: 1_000 }).done;
        equal([missing.exit_code, missing.spawnError], [null, 'ENOENT'], 'no claude on PATH');
      } finally {
        for (const pid of pids) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }],

    ['end to end: a stuck ship stops the run; the rest is not dispatched', async () => {
      const w = world('e2e-stuck', { config: twoItems });
      try {
        fs.writeFileSync(w.files.FAKE_CLAUDE_SHIP_OUT, jsonl(initEvent('sess-stuck')));
        await withStub(stubHandler({ rows: e2eRows(), tickets: { 'ABC-1': { id: 'ABC-1', status: 'in-progress', kind: 'solo', pr_url: null } } }), async (url) => {
          const res = await runEntry(['run', '--project-root', w.repo], { env: worldEnv(w, url, { FAKE_CLAUDE_SHIP_STATUS: '1' }) });
          assert(res.status === 0, `stuck run: exit ${res.status} ${res.stdout}`);
          equal(res.doc.items.map((i) => [i.id, i.outcome, i.reason, i.session_id, i.exit_code]), [['ABC-1', 'stuck', 'exit 1', 'sess-stuck', 1], ['ABC-2', 'not dispatched', 'run stopped at ABC-1', null, null]], 'items');
          equal(res.doc.sync.after?.ok, true, 'the closing sync still runs');
          equal(claudeCalls(w).map((call) => call[2]), ['/feature:sync', '/feature:ship ABC-1 --worktree', '/feature:sync'], 'one ship session');
          assert(fs.readFileSync(res.doc.report, 'utf8').includes('- Resume ABC-1: claude --resume sess-stuck'), 'resume line');
        });
      } finally {
        fs.rmSync(w.dir, { recursive: true, force: true });
      }
    }],

    ['end to end: a rate-limit stop skips the closing sync', async () => {
      const w = world('e2e-limit');
      try {
        fs.writeFileSync(w.files.FAKE_CLAUDE_SHIP_OUT, jsonl(initEvent('sess-rl'), rateLimitEvent('sess-rl')));
        await withStub(stubHandler({ rows: e2eRows(), tickets: { 'ABC-1': { id: 'ABC-1', status: 'in-progress', kind: 'solo', pr_url: null } } }), async (url) => {
          const res = await runEntry(['run', '--project-root', w.repo], { env: worldEnv(w, url, { FAKE_CLAUDE_SHIP_STATUS: '1' }) });
          assert(res.status === 0, `rate-limit run: exit ${res.status} ${res.stdout}`);
          equal([res.doc.items[0].outcome, res.doc.items[0].reason, res.doc.items[0].rate_limit_retries], ['stuck', 'rate_limit', 1], 'rate-limited item');
          equal(res.doc.sync.after, null, 'closing sync skipped');
          assert(res.doc.notes.includes('closing sync skipped after a rate-limit stop'), `notes: ${JSON.stringify(res.doc.notes)}`);
        });
      } finally {
        fs.rmSync(w.dir, { recursive: true, force: true });
      }
    }],

    ['end to end: a failed first sync stops the run before any ship', async () => {
      const w = world('e2e-sync');
      const inbox = [];
      try {
        await withStub(stubHandler({ rows: e2eRows(), inbox }), async (url) => {
          const res = await runEntry(['run', '--project-root', w.repo], { env: worldEnv(w, url, { FAKE_CLAUDE_SYNC_STATUS: '1' }) });
          assert(res.status === 1 && res.doc?.error === 'sync failed: exit 1', `failed sync: exit ${res.status} ${res.stdout}`);
          equal(claudeCalls(w).map((call) => call[2]), ['/feature:sync'], 'no ship session');
          const runs = readRuns(w);
          equal([runs[0].outcome, runs[0].sync.before.ok, runs[0].sync.before.reason, runs[0].items], ['stopped', false, 'exit 1', []], 'stopped record');
          equal(inbox.length, 1, 'a stopped run still sends its inbox item');
          assert(inbox[0].body.body.startsWith(`Night dispatch ${runs[0].run_id}: 0 shipped, 0 stuck, 0 skipped`), 'stopped inbox first line');
        });
      } finally {
        fs.rmSync(w.dir, { recursive: true, force: true });
      }
    }],

    ['end to end: a dirty tree stops the run before any session', async () => {
      const w = world('e2e-dirty');
      try {
        fs.writeFileSync(path.join(w.repo, 'notes.txt'), 'uncommitted');
        await withStub(stubHandler({ rows: e2eRows() }), async (url) => {
          const res = await runEntry(['run', '--project-root', w.repo], { env: worldEnv(w, url) });
          assert(res.status === 1 && res.doc?.error === 'preconditions failed: git_clean (working tree not clean: notes.txt)', `dirty tree: exit ${res.status} ${res.stdout}`);
          equal(claudeCalls(w), [], 'claude never invoked');
          equal(readRuns(w).map((x) => x.outcome), ['stopped'], 'stopped record');
        });
      } finally {
        fs.rmSync(w.dir, { recursive: true, force: true });
      }
    }],

    ['end to end: a failed inbox capture is a note, not an exit', async () => {
      const w = world('e2e-inbox');
      try {
        await withStub(stubHandler({ rows: e2eRows(), tickets: { 'ABC-1': shippedRow('ABC-1') }, projects: [], inboxStatus: 500 }), async (url) => {
          const res = await runEntry(['run', '--project-root', w.repo], { env: worldEnv(w, url) });
          assert(res.status === 0, `inbox 500: exit ${res.status} ${res.stdout}`);
          const report = fs.readFileSync(res.doc.report, 'utf8');
          assert(report.includes('- inbox capture failed: HTTP 500'), 'capture failure note');
          assert(report.includes(`project name not resolved: the server lists no project ${PROJECT_ID}`), 'project-name note');
          assert(!report.includes(TOKEN), 'token in the report');
        });
      } finally {
        fs.rmSync(w.dir, { recursive: true, force: true });
      }
    }],

    ['end to end: SIGTERM mid-session stops the child and records it interrupted', async () => {
      const w = world('e2e-sigterm');
      const inbox = [];
      try {
        fs.writeFileSync(w.files.FAKE_CLAUDE_SHIP_OUT, jsonl(initEvent('sess-int')));
        await withStub(stubHandler({ rows: e2eRows(), inbox }), async (url) => {
          const res = await runEntry(['run', '--project-root', w.repo], {
            env: worldEnv(w, url, { FAKE_CLAUDE_HANG: '1' }),
            onSpawn: (child) => {
              const started = Date.now();
              const poll = setInterval(() => {
                if (fs.existsSync(w.files.FAKE_CLAUDE_PID) || Date.now() - started > 15_000) {
                  clearInterval(poll);
                  setTimeout(() => child.kill('SIGTERM'), 200);
                }
              }, 50);
            },
          });
          assert(res.status === 1 && res.doc?.error === 'interrupted by SIGTERM', `signal: exit ${res.status} ${res.stdout}`);
          const runs = readRuns(w);
          equal([runs[0].outcome, runs[0].items.map((i) => [i.outcome, i.reason, i.session_id])], ['stopped', [['stuck', 'interrupted', 'sess-int']]], 'interrupted record');
          equal(inbox.length, 1, 'a signalled run still sends its inbox item');
          const item = inbox[0].body;
          equal([item.source, item.project, item.metadata.run_id], ['feature:dispatch', 'my-app', runs[0].run_id], 'signal inbox item fields');
          equal(item.body.split('\n')[0], `Night dispatch ${runs[0].run_id}: 0 shipped, 1 stuck, 2 skipped`, 'signal inbox first line');
          assert(item.body.includes('interrupted by SIGTERM') && !item.body.includes(TOKEN), 'signal inbox body');
          const report = fs.readFileSync(path.join(w.stateDir, 'reports', `${runs[0].run_id}.md`), 'utf8');
          assert(!report.includes('no inbox item') && !report.includes('inbox capture failed'), `signal report notes: ${report}`);
          const pid = Number(fs.readFileSync(w.files.FAKE_CLAUDE_PID, 'utf8'));
          assert(await until(() => !alive(pid), 5_000), 'the stand-in survived the dispatcher');
          assert(!fs.existsSync(path.join(w.repo, '.git', 'feature-dispatch.lock')), 'lock not released');
        });
      } finally {
        fs.rmSync(w.dir, { recursive: true, force: true });
      }
    }],

    ['inbox: the synchronous helper reports an unreachable server as notes', async () => {
      const probe = net.createServer();
      await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const { port } = probe.address();
      await new Promise((resolve) => probe.close(resolve));
      const origin = `http://127.0.0.1:${port}`;
      const notes = sendInboxSync({
        access: { apiBase: `${origin}/api`, origin, token: TOKEN, tokenSource: 'env' },
        projectId: PROJECT_ID,
        runId: '2026-10-14-a1b2c3',
        body: 'Night dispatch 2026-10-14-a1b2c3: 0 shipped, 1 stuck, 0 skipped\n',
        env: { PATH: process.env.PATH },
        timeoutMs: 2_000,
      });
      equal(notes, [`inbox item sent without a project: project name not resolved: server unreachable at ${origin}`, `inbox capture failed: server unreachable at ${origin}`], 'helper notes');
      assert(!notes.join('\n').includes(TOKEN), 'token in the helper notes');
    }],

  ];
}
