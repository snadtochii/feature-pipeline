// The structural changes between two diagram documents (CONTRACT.md §6, "Round changes"):
// `diffDiagrams(before, after)` compares boxes and arrows by id and returns the op list a round
// records, in the contract's order — box ops before arrow ops, and within each collection the
// removals in `before`'s order, then the additions and the edits in `after`'s order. Positions,
// `files`, `why`, groups and walkthroughs are layout and never listed. It never mutates its
// inputs, touches no DOM and imports nothing, so the server and the viewer share it.

const byId = (entries) => new Map(entries.map((entry) => [entry.id, entry]));
const groupOf = (box) => box.group ?? null;
const sameEnds = (a, b) => a.from === b.from && a.to === b.to;

const removedBox = (box) => ({ op: 'remove-box', id: box.id, label: box.label });
const addedBox = (box) => ({ op: 'add-box', id: box.id, label: box.label, kind: box.kind, group: groupOf(box) });
const removedArrow = (arrow) => ({ op: 'remove-arrow', id: arrow.id, from: arrow.from, to: arrow.to, label: arrow.label });
const addedArrow = (arrow) => ({ op: 'add-arrow', id: arrow.id, from: arrow.from, to: arrow.to, label: arrow.label });

function boxEdits(was, now) {
  const ops = [];
  if (was.label !== now.label) {
    ops.push({ op: 'rename-box', id: now.id, was: was.label, now: now.label });
  }
  if (was.kind !== now.kind) {
    ops.push({ op: 'change-kind', id: now.id, was: was.kind, now: now.kind });
  }
  if (groupOf(was) !== groupOf(now)) {
    ops.push({ op: 'move-box', id: now.id, was: groupOf(was), now: groupOf(now) });
  }
  return ops;
}

function boxOps(before, after) {
  const old = byId(before);
  const current = byId(after);
  const removes = before.filter((box) => !current.has(box.id)).map(removedBox);
  const adds = after.filter((box) => !old.has(box.id)).map(addedBox);
  const edits = after.filter((box) => old.has(box.id)).flatMap((box) => boxEdits(old.get(box.id), box));
  return [...removes, ...adds, ...edits];
}

function arrowOps(before, after) {
  const old = byId(before);
  const current = byId(after);
  const rewired = (arrow) => old.has(arrow.id) && !sameEnds(old.get(arrow.id), arrow);
  const removes = before
    .filter((arrow) => !current.has(arrow.id) || !sameEnds(arrow, current.get(arrow.id)))
    .map(removedArrow);
  const adds = after.filter((arrow) => !old.has(arrow.id) || rewired(arrow)).map(addedArrow);
  const edits = after
    .filter((arrow) => old.has(arrow.id) && !rewired(arrow) && old.get(arrow.id).label !== arrow.label)
    .map((arrow) => ({ op: 'relabel-arrow', id: arrow.id, was: old.get(arrow.id).label, now: arrow.label }));
  return [...removes, ...adds, ...edits];
}

export function diffDiagrams(before, after) {
  return [...boxOps(before.boxes, after.boxes), ...arrowOps(before.arrows, after.arrows)];
}
