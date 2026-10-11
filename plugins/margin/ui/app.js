// margin viewer. One page, no build step. Talks to ../server/lib/server.mjs over
// its six routes and keeps the notes file current through PUT /api/session.

import { highlightLines } from './highlight.js';

const $ = (selector) => document.querySelector(selector);

// A scope with more files than this opens with every folder below the scope collapsed.
const COLLAPSE_THRESHOLD = 200;

const state = {
  session: null, // { root, scope, out, overall, annotations }
  files: [], // repo-relative paths in scope, sorted
  current: null, // { path, lines } or { path, lines: null } for a binary file
  selection: null, // { start, end } line numbers in the current file
  editing: null, // annotation id while the composer edits instead of adds
  collapsed: new Set(), // folder paths shown closed; not consulted while the filter is on
  filter: '', // lower-cased tree filter text, '' when off
  saveTimer: null,
  // The rendered code view, null when no text file is shown. It records what the line nodes
  // currently show, so note and selection changes patch only the lines whose state differs:
  // { nodes: index n-1 → the .line node for line n, marks: line numbers painted .marked,
  //   selection: { start, end } painted .selected or null, btn: the "Annotate L…" button }
  view: null,
};

const el = {
  treeRows: $('#tree-rows'),
  filter: $('#filter'),
  code: $('#code'),
  list: $('#list'),
  overall: $('#overall'),
  composer: $('#composer'),
  send: $('#send'),
  cancel: $('#cancel'),
  addScope: $('#add-scope'),
  scope: $('#scope'),
  saveState: $('#save-state'),
  count: $('#count'),
};

// The per-run token rides in the URL fragment the server printed; every API call carries it.
const TOKEN = window.location.hash.slice(1);

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'x-margin-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${url} failed with ${res.status}`);
  }
  return res.json();
}

const byName = (a, b) => a.name.localeCompare(b.name);
const annotations = () => state.session.annotations;

function anchorLabel(anchor) {
  switch (anchor.kind) {
    case 'range':
      return anchor.start === anchor.end ? `${anchor.path}:${anchor.start}` : `${anchor.path}:${anchor.start}-${anchor.end}`;
    case 'file':
      return anchor.path;
    case 'folder':
      return `${anchor.path}/`;
    default:
      return 'whole scope';
  }
}

// ---- loading -------------------------------------------------------------

async function load() {
  const data = await api('GET', '/api/session');
  state.session = data.session;
  state.files = data.files;
  el.scope.textContent = `${data.session.root} · ${data.session.scope.join(', ') || '.'}`;
  el.overall.value = data.session.overall || '';
  applyDefaultCollapse();
  renderTree();
  renderList();
}

// ---- tree ----------------------------------------------------------------

function buildTree(paths) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!node.dirs.has(parts[i])) {
        node.dirs.set(parts[i], { name: parts[i], path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] });
      }
      node = node.dirs.get(parts[i]);
    }
    node.files.push({ name: parts.at(-1), path });
  }
  return root;
}

// The folders above `path`, outermost first.
function ancestors(path) {
  const parts = path.split('/');
  const dirs = [];
  for (let i = 1; i < parts.length; i += 1) {
    dirs.push(parts.slice(0, i).join('/'));
  }
  return dirs;
}

// Opens every folder above `path`, and `path` itself when `self` is set.
function expandTo(path, { self = false } = {}) {
  for (const dir of ancestors(path)) {
    state.collapsed.delete(dir);
  }
  if (self) {
    state.collapsed.delete(path);
  }
}

// Large scopes open collapsed below each scope entry, with the folders holding notes open,
// so a resumed review shows its noted rows without a click.
function applyDefaultCollapse() {
  if (state.files.length <= COLLAPSE_THRESHOLD) {
    return;
  }
  for (const path of state.files) {
    for (const dir of ancestors(path)) {
      state.collapsed.add(dir);
    }
  }
  for (const entry of state.session.scope) {
    expandTo(entry, { self: true });
  }
  for (const a of annotations()) {
    if (a.anchor.path) {
      expandTo(a.anchor.path);
    }
  }
}

// Note counts per tree row: `folder:<path>` counts folder notes, `file:<path>` file and range notes.
function noteCounts() {
  const counts = new Map();
  for (const a of annotations()) {
    if (a.anchor.path) {
      const key = `${a.anchor.kind === 'folder' ? 'folder' : 'file'}:${a.anchor.path}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

const matchesFilter = (path) => path.toLowerCase().includes(state.filter);

// While the filter is on, the tree holds only the matching files and the folders above
// them, all shown open without consulting `state.collapsed`, so clearing the filter brings
// back the expansion as it was plus the folders of any file opened while filtering.
function renderTree() {
  const filtering = state.filter !== '';
  const paths = filtering ? state.files.filter(matchesFilter) : state.files;
  if (filtering && paths.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = 'No files match';
    el.treeRows.replaceChildren(empty);
    return;
  }
  const view = { counts: noteCounts(), filtering };
  el.treeRows.replaceChildren(renderDir(buildTree(paths), 0, view));
}

function renderDir(node, depth, view) {
  const frag = document.createDocumentFragment();
  for (const dir of [...node.dirs.values()].sort(byName)) {
    frag.append(treeRow('folder', dir, depth, view));
    if (view.filtering || !state.collapsed.has(dir.path)) {
      frag.append(renderDir(dir, depth + 1, view));
    }
  }
  for (const file of node.files.sort(byName)) {
    frag.append(treeRow('file', file, depth, view));
  }
  return frag;
}

function treeRow(kind, node, depth, view) {
  const row = document.createElement('div');
  row.className = `row ${kind}`;
  row.style.paddingLeft = `${8 + depth * 14}px`;
  if (kind === 'file' && state.current?.path === node.path) {
    row.classList.add('active');
  }
  const name = document.createElement('span');
  name.className = 'name';
  const open = view.filtering || !state.collapsed.has(node.path);
  name.textContent = kind === 'folder' ? `${open ? '▾' : '▸'} ${node.name}` : node.name;
  name.title = node.path;
  name.addEventListener('click', () => {
    if (kind === 'file') {
      openFile(node.path);
    } else if (!view.filtering) {
      toggleDir(node.path);
    }
  });

  const count = view.counts.get(`${kind}:${node.path}`) ?? 0;
  const btn = document.createElement('button');
  btn.className = `note-btn${count ? ' has' : ''}`;
  btn.title = `Annotate this ${kind}`;
  btn.textContent = count ? String(count) : '+';
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    openComposer({ kind, path: node.path });
  });
  row.append(name, btn);
  return row;
}

function toggleDir(path) {
  if (state.collapsed.has(path)) {
    state.collapsed.delete(path);
  } else {
    state.collapsed.add(path);
  }
  renderTree();
}

function setFilter(text) {
  state.filter = text.trim().toLowerCase();
  renderTree();
}

// ---- code view -----------------------------------------------------------

async function openFile(path, scrollTo) {
  let data;
  try {
    data = await api('GET', `/api/file?path=${encodeURIComponent(path)}`);
  } catch {
    // A resumed note can point at a file that moved or sits outside this run's scope.
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent = `${path} is not in this scope (moved, deleted, or outside the paths this review was opened with). Its notes are kept.`;
    el.code.replaceChildren(note);
    state.current = null;
    state.selection = null;
    state.view = null;
    renderTree();
    return;
  }
  state.selection = null;
  if (data.binary) {
    state.current = { path, lines: null };
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent = `${path}: ${data.reason}. Annotate it as a file from the tree.`;
    el.code.replaceChildren(note);
    state.view = null;
  } else {
    const lines = data.text.split('\n');
    if (lines.at(-1) === '') {
      lines.pop();
    }
    state.current = { path, lines };
    renderCode();
    if (scrollTo) {
      state.view.nodes[scrollTo - 1]?.scrollIntoView({ block: 'center' });
    }
  }
  // A file opened while filtering keeps a visible row once the filter is cleared.
  if (state.filter) {
    expandTo(path);
  }
  renderTree();
}

function markedLines(path) {
  const marked = new Set();
  for (const a of annotations()) {
    if (a.anchor.kind === 'range' && a.anchor.path === path) {
      for (let n = a.anchor.start; n <= a.anchor.end; n += 1) {
        marked.add(n);
      }
    }
  }
  return marked;
}

function renderCode() {
  const { path, lines } = state.current;
  const marked = markedLines(path);
  const head = document.createElement('div');
  head.className = 'file-head';
  head.textContent = `${path} · ${lines.length} lines`;
  const box = document.createElement('div');
  box.className = 'lines';
  // One delegated listener for every gutter, however long the file.
  box.addEventListener('click', (event) => {
    const gutter = event.target.closest('.gutter');
    if (gutter) {
      selectLine(Number(gutter.parentElement.dataset.n), event.shiftKey);
    }
  });
  const nodes = [];
  const tokens = highlightLines(lines, path);
  lines.forEach((text, i) => {
    const n = i + 1;
    const line = document.createElement('div');
    line.className = `line${marked.has(n) ? ' marked' : ''}`;
    line.dataset.n = String(n);
    nodes.push(line);
    const gutter = document.createElement('span');
    gutter.className = 'gutter';
    gutter.textContent = String(n);
    const src = document.createElement('span');
    src.className = 'src';
    if (text === '') {
      src.textContent = ' ';
    }
    for (const token of tokens[i]) {
      if (token.type === null) {
        src.append(token.text);
      } else {
        const piece = document.createElement('span');
        piece.className = `tok-${token.type}`;
        piece.textContent = token.text;
        src.append(piece);
      }
    }
    line.append(gutter, src);
    box.append(line);
  });
  // One "Annotate L…" button per render, moved and hidden rather than re-inserted: adding or
  // removing a node in the pane re-lays out every line, moving a positioned one does not.
  const selBtn = document.createElement('button');
  selBtn.className = 'sel-btn off';
  selBtn.addEventListener('click', () => {
    const sel = state.selection;
    if (sel) {
      const excerpt = state.current.lines.slice(sel.start - 1, sel.end).join('\n');
      openComposer({ kind: 'range', path: state.current.path, start: sel.start, end: sel.end, excerpt });
    }
  });
  el.code.replaceChildren(head, box, selBtn);
  state.view = { nodes, marks: marked, selection: null, btn: selBtn };
  applySelection();
}

// Toggles .marked on the lines whose marked state changed since the last paint.
function refreshMarks() {
  const view = state.view;
  const next = markedLines(state.current.path);
  for (const n of view.marks) {
    if (!next.has(n)) {
      view.nodes[n - 1]?.classList.remove('marked');
    }
  }
  for (const n of next) {
    if (!view.marks.has(n)) {
      view.nodes[n - 1]?.classList.add('marked');
    }
  }
  view.marks = next;
}

function selectLine(n, extend) {
  if (extend && state.selection) {
    state.selection = { start: Math.min(state.selection.start, n), end: Math.max(state.selection.end, n) };
  } else if (state.selection && state.selection.start === n && state.selection.end === n) {
    state.selection = null;
  } else {
    state.selection = { start: n, end: n };
  }
  applySelection();
}

// Paints state.selection, toggling .selected only on the lines whose state changed.
function applySelection() {
  const view = state.view;
  if (!view) {
    return;
  }
  const sel = state.selection;
  const shown = view.selection;
  const within = (range, n) => Boolean(range) && n >= range.start && n <= range.end;
  if (shown) {
    for (let n = shown.start; n <= shown.end; n += 1) {
      if (!within(sel, n)) {
        view.nodes[n - 1]?.classList.remove('selected');
      }
    }
  }
  if (sel) {
    for (let n = sel.start; n <= sel.end; n += 1) {
      if (!within(shown, n)) {
        view.nodes[n - 1]?.classList.add('selected');
      }
    }
  }
  view.selection = sel ? { start: sel.start, end: sel.end } : null;
  const btn = view.btn;
  const anchorLine = sel ? view.nodes[sel.start - 1] : null;
  btn.classList.toggle('off', !anchorLine);
  if (anchorLine) {
    btn.textContent = sel.start === sel.end ? `Annotate L${sel.start}` : `Annotate L${sel.start}–${sel.end}`;
    btn.style.top = `${anchorLine.offsetTop}px`;
  }
}

// ---- composer ------------------------------------------------------------

function openComposer(anchor, existing = null) {
  state.editing = existing?.id ?? null;
  const intent = existing?.intent ?? 'change';
  el.composer.classList.remove('hidden');
  el.composer.replaceChildren();

  const label = document.createElement('div');
  label.className = 'anchor';
  label.textContent = anchorLabel(anchor);

  const intents = document.createElement('div');
  intents.className = 'intent';
  for (const value of ['change', 'question']) {
    const option = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'intent';
    radio.value = value;
    radio.checked = value === intent;
    option.append(radio, ` ${value}`);
    intents.append(option);
  }

  const body = document.createElement('textarea');
  body.rows = 5;
  body.placeholder = anchor.kind === 'scope' ? 'Something about the scope as a whole.' : 'What should change here, or what do you want to know?';
  body.value = existing?.body ?? '';

  const actions = document.createElement('div');
  actions.className = 'actions';
  const add = document.createElement('button');
  add.className = 'primary';
  add.append(existing ? 'Update' : 'Add');
  const hint = document.createElement('kbd');
  hint.textContent = '⌘↩';
  add.append(hint);
  const cancel = document.createElement('button');
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';

  const commit = () => {
    const text = body.value.trim();
    if (text === '') {
      body.focus();
      return;
    }
    const chosen = intents.querySelector('input:checked').value;
    if (state.editing) {
      const target = annotations().find((a) => a.id === state.editing);
      Object.assign(target, { intent: chosen, body: text });
    } else {
      annotations().push({ id: crypto.randomUUID(), anchor, intent: chosen, body: text, createdAt: new Date().toISOString() });
    }
    state.selection = null;
    closeComposer();
    afterChange();
  };

  add.addEventListener('click', commit);
  cancel.addEventListener('click', closeComposer);
  body.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      commit();
    }
    if (event.key === 'Escape') {
      closeComposer();
    }
  });

  actions.append(add, cancel);
  el.composer.append(label, intents, body, actions);
  body.focus();
}

function closeComposer() {
  state.editing = null;
  el.composer.classList.add('hidden');
  el.composer.replaceChildren();
}

function afterChange() {
  scheduleSave();
  renderList();
  renderTree();
  // Patch the open file in place; commit clears the selection, so repaint it too.
  if (state.view) {
    refreshMarks();
    applySelection();
  }
}

// ---- notes list ----------------------------------------------------------

const KIND_ORDER = { scope: 0, folder: 1, file: 2, range: 3 };

function sortedAnnotations() {
  return [...annotations()].sort((a, b) => {
    const pathDiff = (a.anchor.path ?? '').localeCompare(b.anchor.path ?? '');
    if (pathDiff !== 0) {
      return pathDiff;
    }
    const kindDiff = KIND_ORDER[a.anchor.kind] - KIND_ORDER[b.anchor.kind];
    return kindDiff !== 0 ? kindDiff : (a.anchor.start ?? 0) - (b.anchor.start ?? 0);
  });
}

function renderList() {
  const all = sortedAnnotations();
  el.count.textContent = `${all.length} ${all.length === 1 ? 'note' : 'notes'}`;
  el.send.textContent = all.length ? `Send ${all.length}` : 'Send';
  el.list.replaceChildren(...all.map(noteItem));
}

function noteItem(a) {
  const item = document.createElement('li');
  item.className = 'note';

  const head = document.createElement('div');
  head.className = 'head';
  const anchor = document.createElement('span');
  anchor.className = 'anchor';
  anchor.textContent = anchorLabel(a.anchor);
  anchor.addEventListener('click', () => revealAnchor(a.anchor));
  const badge = document.createElement('span');
  badge.className = `badge ${a.intent}`;
  badge.textContent = a.intent;
  head.append(anchor, badge);

  const body = document.createElement('p');
  body.className = 'body';
  body.textContent = a.body;

  const ops = document.createElement('div');
  ops.className = 'ops';
  const edit = document.createElement('button');
  edit.textContent = 'edit';
  edit.addEventListener('click', () => openComposer(a.anchor, a));
  const del = document.createElement('button');
  del.className = 'del';
  del.textContent = 'delete';
  del.addEventListener('click', () => {
    state.session.annotations = annotations().filter((x) => x.id !== a.id);
    afterChange();
  });
  ops.append(edit, del);

  item.append(head, body, ops);
  return item;
}

// Shows a note's anchor in the tree, clearing first a filter that would hide it.
function revealAnchor(anchor) {
  if (anchor.path && !matchesFilter(anchor.path)) {
    el.filter.value = '';
    setFilter('');
  }
  if (anchor.kind === 'range' || anchor.kind === 'file') {
    expandTo(anchor.path);
    openFile(anchor.path, anchor.start);
  } else if (anchor.kind === 'folder') {
    expandTo(anchor.path, { self: true });
    renderTree();
  } else {
    el.overall.focus();
  }
}

// ---- persistence ---------------------------------------------------------

function payload() {
  return { overall: el.overall.value, annotations: annotations() };
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  el.saveState.textContent = 'saving…';
  state.saveTimer = setTimeout(save, 400);
}

async function save() {
  clearTimeout(state.saveTimer);
  try {
    const res = await api('PUT', '/api/session', payload());
    el.saveState.textContent = `saved ${new Date(res.updatedAt).toLocaleTimeString()}`;
  } catch (err) {
    el.saveState.textContent = `save failed: ${err.message}`;
  }
}

function finish(status) {
  const total = annotations().length;
  const card = document.createElement('div');
  card.className = 'card';
  const title = document.createElement('h2');
  const text = document.createElement('p');
  if (status === 'submitted') {
    title.textContent = `Sent ${total} ${total === 1 ? 'note' : 'notes'}`;
    text.append('Saved to ');
    const code = document.createElement('code');
    code.textContent = state.session.out;
    text.append(code, '. The agent picks the file up from here. You can close this tab.');
  } else {
    title.textContent = 'Review cancelled';
    text.textContent = total || el.overall.value.trim() ? 'The draft stays on disk; nothing was sent.' : 'Nothing was saved.';
  }
  card.append(title, text);
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.append(card);
  document.body.append(overlay);
}

// Ends the review through one of the two terminal routes; the server exits after answering.
async function end(route, status) {
  el.send.disabled = true;
  el.cancel.disabled = true;
  try {
    await api('POST', route, payload());
    finish(status);
  } catch (err) {
    el.send.disabled = false;
    el.cancel.disabled = false;
    el.saveState.textContent = `${status === 'submitted' ? 'send' : 'cancel'} failed: ${err.message}`;
  }
}

el.send.addEventListener('click', () => end('/api/submit', 'submitted'));
el.cancel.addEventListener('click', () => {
  if (window.confirm('Cancel this review? The server stops; a non-empty draft stays on disk.')) {
    end('/api/cancel', 'cancelled');
  }
});

el.filter.addEventListener('input', () => setFilter(el.filter.value));

el.addScope.addEventListener('click', () => openComposer({ kind: 'scope' }));
el.overall.addEventListener('input', scheduleSave);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && el.composer.classList.contains('hidden') && state.selection) {
    state.selection = null;
    applySelection();
  }
});

load().catch((err) => {
  el.code.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: `Could not load: ${err.message}` }));
});
