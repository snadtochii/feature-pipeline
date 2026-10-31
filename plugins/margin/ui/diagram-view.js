// The viewer's Diagram tab: GET /api/diagram's document drawn as SVG — group frames, boxes styled
// by kind and labelled arrows — with pan, zoom and fit, a detail card for the box clicked, and
// walkthroughs stepped with J and K. Every position comes from ./diagram.js's model, and diagram
// text reaches the page through textContent only. It owns its nodes, the open card and the keys
// and clicks that drive them; leaving the tab goes through the callbacks createDiagramView takes.

import { arrowGeometry, boxLabel, boxSize, diagramBounds, fitTransform, groupFrames, layoutDiagram, wheelZoomFactor, zoomView } from './diagram.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAN_THRESHOLD = 4;
const ARROW_LABEL_CHAR = 6.2;

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

// `nodes.pane` is the tab's pane. The callbacks:
//   listed(path)    whether the path is in the run's listing, so the Code tab can open it
//   openCode(path)  shows the file in the Code tab
// F fits, J and K step the walkthrough, only while the tab is shown, with no Ctrl, ⌘ or Alt, and
// never while typing. Escape while a card is open closes it and marks the event handled
// (defaultPrevented).
export function createDiagramView({ nodes, listed, openCode }) {
  const { pane } = nodes;
  const state = {
    // The run's diagram: null without one, { doc: { file, root, document } } once read, { error }.
    result: null,
    shown: false, // the tab is the center pane on screen
    dirty: true, // the tab needs rendering the next time it is shown
    view: { x: 0, y: 0, k: 1 }, // screen = world × k + (x, y)
    // The drawn diagram: { laid, world, card, caption, arrows: id → { node, from, to },
    // boxes: id → node }, or null while a notice stands in for it.
    drawing: null,
    card: null, // the id of the box whose card is open, or null
    walkthrough: 0,
    position: 0, // 0 shows every arrow; n shows step n
    pointer: null, // the press in progress: { id, x, y, view, box, panning }
    justPanned: false, // the click that ends a drag is not a click on the canvas
  };

  function notice(text) {
    state.drawing = null;
    state.card = null;
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
    const { document: doc } = state.result.doc;
    if (doc.boxes.length === 0) {
      notice('This diagram has no boxes yet.');
      return;
    }
    draw(layoutDiagram(doc));
    fit();
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

  function drawArrows(laid, layer) {
    const byId = new Map(laid.arrows.map((arrow) => [arrow.id, arrow]));
    const arrows = new Map();
    for (const shape of arrowGeometry(laid)) {
      const arrow = byId.get(shape.id);
      const node = svg('g', { class: 'd-arrow' }, layer);
      node.dataset.id = shape.id;
      svg('path', { class: 'd-line', d: shape.d }, node);
      svg('path', { class: 'd-hit', d: shape.d }, node);
      if (arrow.label !== '') {
        const width = [...arrow.label].length * ARROW_LABEL_CHAR + 10;
        svg('rect', { class: 'd-label-bg', x: shape.lx - width / 2, y: shape.ly - 9, width, height: 18, rx: 4 }, node);
        svgText({ class: 'd-label', x: shape.lx, y: shape.ly + 4 }, arrow.label, node);
      }
      const title = svg('title', {}, node);
      title.textContent = [arrow.label, arrow.why].filter((text) => text !== '').join(': ');
      arrows.set(shape.id, { node, from: shape.from, to: shape.to });
    }
    return arrows;
  }

  function drawBoxes(laid, layer) {
    const boxes = new Map();
    for (const box of laid.boxes) {
      const { w, h } = boxSize(box);
      const node = svg('g', { class: `d-box kind-${box.kind}`, transform: `translate(${box.x} ${box.y})` }, layer);
      node.dataset.id = box.id;
      svg('rect', { width: w, height: h, rx: 6 }, node);
      svgText({ class: 'd-box-label', x: w / 2, y: 20 }, boxLabel(box), node);
      svgText({ class: 'd-box-kind', x: w / 2, y: 36 }, box.kind, node);
      const title = svg('title', {}, node);
      title.textContent = [box.label, ...box.files].join('\n');
      boxes.set(box.id, node);
    }
    return boxes;
  }

  function draw(laid) {
    const toolbar = html('div', 'd-toolbar');
    const fitButton = html('button', 'small', 'Fit');
    fitButton.title = 'Fit (F)';
    fitButton.addEventListener('click', fit);
    toolbar.append(fitButton);

    const canvas = svg('svg', { class: 'd-canvas', role: 'img', 'aria-label': 'Diagram' });
    const defs = svg('defs', {}, canvas);
    for (const id of ['d-head', 'd-head-hl']) {
      const marker = svg('marker', { id, class: id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
      svg('path', { d: 'M 0 0 L 10 5 L 0 10 z' }, marker);
    }
    const world = svg('g', { class: 'd-world' }, canvas);
    drawFrames(laid, svg('g', {}, world));
    const arrows = drawArrows(laid, svg('g', {}, world));
    const boxes = drawBoxes(laid, svg('g', {}, world));

    const card = html('div', 'd-card hidden');
    const caption = laid.walkthroughs.length > 0 ? buildCaption(laid) : null;
    pane.replaceChildren(canvas, toolbar, card, ...(caption ? [caption.node] : []));
    state.drawing = { laid, world, card, caption, arrows, boxes };
    state.card = null;
    wireCanvas(canvas);
    applyView();
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
    state.view = fitTransform(diagramBounds(state.drawing.laid), pane.clientWidth, pane.clientHeight);
    applyView();
  }

  function wireCanvas(canvas) {
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }
      const box = event.target instanceof Element ? event.target.closest('.d-box') : null;
      state.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, view: { ...state.view }, box: box?.dataset.id ?? null, panning: false };
    });
    canvas.addEventListener('pointermove', (event) => {
      const press = state.pointer;
      if (!press || press.id !== event.pointerId) {
        return;
      }
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      if (!press.panning && Math.hypot(dx, dy) <= PAN_THRESHOLD) {
        return;
      }
      if (!press.panning) {
        press.panning = true;
        canvas.setPointerCapture(event.pointerId);
        canvas.classList.add('panning');
      }
      state.view = { ...press.view, x: press.view.x + dx, y: press.view.y + dy };
      applyView();
    });
    const release = (event) => {
      const press = state.pointer;
      if (!press || press.id !== event.pointerId) {
        return null;
      }
      state.pointer = null;
      canvas.classList.remove('panning');
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      return press;
    };
    canvas.addEventListener('pointerup', (event) => {
      const press = release(event);
      if (!press) {
        return;
      }
      if (press.panning) {
        state.justPanned = true;
        setTimeout(() => {
          state.justPanned = false;
        }, 0);
      } else if (press.box !== null) {
        openCard(press.box);
      } else {
        closeCard();
      }
    });
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
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

  // ---- the box card ---------------------------------------------------------

  function openCard(id) {
    const drawing = state.drawing;
    const box = drawing.laid.boxes.find((entry) => entry.id === id);
    closeCard();
    state.card = id;
    drawing.boxes.get(id).classList.add('open');

    const head = html('div', 'd-card-head');
    const close = html('button', 'ghost small', 'Close');
    close.addEventListener('click', closeCard);
    head.append(html('span', 'd-card-label', box.label), html('span', 'd-card-kind', box.kind), close);
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
    drawing.card.replaceChildren(head, files);
    drawing.card.classList.remove('hidden');
  }

  function closeCard() {
    const drawing = state.drawing;
    if (state.card !== null && drawing) {
      drawing.boxes.get(state.card)?.classList.remove('open');
      drawing.card.classList.add('hidden');
      drawing.card.replaceChildren();
    }
    state.card = null;
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
    const { steps } = drawing.laid.walkthroughs[state.walkthrough];
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
    const lit = current ? current.arrows : [];
    drawing.world.classList.toggle('dim', lit.length > 0);
    for (const id of lit) {
      const arrow = drawing.arrows.get(id);
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
    const count = drawing.laid.walkthroughs[state.walkthrough].steps.length;
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
      if (state.card !== null) {
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
    }
  });
  document.addEventListener('click', (event) => {
    if (state.justPanned) {
      state.justPanned = false;
      return;
    }
    if (state.card !== null && !eventInside(event, '.d-card, .d-box, .d-toolbar, .d-caption')) {
      closeCard();
    }
  });

  return {
    setDiagram(result) {
      state.result = result;
      state.dirty = true;
      state.walkthrough = 0;
      state.position = 0;
      if (state.shown) {
        render();
      }
    },
    // The tab comes on screen or leaves it: shown, it renders what changed while it was hidden;
    // hidden, its card closes.
    show(shown) {
      state.shown = shown;
      if (!shown) {
        closeCard();
      } else if (state.dirty) {
        render();
      }
    },
    render,
  };
}
