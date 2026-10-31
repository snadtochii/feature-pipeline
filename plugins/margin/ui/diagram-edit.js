// The edits a human makes to a diagram in margin's Diagram tab (CONTRACT §15), as pure functions
// over a document: each returns a new document, or the very document it was given when the edit
// does not apply (an unknown id, an empty box label, a self-loop), so a caller can tell a no-op
// by identity. Removing an arrow, directly or with its box, drops its id from every walkthrough
// step. It also owns the session's id allocation (`createIds`), where a dropped box lands
// (`dropFrames`, `groupAt`, `dropGroup`) and the save ordering (`createSaver`: one request in
// flight, the newest document sent next). It touches no DOM and imports only the model, so the
// self-test runs every edit through `checkDiagram`.

import { KINDS, groupFrames, layoutDiagram } from './diagram.js';

const ID_SUFFIX = /^(box|arrow)-(\d+)$/;

// `next('box' | 'arrow')` returns `<prefix>-<n>`, `n` one more than the largest numeric suffix
// of that prefix among the ids of `doc`, the ids in `seen` and every id returned before, skipping
// any id in use. `seen` holds ids the document no longer has but something still names — the
// round's starting file, a note's anchor — so a new box never takes a removed one's identity.
export function createIds(doc, seen = []) {
  const used = new Set();
  const largest = { box: 0, arrow: 0 };
  for (const id of [...doc.groups, ...doc.boxes, ...doc.arrows].map((entry) => entry.id).concat(seen)) {
    used.add(id);
    const match = ID_SUFFIX.exec(id);
    const n = match ? Number(match[2]) : 0;
    if (match && Number.isSafeInteger(n)) {
      largest[match[1]] = Math.max(largest[match[1]], n);
    }
  }
  return {
    next(prefix) {
      let id;
      do {
        largest[prefix] += 1;
        id = `${prefix}-${largest[prefix]}`;
      } while (used.has(id));
      used.add(id);
      return id;
    },
  };
}

const findBox = (doc, id) => doc.boxes.findIndex((box) => box.id === id);
const findArrow = (doc, id) => doc.arrows.findIndex((arrow) => arrow.id === id);

function editBox(doc, id, change) {
  const index = findBox(doc, id);
  if (index === -1) {
    return doc;
  }
  const next = structuredClone(doc);
  change(next.boxes[index]);
  return next;
}

function withoutArrows(doc, ids) {
  doc.arrows = doc.arrows.filter((arrow) => !ids.has(arrow.id));
  for (const walkthrough of doc.walkthroughs) {
    for (const step of walkthrough.steps) {
      step.arrows = step.arrows.filter((arrowId) => !ids.has(arrowId));
    }
  }
  return doc;
}

export function addBox(doc, { id, x, y, label, group }) {
  const text = label.trim();
  if (text === '' || findBox(doc, id) !== -1) {
    return doc;
  }
  const box = { id, label: text, kind: 'concept', files: [] };
  if (group !== null && group !== undefined && doc.groups.some((entry) => entry.id === group)) {
    box.group = group;
  }
  box.x = Math.round(x);
  box.y = Math.round(y);
  const next = structuredClone(doc);
  next.boxes.push(box);
  return next;
}

export function renameBox(doc, id, label) {
  const text = label.trim();
  const index = findBox(doc, id);
  if (text === '' || index === -1 || doc.boxes[index].label === text) {
    return doc;
  }
  return editBox(doc, id, (box) => {
    box.label = text;
  });
}

export function setKind(doc, id, kind) {
  const index = findBox(doc, id);
  if (!KINDS.includes(kind) || index === -1 || doc.boxes[index].kind === kind) {
    return doc;
  }
  return editBox(doc, id, (box) => {
    box.kind = kind;
  });
}

// `group` null takes the box out of every group.
export function setGroup(doc, id, group) {
  const index = findBox(doc, id);
  if (index === -1 || (group !== null && !doc.groups.some((entry) => entry.id === group))) {
    return doc;
  }
  if ((doc.boxes[index].group ?? null) === group) {
    return doc;
  }
  return editBox(doc, id, (box) => {
    if (group === null) {
      delete box.group;
    } else {
      box.group = group;
    }
  });
}

export function moveBox(doc, id, x, y) {
  const index = findBox(doc, id);
  const [left, top] = [Math.round(x), Math.round(y)];
  if (index === -1 || (doc.boxes[index].x === left && doc.boxes[index].y === top)) {
    return doc;
  }
  return editBox(doc, id, (box) => {
    box.x = left;
    box.y = top;
  });
}

export function removeBox(doc, id) {
  if (findBox(doc, id) === -1) {
    return doc;
  }
  const next = structuredClone(doc);
  next.boxes = next.boxes.filter((box) => box.id !== id);
  const touching = new Set(doc.arrows.filter((arrow) => arrow.from === id || arrow.to === id).map((arrow) => arrow.id));
  return withoutArrows(next, touching);
}

export function connect(doc, { id, from, to }) {
  if (from === to || findBox(doc, from) === -1 || findBox(doc, to) === -1 || findArrow(doc, id) !== -1) {
    return doc;
  }
  const next = structuredClone(doc);
  next.arrows.push({ id, from, to, label: '', why: '' });
  return next;
}

export function relabelArrow(doc, id, label) {
  const index = findArrow(doc, id);
  const text = label.trim();
  if (index === -1 || doc.arrows[index].label === text) {
    return doc;
  }
  const next = structuredClone(doc);
  next.arrows[index].label = text;
  return next;
}

export function removeArrow(doc, id) {
  if (findArrow(doc, id) === -1) {
    return doc;
  }
  return withoutArrows(structuredClone(doc), new Set([id]));
}

export function relayout(doc) {
  return layoutDiagram(doc, { all: true });
}

// The document the viewer edits: every box positioned, stored positions kept.
export function freeze(doc) {
  return layoutDiagram(doc);
}

// The group frames a dragged box can drop into: computed without that box, so its own frame
// does not follow it.
export function dropFrames(doc, id) {
  return groupFrames({ ...doc, boxes: doc.boxes.filter((box) => box.id !== id) });
}

// The id of the last frame in `frames` holding `point`, or null.
export function groupAt(frames, point) {
  let hit = null;
  for (const frame of frames) {
    if (point.x >= frame.x && point.x <= frame.x + frame.w && point.y >= frame.y && point.y <= frame.y + frame.h) {
      hit = frame.id;
    }
  }
  return hit;
}

// The group box `id` belongs to once dropped with its centre at `point`: the group whose frame
// holds the point, else the group it already had (null for none).
export function dropGroup(doc, id, point, frames) {
  const index = findBox(doc, id);
  const current = index === -1 ? null : doc.boxes[index].group ?? null;
  return groupAt(frames, point) ?? current;
}

// Orders the saves of one session. `send(doc)` returns a promise that rejects with an error
// carrying the HTTP `status` (0 when there was no reply). One request is in flight at a time; a
// save made meanwhile replaces any document still waiting, so the newest is sent next. A 4xx
// drops the waiting document; a failure without a 4xx keeps the newest unsaved one for
// `retry()`, and the next `save` sends its own document instead. `state` is
// `{ phase: 'idle' | 'saving' | 'failed', status, error, saved }`, `saved` the last document
// the server accepted; `onChange(state)` hears every change of phase. `flush()` resolves with
// the state once nothing is waiting or in flight.
export function createSaver(send, { saved = null, onChange = () => {} } = {}) {
  let state = { phase: 'idle', status: 0, error: '', saved };
  let flying = false;
  let waiting = null;
  let held = null;
  const idlers = [];
  const set = (changes) => {
    state = { ...state, ...changes };
    onChange(state);
  };
  const settle = () => {
    if (!flying && waiting === null) {
      idlers.splice(0).forEach((done) => done(state));
    }
  };
  const fly = () => {
    if (flying || waiting === null) {
      settle();
      return;
    }
    const doc = waiting;
    waiting = null;
    held = null;
    flying = true;
    set({ phase: 'saving', status: 0, error: '' });
    let sent;
    try {
      sent = Promise.resolve(send(doc));
    } catch (err) {
      sent = Promise.reject(err);
    }
    sent.then(
      () => {
        flying = false;
        if (waiting === null) {
          set({ phase: 'idle', saved: doc });
        } else {
          state = { ...state, saved: doc };
        }
        fly();
      },
      (err) => {
        flying = false;
        const status = Number.isInteger(err?.status) ? err.status : 0;
        if (status < 400 || status >= 500) {
          held = waiting ?? doc;
        }
        waiting = null;
        set({ phase: 'failed', status, error: String(err?.message ?? err) });
        settle();
      },
    );
  };
  return {
    get state() {
      return state;
    },
    save(doc) {
      waiting = doc;
      fly();
    },
    retry() {
      if (waiting === null && held !== null) {
        waiting = held;
      }
      fly();
    },
    flush() {
      return new Promise((done) => {
        idlers.push(done);
        settle();
      });
    },
  };
}
