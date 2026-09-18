const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const repo = '/Users/serhiinadtochii/Projects/personal-server';
const apiRequire = Module.createRequire(path.join(repo, 'apps/api/package.json'));
const swc = apiRequire('@swc/core');
const compiler = JSON.parse(fs.readFileSync(path.join(repo, 'apps/api/.swcrc'), 'utf8'));
apiRequire('reflect-metadata');
Module._extensions['.ts'] = (module, filename) => {
  module._compile(swc.transformSync(fs.readFileSync(filename, 'utf8'), { ...compiler, filename, swcrc: false }).code, filename);
};
const { openMigratedDatabase } = require(path.join(repo, 'apps/api/src/database/migrations.ts'));
const { SqliteAssistantStore } = require(path.join(repo, 'apps/api/src/assistant/sqlite-assistant-store.ts'));
const owner = { scope: 'owner', processing: 'local_human' };
const other = { scope: 'different-human', processing: 'local_human' };
const now = '2026-09-11T00:00:00.000Z';
async function request(store, context, operation) {
  const issued = await store.register(context, { contract_version: 1, instruction: 'Synthetic scope audit', originating_at: now, originating_surface: 'local_web', operation_count: 1 });
  return { contract_version: 1, request_id: issued.request_id, instruction: issued.instruction, originating_at: issued.originating_at, originating_surface: issued.originating_surface, operations: [{ ...operation, operation_id: issued.operation_ids[0] }] };
}
async function fixture() {
  const db = openMigratedDatabase(':memory:');
  const store = new SqliteAssistantStore(db, () => now);
  const create = await request(store, owner, { kind: 'task.create', input: { action: 'Synthetic owner task', clarity: 'actionable' } });
  const created = await store.apply(owner, create);
  assert.equal(created.operations[0].status, 'applied');
  const task = created.operations[0].records[0];
  const remove = await request(store, owner, { kind: 'task.delete', target_id: task.id, expected_revision: task.revision });
  const preview = await store.preview(owner, { request: remove, operation_id: remove.operations[0].operation_id });
  return { db, store, task, remove, preview };
}
async function main() {
  const results = {};
  let f = await fixture();
  try {
    let lookup;
    try {
      await f.store.get(other, f.remove.request_id);
      lookup = 'returned';
    } catch (error) {
      lookup = error.code;
    }
    const leaked = await f.store.getPreview(other, f.preview.preview_id);
    const decision = await f.store.decide(other, f.preview.preview_id, 'approve');
    const attempt = await request(f.store, other, { kind: 'task.delete', target_id: f.task.id, expected_revision: f.task.revision, approval_receipt: decision.approval_receipt });
    const denied = await f.store.apply(other, attempt);
    const applied = await f.store.apply(owner, { ...f.remove, resume_operation_ids: [f.remove.operations[0].operation_id], operations: [{ ...f.remove.operations[0], approval_receipt: decision.approval_receipt }] });
    results.approval = { ordinaryForeignRequestLookup: lookup, foreignPreviewReturnedOwnerRequest: leaked.request_id === f.remove.request_id, foreignPreviewContainsOwnerTask: leaked.identifying_records.some(r => r.id === f.task.id), foreignDecision: decision.decision, foreignDecisionIssuedReceipt: typeof decision.approval_receipt === 'string', foreignReceiptConsumptionError: denied.operations[0].error?.code, ownerExecutionWithForeignDecision: applied.operations[0].status, ownerTaskStillExists: !!f.db.prepare('SELECT 1 FROM personal_tasks WHERE id = ?').get(f.task.id) };
  } finally {
    f.db.close();
  }
  f = await fixture();
  try {
    const decision = await f.store.decide(other, f.preview.preview_id, 'deny');
    const ownerView = await f.store.get(owner, f.remove.request_id);
    results.denial = { foreignDecision: decision.decision, ownerOperationState: ownerView.operations[0].status, ownerTaskStillExists: !!f.db.prepare('SELECT 1 FROM personal_tasks WHERE id = ?').get(f.task.id) };
  } finally {
    f.db.close();
  }
  results.scope = 'Production SqliteAssistantStore with default DomainCommands, real in-memory migrations and real task create/delete; two synthetic trusted local_human contexts, not multi-user HTTP exploitation.';
  console.log(JSON.stringify(results, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
