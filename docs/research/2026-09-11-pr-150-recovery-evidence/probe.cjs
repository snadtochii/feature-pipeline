const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');
const repo = '/Users/serhiinadtochii/Projects/personal-server';
const rootRequire = Module.createRequire(path.join(repo, 'package.json'));
const apiRequire = Module.createRequire(path.join(repo, 'apps/api/package.json'));
const swc = apiRequire('@swc/core');
const compiler = JSON.parse(fs.readFileSync(path.join(repo, 'apps/api/.swcrc'), 'utf8'));
apiRequire('reflect-metadata');
Module._extensions['.ts'] = (module, filename) => {
  const result = swc.transformSync(fs.readFileSync(filename, 'utf8'), { ...compiler, filename, swcrc: false });
  module._compile(result.code, filename);
};
const source = (name) => require(path.join(repo, 'apps/api/src', name));

async function main() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pr150-recovery-audit-'));
  const originalCwd = process.cwd();
  let app;
  let db;
  try {
    process.chdir(directory);
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('PERSONAL_SERVER_')) {
        delete process.env[key];
      }
    }
    const human = crypto.randomBytes(32).toString('base64url');
    const assistant = crypto.randomBytes(32).toString('base64url');
    const reservation = require('node:net').createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    Object.assign(process.env, {
      PERSONAL_SERVER_DATA_DIR: directory,
      PERSONAL_SERVER_WEB_DIR: path.join(directory, 'no-web'),
      PERSONAL_SERVER_PORT: '7717', PERSONAL_SERVER_BIND_HOST: '127.0.0.1',
      PERSONAL_SERVER_ACCESS_MODE: 'restricted',
      PERSONAL_SERVER_HUMAN_TOKEN: human,
      PERSONAL_SERVER_ASSISTANT_TOKEN: assistant,
      PERSONAL_SERVER_HUMAN_ORIGINS: origin,
    });
    const { AppModule } = source('app.module.ts');
    const { configureApp } = source('configure-app.ts');
    const { RecoveryGuard } = source('recovery/recovery.module.ts');
    const { AccessGuard } = source('access/access.guard.ts');
    const { SqliteRecoveryStore } = source('recovery/sqlite-recovery-store.ts');
    const trace = [];
    for (const [Class, label, method] of [
      [RecoveryGuard, 'recovery-guard', 'canActivate'],
      [AccessGuard, 'access-guard', 'canActivate'],
      [SqliteRecoveryStore, 'recovery-status-query', 'status'],
    ]) {
      const original = Class.prototype[method];
      Class.prototype[method] = function (...args) {
        trace.push(label);
        return original.apply(this, args);
      };
    }
    const { Test } = apiRequire('@nestjs/testing');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot()] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.listen(port, '127.0.0.1');
    const base = await app.getUrl();
    let cookie;
    let csrf;
    async function call(route, method = 'GET', body, identity = 'human') {
      const headers = { Host: new URL(origin).host, Origin: origin };
      if (identity === 'human' && cookie) {
        headers.Cookie = cookie;
        headers['X-Personal-Server-CSRF'] = csrf;
      } else if (identity === 'assistant') {
        headers.Authorization = `Bearer ${assistant}`;
      }
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      trace.length = 0;
      const response = await fetch(`${base}/api${route}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const captured = [...trace];
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null, trace: captured };
    }
    const login = await fetch(`${base}/api/access/session`, {
      method: 'POST', headers: {
        Host: new URL(origin).host, Origin: origin,
        Authorization: `Bearer ${human}`, 'X-Personal-Server-Intent': 'human-session',
      },
    });
    assert.equal(login.status, 201, 'synthetic HTTP login');
    cookie = login.headers.get('set-cookie').split(';')[0];
    csrf = (await login.json()).csrf_token;
    const rows = [];
    for (const identity of ['anonymous', 'assistant', 'human']) {
      const result = await call('/projects', 'GET', undefined, identity);
      rows.push({ mode: 'active', route: 'GET /projects', identity, status: result.status, trace: result.trace });
    }
    const id = '01990000-0000-7000-8000-000000000001';
    const input = {
      import_id: id, account_id: 'synthetic-account',
      snapshot_sha256: 'a'.repeat(64), mapping_sha256: 'b'.repeat(64), importer_sha256: 'c'.repeat(64),
      inbox_project_id: 'synthetic-inbox', projects: [], views: [], exclusions: [],
      tasks: [{ source_id: 'synthetic-task', source_project_id: 'synthetic-inbox', action: 'Synthetic audit',
        description: '', clarity: 'actionable', planned_date: null, recurrence: null, recurrence_evidence: null }],
    };
    assert.equal((await call('/todoist-imports', 'POST', input)).status, 201);
    const state = await call(`/todoist-imports/${id}/state`);
    assert.equal(state.status, 200);
    const frozen = await call('/recovery/freeze', 'POST');
    assert.equal(frozen.status, 201);
    const decision = { fingerprint: state.body.fingerprint, freeze_id: frozen.body.freeze_id, decision: 'accept', confirmed: true };
    for (const identity of ['anonymous', 'assistant', 'human']) {
      for (const route of ['/projects', '/recovery/status', `/todoist-imports/${id}/state`]) {
        const result = await call(route, 'GET', undefined, identity);
        rows.push({ mode: 'frozen', route: `GET ${route.replace(id, ':id')}`, identity, status: result.status, trace: result.trace });
      }
      const result = await call(`/todoist-imports/${id}/decision`, 'POST', decision, identity);
      rows.push({ mode: 'frozen', route: 'POST /todoist-imports/:id/decision', identity, status: result.status, trace: result.trace });
    }
    const wrong = await call(`/todoist-imports/${id}/decision`, 'POST', { ...decision, freeze_id: '01990000-0000-7000-8000-000000000099' });
    assert.equal(wrong.status, 409, 'wrong freeze decision');
    const malformed = await call(`/todoist-imports/${id}/decision`, 'POST', { fingerprint: decision.fingerprint, freeze_id: decision.freeze_id, decision: 'accept' });
    const after = await call(`/todoist-imports/${id}/state`);
    assert.equal(after.body.state, 'accepted');
    const Database = apiRequire('better-sqlite3');
    db = new Database(path.join(directory, 'personal-server.sqlite'));
    const count = () => db.prepare('SELECT COUNT(*) AS n FROM recovery_snapshots').get().n;
    const before = count();
    const snapshot = await call('/recovery/snapshot');
    assert.equal(snapshot.status, 200);
    const bytes = Buffer.from(snapshot.body.content, 'base64');
    assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\0');
    assert.equal(count(), before + 1);
    console.log(JSON.stringify({ rows, wrongFreezeDecision: wrong.status, missingConfirmationStatus: malformed.status, acceptedState: after.body.state,
      snapshot: { status: snapshot.status, sqliteHeaderVerified: true, rawBytes: bytes.length, base64Characters: snapshot.body.content.length,
        metadataRowsAddedByGET: count() - before },
      scope: 'actual source AppModule, real migrations, loopback HTTP, synthetic credentials and disposable DB; guard/store observation wrappers preserve behavior' }, null, 2));
  } finally {
    if (db) {
      db.close();
    }
    if (app) {
      await app.close();
    }
    process.chdir(originalCwd);
    await fsp.rm(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
