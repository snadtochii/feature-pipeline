// The viewer's Diagram tab: GET /api/diagram's document drawn as SVG — group frames, boxes styled
// by kind and labelled arrows — with pan, zoom and fit, a detail card for the box or arrow
// selected, and walkthroughs stepped with J and K. In a run that keeps notes, N and the card's
// Add note open the composer on the selection, and a badge counts the notes on each element. Given a save (setEditable), it is editable:
// every finished edit is one ./diagram-edit.js call, handed whole to the save, at most one
// request in flight, and redrawn in place from that document laid out. An edit that places a
// box — a move, an added box, a re-layout — runs on the laid-out document, so the positions on
// screen become the file's; every other edit runs on the saved one, so a box the file leaves
// unpositioned stays unpositioned. Every position comes from
// ./diagram.js's model, and diagram text reaches the page through textContent only. It owns its
// nodes, the open card and the keys and clicks that drive them; leaving the tab goes through the
// callbacks createDiagramView takes.

import { KINDS, arrowGeometry, boxLabel, boxSize, diagramBounds, fitTransform, groupFrames, wheelZoomFactor, zoomView } from './diagram.js';
import { addBox, connect, createIds, createSaver, dropFrames, dropGroup, freeze, groupAt, moveBox, relabelArrow, relayout, removeArrow, removeBox, renameBox, setGroup, setKind } from './diagram-edit.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAN_THRESHOLD = 4;
const ARROW_LABEL_CHAR = 6.2;
const HANDLE_RADIUS = 6;
const BADGE_HEIGHT = 16;
// Two clicks this close in time and space are a double-click; it is timed here because a press
// that ends a drag must never count as half of one.
const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_PX = 6;
const NEW_BOX_LABEL = 'New box';
const RENAME_HEIGHT = 28;
const RENAME_BOX_MIN = 160;
const RENAME_ARROW_WIDTH = 180;

function svg(tag, attrs, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) {
    node.setAttribute(name, String(value));
  }
  parent?.append(node);
  return node;
}

function svgText(attrs, text, parent) {
  const node = svg('text', attrs, parent);
  node.textContent = text;
  return node;
}

function html(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

// Read from the path the event was dispatched along, which still holds the ancestors of a target
// that a handler removed.
const eventInside = (event, selector) => event.composedPath().some((node) => node instanceof Element && node.matches(selector));

const typing = (event) => event.target instanceof Element && (event.target.matches('input, textarea, select') || event.target.isContentEditable === true);

const focusOnButton = () => document.activeElement instanceof HTMLButtonElement;

const SESSION_ENDED = 'the run has ended';

// `nodes.pane` is the tab's pane. The callbacks:
//   listed(path)     whether the path is in the run's listing, so the Code tab can open it
//   openCode(path)   shows the file in the Code tab
//   ended()          true once the run is over: no edit is made or saved
//   saveState(text)  the header's save indicator
//   counts()         the notes per element, keyed `box:<id>` and `arrow:<id>`, drawn as badges
// F fits, J and K step the walkthrough, and N notes the selection once setAnnotate has been given
// a composer, only while the tab is shown, with no Ctrl, ⌘ or Alt, and never while typing. While
// editable, Delete or Backspace deletes the selection and L re-lays out, under the same rules and
// never with a button focused or a press on the canvas in progress. Escape while a card is open
// closes it and marks the event handled (defaultPrevented).
export function createDiagramView({ nodes, listed, openCode, ended = () => false, saveState = () => {}, counts = () => new Map() }) {
  const { pane } = nodes;
  // Opens the composer on a { kind: 'box' | 'arrow', id, label } anchor; null in a run that keeps
  // no notes, which then offers no way to add one.
  let annotate = null;
  const state = {
    // The run's diagram: null without one, { doc: { file, root, document } } once read, { error }.
    result: null,
    send: null, // the save setEditable was given: document → promise, or null
    editable: false, // edits are made and saved: a save was given, and no 409 has turned them off
    stored: null, // the document as saved: the served one, then each edit's result
    doc: null, // the document drawn: `stored` with every box positioned, or a gesture's preview of it
    saver: null, // the save ordering of ./diagram-edit.js while editable
    ids: null, // the session's id allocator, seeded from the served document
    bar: null, // the save bar's message: { text, retry }, or null
    // The rename field open: { type, id, input }, plus for a box being added { base, spec }: the
    // document before it and the addBox arguments; null when closed.
    rename: null,
    lastClick: null, // the click that may start a double-click: { time, x, y, target }
    shown: false, // the tab is the center pane on screen
    dirty: true, // the tab needs rendering the next time it is shown
    view: { x: 0, y: 0, k: 1 }, // screen = world × k + (x, y)
    // The drawn diagram: { world, layers: { frames, arrows, boxes }, card, caption, relayout, bar,
    // arrows: id → { node, from, to }, boxes: id → node }, or null while a notice stands in for it.
    drawing: null,
    selected: null, // the box or arrow whose card is open, { type: 'box' | 'arrow', id }, or null
    walkthrough: 0,
    position: 0, // 0 shows every arrow; n shows step n
    // The press in progress: { id, x, y, view, box, arrow, mode }, `mode` null until it is a
    // 'pan', a 'move' (with { base, start, origin, frames }) or a 'connect' (with { line }).
    pointer: null,
    touches: new Map(), // the fingers on the canvas: pointer id → { x, y } in client coordinates
    pinch: null, // the two-finger pinch in progress: { rect, view, mid, dist } at its start
    justPanned: false, // the click that ends a drag or a pinch is not a click on the canvas
  };

  function notice(text) {
    state.drawing = null;
    state.selected = null;
    pane.replaceChildren(html('div', 'empty', text));
  }

  function render() {
    if (!state.result || !state.shown) {
      state.dirty = true;
      return;
    }
    state.dirty = false;
    if (state.result.error) {
      notice(`Could not load the diagram: ${state.result.error}`);
      return;
    }
    if (state.doc.boxes.length === 0 && state.saver === null) {
      notice('This diagram has no boxes yet.');
      return;
    }
    draw();
    fit();
  }

  // ---- editing --------------------------------------------------------------

  const canEdit = () => state.editable && !ended();

  // The document saved, and the one drawn from it.
  function setStored(stored) {
    state.stored = stored;
    state.doc = freeze(stored);
  }

  // One finished edit: drawn at once and saved; an edit that changed nothing is not saved.
  function commit(next) {
    if (!canEdit() || next === state.stored || next === state.doc) {
      return;
    }
    setStored(next);
    paint();
    state.saver.save(next);
  }

  function deleteSelected() {
    const { type, id } = state.selected;
    commit(type === 'box' ? removeBox(state.stored, id) : removeArrow(state.stored, id));
  }

  function relayoutAll() {
    if (!canEdit()) {
      return;
    }
    commit(relayout(state.doc));
    fit();
  }

  // A 400 puts the last saved document back; a 409 turns editing off; any other failure keeps
  // the edit on screen and offers Retry.
  function saveChanged(saved) {
    if (saved.phase === 'saving') {
      saveState('saving…');
      showBar(null);
      return;
    }
    if (saved.phase === 'idle') {
      saveState(`saved ${new Date().toLocaleTimeString()}`);
      showBar(null);
      return;
    }
    saveState(`save failed: ${saved.error}`);
    if (saved.status < 400 || saved.status >= 500) {
      showBar({ text: `Not saved: ${saved.error}`, retry: true });
      return;
    }
    abandonGestures();
    setStored(saved.saved);
    if (saved.status === 409) {
      state.editable = false;
      showBar({ text: saved.error === SESSION_ENDED ? 'The session has ended.' : 'The diagram file changed on disk, so edits are off. Restart the session to edit it.' });
    } else {
      showBar({ text: `Not saved: ${saved.error}. The last saved diagram is back.` });
    }
    if (state.drawing) {
      state.drawing.relayout.disabled = !state.editable;
      paint();
    }
  }

  function showBar(bar) {
    state.bar = bar;
    const node = state.drawing?.bar;
    if (!node) {
      return;
    }
    node.classList.toggle('error', bar !== null);
    node.replaceChildren();
    if (bar === null) {
      return;
    }
    const text = html('span', 'd-save-text', bar.text);
    text.title = bar.text;
    node.append(text);
    if (bar.retry) {
      const retry = html('button', 'small', 'Retry');
      retry.addEventListener('click', () => state.saver.retry());
      node.append(retry);
    }
  }

  // ---- drawing --------------------------------------------------------------

  function drawFrames(laid, layer) {
    const labels = new Map(laid.groups.map((group) => [group.id, group.label]));
    for (const frame of groupFrames(laid)) {
      const node = svg('g', { class: 'd-frame' }, layer);
      svg('rect', { x: frame.x, y: frame.y, width: frame.w, height: frame.h, rx: 10 }, node);
      svgText({ class: 'd-frame-label', x: frame.x + 10, y: frame.y + 16 }, labels.get(frame.id), node);
    }
  }

  // A count of the notes on a box or an arrow, centred on (x, y); nothing for none.
  function drawBadge(parent, x, y, count) {
    if (!count) {
      return;
    }
    const text = count > 99 ? '99+' : String(count);
    const node = svg('g', { class: 'd-badge', transform: `translate(${x} ${y})` }, parent);
    svg('rect', { x: -(BADGE_HEIGHT / 2 + (text.length - 1) * 3.5), y: -BADGE_HEIGHT / 2, width: BADGE_HEIGHT + (text.length - 1) * 7, height: BADGE_HEIGHT, rx: BADGE_HEIGHT / 2 }, node);
    svgText({ x: 0, y: 3.5 }, text, node);
    const title = svg('title', {}, node);
    title.textContent = `${count} ${count === 1 ? 'note' : 'notes'}`;
  }

  function drawArrows(laid, layer, notes) {
    const byId = new Map(laid.arrows.map((arrow) => [arrow.id, arrow]));
    const arrows = new Map();
    for (const shape of arrowGeometry(laid)) {
      const arrow = byId.get(shape.id);
      const node = svg('g', { class: 'd-arrow' }, layer);
      node.dataset.id = shape.id;
      svg('path', { class: 'd-line', d: shape.d }, node);
      svg('path', { class: 'd-hit', d: shape.d }, node);
      let badgeX = shape.lx;
      if (arrow.label !== '') {
        const width = [...arrow.label].length * ARROW_LABEL_CHAR + 10;
        svg('rect', { class: 'd-label-bg', x: shape.lx - width / 2, y: shape.ly - 9, width, height: 18, rx: 4 }, node);
        svgText({ class: 'd-label', x: shape.lx, y: shape.ly + 4 }, arrow.label, node);
        badgeX = shape.lx + width / 2 + BADGE_HEIGHT / 2 + 2;
      }
      const title = svg('title', {}, node);
      title.textContent = [arrow.label, arrow.why].filter((text) => text !== '').join(': ');
      drawBadge(node, badgeX, shape.ly, notes.get(`arrow:${shape.id}`));
      arrows.set(shape.id, { node, from: shape.from, to: shape.to });
    }
    return arrows;
  }

  function drawBoxes(laid, layer, notes) {
    const boxes = new Map();
    for (const box of laid.boxes) {
      const { w, h } = boxSize(box);
      const node = svg('g', { class: `d-box kind-${box.kind}`, transform: `translate(${box.x} ${box.y})` }, layer);
      node.dataset.id = box.id;
      svg('rect', { width: w, height: h, rx: 6 }, node);
      svgText({ class: 'd-box-label', x: w / 2, y: 20 }, boxLabel(box), node);
      svgText({ class: 'd-box-kind', x: w / 2, y: 36 }, box.kind, node);
      if (state.editable) {
        svg('circle', { class: 'd-handle', cx: w, cy: h / 2, r: HANDLE_RADIUS }, node);
      }
      const title = svg('title', {}, node);
      title.textContent = [box.label, ...box.files].join('\n');
      drawBadge(node, w, 0, notes.get(`box:${box.id}`));
      boxes.set(box.id, node);
    }
    return boxes;
  }

  // Builds the canvas and the nodes floating over it, then paints the document into it.
  function draw() {
    const toolbar = html('div', 'd-toolbar');
    const fitButton = html('button', 'small', 'Fit');
    fitButton.title = 'Fit (F)';
    fitButton.addEventListener('click', fit);
    toolbar.append(fitButton);
    let noteButton = null;
    if (annotate) {
      noteButton = html('button', 'small', 'Note');
      noteButton.addEventListener('click', noteSelected);
      toolbar.append(noteButton);
    }
    let relayoutButton = null;
    let bar = null;
    if (state.saver) {
      relayoutButton = html('button', 'small', 'Re-layout');
      relayoutButton.title = 'Re-layout (L)';
      relayoutButton.disabled = !state.editable;
      relayoutButton.addEventListener('click', relayoutAll);
      bar = html('div', 'd-save');
      toolbar.append(relayoutButton, bar);
    }

    const canvas = svg('svg', { class: 'd-canvas', role: 'img', 'aria-label': 'Diagram' });
    const defs = svg('defs', {}, canvas);
    for (const id of ['d-head', 'd-head-hl']) {
      const marker = svg('marker', { id, class: id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
      svg('path', { d: 'M 0 0 L 10 5 L 0 10 z' }, marker);
    }
    const world = svg('g', { class: 'd-world' }, canvas);
    const layers = { frames: svg('g', {}, world), arrows: svg('g', {}, world), boxes: svg('g', {}, world), rubber: svg('g', {}, world) };

    const card = html('div', 'd-card hidden');
    const caption = state.doc.walkthroughs.length > 0 ? buildCaption(state.doc) : null;
    const hint = state.saver ? html('div', 'd-hint', 'Double-click to add a box.') : null;
    // The field goes with the nodes it sat in; its blur must not commit into the new drawing.
    state.rename = null;
    pane.replaceChildren(canvas, ...(hint ? [hint] : []), toolbar, card, ...(caption ? [caption.node] : []));
    state.drawing = { canvas, world, layers, card, caption, hint, note: noteButton, relayout: relayoutButton, bar, arrows: new Map(), boxes: new Map() };
    state.selected = null;
    state.lastClick = null;
    state.pointer = null;
    state.touches.clear();
    state.pinch = null;
    wireCanvas(canvas);
    applyView();
    paint();
    showBar(state.bar);
  }

  // Redraws the frames, arrows and boxes from state.doc inside the canvas already on screen, so
  // the view transform, pointer capture and the floating nodes survive an edit; then puts back
  // the selection, its card (closed when its box or arrow is gone) and the walkthrough step.
  function paint() {
    const drawing = state.drawing;
    if (!drawing) {
      return;
    }
    const { frames, arrows, boxes } = drawing.layers;
    frames.replaceChildren();
    arrows.replaceChildren();
    boxes.replaceChildren();
    drawFrames(state.doc, frames);
    const notes = counts();
    drawing.arrows = drawArrows(state.doc, arrows, notes);
    drawing.boxes = drawBoxes(state.doc, boxes, notes);
    drawing.canvas.classList.toggle('editable', state.editable);
    drawing.hint?.classList.toggle('hidden', !state.editable || state.doc.boxes.length > 0);
    showSelection();
    applyStep();
  }

  // ---- pan, zoom and fit ----------------------------------------------------

  function applyView() {
    const { x, y, k } = state.view;
    state.drawing?.world.setAttribute('transform', `translate(${x} ${y}) scale(${k})`);
  }

  function fit() {
    if (!state.drawing) {
      return;
    }
    state.view = fitTransform(diagramBounds(state.doc), pane.clientWidth, pane.clientHeight);
    applyView();
  }

  function swallowClick() {
    state.justPanned = true;
    setTimeout(() => {
      state.justPanned = false;
    }, 0);
  }

  // The midpoint and distance of the first two fingers on the canvas.
  function span() {
    const [a, b] = [...state.touches.values()];
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(b.x - a.x, b.y - a.y) };
  }

  // A second finger turns the press into a pinch: the first finger's press ends without a pan
  // or a card, and the pinch scales by the change in the fingers' distance about their midpoint.
  function startPinch(canvas) {
    cancelGesture();
    state.pointer = null;
    canvas.classList.remove('panning');
    state.pinch = { rect: canvas.getBoundingClientRect(), view: { ...state.view }, ...span() };
  }

  // ---- gestures: move, connect, add and rename ------------------------------

  function toWorld(event) {
    const rect = state.drawing.canvas.getBoundingClientRect();
    const { x, y, k } = state.view;
    return { x: (event.clientX - rect.left - x) / k, y: (event.clientY - rect.top - y) / k };
  }

  const boxById = (id) => state.doc.boxes.find((box) => box.id === id) ?? null;

  // The topmost box under a world point, or null. A captured pointer's events all target the
  // canvas, so a connect's drop is found by position.
  function boxAt(point) {
    for (let i = state.doc.boxes.length - 1; i >= 0; i -= 1) {
      const box = state.doc.boxes[i];
      const { w, h } = boxSize(box);
      if (point.x >= box.x && point.x <= box.x + w && point.y >= box.y && point.y <= box.y + h) {
        return box;
      }
    }
    return null;
  }

  function startPan(press, event) {
    press.mode = 'pan';
    state.drawing.canvas.setPointerCapture(event.pointerId);
    state.drawing.canvas.classList.add('panning');
  }

  // Group frames are taken once, without the box, so its own frame does not follow the drag.
  function startMove(press, event) {
    const box = boxById(press.box);
    press.mode = 'move';
    press.base = state.doc;
    press.origin = { x: box.x, y: box.y };
    press.frames = dropFrames(state.doc, box.id);
    state.drawing.canvas.setPointerCapture(event.pointerId);
    state.drawing.canvas.classList.add('moving');
  }

  function movedTo(press, event) {
    const point = toWorld(event);
    return { x: press.origin.x + point.x - press.start.x, y: press.origin.y + point.y - press.start.y };
  }

  function startConnect(press, event) {
    const box = boxById(press.box);
    const { w, h } = boxSize(box);
    press.mode = 'connect';
    press.line = svg('line', { class: 'd-rubber', x1: box.x + w, y1: box.y + h / 2, x2: press.start.x, y2: press.start.y }, state.drawing.layers.rubber);
    state.drawing.canvas.setPointerCapture(event.pointerId);
  }

  function endPress(press) {
    state.pointer = null;
    const { canvas } = state.drawing;
    canvas.classList.remove('panning', 'moving');
    if (canvas.hasPointerCapture(press.id)) {
      canvas.releasePointerCapture(press.id);
    }
    press.line?.remove();
  }

  // Escape, a second finger or a refused save during a move or a connect: the box goes back, no
  // arrow is drawn, and nothing is saved.
  function cancelGesture() {
    const press = state.pointer;
    if (!press || !state.drawing || (press.mode !== 'move' && press.mode !== 'connect')) {
      return;
    }
    endPress(press);
    if (press.mode === 'move') {
      state.doc = press.base;
      paint();
    }
  }

  // A drop decides the group by the box's centre: another group's frame there takes it in, and
  // anywhere else it keeps its group. The move and the group change are one save.
  function finishMove(press, event) {
    const { x, y } = movedTo(press, event);
    const moved = moveBox(press.base, press.box, x, y);
    const box = moved.boxes.find((entry) => entry.id === press.box);
    const { w, h } = boxSize(box);
    const next = setGroup(moved, press.box, dropGroup(moved, press.box, { x: box.x + w / 2, y: box.y + h / 2 }, press.frames));
    state.doc = press.base;
    state.selected = { type: 'box', id: press.box };
    if (next !== press.base && canEdit()) {
      commit(next);
    } else {
      paint();
    }
  }

  // Released on another box, the handle draws a new arrow and selects it; anywhere else,
  // the source box included, it draws nothing.
  function finishConnect(press, event) {
    const target = boxAt(toWorld(event));
    if (target === null || target.id === press.box || !canEdit()) {
      return;
    }
    const id = state.ids.next('arrow');
    const next = connect(state.stored, { id, from: press.box, to: target.id });
    if (next !== state.stored) {
      state.selected = { type: 'arrow', id };
      commit(next);
    }
  }

  // A click selects what it landed on. The second click of a double-click renames a box or an
  // arrow, or adds a box on empty canvas, instead.
  function click(press, event) {
    const target = press.box ?? press.arrow ?? '';
    const now = performance.now();
    const last = state.lastClick;
    const double = last !== null && last.target === target && now - last.time <= DOUBLE_CLICK_MS
      && Math.hypot(event.clientX - last.x, event.clientY - last.y) <= DOUBLE_CLICK_PX;
    state.lastClick = double ? null : { time: now, x: event.clientX, y: event.clientY, target };
    if (double && canEdit()) {
      if (press.box !== null) {
        startRename({ type: 'box', id: press.box });
      } else if (press.arrow !== null) {
        startRename({ type: 'arrow', id: press.arrow });
      } else {
        addPending(toWorld(event));
      }
      return;
    }
    if (press.box !== null) {
      select({ type: 'box', id: press.box });
    } else if (press.arrow !== null) {
      select({ type: 'arrow', id: press.arrow });
    } else {
      closeCard();
    }
  }

  // A new box centred on the point, in the group whose frame holds it, drawn but not saved: the
  // rename field opens on it, and its commit is the one save that adds it.
  function addPending(point) {
    const { w, h } = boxSize({ label: NEW_BOX_LABEL });
    const spec = { id: state.ids.next('box'), x: point.x - w / 2, y: point.y - h / 2, group: groupAt(groupFrames(state.doc), point) };
    const base = state.doc;
    state.doc = addBox(base, { ...spec, label: NEW_BOX_LABEL });
    state.selected = { type: 'box', id: spec.id };
    paint();
    // The click that follows this pointerup lands on the canvas; it must not close the new card.
    swallowClick();
    startRename({ type: 'box', id: spec.id, base, spec });
  }

  // Lays the field over the box, or centred on the arrow's label point, inside the pane.
  function placeRename(input, type, entry) {
    const { x: vx, y: vy, k } = state.view;
    let width;
    let left;
    let top;
    if (type === 'box') {
      const { w, h } = boxSize(entry);
      width = Math.max(RENAME_BOX_MIN, w * k);
      left = entry.x * k + vx + (w * k - width) / 2;
      top = (entry.y + h / 2) * k + vy - RENAME_HEIGHT / 2;
    } else {
      const shape = arrowGeometry(state.doc).find((item) => item.id === entry.id);
      width = RENAME_ARROW_WIDTH;
      left = shape.lx * k + vx - width / 2;
      top = shape.ly * k + vy - RENAME_HEIGHT / 2;
    }
    width = Math.min(width, Math.max(0, pane.clientWidth - 8));
    input.style.width = `${width}px`;
    input.style.left = `${Math.min(Math.max(4, pane.clientWidth - width - 4), Math.max(4, left))}px`;
    input.style.top = `${Math.min(Math.max(4, pane.clientHeight - RENAME_HEIGHT - 4), Math.max(4, top))}px`;
  }

  // `target` is { type, id }, plus { base, spec } for a box being added. Enter or a blur commits,
  // Escape cancels; both keys are marked handled on the field itself.
  function startRename(target) {
    if (!canEdit() || !state.drawing) {
      return;
    }
    finishRename(true);
    const entry = (target.type === 'box' ? state.doc.boxes : state.doc.arrows).find((item) => item.id === target.id);
    if (!entry) {
      return;
    }
    const input = html('input', 'd-rename');
    input.type = 'text';
    input.value = entry.label;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', target.type === 'box' ? 'Box label' : 'Arrow label');
    if (target.type === 'arrow') {
      input.placeholder = 'Label this arrow';
    }
    placeRename(input, target.type, entry);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        finishRename(event.key === 'Enter');
      }
    });
    input.addEventListener('blur', () => finishRename(true));
    pane.append(input);
    state.rename = { ...target, input };
    setTimeout(() => {
      if (state.rename?.input === input) {
        input.focus();
        input.select();
      }
    }, 0);
  }

  // An empty box label keeps the old one; a box being added is dropped instead. An arrow label
  // may be empty.
  function finishRename(keep) {
    const rename = state.rename;
    if (rename === null) {
      return;
    }
    state.rename = null;
    const value = rename.input.value;
    rename.input.remove();
    if (rename.base) {
      state.doc = rename.base;
      const next = keep ? addBox(rename.base, { ...rename.spec, label: value }) : rename.base;
      if (next !== rename.base && canEdit()) {
        commit(next);
      } else {
        paint();
      }
      return;
    }
    if (keep) {
      commit(rename.type === 'box' ? renameBox(state.stored, rename.id, value) : relabelArrow(state.stored, rename.id, value));
    }
  }

  function abandonGestures() {
    finishRename(false);
    cancelGesture();
  }

  function movePinch() {
    const { rect, view, mid, dist } = state.pinch;
    const now = span();
    const local = (point) => ({ x: point.x - rect.left, y: point.y - rect.top });
    state.view = zoomView(view, view.k * (now.dist / Math.max(1, dist)), local(mid), local(now.mid));
    applyView();
  }

  function wireCanvas(canvas) {
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }
      finishRename(true);
      if (event.pointerType === 'touch') {
        state.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (state.touches.size === 2) {
          startPinch(canvas);
        }
        if (state.touches.size > 1) {
          return;
        }
      }
      const target = event.target instanceof Element ? event.target : null;
      const box = target?.closest('.d-box')?.dataset.id ?? null;
      const arrow = box === null ? target?.closest('.d-arrow')?.dataset.id ?? null : null;
      const press = { id: event.pointerId, x: event.clientX, y: event.clientY, view: { ...state.view }, start: toWorld(event), box, arrow, mode: null };
      state.pointer = press;
      if (box !== null && canEdit() && target.closest('.d-handle')) {
        startConnect(press, event);
      }
    });
    canvas.addEventListener('pointermove', (event) => {
      if (state.touches.has(event.pointerId)) {
        state.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
      if (state.pinch) {
        if (state.touches.size >= 2) {
          movePinch();
        }
        return;
      }
      const press = state.pointer;
      if (!press || press.id !== event.pointerId) {
        return;
      }
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      if (press.mode === null) {
        if (Math.hypot(dx, dy) <= PAN_THRESHOLD) {
          return;
        }
        if (press.box !== null && canEdit()) {
          startMove(press, event);
        } else {
          startPan(press, event);
        }
      }
      if (press.mode === 'connect') {
        const point = toWorld(event);
        press.line.setAttribute('x2', String(point.x));
        press.line.setAttribute('y2', String(point.y));
      } else if (press.mode === 'move') {
        const { x, y } = movedTo(press, event);
        state.doc = moveBox(press.base, press.box, x, y);
        paint();
      } else {
        state.view = { ...press.view, x: press.view.x + dx, y: press.view.y + dy };
        applyView();
      }
    });
    const release = (event) => {
      state.touches.delete(event.pointerId);
      if (state.pinch && state.touches.size < 2) {
        state.pinch = null;
        swallowClick();
      }
      const press = state.pointer;
      if (!press || press.id !== event.pointerId) {
        return null;
      }
      endPress(press);
      return press;
    };
    canvas.addEventListener('pointerup', (event) => {
      const press = release(event);
      if (!press) {
        return;
      }
      if (press.mode === null) {
        click(press, event);
        return;
      }
      state.lastClick = null;
      swallowClick();
      if (press.mode === 'move') {
        finishMove(press, event);
      } else if (press.mode === 'connect') {
        finishConnect(press, event);
      }
    });
    canvas.addEventListener('pointercancel', (event) => {
      const press = release(event);
      if (press?.mode === 'move') {
        state.doc = press.base;
        paint();
      }
    });
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        finishRename(true);
        const { x, y, k } = state.view;
        if (event.ctrlKey || event.metaKey) {
          const rect = canvas.getBoundingClientRect();
          const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
          state.view = zoomView(state.view, k * wheelZoomFactor(event.deltaY, event.deltaMode), point);
        } else {
          state.view = { x: x - event.deltaX, y: y - event.deltaY, k };
        }
        applyView();
      },
      { passive: false },
    );
  }

  // ---- the selection and its card -------------------------------------------

  function selectedEntry() {
    if (state.selected === null) {
      return null;
    }
    const { type, id } = state.selected;
    return (type === 'box' ? state.doc.boxes : state.doc.arrows).find((entry) => entry.id === id) ?? null;
  }

  function select(selected) {
    state.selected = selected;
    showSelection();
  }

  // Marks the selected box or arrow and fills its card, or hides the card when nothing is
  // selected or the selection is gone from the document.
  function showSelection() {
    const drawing = state.drawing;
    for (const node of drawing.world.querySelectorAll('.open')) {
      node.classList.remove('open');
    }
    const entry = selectedEntry();
    updateNoteButton(entry !== null);
    if (entry === null) {
      state.selected = null;
      drawing.card.classList.add('hidden');
      drawing.card.replaceChildren();
      return;
    }
    if (state.selected.type === 'box') {
      drawing.boxes.get(entry.id).classList.add('open');
      drawing.card.replaceChildren(...boxCard(entry));
    } else {
      drawing.arrows.get(entry.id).node.classList.add('open');
      drawing.card.replaceChildren(...arrowCard(entry));
    }
    drawing.card.classList.remove('hidden');
  }

  const canNote = () => annotate !== null && !ended();

  function updateNoteButton(hasSelection) {
    const button = state.drawing?.note;
    if (!button) {
      return;
    }
    button.disabled = !hasSelection || !canNote();
    button.title = ended() ? 'The run has ended' : hasSelection ? 'Add a note (N)' : 'Select a box or arrow';
  }

  // Opens the composer on the selected box or arrow, its label snapshot taken from the drawing.
  function noteSelected() {
    const entry = selectedEntry();
    if (entry === null || !canNote()) {
      return;
    }
    annotate({ kind: state.selected.type, id: entry.id, label: entry.label });
  }

  const cardShown = () => state.drawing !== null && !state.drawing.card.classList.contains('hidden');

  // The card for a note whose box or arrow the diagram no longer holds; the view stays as it is.
  function showMissing(text) {
    state.selected = null;
    showSelection();
    const { card } = state.drawing;
    card.replaceChildren(cardHead(html('span', 'd-card-label muted', text)));
    card.classList.remove('hidden');
  }

  function noteRow() {
    const row = html('div', 'd-card-edit');
    const button = html('button', 'small', 'Add note');
    button.title = 'Add a note (N)';
    button.disabled = !canNote();
    button.addEventListener('click', noteSelected);
    row.append(button);
    return row;
  }

  function cardHead(label, kind) {
    const head = html('div', 'd-card-head');
    const close = html('button', 'ghost small', 'Close');
    close.addEventListener('click', closeCard);
    head.append(label, ...(kind ? [html('span', 'd-card-kind', kind)] : []), close);
    return head;
  }

  // A select that blurs once changed, so the diagram keys work again at once.
  function picker(label, options, value, change) {
    const menu = html('select', 'd-pick');
    menu.setAttribute('aria-label', label);
    menu.title = label;
    for (const [optionValue, text] of options) {
      const option = html('option', '', text);
      option.value = optionValue;
      menu.append(option);
    }
    menu.value = value;
    menu.disabled = !canEdit();
    menu.addEventListener('change', () => {
      const chosen = menu.value;
      menu.blur();
      change(chosen);
    });
    return menu;
  }

  function cardButton(text, title, action) {
    const button = html('button', 'small', text);
    button.title = title;
    button.disabled = !canEdit();
    button.addEventListener('click', action);
    return button;
  }

  const renameButton = () => cardButton('Rename', 'Rename (Enter or double-click)', () => startRename(state.selected));
  const deleteButton = () => cardButton('Delete', 'Delete (Del)', deleteSelected);

  function boxCard(box) {
    const head = cardHead(html('span', 'd-card-label', box.label), box.kind);
    const parts = [head];
    if (state.editable) {
      const edit = html('div', 'd-card-edit');
      edit.append(picker('Kind', KINDS.map((kind) => [kind, kind]), box.kind, (kind) => commit(setKind(state.stored, box.id, kind))));
      if (state.doc.groups.length > 0) {
        const groups = [['', 'No group'], ...state.doc.groups.map((group) => [group.id, group.label])];
        edit.append(picker('Group', groups, box.group ?? '', (group) => commit(setGroup(state.stored, box.id, group === '' ? null : group))));
      }
      edit.append(renameButton(), deleteButton());
      parts.push(edit);
    }
    if (annotate) {
      parts.push(noteRow());
    }
    const files = html('div', 'd-card-files');
    if (box.files.length === 0) {
      files.append(html('div', 'muted', 'No linked files.'));
    }
    for (const path of box.files) {
      const row = html('div', 'd-card-file');
      const link = html('button', 'link', path);
      link.addEventListener('click', () => openCode(path));
      row.append(link);
      if (listed(path)) {
        link.title = `Open ${path} in the Code tab`;
      } else {
        link.title = `${path} is not a file this diagram can open`;
        row.append(html('span', 'd-missing', 'not found'));
      }
      files.append(row);
    }
    parts.push(files);
    return parts;
  }

  function arrowCard(arrow) {
    const label = arrow.label === '' ? html('span', 'd-card-label muted', 'No label') : html('span', 'd-card-label', arrow.label);
    const parts = [cardHead(label, 'arrow')];
    const labelOf = (id) => state.doc.boxes.find((box) => box.id === id)?.label ?? id;
    parts.push(html('div', 'd-card-ends', `${labelOf(arrow.from)} → ${labelOf(arrow.to)}`));
    if (arrow.why !== '') {
      parts.push(html('div', 'd-card-why', arrow.why));
    }
    if (state.editable) {
      const edit = html('div', 'd-card-edit');
      edit.append(renameButton(), deleteButton());
      parts.push(edit);
    }
    if (annotate) {
      parts.push(noteRow());
    }
    return parts;
  }

  function closeCard() {
    state.selected = null;
    if (state.drawing) {
      showSelection();
    }
  }

  // ---- walkthroughs ---------------------------------------------------------

  function buildCaption(laid) {
    const node = html('div', 'd-caption');
    let picker;
    if (laid.walkthroughs.length > 1) {
      picker = html('select', 'd-walk');
      picker.setAttribute('aria-label', 'Walkthrough');
      laid.walkthroughs.forEach((walkthrough, i) => {
        const option = html('option', '', walkthrough.name);
        option.value = String(i);
        picker.append(option);
      });
      picker.value = String(state.walkthrough);
      picker.addEventListener('change', () => {
        state.walkthrough = Number(picker.value);
        state.position = 0;
        // Focus leaves the select so J and K step the new walkthrough at once.
        picker.blur();
        applyStep();
      });
    } else {
      picker = html('span', 'd-walk', laid.walkthroughs[0].name);
      picker.title = laid.walkthroughs[0].name;
    }
    const prev = html('button', 'small', 'Prev');
    prev.title = 'Previous step (K)';
    prev.addEventListener('click', () => step(-1));
    const next = html('button', 'small', 'Next');
    next.title = 'Next step (J)';
    next.addEventListener('click', () => step(1));
    const position = html('span', 'd-pos');
    const text = html('span', 'd-step');
    node.append(picker, prev, position, next, text);
    return { node, prev, next, position, text };
  }

  function applyStep() {
    const drawing = state.drawing;
    if (!drawing?.caption) {
      return;
    }
    const { steps } = state.doc.walkthroughs[state.walkthrough];
    const { prev, next, position, text } = drawing.caption;
    prev.disabled = state.position === 0;
    next.disabled = state.position === steps.length;
    position.textContent = `${state.position}/${steps.length}`;
    const current = state.position === 0 ? null : steps[state.position - 1];
    const words = current ? current.text : `${steps.length} ${steps.length === 1 ? 'step' : 'steps'} · J next, K previous`;
    text.textContent = words;
    text.title = words;
    for (const node of drawing.world.querySelectorAll('.hl')) {
      node.classList.remove('hl');
    }
    const lit = (current ? current.arrows : []).flatMap((id) => (drawing.arrows.has(id) ? [drawing.arrows.get(id)] : []));
    drawing.world.classList.toggle('dim', lit.length > 0);
    for (const arrow of lit) {
      arrow.node.classList.add('hl');
      drawing.boxes.get(arrow.from).classList.add('hl');
      drawing.boxes.get(arrow.to).classList.add('hl');
    }
  }

  function step(delta) {
    const drawing = state.drawing;
    if (!drawing?.caption) {
      return;
    }
    const count = state.doc.walkthroughs[state.walkthrough].steps.length;
    const position = Math.min(count, Math.max(0, state.position + delta));
    if (position !== state.position) {
      state.position = position;
      applyStep();
    }
  }

  // ---- keys and dismissal ---------------------------------------------------

  document.addEventListener('keydown', (event) => {
    if (!state.shown || !state.drawing || event.defaultPrevented || typing(event)) {
      return;
    }
    if (event.key === 'Escape') {
      if (state.pointer?.mode === 'move' || state.pointer?.mode === 'connect') {
        cancelGesture();
        event.preventDefault();
      } else if (cardShown()) {
        closeCard();
        event.preventDefault();
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'f') {
      fit();
    } else if (key === 'j') {
      step(1);
    } else if (key === 'k') {
      step(-1);
    } else if (key === 'n' && annotate) {
      // The composer takes focus at once; the key must not type into it.
      if (state.selected !== null && canNote()) {
        event.preventDefault();
        noteSelected();
      }
    } else if (!canEdit() || focusOnButton() || state.pointer !== null) {
      // A press in progress ends in an edit of the document it started from, so an edit made
      // before its drop would be undone by it.
      return;
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && state.selected !== null) {
      event.preventDefault();
      deleteSelected();
    } else if (event.key === 'Enter' && state.selected !== null) {
      event.preventDefault();
      startRename(state.selected);
    } else if (key === 'l') {
      relayoutAll();
    }
  });
  document.addEventListener('click', (event) => {
    if (state.justPanned) {
      state.justPanned = false;
      return;
    }
    if (cardShown() && !eventInside(event, '.d-card, .d-box, .d-arrow, .d-toolbar, .d-caption, .d-rename, .notes, .composer')) {
      closeCard();
    }
  });

  return {
    // Before setDiagram: `send(document)` saves an edited document and returns a promise that
    // rejects with an error carrying the HTTP `status`; with it the next diagram is editable.
    setEditable(send) {
      state.send = send;
    },
    // Before setDiagram: `compose(anchor)` opens the composer on a box or arrow anchor; with it the
    // diagram takes notes.
    setAnnotate(compose) {
      annotate = compose;
    },
    setDiagram(result) {
      state.result = result;
      if (result?.doc) {
        setStored(result.doc.document);
      } else {
        state.stored = null;
        state.doc = null;
      }
      state.ids = result?.doc ? createIds(result.doc.document) : null;
      state.editable = Boolean(result?.doc) && state.send !== null;
      state.saver = state.editable ? createSaver(state.send, { saved: state.stored, onChange: saveChanged }) : null;
      state.bar = null;
      state.dirty = true;
      state.walkthrough = 0;
      state.position = 0;
      if (state.shown) {
        render();
      }
    },
    // Resolves with the save state once no save is waiting or in flight; null when not editable.
    flush() {
      return state.saver ? state.saver.flush() : Promise.resolve(null);
    },
    // The tab comes on screen or leaves it: shown, it renders what changed while it was hidden;
    // hidden, its card closes.
    show(shown) {
      state.shown = shown;
      if (!shown) {
        finishRename(true);
        cancelGesture();
        closeCard();
      } else if (state.dirty) {
        render();
      }
    },
    render,
    // The notes changed: the badges are repainted in place, keeping the view and the selection.
    notesChanged() {
      paint();
    },
    // Selects the box or arrow a note sits on and centres it at the current zoom; the tab must
    // be shown. False, with a card saying so, when the diagram no longer holds it, and false
    // with nothing done while a notice stands in for the drawing.
    reveal({ kind, id, label }) {
      if (!state.drawing) {
        return false;
      }
      const entry = (kind === 'box' ? state.doc.boxes : state.doc.arrows).find((item) => item.id === id);
      if (!entry) {
        showMissing(`${kind} ${label || id} is not in this diagram.`);
        return false;
      }
      select({ type: kind, id });
      let centre;
      if (kind === 'box') {
        const { w, h } = boxSize(entry);
        centre = { x: entry.x + w / 2, y: entry.y + h / 2 };
      } else {
        const shape = arrowGeometry(state.doc).find((item) => item.id === id);
        centre = { x: shape.lx, y: shape.ly };
      }
      const { k } = state.view;
      state.view = { x: pane.clientWidth / 2 - centre.x * k, y: pane.clientHeight / 2 - centre.y * k, k };
      applyView();
      return true;
    },
  };
}
