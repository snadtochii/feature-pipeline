// margin viewer. One page, no build step. Talks to ../server/lib/server.mjs over its session,
// file, changes, submit, finish and cancel routes, keeps the notes file current through
// PUT /api/session, and refreshes in place whenever GET /api/changes reports a change.

import { highlightLines } from './syntax.js';

const $ = (selector) => document.querySelector(selector);

// A scope with more files than this opens with every folder below the scope collapsed.
const COLLAPSE_THRESHOLD = 200;

const state = {
  // The notes file as the viewer holds it: { root, scope, out, overall, round, rounds,
  // overallReplies, annotations }. The server owns the sent notes and the round fields; the
  // viewer owns the unsent notes and the overall text (mergeSession).
  session: null,
  files: [], // repo-relative paths in scope, sorted
  fileSet: new Set(), // state.files as a set, rebuilt with it
  current: null, // { path, lines } or { path, lines: null } for a binary file
  selection: null, // { start, end } line numbers in the current file
  editing: null, // annotation id while the composer edits instead of adds
  collapsed: new Set(), // folder paths shown closed; not consulted while the filter is on
  filter: '', // lower-cased tree filter text, '' when off
  saveTimer: null,
  // The last write sent to the server. Writes run one after another, so an older snapshot can
  // never land after a newer one; each sends the session as it stands when its turn comes.
  writes: Promise.resolve(),
  // The open composer's { dirty, commit } while a note is being written, null otherwise.
  composer: null,
  // The rendered code view, null when no text file is shown. It records what the line nodes
  // currently show, so note and selection changes patch only the lines whose state differs:
  // { nodes: index n-1 → the .line node for line n, marks: line numbers painted .marked,
  //   selection: { start, end } painted .selected or null, btn: the "Annotate L…" button }
  view: null,
  // The last change count seen from GET /api/session or GET /api/changes.
  changes: 0,
  // The path the human last opened, and a counter bumped by every file fetch so that an answer
  // arriving after a newer fetch began is dropped.
  openPath: null,
  fileSeq: 0,
  // The change poll's connection problem, '' while the server answers.
  connection: '',
  // A message from the last action, { text, error }, or null.
  notice: null,
  // A Send, Finish or Cancel request is in flight; Send, Finish and Cancel are disabled.
  busy: false,
  // The server has begun ending the run: autosave stops until the end overlay comes up.
  ending: false,
  ended: false, // true once the end-of-run overlay is up
};

const el = {
  status: $('#status'),
  treeRows: $('#tree-rows'),
  filter: $('#filter'),
  code: $('#code'),
  list: $('#list'),
  overall: $('#overall'),
  overallReplies: $('#overall-replies'),
  composer: $('#composer'),
  send: $('#send'),
  finish: $('#finish'),
  cancel: $('#cancel'),
  addScope: $('#add-scope'),
  scope: $('#scope'),
  saveState: $('#save-state'),
  count: $('#count'),
};

// The per-run token rides in the URL fragment the server printed; every API call carries it.
const TOKEN = window.location.hash.slice(1);

// A failed call throws an Error carrying `status` — the HTTP status, or 0 when the server could
// not be reached — with the server's own `error` text as its message when the reply has one.
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'x-margin-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    throw Object.assign(new Error(`${method} ${url} failed: ${cause.message}`), { status: 0 });
  }
  if (!res.ok) {
    let message = `${method} ${url} failed with ${res.status}`;
    try {
      const data = await res.json();
      if (typeof data?.error === 'string') {
        message = data.error;
      }
    } catch {
      // Not a JSON reply; the generic message stands.
    }
    throw Object.assign(new Error(message), { status: res.status });
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

// A note is sent once the server has stamped it with the round it went out in.
const isSent = (a) => typeof a.round === 'number';

function setFiles(files) {
  state.files = files;
  state.fileSet = new Set(files);
}

// The contract's anchor rule (CONTRACT.md §7) against the current listing: whether the server
// would accept a new note on this anchor now.
function anchorListed(anchor) {
  switch (anchor.kind) {
    case 'scope':
      return true;
    case 'folder':
      return anchor.path !== '' && anchor.path !== '.' && state.files.some((path) => path.startsWith(`${anchor.path}/`));
    default:
      return state.fileSet.has(anchor.path);
  }
}

async function load() {
  const data = await api('GET', '/api/session');
  state.session = data.session;
  setFiles(data.files);
  state.changes = data.changes;
  el.scope.textContent = `${data.session.root} · ${data.session.scope.join(', ') || '.'}`;
  el.overall.value = data.session.overall || '';
  applyDefaultCollapse();
  renderTree();
  renderList();
  renderStatus();
  watchChanges();
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

// Splits file text into lines. A `\r` ending a line of CRLF text stays on it.
function splitLines(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

function showEmpty(text) {
  const note = document.createElement('div');
  note.className = 'empty';
  note.textContent = text;
  el.code.replaceChildren(note);
}

// Says why a file cannot be shown and drops its cached text, so nothing stale stays on screen.
function showFileError(path, err) {
  if (err.status === 404 && /no longer exists/.test(err.message)) {
    showEmpty(`${path} no longer exists. Its notes are kept.`);
  } else if (err.status === 404) {
    showEmpty(`${path} is not in this review's listing. Its notes are kept.`);
  } else {
    showEmpty(`Could not read ${path}: ${err.message}`);
  }
  state.current = null;
  state.selection = null;
  state.view = null;
}

function showBinary(path, reason) {
  state.current = { path, lines: null };
  state.selection = null;
  state.view = null;
  showEmpty(`${path}: ${reason}. Annotate it as a file from the tree.`);
}

// Reads a file. `fresh` is false when a newer file fetch began before this one answered.
async function fetchFile(path) {
  state.fileSeq += 1;
  const seq = state.fileSeq;
  try {
    const data = await api('GET', `/api/file?path=${encodeURIComponent(path)}`);
    return { fresh: seq === state.fileSeq, data };
  } catch (err) {
    return { fresh: seq === state.fileSeq, err };
  }
}

async function openFile(path, scrollTo) {
  state.openPath = path;
  const { fresh, data, err } = await fetchFile(path);
  if (!fresh) {
    return;
  }
  if (err) {
    // A resumed note can point at a file that moved, was deleted or left the listing.
    showFileError(path, err);
    renderTree();
    renderList();
    return;
  }
  if (data.binary) {
    showBinary(path, data.reason);
  } else {
    state.selection = null;
    state.current = { path, lines: splitLines(data.text) };
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
  // The notes list marks drift against the open file's text.
  renderList();
}

// Re-reads the open file after a round: unchanged text only repaints marks and selection,
// changed text re-renders this one file at the same scroll position, and a failure drops the
// cached text, so text from before the round is never shown as current.
async function refreshOpenFile() {
  const path = state.openPath;
  if (path === null) {
    return;
  }
  if (state.current?.path !== path) {
    await openFile(path);
    return;
  }
  const { fresh, data, err } = await fetchFile(path);
  if (!fresh) {
    return;
  }
  if (err) {
    showFileError(path, err);
    renderTree();
    return;
  }
  if (data.binary) {
    showBinary(path, data.reason);
    return;
  }
  const lines = splitLines(data.text);
  const shown = state.current.lines;
  if (shown && shown.length === lines.length && shown.every((text, i) => text === lines[i])) {
    if (state.view) {
      refreshMarks();
      applySelection();
    }
    return;
  }
  const { scrollTop } = el.code;
  state.current = { path, lines };
  if (state.selection && state.selection.end > lines.length) {
    state.selection = null;
  }
  renderCode();
  el.code.scrollTop = scrollTop;
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
      if (token.className === null) {
        src.append(token.text);
      } else {
        const piece = document.createElement('span');
        piece.className = token.className;
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
      const excerpt = excerptOf(state.current.lines, sel.start, sel.end);
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

// `existing` is the unsent note being edited; `intent` presets the intent of a new note.
function openComposer(anchor, { existing = null, intent = existing?.intent ?? 'change' } = {}) {
  state.editing = existing?.id ?? null;
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
      // Only an unsent note is edited; a sent note sharing its id stays as the server holds it.
      const target = annotations().find((a) => a.id === state.editing && !isSent(a));
      if (target) {
        Object.assign(target, { intent: chosen, body: text });
      }
    } else {
      annotations().push({ id: crypto.randomUUID(), anchor, intent: chosen, body: text, createdAt: new Date().toISOString() });
    }
    state.selection = null;
    closeComposer();
    afterChange();
  };

  // Text that differs from what is stored: a new note with any text, or an edit that changed
  // the body or the intent.
  const dirty = () => {
    const text = body.value.trim();
    const chosen = intents.querySelector('input:checked').value;
    return text !== '' && (text !== (existing?.body ?? '') || chosen !== intent);
  };
  state.composer = { dirty, commit };

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
  state.composer = null;
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

const unsentNotes = () => annotations().filter((a) => !isSent(a));

// Whether the overall text, trimmed, differs from the text the last round sent.
function overallChanged() {
  return el.overall.value.trim() !== (state.session.rounds?.at(-1)?.overall ?? '').trim();
}

// The server's rule for a Send: an unsent note, or an overall text the last round did not send.
const canSend = () => unsentNotes().length > 0 || overallChanged();

function updateSend() {
  const count = unsentNotes().length;
  el.send.textContent = count ? `Send ${count}` : 'Send';
  el.send.disabled = state.busy || state.ended || !canSend();
}

function renderList() {
  const all = sortedAnnotations();
  const noun = `${all.length} ${all.length === 1 ? 'note' : 'notes'}`;
  el.count.textContent = state.session.round ? `${noun} · ${all.filter(isSent).length} sent` : noun;
  updateSend();
  el.list.replaceChildren(...all.map(noteItem));
  renderOverallReplies();
}

// Replies render as text only, under the note or the overall direction they answer.
function replyItems(replies) {
  return replies.map((reply) => {
    const item = document.createElement('li');
    item.className = 'reply';
    const head = document.createElement('div');
    head.className = 'reply-head';
    head.textContent = `agent · round ${reply.round}`;
    const body = document.createElement('p');
    body.className = 'body';
    body.textContent = reply.body;
    item.append(head, body);
    return item;
  });
}

function renderOverallReplies() {
  el.overallReplies.replaceChildren(...replyItems(state.session.overallReplies ?? []));
}

// The server caps a stored excerpt at this many characters, so a capped one is a prefix.
const EXCERPT_CAP = 4000;
const stripCr = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line);

// A range note's excerpt: its lines as the file holds them, raw line endings kept, so the drift
// check below and every note created from a selection or a reply agree.
function excerptOf(lines, start, end) {
  return lines.slice(start - 1, end).join('\n');
}

// Whether a range note on the open file no longer matches the text it was written on. Line
// endings are compared without a trailing `\r`, so CRLF text matches its own excerpt.
function drifted(anchor) {
  const lines = anchor.kind === 'range' && state.current?.path === anchor.path ? state.current.lines : null;
  if (!lines) {
    return false;
  }
  if (anchor.end > lines.length) {
    return true;
  }
  const excerpt = anchor.excerpt ?? '';
  const now = lines.slice(anchor.start - 1, anchor.end).map(stripCr).join('\n');
  const was = excerpt.split('\n').map(stripCr).join('\n');
  return excerpt.length >= EXCERPT_CAP ? !now.startsWith(was) : now !== was;
}

function noteItem(a) {
  const sent = isSent(a);
  const item = document.createElement('li');
  item.className = sent ? 'note sent' : 'note';

  const head = document.createElement('div');
  head.className = 'head';
  const anchor = document.createElement('span');
  anchor.className = 'anchor';
  anchor.textContent = anchorLabel(a.anchor);
  anchor.addEventListener('click', () => revealAnchor(a.anchor));
  const tags = document.createElement('span');
  tags.className = 'tags';
  if (drifted(a.anchor)) {
    const drift = document.createElement('span');
    drift.className = 'tag drift';
    drift.textContent = 'lines changed';
    drift.title = 'These lines differ from the text the note was written on';
    tags.append(drift);
  }
  if (sent) {
    const round = document.createElement('span');
    round.className = 'badge round';
    round.textContent = `round ${a.round}`;
    tags.append(round);
  }
  const badge = document.createElement('span');
  badge.className = `badge ${a.intent}`;
  badge.textContent = a.intent;
  tags.append(badge);
  head.append(anchor, tags);

  const body = document.createElement('p');
  body.className = 'body';
  body.textContent = a.body;
  item.append(head, body);

  if (a.replies?.length) {
    const thread = document.createElement('ol');
    thread.className = 'replies';
    thread.append(...replyItems(a.replies));
    item.append(thread);
  }
  item.append(sent ? lockedOps(a) : editOps(a));
  return item;
}

function editOps(a) {
  const ops = document.createElement('div');
  ops.className = 'ops';
  const edit = document.createElement('button');
  edit.textContent = 'edit';
  edit.addEventListener('click', () => openComposer(a.anchor, { existing: a }));
  const del = document.createElement('button');
  del.className = 'del';
  del.textContent = 'delete';
  del.addEventListener('click', () => {
    // A sent note sharing this id stays, as it does on the server.
    state.session.annotations = annotations().filter((x) => !(x.id === a.id && !isSent(x)));
    // A composer editing this note has nothing left to update.
    if (state.editing === a.id) {
      closeComposer();
    }
    afterChange();
  });
  ops.append(edit, del);
  return ops;
}

// A sent note is read-only; its one action starts a follow-up note on the same anchor, offered
// while the anchor still passes the anchor rule against the current listing.
function lockedOps(a) {
  const ops = document.createElement('div');
  ops.className = 'ops';
  const reply = document.createElement('button');
  reply.textContent = 'reply';
  if (anchorListed(a.anchor)) {
    reply.title = 'Write a follow-up note on the same anchor';
    reply.addEventListener('click', () => replyTo(a));
  } else {
    reply.disabled = true;
    reply.title = `${a.anchor.path} is no longer in this review's listing`;
  }
  ops.append(reply);
  return ops;
}

// Opens the composer for a follow-up note on a sent note's anchor, preset to its intent. A range
// takes a fresh excerpt from the file as it is now, with its raw line endings.
async function replyTo(a) {
  const { anchor } = a;
  const options = { intent: a.intent };
  state.notice = null;
  renderStatus();
  if (anchor.kind === 'scope') {
    openComposer({ kind: 'scope' }, options);
    return;
  }
  if (anchor.kind === 'folder') {
    expandTo(anchor.path, { self: true });
    renderTree();
    openComposer({ kind: 'folder', path: anchor.path }, options);
    return;
  }
  const label = anchorLabel(anchor);
  expandTo(anchor.path);
  await openFile(anchor.path, anchor.start);
  if (state.current?.path !== anchor.path) {
    notify(`Cannot reply on ${label}: the file could not be opened.`, { error: true });
    return;
  }
  if (anchor.kind === 'file') {
    openComposer({ kind: 'file', path: anchor.path }, options);
    return;
  }
  const { lines } = state.current;
  if (lines === null) {
    notify(`Cannot reply on ${label}: the file is not shown as text.`, { error: true });
    return;
  }
  if (lines.length < anchor.end) {
    notify(`Cannot reply on ${label}: the file now has ${lines.length} lines.`, { error: true });
    return;
  }
  const excerpt = excerptOf(lines, anchor.start, anchor.end);
  openComposer({ kind: 'range', path: anchor.path, start: anchor.start, end: anchor.end, excerpt }, options);
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
  if (state.ending || state.ended) {
    return;
  }
  clearTimeout(state.saveTimer);
  el.saveState.textContent = 'saving…';
  state.saveTimer = setTimeout(save, 400);
}

// Queues one write behind the previous one; the payload is read when the write starts, not
// when it is queued, so a queued write always carries the newest session.
function enqueue(write) {
  const run = state.writes.then(write);
  state.writes = run.catch(() => {});
  return run;
}

// PUTs the session as it stands when the write's turn comes.
async function writeSession() {
  try {
    const res = await api('PUT', '/api/session', payload());
    el.saveState.textContent = `saved ${new Date(res.updatedAt).toLocaleTimeString()}`;
  } catch (err) {
    if (err.status === 409) {
      markEnding();
    } else {
      el.saveState.textContent = `save failed: ${err.message}`;
    }
  }
}

function save() {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  return enqueue(writeSession);
}

// ---- server changes ------------------------------------------------------

// Takes the server's copy in by ownership: the sent notes, the round fields, the overall
// replies and `out` come from the server; the unsent notes and the overall text stay as the
// viewer holds them. When the two copies disagree on what is unsent, a save levels the server.
function mergeSession(server) {
  const sent = server.annotations.filter(isSent);
  const sentIds = new Set(sent.map((a) => a.id));
  const unsent = annotations().filter((a) => !isSent(a) && !sentIds.has(a.id));
  const ids = (list) => list.map((a) => a.id).join('\n');
  const differs = ids(unsent) !== ids(server.annotations.filter((a) => !isSent(a))) || server.overall !== el.overall.value;
  state.session = { ...server, overall: el.overall.value, annotations: [...sent, ...unsent] };
  // An edit of a note that has since been sent has nothing left to update.
  if (state.editing !== null && !unsent.some((a) => a.id === state.editing)) {
    closeComposer();
  }
  if (differs) {
    scheduleSave();
  }
}

// Flushes a pending save, reads the session behind every queued write, merges it, and
// re-renders what depends on it: the tree, the status strip, the open file and the notes.
async function refresh() {
  const pending = state.saveTimer !== null;
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  await enqueue(async () => {
    if (pending) {
      await writeSession();
    }
    const data = await api('GET', '/api/session');
    mergeSession(data.session);
    setFiles(data.files);
    state.changes = Math.max(state.changes, data.changes);
  });
  // A successful refresh is the next action that clears the last action's message, so the
  // round state shows again; the run-ending message stays until the end overlay.
  if (!state.ending) {
    state.notice = null;
  }
  renderTree();
  renderStatus();
  await refreshOpenFile();
  renderList();
}

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Holds one GET /api/changes for the life of the page. A change refreshes the page and re-arms
// the wait; the end of the run raises the end overlay. Requests start at least a second apart,
// and a lost connection retries after a backoff from 1 s, doubling up to 10 s.
async function watchChanges() {
  let backoff = 1000;
  while (!state.ended) {
    const started = Date.now();
    try {
      const res = await api('GET', `/api/changes?after=${state.changes}`);
      if (res.status !== 'changed') {
        showEnd(res.status);
        return;
      }
      backoff = 1000;
      if (state.connection) {
        state.connection = '';
        renderStatus();
      }
      await refresh();
    } catch {
      state.connection = 'Lost contact with the server — retrying';
      renderStatus();
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 10000);
    }
    await sleep(Math.max(0, 1000 - (Date.now() - started)));
  }
}

// ---- status --------------------------------------------------------------

// Waiting: a round has been sent and the agent has posted no reply for it yet.
function waiting() {
  const round = state.session.round ?? 0;
  const forRound = (reply) => reply.round === round;
  return (
    round > 0 &&
    !annotations().some((a) => a.replies?.some(forRound)) &&
    !(state.session.overallReplies ?? []).some(forRound)
  );
}

// The strip shows one message, in this order: a lost connection, the last action's message,
// then the round state.
function renderStatus() {
  const round = state.session.round ?? 0;
  let text;
  let kind = '';
  if (state.connection) {
    text = state.connection;
    kind = 'error';
  } else if (state.notice) {
    text = state.notice.text;
    kind = state.notice.error ? 'error' : '';
  } else if (round === 0) {
    text = 'Notes go out when you press Send.';
  } else if (waiting()) {
    text = `Round ${round} sent — the agent is working. You can keep reading and adding notes.`;
    kind = 'waiting';
  } else {
    text = `Round ${round} answered — replies are under the notes.`;
  }
  el.status.textContent = text;
  // The strip is one line cut with an ellipsis; the full text stays readable on hover.
  el.status.title = text;
  el.status.className = kind ? `status ${kind}` : 'status';
}

function notify(text, { error = false } = {}) {
  state.notice = { text, error };
  renderStatus();
}

// Raises the end-of-run overlay once, whichever end came first: the viewer's own Finish or
// Cancel, or an end the change poll reports.
function showEnd(status) {
  if (state.ended) {
    return;
  }
  state.ended = true;
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  for (const control of document.querySelectorAll('button, textarea, input')) {
    control.disabled = true;
  }
  const rounds = state.session.round ?? 0;
  const sent = `${rounds} ${rounds === 1 ? 'round' : 'rounds'} sent.`;
  const card = document.createElement('div');
  card.className = 'card';
  const title = document.createElement('h2');
  const text = document.createElement('p');
  if (status === 'finished') {
    title.textContent = 'Review finished';
    text.append(`${sent} `);
    if (state.session.out) {
      const code = document.createElement('code');
      code.textContent = state.session.out;
      text.append('Saved to ', code, '. ');
    }
    text.append('You can close this tab.');
  } else if (status === 'cancelled') {
    title.textContent = 'Review cancelled';
    text.textContent = `${sent} Notes not sent were not handed to the agent.`;
  } else if (status === 'interrupted') {
    title.textContent = 'Review interrupted';
    text.textContent = `The server stopped. ${sent} You can close this tab.`;
  } else {
    title.textContent = 'Review ended';
    text.textContent = `${sent} You can close this tab.`;
  }
  card.append(title, text);
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.append(card);
  document.body.append(overlay);
}

// ---- rounds and the end of the run ---------------------------------------

// Disables Send, Finish and Cancel while a lifecycle request is in flight, and for good once the
// run is ending; when idle, Send follows its own rule again.
function setBusy(flag) {
  state.busy = flag || state.ending;
  el.finish.disabled = state.busy || state.ended;
  el.cancel.disabled = state.busy || state.ended;
  updateSend();
}

// The server refused a write because the run is ending: saving stops, and the change poll's end
// document raises the overlay.
function markEnding() {
  state.ending = true;
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  setBusy(true);
  notify('The review has ended.');
}

// Sends the round: a note still open in the composer is added (or its update applied) first, so
// it goes out too. The write queues behind any write in flight, so its body is the newest
// session; the refresh that follows locks the sent notes and shows the waiting state.
async function sendRound() {
  if (state.composer?.dirty()) {
    state.composer.commit();
  }
  if (!canSend()) {
    return;
  }
  state.notice = null;
  setBusy(true);
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  try {
    const res = await enqueue(() => api('POST', '/api/submit', payload()));
    el.saveState.textContent = `round ${res.round} sent ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    if (err.status === 409 && err.message === 'nothing to send') {
      notify('Nothing new to send.');
    } else if (err.status === 409) {
      markEnding();
    } else {
      notify(`Send failed: ${err.message}`, { error: true });
    }
    setBusy(false);
    return;
  }
  try {
    await refresh();
  } catch (err) {
    notify(`The round was sent, but the page could not refresh: ${err.message}`, { error: true });
  }
  setBusy(false);
}

// Finish adds a note still open in the composer, then asks before ending the run. Unsent work
// stays in the notes file without a round, and the dialog names it.
function finishRun() {
  if (state.composer?.dirty()) {
    state.composer.commit();
  }
  const count = unsentNotes().length;
  const kept = [];
  if (count) {
    kept.push(`${count} unsent ${count === 1 ? 'note' : 'notes'}`);
  }
  if (overallChanged()) {
    kept.push('the overall direction edit');
  }
  const clause = kept.length ? ` Kept in the notes file but not sent to the agent: ${kept.join(' and ')}.` : '';
  if (window.confirm(`Finish the review?${clause}`)) {
    endRun('/api/finish', 'finished');
  }
}

// Posts Finish or Cancel behind any write in flight, so its body is the newest session, and
// raises the end overlay once the server has saved the run's end.
async function endRun(route, status) {
  state.notice = null;
  setBusy(true);
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  try {
    await enqueue(() => api('POST', route, payload()));
  } catch (err) {
    if (err.status === 409) {
      markEnding();
    } else {
      notify(`${status === 'finished' ? 'Finish' : 'Cancel'} failed: ${err.message}`, { error: true });
      setBusy(false);
    }
    return;
  }
  showEnd(status);
}

el.send.addEventListener('click', sendRound);
el.finish.addEventListener('click', finishRun);
// Cancel discards a note still open in the composer, and says so before ending the run.
el.cancel.addEventListener('click', () => {
  const writing = state.composer?.dirty() ? ' The note you are writing is discarded too.' : '';
  if (window.confirm(`Cancel the review? The unsent notes are discarded: the agent never receives them, and the review ends.${writing}`)) {
    closeComposer();
    endRun('/api/cancel', 'cancelled');
  }
});

el.filter.addEventListener('input', () => setFilter(el.filter.value));

el.addScope.addEventListener('click', () => openComposer({ kind: 'scope' }));
el.overall.addEventListener('input', () => {
  scheduleSave();
  updateSend();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && el.composer.classList.contains('hidden') && state.selection) {
    state.selection = null;
    applySelection();
  }
});

load().catch((err) => {
  el.code.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: `Could not load: ${err.message}` }));
});
