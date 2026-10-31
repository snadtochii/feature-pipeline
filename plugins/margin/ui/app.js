// margin viewer. One page, no build step. Renders the tree, the code pane, the composer and the
// notes with their replies, and switches between the surfaces the run serves — Overview, Diagram
// and Code; ./rounds.js holds the session and talks to ../server/lib/server.mjs for it,
// ./overview-view.js renders the Overview tab, ./diagram-view.js the Diagram tab, and this file
// reads files through GET /api/file. A diagram session is standalone: it keeps no notes, so every
// notes control leaves the page, and the Diagram tab saves the human's edits to the diagram file.

import { highlightLines } from './syntax.js';
import { createRounds, isSent } from './rounds.js';
import { noteCounts } from './overview.js';
import { createOverviewView } from './overview-view.js';
import { createDiagramView } from './diagram-view.js';

const $ = (selector) => document.querySelector(selector);

// A scope with more files than this opens with every folder below the scope collapsed.
const COLLAPSE_THRESHOLD = 200;

const state = {
  current: null, // { path, lines } or { path, lines: null } for a binary file
  selection: null, // { start, end } line numbers in the current file
  editing: null, // annotation id while the composer edits instead of adds
  collapsed: new Set(), // folder paths shown closed; not consulted while the filter is on
  filter: '', // lower-cased tree filter text, '' when off
  // The open composer's { dirty, commit } while a note is being written, null otherwise.
  composer: null,
  // The rendered code view, null when no text file is shown. It records what the line nodes
  // currently show, so note and selection changes patch only the lines whose state differs:
  // { nodes: index n-1 → the .line node for line n, marks: line numbers painted .marked,
  //   selection: { start, end } painted .selected or null, btn: the "Annotate L…" button }
  view: null,
  // The path the human last opened, and a counter bumped by every file fetch so that an answer
  // arriving after a newer fetch began is dropped.
  openPath: null,
  fileSeq: 0,
  // A message from the last action, { text, error }, or null.
  notice: null,
  // The center pane shown: the name of one of the registered surfaces, 'code' until load()
  // registers them.
  surface: 'code',
};

const el = {
  status: $('#status'),
  layout: $('.layout'),
  treeRows: $('#tree-rows'),
  filter: $('#filter'),
  tabs: $('#tabs'),
  tabOverview: $('#tab-overview'),
  tabDiagram: $('#tab-diagram'),
  tabCode: $('#tab-code'),
  toggleFiles: $('#toggle-files'),
  toggleNotes: $('#toggle-notes'),
  diagram: $('#diagram'),
  overview: $('#overview'),
  overviewNotice: $('#overview-notice'),
  overviewBody: $('#overview-body'),
  code: $('#code'),
  list: $('#list'),
  notesNotice: $('#notes-notice'),
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

// The session, the write queue, the change poll and the Send, Finish and Cancel lifecycle; it
// shows everything through these callbacks.
const rounds = createRounds({
  api,
  view: {
    overall: () => el.overall.value,
    composer: () => state.composer,
    editing: () => state.editing,
    closeComposer,
    confirm: (text) => window.confirm(text),
    saveState: (text) => {
      el.saveState.textContent = text;
    },
    notify,
    clearNotice: () => {
      state.notice = null;
    },
    dropped: notifyDropped,
    renderStatus,
    renderControls,
    refreshed: async () => {
      renderTree();
      overviewView.render();
      renderStatus();
      await refreshOpenFile();
      renderList();
    },
    showEnd,
  },
});

const overviewView = createOverviewView({
  nodes: { pane: el.overview, notice: el.overviewNotice, body: el.overviewBody },
  listed: rounds.listed,
  notes: () => rounds.session.annotations,
  ended: () => rounds.ended,
  openCode: (path, line) => {
    showSurface('code');
    expandTo(path);
    openFile(path, line);
  },
  annotate: (anchor) => openComposer(anchor),
});

const diagramView = createDiagramView({
  nodes: { pane: el.diagram },
  listed: (path) => rounds.listed({ kind: 'file', path }),
  openCode: (path) => {
    showSurface('code');
    expandTo(path);
    openFile(path);
  },
  ended: () => rounds.ended,
  saveState: (text) => {
    el.saveState.textContent = text;
  },
});

// The center panes the run serves, in tab order — Overview, Diagram, Code — each
// { name, tab, pane, view }. load() fills it once; Code is always one of them.
const surfaces = [];

const byName = (a, b) => a.name.localeCompare(b.name);
const annotations = () => rounds.session.annotations;

function anchorLabel(anchor) {
  switch (anchor.kind) {
    case 'range':
      return anchor.start === anchor.end ? `${anchor.path}:${anchor.start}` : `${anchor.path}:${anchor.start}-${anchor.end}`;
    case 'file':
      return anchor.path;
    case 'folder':
      return `${anchor.path}/`;
    case 'candidate':
      return `candidate ${anchor.name}`;
    case 'scope':
      return 'whole scope';
    default:
      return anchor.kind;
  }
}

// ---- loading -------------------------------------------------------------

async function load() {
  const [session, overview, diagram] = await Promise.all([rounds.load(), loadOptional('/api/overview'), loadOptional('/api/diagram')]);
  if (overview === null) {
    rounds.setCandidates([]);
  } else {
    rounds.setCandidates(overview.doc ? overview.doc.candidates.map((candidate) => candidate.name) : null);
  }
  overviewView.setOverview(overview);
  if (rounds.standalone && diagram?.doc) {
    diagramView.setEditable((edited) => api('PUT', '/api/diagram', { document: edited }));
  }
  diagramView.setDiagram(diagram);
  if (rounds.standalone) {
    enterStandalone(diagram);
  } else {
    el.scope.textContent = `${session.root} · ${session.scope.join(', ') || '.'}`;
    el.overall.value = session.overall || '';
  }
  applyDefaultCollapse();
  renderTree();
  renderList();
  renderStatus();
  registerSurfaces(overview, diagram);
  rounds.watchChanges();
}

// A route the run may not serve: null on its 404, { doc } once read, { error } when the read failed.
async function loadOptional(url) {
  try {
    return { doc: await api('GET', url) };
  } catch (err) {
    return err.status === 404 ? null : { error: err.message };
  }
}

// A diagram session keeps no notes, so Send, Cancel and the notes panel leave the page.
function enterStandalone(diagram) {
  document.body.classList.add('standalone');
  for (const control of [el.send, el.cancel, el.toggleNotes]) {
    control.classList.add('hidden');
  }
  setPanel('hide-notes', el.toggleNotes, false);
  el.finish.title = 'End the diagram session';
  el.scope.textContent = diagram?.doc ? `${diagram.doc.root} · ${diagram.doc.file}` : '';
  showEmpty('Pick a file to read it.');
}

// ---- center tabs and side panels ----------------------------------------

// The tab strip shows once the run serves more than the Code pane, opening on the first other one.
function registerSurfaces(overview, diagram) {
  if (overview) {
    surfaces.push({ name: 'overview', tab: el.tabOverview, pane: el.overview, view: overviewView });
  }
  if (diagram) {
    surfaces.push({ name: 'diagram', tab: el.tabDiagram, pane: el.diagram, view: diagramView });
  }
  surfaces.push({ name: 'code', tab: el.tabCode, pane: el.code, view: null });
  for (const surface of surfaces) {
    surface.tab.classList.remove('hidden');
  }
  if (surfaces.length > 1) {
    el.tabs.classList.remove('hidden');
    showSurface(surfaces[0].name);
  }
}

function showSurface(name) {
  if (state.surface === name || !surfaces.some((surface) => surface.name === name)) {
    return;
  }
  state.surface = name;
  for (const surface of surfaces) {
    const shown = surface.name === name;
    surface.pane.classList.toggle('off', !shown);
    surface.tab.classList.toggle('on', shown);
    surface.tab.setAttribute('aria-selected', String(shown));
    surface.view?.show(shown);
  }
}

function setPanel(className, button, shown) {
  el.layout.classList.toggle(className, !shown);
  button.setAttribute('aria-pressed', String(shown));
}

const togglePanel = (className, button) => setPanel(className, button, el.layout.classList.contains(className));

function showPanel(name) {
  if (surfaces.length < 2) {
    return;
  }
  if (name === 'notes') {
    setPanel('hide-notes', el.toggleNotes, true);
  } else {
    setPanel('hide-tree', el.toggleFiles, true);
  }
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
  if (rounds.files.length <= COLLAPSE_THRESHOLD) {
    return;
  }
  for (const path of rounds.files) {
    for (const dir of ancestors(path)) {
      state.collapsed.add(dir);
    }
  }
  for (const entry of rounds.session.scope) {
    expandTo(entry, { self: true });
  }
  for (const a of annotations()) {
    if (a.anchor.path) {
      expandTo(a.anchor.path);
    }
  }
}

const matchesFilter = (path) => path.toLowerCase().includes(state.filter);

// While the filter is on, the tree holds only the matching files and the folders above
// them, all shown open without consulting `state.collapsed`, so clearing the filter brings
// back the expansion as it was plus the folders of any file opened while filtering.
function renderTree() {
  const filtering = state.filter !== '';
  const paths = filtering ? rounds.files.filter(matchesFilter) : rounds.files;
  if (filtering && paths.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = 'No files match';
    el.treeRows.replaceChildren(empty);
    return;
  }
  const view = { counts: noteCounts(annotations()), filtering };
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
      showSurface('code');
      openFile(node.path);
    } else if (!view.filtering) {
      toggleDir(node.path);
    }
  });

  row.append(name);
  if (rounds.standalone) {
    return row;
  }
  const count = view.counts.get(`${kind}:${node.path}`) ?? 0;
  const btn = document.createElement('button');
  btn.className = `note-btn${count ? ' has' : ''}`;
  btn.title = `Annotate this ${kind}`;
  btn.textContent = count ? String(count) : '+';
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    openComposer({ kind, path: node.path });
  });
  row.append(btn);
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

function emptyLine(text) {
  const note = document.createElement('div');
  note.className = 'empty';
  note.textContent = text;
  return note;
}

function showEmpty(text) {
  el.code.replaceChildren(emptyLine(text));
}

// Says why a file cannot be shown and drops its cached text, so nothing stale stays on screen.
function showFileError(path, err) {
  if (err.status === 404 && /no longer exists/.test(err.message)) {
    showEmpty(rounds.standalone ? `${path} no longer exists.` : `${path} no longer exists. Its notes are kept.`);
  } else if (err.status === 404) {
    showEmpty(rounds.standalone ? `${path} is not a file this diagram can open.` : `${path} is not in this review's listing. Its notes are kept.`);
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
  showEmpty(rounds.standalone ? `${path}: ${reason}.` : `${path}: ${reason}. Annotate it as a file from the tree.`);
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

// Answers false when a newer file fetch superseded this one, so its result was not shown.
async function openFile(path, scrollTo) {
  state.openPath = path;
  const { fresh, data, err } = await fetchFile(path);
  if (!fresh) {
    return false;
  }
  if (err) {
    // A resumed note can point at a file that moved, was deleted or left the listing.
    showFileError(path, err);
    renderTree();
    renderList();
    return true;
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
  return true;
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
  if (!rounds.standalone) {
    box.addEventListener('click', (event) => {
      const gutter = event.target.closest('.gutter');
      if (gutter) {
        selectLine(Number(gutter.parentElement.dataset.n), event.shiftKey);
      }
    });
  }
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
  if (rounds.standalone) {
    return;
  }
  showPanel('notes');
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
  body.placeholder =
    anchor.kind === 'scope'
      ? 'Something about the scope as a whole.'
      : anchor.kind === 'candidate'
        ? 'Accept, reject or reshape this candidate — and why.'
        : 'What should change here, or what do you want to know?';
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
      rounds.updateNote(state.editing, { intent: chosen, body: text });
    } else if (rounds.listed(anchor)) {
      rounds.addNote({ id: crypto.randomUUID(), anchor, intent: chosen, body: text, createdAt: new Date().toISOString() });
    } else {
      // A refresh dropped the anchor from the listing while the composer was open, and the server
      // would drop the note; the composer stays open so the text is not lost.
      notify(`Cannot add the note: ${anchorLabel(anchor)} left this review's listing.`, { error: true });
      return;
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
  body.addEventListener('input', updateSend);
  intents.addEventListener('change', updateSend);
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
  updateSend();
}

function afterChange() {
  rounds.scheduleSave();
  renderList();
  renderTree();
  overviewView.render();
  // Patch the open file in place; commit clears the selection, so repaint it too.
  if (state.view) {
    refreshMarks();
    applySelection();
  }
}

// ---- notes list ----------------------------------------------------------

const KIND_ORDER = { scope: 0, candidate: 1, folder: 2, file: 3, range: 4 };
const SORT_GROUP = { scope: 0, candidate: 1 };
const PATH_GROUP = 2;
const sortGroup = (anchor) => SORT_GROUP[anchor.kind] ?? PATH_GROUP;

function sortedAnnotations() {
  return [...annotations()].sort((a, b) => {
    const groupDiff = sortGroup(a.anchor) - sortGroup(b.anchor);
    if (groupDiff !== 0) {
      return groupDiff;
    }
    const nameDiff = (a.anchor.name ?? a.anchor.path ?? '').localeCompare(b.anchor.name ?? b.anchor.path ?? '');
    if (nameDiff !== 0) {
      return nameDiff;
    }
    const kindDiff = KIND_ORDER[a.anchor.kind] - KIND_ORDER[b.anchor.kind];
    return kindDiff !== 0 ? kindDiff : (a.anchor.start ?? 0) - (b.anchor.start ?? 0);
  });
}

const SEND_TITLE = el.send.title;

// Send is offered when the server's rule holds or when the open composer holds a note Send would
// add first (rounds.sendRound commits it before checking the rule), and never while Send is held.
function updateSend() {
  const count = rounds.sendable().length;
  const held = rounds.sendHeld();
  el.send.textContent = count ? `Send ${count}` : 'Send';
  el.send.title = held ? 'The overview could not be loaded: reload the page to send' : SEND_TITLE;
  el.send.disabled = rounds.busy || rounds.ended || held || !(rounds.canSend() || Boolean(state.composer?.dirty()));
}

// Finish and Cancel are disabled while a lifecycle request is in flight and once the run is over.
function renderControls() {
  el.finish.disabled = rounds.busy || rounds.ended;
  el.cancel.disabled = rounds.busy || rounds.ended;
  updateSend();
}

function renderList() {
  const all = sortedAnnotations();
  const noun = `${all.length} ${all.length === 1 ? 'note' : 'notes'}`;
  el.count.textContent = rounds.session.round ? `${noun} · ${all.filter(isSent).length} sent` : noun;
  updateSend();
  el.list.replaceChildren(...all.map(noteItem));
  renderNotesNotice();
  renderOverallReplies();
}

function readOnlyNotice() {
  const { overview } = overviewView;
  if (overview === null) {
    return 'The overview is missing: candidate notes are read-only.';
  }
  if (overview.error) {
    return rounds.sendHeld()
      ? 'The overview could not be loaded: candidate notes are read-only, and Send waits for a reload.'
      : 'The overview could not be loaded: candidate notes are read-only.';
  }
  return 'Some candidate notes name no candidate of this overview and are read-only.';
}

function renderNotesNotice() {
  const shown = annotations().some((a) => a.anchor.kind === 'candidate' && !rounds.listed(a.anchor));
  const text = shown ? readOnlyNotice() : '';
  el.notesNotice.textContent = text;
  el.notesNotice.title = text;
  el.notesNotice.classList.toggle('hidden', !shown);
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
  el.overallReplies.replaceChildren(...replyItems(rounds.session.overallReplies ?? []));
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
  if (sent) {
    item.append(lockedOps(a));
  } else {
    item.append(rounds.withheld(a) ? withheldOps() : editOps(a));
  }
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
    rounds.deleteNote(a.id);
    // A composer editing this note has nothing left to update.
    if (state.editing === a.id) {
      closeComposer();
    }
    afterChange();
  });
  ops.append(edit, del);
  return ops;
}

function withheldOps() {
  const ops = document.createElement('div');
  ops.className = 'ops';
  const label = document.createElement('span');
  label.className = 'muted';
  label.textContent = 'read-only';
  label.title = "This candidate is not in this run's overview: the note cannot be edited, deleted or sent";
  ops.append(label);
  return ops;
}

// A sent note is read-only; its one action starts a follow-up note on the same anchor, offered
// while the anchor still passes the anchor rule against the current listing.
function lockedOps(a) {
  const ops = document.createElement('div');
  ops.className = 'ops';
  const reply = document.createElement('button');
  reply.textContent = 'reply';
  if (rounds.listed(a.anchor)) {
    reply.title = 'Write a follow-up note on the same anchor';
    reply.addEventListener('click', () => replyTo(a));
  } else {
    reply.disabled = true;
    reply.title =
      a.anchor.kind === 'candidate'
        ? `${anchorLabel(a.anchor)} is not a candidate of this run's overview`
        : `${a.anchor.path} is no longer in this review's listing`;
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
  if (anchor.kind === 'candidate') {
    showSurface('overview');
    overviewView.revealCandidate(anchor.name);
    openComposer({ kind: 'candidate', name: anchor.name }, options);
    return;
  }
  if (anchor.kind === 'folder') {
    expandTo(anchor.path, { self: true });
    renderTree();
    showPanel('tree');
    openComposer({ kind: 'folder', path: anchor.path }, options);
    return;
  }
  const label = anchorLabel(anchor);
  showSurface('code');
  expandTo(anchor.path);
  let shown = await openFile(anchor.path, anchor.start);
  // A refresh re-opening the same file supersedes this fetch; fetch it once more.
  if (!shown && state.openPath === anchor.path) {
    shown = await openFile(anchor.path, anchor.start);
  }
  // The human opened another file meanwhile: the reply is abandoned without a message.
  if (state.openPath !== anchor.path) {
    return;
  }
  if (!shown || state.current?.path !== anchor.path) {
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
    showPanel('tree');
  }
  if (anchor.kind === 'range' || anchor.kind === 'file') {
    showSurface('code');
    expandTo(anchor.path);
    openFile(anchor.path, anchor.start);
  } else if (anchor.kind === 'folder') {
    expandTo(anchor.path, { self: true });
    renderTree();
    showPanel('tree');
  } else if (anchor.kind === 'candidate') {
    if (rounds.listed(anchor)) {
      showSurface('overview');
      overviewView.revealCandidate(anchor.name);
    }
  } else {
    el.overall.focus();
  }
}

// ---- status --------------------------------------------------------------

// Waiting: a round has been sent and the agent has posted no reply for it yet.
function waiting() {
  const round = rounds.session.round ?? 0;
  const forRound = (reply) => reply.round === round;
  return (
    round > 0 &&
    !annotations().some((a) => a.replies?.some(forRound)) &&
    !(rounds.session.overallReplies ?? []).some(forRound)
  );
}

// The strip shows one message, in this order: a lost connection, the last action's message,
// then the round state.
function renderStatus() {
  const round = rounds.session.round ?? 0;
  let text;
  let kind = '';
  if (rounds.connection) {
    text = rounds.connection;
    kind = 'error';
  } else if (state.notice) {
    text = state.notice.text;
    kind = state.notice.error ? 'error' : '';
  } else if (rounds.standalone) {
    text = 'Edits save to the diagram file as you make them; no notes are taken in this session.';
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

// Says which unsent notes were removed because their anchor left the listing.
function notifyDropped(dropped) {
  const labels = dropped.map((a) => anchorLabel(a.anchor)).join(', ');
  const lead = dropped.length === 1 ? 'An unsent note was' : `${dropped.length} unsent notes were`;
  notify(`${lead} removed: ${labels} left this review's listing.`, { error: true });
}

// Disables every control and raises the end-of-run overlay; rounds.js calls it once per run.
function showEnd(status) {
  for (const control of document.querySelectorAll('button, textarea, input, select')) {
    control.disabled = true;
  }
  const count = rounds.session.round ?? 0;
  const sent = `${count} ${count === 1 ? 'round' : 'rounds'} sent.`;
  const card = document.createElement('div');
  card.className = 'card';
  const title = document.createElement('h2');
  const text = document.createElement('p');
  if (rounds.standalone) {
    const interrupted = status === 'interrupted';
    title.textContent = interrupted ? 'Diagram session interrupted' : 'Diagram session finished';
    text.textContent = interrupted ? 'The server stopped. You can close this tab.' : 'You can close this tab.';
  } else if (status === 'finished') {
    title.textContent = 'Review finished';
    text.append(`${sent} `);
    if (rounds.session.out) {
      const code = document.createElement('code');
      code.textContent = rounds.session.out;
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

// A diagram session ends once the last diagram edit has reached the server, or once the human
// accepts that it did not.
async function finish() {
  if (rounds.standalone) {
    const saved = await diagramView.flush();
    if (saved?.phase === 'failed' && !window.confirm('The last diagram edit was not saved. Finish anyway?')) {
      return;
    }
  }
  await rounds.finishRun();
}

el.send.addEventListener('click', rounds.sendRound);
el.finish.addEventListener('click', finish);
el.cancel.addEventListener('click', rounds.cancelRun);

el.filter.addEventListener('input', () => setFilter(el.filter.value));

el.tabOverview.addEventListener('click', () => showSurface('overview'));
el.tabDiagram.addEventListener('click', () => showSurface('diagram'));
el.tabCode.addEventListener('click', () => showSurface('code'));
el.toggleFiles.addEventListener('click', () => togglePanel('hide-tree', el.toggleFiles));
el.toggleNotes.addEventListener('click', () => togglePanel('hide-notes', el.toggleNotes));

el.addScope.addEventListener('click', () => openComposer({ kind: 'scope' }));
el.overall.addEventListener('input', () => {
  rounds.scheduleSave();
  updateSend();
});
// An Escape the Overview tab took to close its detail card arrives defaultPrevented.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) {
    return;
  }
  if (el.composer.classList.contains('hidden') && state.selection) {
    state.selection = null;
    applySelection();
  }
});

load().catch((err) => {
  showEmpty(`Could not load: ${err.message}`);
});
