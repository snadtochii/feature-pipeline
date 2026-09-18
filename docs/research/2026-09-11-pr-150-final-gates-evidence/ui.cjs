const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const repo = '/Users/serhiinadtochii/Projects/personal-server';
const webRequire = Module.createRequire(path.join(repo, 'apps/web/package.json'));
const apiRequire = Module.createRequire(path.join(repo, 'apps/api/package.json'));
const { JSDOM } = webRequire('jsdom');
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { configurable: true, value: dom.window.navigator });
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (!(key in global)) {
    Object.defineProperty(global, key, { configurable: true, get: () => dom.window[key] });
  }
}
for (const key of ['Event', 'CustomEvent', 'EventTarget']) {
  global[key] = dom.window[key];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
const swc = apiRequire('@swc/core');
for (const extension of ['.ts', '.tsx']) {
  Module._extensions[extension] = (module, filename) => {
    const code = swc.transformSync(fs.readFileSync(filename, 'utf8'), { filename, swcrc: false, module: { type: 'commonjs' }, jsc: { target: 'es2023', parser: { syntax: 'typescript', tsx: filename.endsWith('.tsx') }, transform: { react: { runtime: 'automatic' } } } }).code;
    module._compile(code, filename);
  };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request.startsWith('@/')) {
    request = path.join(repo, 'apps/web/src', request.slice(2));
  }
  return originalResolve.call(this, request, ...args);
};
const React = webRequire('react');
const { render, fireEvent, screen, act, cleanup, waitFor } = webRequire('@testing-library/react');
const { QueryClient, QueryClientProvider, QueryObserver } = webRequire('@tanstack/react-query');
const { AssistantTransportError } = webRequire('@personal-server/client');
const source = name => require(path.join(repo, 'apps/web/src', name));
const { TaskClientsProvider } = source('lib/task-clients-context.tsx');
const { HistoryClientsProvider } = source('lib/history-clients-context.tsx');
const { HumanAccessContext } = source('features/access/human-access-context.tsx');
const { ChatReceipt } = source('features/chat/chat-receipt.tsx');
const { HistoryPage } = source('features/history/history-page.tsx');
const el = React.createElement;
const id = '01990000-0000-7000-8000-000000000001';
const opId = '01990000-0000-7000-8000-000000000002';
const newId = '01990000-0000-7000-8000-000000000003';
const now = new Date().toISOString();
const issued = { contract_version: 1, request_id: newId, operation_ids: [opId], instruction: 'Synthetic undo', originating_at: now, originating_surface: 'local_web' };
const request = { contract_version: 1, request_id: id, instruction: 'Synthetic delete', originating_at: now, originating_surface: 'local_web', operations: [{ operation_id: opId, kind: 'task.delete', target_id: newId, expected_revision: 'synthetic' }] };
const preview = { preview_id: newId, request_id: id, operation: request.operations[0], identifying_records: [], dependencies: [], affected_link_count: 0, expires_at: new Date(Date.now() + 60000).toISOString(), decision: 'pending' };
function receipt(approval = false) {
  return { contract_version: 1, request_id: id, status: approval ? 'awaiting_approval' : 'applied', payload_status: 'available', local_link: `/history?request=${id}`, operations: [{ operation_id: opId, kind: approval ? 'task.delete' : 'task.patch', status: approval ? 'awaiting_approval' : 'applied', affected: [], records: [], approval: approval ? 'required' : 'not_required', undo: { available: !approval } }] };
}
function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
}
function chat(client, assistant, onRecovery, approval = false) {
  return el(QueryClientProvider, { client }, el(TaskClientsProvider, { tasks: {}, assistant }, el(ChatReceipt, { result: receipt(approval), request: approval ? request : null, onRecovery })));
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function main() {
  const output = {};
  let client = queryClient();
  let fetches = 0;
  const activeKey = ['unrelated-active-audit'];
  const inactiveKey = ['unrelated-inactive-audit'];
  client.setQueryData(inactiveKey, 'retained-inactive');
  const observer = new QueryObserver(client, { queryKey: activeKey, initialData: 'retained-active', staleTime: Infinity, queryFn: async () => { fetches++; return 'refetched'; } });
  const unsubscribe = observer.subscribe(() => {});
  const invalidations = [];
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = (...args) => { invalidations.push(args); return invalidate(...args); };
  render(chat(client, { preview: async () => preview }, () => {}, true));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Review Delete task', exact: true })); });
  output.previewInvalidation = { invalidationArguments: invalidations, unrelatedActiveRefetches: fetches, unrelatedInactiveMarkedStale: client.getQueryState(inactiveKey).isInvalidated, inactiveData: client.getQueryData(inactiveKey), approvalDialogVisible: !!screen.queryByRole('dialog') };
  assert.equal(fetches, 1);
  assert.equal(client.getQueryData(inactiveKey), 'retained-inactive');
  cleanup(); unsubscribe(); client.clear();

  client = queryClient();
  let undoCalls = 0;
  render(chat(client, { register: async () => { throw new AssistantTransportError('not_dispatched'); }, undo: async () => { undoCalls++; } }, () => {}));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo Update task', exact: true })); });
  output.notDispatched = { alert: screen.getByRole('alert').textContent, undoCalls };
  cleanup(); client.clear();

  client = queryClient();
  const registration = deferred();
  const events = [];
  const h = render(chat(client, { register: () => { events.push('register-start'); return registration.promise; }, undo: async () => { events.push('undo-dispatched'); } }, () => events.push('recovery-callback')));
  fireEvent.click(screen.getByRole('button', { name: 'Undo Update task', exact: true }));
  h.unmount(); events.push('unmounted');
  await act(async () => { registration.resolve(issued); await registration.promise; });
  output.unmountedRegistration = events;
  assert.deepEqual(events, ['register-start', 'unmounted', 'recovery-callback', 'undo-dispatched']);
  client.clear();

  client = queryClient();
  const navigation = [];
  function Parent() {
    const [selected, setSelected] = React.useState(false);
    return selected ? el('p', { role: 'status' }, 'Selected recovery request') : chat(client, { register: async () => issued, undo: async () => { navigation.push('undo-dispatched'); throw new AssistantTransportError('uncertain', newId); } }, () => { navigation.push('recovery-callback'); setSelected(true); });
  }
  render(el(Parent));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo Update task', exact: true })); });
  output.recoveryBeforeFailedUndo = { events: navigation, errorVisibleAfterParentReplacesReceipt: !!screen.queryByRole('alert'), recoverySelected: !!screen.queryByText('Selected recovery request') };
  cleanup(); client.clear();

  client = queryClient();
  const pending = deferred();
  const calls = { request: 0, disclosure: 0 };
  const clients = {
    requests: { list: async () => ({ items: [], next_cursor: null }), detail: async () => ({ instruction: { instruction: 'Synthetic history', originating_surface: 'local_web', originating_at: now }, result: receipt() }), purge: async () => { calls.request++; await pending.promise; } },
    privacy: { list: async () => ({ items: [{ id: newId, at: now, hop: 'model', outcome: 'denied', reason: 'synthetic', processor: null, approximate_bytes: 0, fields: [], identifier_categories: [], references: [] }], next_cursor: null }), purge: async () => { calls.disclosure++; await pending.promise; } },
  };
  render(el(QueryClientProvider, { client }, el(HumanAccessContext, { value: true }, el(HistoryClientsProvider, { clients }, el(HistoryPage, { requestId: id })))));
  const requestButton = await screen.findByRole('button', { name: 'Purge request payload', exact: true });
  const disclosureButton = await screen.findByRole('button', { name: 'Purge disclosure metadata', exact: true });
  fireEvent.click(requestButton); fireEvent.click(disclosureButton);
  const first = { ...calls };
  const dialogs = screen.queryAllByRole('dialog').length + screen.queryAllByRole('alertdialog').length;
  const disabled = { request: requestButton.disabled, disclosure: disclosureButton.disabled };
  fireEvent.click(requestButton); fireEvent.click(disclosureButton);
  output.purge = { callsAfterFirstClick: first, confirmationDialogs: dialogs, disabledWhilePending: disabled, callsAfterSecondClickWhilePending: { ...calls } };
  await act(async () => { pending.resolve(); await pending.promise; });
  cleanup(); client.clear();
  output.scope = 'Actual ChatReceipt, HistoryPage, UI components, providers and QueryClient in JSDOM; injected synthetic clients. Parent replacement is controlled, not a real router/browser run. No HTTP or user data.';
  console.log(JSON.stringify(output, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { cleanup(); dom.window.close(); });
