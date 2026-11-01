// The diagram canvas's gesture state machine: what a press, a second finger, a wheel turn or a
// second click on the canvas means. It owns the press in progress, the fingers down, the pinch and
// the click that may start a double-click, and says what happened through `host`; the document,
// the view and the page stay with the caller. It touches no page global, so the self-test runs it
// over a fake canvas.

import { boxSize, wheelZoomFactor, zoomView } from './diagram.js';
import { dropFrames, dropGroup, moveBox, setGroup } from './diagram-edit.js';

const PAN_THRESHOLD = 4;
// Two clicks this close in time and space are a double-click; it is timed here because a press
// that ends a drag must never count as half of one.
const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_PX = 6;

// `host` is what the gestures read and what they report:
//   canEdit()                  whether an edit may start or finish now
//   document()                 the document drawn, every box positioned
//   view() / setView(view)     the view, { x, y, k }: screen = world × k + (x, y)
//   hit(event)                 what a press landed on: { box, arrow, handle }, ids or null
//   settle()                   the canvas is about to take a press or a wheel turn
//   preview(document)          draw this document without saving it
//   moved(id, base, next)      a move dropped: `next` is `base` when it changed nothing
//   connected(from, to)        a connect dropped on another box
//   select({ type, id })       a click on a box or an arrow
//   clearSelection()           a click on empty canvas
//   rename({ type, id })       a double-click on a box or an arrow
//   add(point)                 a double-click on empty canvas, at a world point
//   rubberBand(from, to)       draws a connect's line: { moveTo(point), remove() }
// `now()` exists so the self-test runs the double-click's timing without waiting it out.
export function createGestures({ host, now = () => performance.now() }) {
  let canvas = null;
  // The press in progress: { id, x, y, view, start, box, arrow, mode }, `mode` null until it is a
  // 'pan', a 'move' (with { base, origin, frames }) or a 'connect' (with { line }).
  let press = null;
  const touches = new Map(); // the fingers on the canvas: pointer id → { x, y } in client coordinates
  let pinch = null; // the two-finger pinch in progress: { rect, view, mid, dist } at its start
  let lastClick = null; // the click that may start a double-click: { time, x, y, target }
  let justPanned = false; // the click that ends a drag or a pinch is not a click on the canvas

  function swallowClick() {
    justPanned = true;
    setTimeout(() => {
      justPanned = false;
    }, 0);
  }

  function toWorld(event) {
    const rect = canvas.getBoundingClientRect();
    const { x, y, k } = host.view();
    return { x: (event.clientX - rect.left - x) / k, y: (event.clientY - rect.top - y) / k };
  }

  const boxById = (id) => host.document().boxes.find((box) => box.id === id) ?? null;

  // The topmost box under a world point, or null. A captured pointer's events all target the
  // canvas, so a connect's drop is found by position.
  function boxAt(point) {
    const { boxes } = host.document();
    for (let i = boxes.length - 1; i >= 0; i -= 1) {
      const box = boxes[i];
      const { w, h } = boxSize(box);
      if (point.x >= box.x && point.x <= box.x + w && point.y >= box.y && point.y <= box.y + h) {
        return box;
      }
    }
    return null;
  }

  function startPan(current, event) {
    current.mode = 'pan';
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('panning');
  }

  // Group frames are taken once, without the box, so its own frame does not follow the drag.
  function startMove(current, event) {
    const box = boxById(current.box);
    current.mode = 'move';
    current.base = host.document();
    current.origin = { x: box.x, y: box.y };
    current.frames = dropFrames(current.base, box.id);
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('moving');
  }

  function movedTo(current, event) {
    const point = toWorld(event);
    return { x: current.origin.x + point.x - current.start.x, y: current.origin.y + point.y - current.start.y };
  }

  function startConnect(current, event) {
    const box = boxById(current.box);
    const { w, h } = boxSize(box);
    current.mode = 'connect';
    current.line = host.rubberBand({ x: box.x + w, y: box.y + h / 2 }, current.start);
    canvas.setPointerCapture(event.pointerId);
  }

  function endPress(current) {
    press = null;
    canvas.classList.remove('panning', 'moving');
    if (canvas.hasPointerCapture(current.id)) {
      canvas.releasePointerCapture(current.id);
    }
    current.line?.remove();
  }

  // Escape, a second finger or a refused save during a move or a connect: the box goes back, no
  // arrow is drawn, and nothing is saved. True when there was one to cancel.
  function cancel() {
    if (!press || !canvas || (press.mode !== 'move' && press.mode !== 'connect')) {
      return false;
    }
    const current = press;
    endPress(current);
    if (current.mode === 'move') {
      host.preview(current.base);
    }
    return true;
  }

  // The midpoint and distance of the first two fingers on the canvas.
  function span() {
    const [a, b] = [...touches.values()];
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(b.x - a.x, b.y - a.y) };
  }

  // A second finger turns the press into a pinch: the first finger's press ends without a pan
  // or a card, and the pinch scales by the change in the fingers' distance about their midpoint.
  function startPinch() {
    cancel();
    press = null;
    canvas.classList.remove('panning');
    pinch = { rect: canvas.getBoundingClientRect(), view: { ...host.view() }, ...span() };
  }

  function movePinch() {
    const { rect, view, mid, dist } = pinch;
    const current = span();
    const local = (point) => ({ x: point.x - rect.left, y: point.y - rect.top });
    host.setView(zoomView(view, view.k * (current.dist / Math.max(1, dist)), local(mid), local(current.mid)));
  }

  // A drop decides the group by the box's centre: another group's frame there takes it in, and
  // anywhere else it keeps its group. The move and the group change are one save.
  function finishMove(current, event) {
    const { x, y } = movedTo(current, event);
    const moved = moveBox(current.base, current.box, x, y);
    const box = moved.boxes.find((entry) => entry.id === current.box);
    const { w, h } = boxSize(box);
    const next = setGroup(moved, current.box, dropGroup(moved, current.box, { x: box.x + w / 2, y: box.y + h / 2 }, current.frames));
    host.moved(current.box, current.base, next);
  }

  // Released on another box, the handle draws a new arrow; anywhere else, the source box included,
  // it draws nothing.
  function finishConnect(current, event) {
    const target = boxAt(toWorld(event));
    if (target !== null && target.id !== current.box && host.canEdit()) {
      host.connected(current.box, target.id);
    }
  }

  // A click selects what it landed on. The second click of a double-click renames a box or an
  // arrow, or adds a box on empty canvas, instead.
  function click(current, event) {
    const target = current.box ?? current.arrow ?? '';
    const time = now();
    const last = lastClick;
    const double = last !== null && last.target === target && time - last.time <= DOUBLE_CLICK_MS
      && Math.hypot(event.clientX - last.x, event.clientY - last.y) <= DOUBLE_CLICK_PX;
    lastClick = double ? null : { time, x: event.clientX, y: event.clientY, target };
    if (double && host.canEdit()) {
      if (current.box !== null) {
        host.rename({ type: 'box', id: current.box });
      } else if (current.arrow !== null) {
        host.rename({ type: 'arrow', id: current.arrow });
      } else {
        // The click that follows this pointerup lands on the canvas; it must not close the new card.
        swallowClick();
        host.add(toWorld(event));
      }
      return;
    }
    if (current.box !== null) {
      host.select({ type: 'box', id: current.box });
    } else if (current.arrow !== null) {
      host.select({ type: 'arrow', id: current.arrow });
    } else {
      host.clearSelection();
    }
  }

  function pointerDown(event) {
    if (event.button !== 0) {
      return;
    }
    host.settle();
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size === 2) {
        startPinch();
      }
      if (touches.size > 1) {
        return;
      }
    }
    const { box, arrow, handle } = host.hit(event);
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, view: { ...host.view() }, start: toWorld(event), box, arrow, mode: null };
    if (box !== null && handle && host.canEdit()) {
      startConnect(press, event);
    }
  }

  function pointerMove(event) {
    if (touches.has(event.pointerId)) {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (pinch) {
      if (touches.size >= 2) {
        movePinch();
      }
      return;
    }
    const current = press;
    if (!current || current.id !== event.pointerId) {
      return;
    }
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (current.mode === null) {
      if (Math.hypot(dx, dy) <= PAN_THRESHOLD) {
        return;
      }
      if (current.box !== null && host.canEdit()) {
        startMove(current, event);
      } else {
        startPan(current, event);
      }
    }
    if (current.mode === 'connect') {
      current.line.moveTo(toWorld(event));
    } else if (current.mode === 'move') {
      const { x, y } = movedTo(current, event);
      host.preview(moveBox(current.base, current.box, x, y));
    } else {
      host.setView({ ...current.view, x: current.view.x + dx, y: current.view.y + dy });
    }
  }

  // The press this event ended, or null: another finger's lift, or the end of a pinch.
  function release(event) {
    touches.delete(event.pointerId);
    if (pinch && touches.size < 2) {
      pinch = null;
      swallowClick();
    }
    const current = press;
    if (!current || current.id !== event.pointerId) {
      return null;
    }
    endPress(current);
    return current;
  }

  function pointerUp(event) {
    const current = release(event);
    if (!current) {
      return;
    }
    if (current.mode === null) {
      click(current, event);
      return;
    }
    lastClick = null;
    swallowClick();
    if (current.mode === 'move') {
      finishMove(current, event);
    } else if (current.mode === 'connect') {
      finishConnect(current, event);
    }
  }

  function pointerCancel(event) {
    const current = release(event);
    if (current?.mode === 'move') {
      host.preview(current.base);
    }
  }

  function wheel(event) {
    event.preventDefault();
    host.settle();
    const view = host.view();
    if (event.ctrlKey || event.metaKey) {
      const rect = canvas.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      host.setView(zoomView(view, view.k * wheelZoomFactor(event.deltaY, event.deltaMode), point));
    } else {
      host.setView({ x: view.x - event.deltaX, y: view.y - event.deltaY, k: view.k });
    }
  }

  function forget() {
    press = null;
    touches.clear();
    pinch = null;
    lastClick = null;
  }

  return {
    // The canvas just drawn: every gesture on the one before it is over.
    attach(next) {
      forget();
      canvas = next;
      canvas.addEventListener('pointerdown', pointerDown);
      canvas.addEventListener('pointermove', pointerMove);
      canvas.addEventListener('pointerup', pointerUp);
      canvas.addEventListener('pointercancel', pointerCancel);
      canvas.addEventListener('wheel', wheel, { passive: false });
    },
    // The canvas is gone from the page and none took its place.
    detach() {
      forget();
      canvas = null;
    },
    cancel,
    pressing: () => press !== null,
    // True once for the click that ends a drag or a pinch, which is no click on the page.
    takeClick() {
      const swallowed = justPanned;
      justPanned = false;
      return swallowed;
    },
  };
}
