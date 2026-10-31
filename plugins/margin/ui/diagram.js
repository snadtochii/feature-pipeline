// The diagram model for margin (CONTRACT.md §15): the single definition of a valid diagram
// document, its canonical text, and its layered layout. `checkDiagram` returns a copy rebuilt
// from the known keys in canonical order, or throws a `DiagramViolation` naming the first
// violation by its location; `serializeDiagram` writes a checked document in canonical form.
// It touches no DOM and imports nothing, so the server, the self-test and the viewer all load it.

export const KINDS = Object.freeze(['module', 'process', 'agent', 'actor', 'store', 'concept']);

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const DRIVE = /^[A-Za-z]:/;

const KEYS = {
  document: ['groups', 'boxes', 'arrows', 'walkthroughs'],
  group: ['id', 'label'],
  box: ['id', 'label', 'kind', 'files', 'group', 'x', 'y'],
  arrow: ['id', 'from', 'to', 'label', 'why'],
  walkthrough: ['name', 'steps'],
  step: ['arrows', 'text'],
};

export class DiagramViolation extends Error {}

function violation(text) {
  throw new DiagramViolation(text);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value) {
  return typeof value === 'string';
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

function isId(value) {
  return typeof value === 'string' && ID.test(value);
}

function isPosition(value) {
  return Number.isSafeInteger(value);
}

function isDiagramPath(value) {
  return isNonEmptyString(value)
    && !value.includes('\\')
    && !value.startsWith('/')
    && !DRIVE.test(value)
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function at(loc, key) {
  return loc === '' ? key : `${loc}.${key}`;
}

function entryShape(entry, loc, allowed) {
  if (!isObject(entry)) {
    violation(loc === '' ? 'the document is not an object' : `${loc} is not an object`);
  }
  const unknown = Object.keys(entry).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    violation(`${loc === '' ? 'the document' : loc} has unknown key ${unknown}`);
  }
}

function field(entry, key, loc, test, expected) {
  if (!Object.hasOwn(entry, key)) {
    violation(`missing key ${at(loc, key)}`);
  }
  const value = entry[key];
  if (!test(value)) {
    violation(`${at(loc, key)} is not ${expected}`);
  }
  return value;
}

function checkFiles(entry, loc) {
  const files = [...field(entry, 'files', loc, Array.isArray, 'an array')];
  const seen = new Map();
  files.forEach((path, j) => {
    if (!isDiagramPath(path)) {
      violation(`${loc}.files[${j}] is not a diagram path`);
    }
    if (seen.has(path)) {
      violation(`${loc}.files[${j}] duplicates ${loc}.files[${seen.get(path)}]`);
    }
    seen.set(path, j);
  });
  return files;
}

function checkPosition(entry, loc) {
  const hasX = Object.hasOwn(entry, 'x');
  if (hasX !== Object.hasOwn(entry, 'y')) {
    violation(`${loc}.x and ${loc}.y must be given together`);
  }
  if (!hasX) {
    return {};
  }
  return {
    x: field(entry, 'x', loc, isPosition, 'a safe integer'),
    y: field(entry, 'y', loc, isPosition, 'a safe integer'),
  };
}

function checkGroup(entry, loc) {
  entryShape(entry, loc, KEYS.group);
  return {
    id: field(entry, 'id', loc, isId, 'an id'),
    label: field(entry, 'label', loc, isNonEmptyString, 'a non-empty string'),
  };
}

function checkBox(entry, loc) {
  entryShape(entry, loc, KEYS.box);
  const id = field(entry, 'id', loc, isId, 'an id');
  const label = field(entry, 'label', loc, isNonEmptyString, 'a non-empty string');
  const kind = field(entry, 'kind', loc, (value) => KINDS.includes(value), `one of ${KINDS.join(', ')}`);
  const files = checkFiles(entry, loc);
  const group = Object.hasOwn(entry, 'group') ? { group: field(entry, 'group', loc, isId, 'an id') } : {};
  return { id, label, kind, files, ...group, ...checkPosition(entry, loc) };
}

function checkArrow(entry, loc) {
  entryShape(entry, loc, KEYS.arrow);
  return {
    id: field(entry, 'id', loc, isId, 'an id'),
    from: field(entry, 'from', loc, isId, 'an id'),
    to: field(entry, 'to', loc, isId, 'an id'),
    label: field(entry, 'label', loc, isString, 'a string'),
    why: field(entry, 'why', loc, isString, 'a string'),
  };
}

function checkStep(entry, loc) {
  entryShape(entry, loc, KEYS.step);
  const arrows = [...field(entry, 'arrows', loc, Array.isArray, 'an array')];
  arrows.forEach((id, k) => {
    if (!isId(id)) {
      violation(`${loc}.arrows[${k}] is not an id`);
    }
  });
  return { arrows, text: field(entry, 'text', loc, isNonEmptyString, 'a non-empty string') };
}

function checkWalkthrough(entry, loc) {
  entryShape(entry, loc, KEYS.walkthrough);
  const name = field(entry, 'name', loc, isNonEmptyString, 'a non-empty string');
  const steps = field(entry, 'steps', loc, (value) => Array.isArray(value) && value.length > 0, 'a non-empty array');
  return { name, steps: steps.map((step, j) => checkStep(step, `${loc}.steps[${j}]`)) };
}

function indexBy(list, collection, key) {
  const index = new Map();
  list.forEach((entry, i) => {
    if (index.has(entry[key])) {
      violation(`${collection}[${i}].${key} duplicates ${collection}[${index.get(entry[key])}].${key}`);
    }
    index.set(entry[key], i);
  });
  return index;
}

function checkReferences(doc, ids) {
  doc.boxes.forEach((box, i) => {
    if (box.group !== undefined && !ids.groups.has(box.group)) {
      violation(`boxes[${i}].group names no group ${box.group}`);
    }
  });
  doc.arrows.forEach((arrow, i) => {
    for (const end of ['from', 'to']) {
      if (!ids.boxes.has(arrow[end])) {
        violation(`arrows[${i}].${end} names no box ${arrow[end]}`);
      }
    }
  });
  doc.walkthroughs.forEach((walkthrough, i) => {
    walkthrough.steps.forEach((step, j) => {
      step.arrows.forEach((id, k) => {
        if (!ids.arrows.has(id)) {
          violation(`walkthroughs[${i}].steps[${j}].arrows[${k}] names no arrow ${id}`);
        }
      });
    });
  });
}

export function checkDiagram(value) {
  entryShape(value, '', KEYS.document);
  const lists = Object.fromEntries(KEYS.document.map((key) => [key, field(value, key, '', Array.isArray, 'an array')]));
  const doc = {
    groups: lists.groups.map((entry, i) => checkGroup(entry, `groups[${i}]`)),
    boxes: lists.boxes.map((entry, i) => checkBox(entry, `boxes[${i}]`)),
    arrows: lists.arrows.map((entry, i) => checkArrow(entry, `arrows[${i}]`)),
    walkthroughs: lists.walkthroughs.map((entry, i) => checkWalkthrough(entry, `walkthroughs[${i}]`)),
  };
  const ids = {
    groups: indexBy(doc.groups, 'groups', 'id'),
    boxes: indexBy(doc.boxes, 'boxes', 'id'),
    arrows: indexBy(doc.arrows, 'arrows', 'id'),
  };
  indexBy(doc.walkthroughs, 'walkthroughs', 'name');
  checkReferences(doc, ids);
  return doc;
}

function canonicalEntry(entry, keys) {
  return JSON.stringify(Object.fromEntries(keys.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]])));
}

function arrayBlock(key, items, indent, closing) {
  if (items.length === 0) {
    return [`${indent}${JSON.stringify(key)}: []${closing}`];
  }
  return [
    `${indent}${JSON.stringify(key)}: [`,
    ...items.map((lines, i) => {
      const last = lines.length - 1;
      const comma = i < items.length - 1 ? ',' : '';
      return lines.map((line, k) => `${indent}  ${line}${k === last ? comma : ''}`).join('\n');
    }),
    `${indent}]${closing}`,
  ];
}

function walkthroughLines(walkthrough) {
  return [
    '{',
    `  "name": ${JSON.stringify(walkthrough.name)},`,
    ...arrayBlock('steps', walkthrough.steps.map((step) => [canonicalEntry(step, KEYS.step)]), '  ', ''),
    '}',
  ];
}

export function serializeDiagram(doc) {
  const line = (keys) => (entry) => [canonicalEntry(entry, keys)];
  return [
    '{',
    ...arrayBlock('groups', doc.groups.map(line(KEYS.group)), '  ', ','),
    ...arrayBlock('boxes', doc.boxes.map(line(KEYS.box)), '  ', ','),
    ...arrayBlock('arrows', doc.arrows.map(line(KEYS.arrow)), '  ', ','),
    ...arrayBlock('walkthroughs', doc.walkthroughs.map(walkthroughLines), '  ', ''),
    '}',
  ].join('\n') + '\n';
}

export const BOX_HEIGHT = 46;

const ORIGIN = 60;
const RANK_STEP = 330;
const ROW_STEP = 80;
const BAND_GAP = 80;
const FRAME_PAD = 20;
const FRAME_LABEL = 24;
const CLEAR = 24;
const SWEEPS = 4;

export function boxSize(box) {
  const n = [...box.label].length;
  return { w: Math.min(230, Math.max(120, Math.round(n * 7.4 + 34))), h: BOX_HEIGHT };
}

function isPositioned(box) {
  return box.x !== undefined && box.y !== undefined;
}

function acyclicRankingEdges(count, out) {
  const OPEN = 1;
  const CLOSED = 2;
  const state = new Array(count).fill(0);
  const edges = [];
  for (let root = 0; root < count; root++) {
    if (state[root] !== 0) {
      continue;
    }
    state[root] = OPEN;
    const stack = [[root, 0]];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const [node, next] = top;
      if (next === out[node].length) {
        state[node] = CLOSED;
        stack.pop();
        continue;
      }
      top[1] = next + 1;
      const target = out[node][next];
      if (state[target] === OPEN) {
        edges.push([target, node]);
      } else {
        edges.push([node, target]);
        if (state[target] === 0) {
          state[target] = OPEN;
          stack.push([target, 0]);
        }
      }
    }
  }
  return edges;
}

function longestPathRanks(count, edges) {
  const succ = Array.from({ length: count }, () => []);
  const indegree = new Array(count).fill(0);
  for (const [from, to] of edges) {
    succ[from].push(to);
    indegree[to] += 1;
  }
  const rank = new Array(count).fill(0);
  const queue = [];
  for (let i = 0; i < count; i++) {
    if (indegree[i] === 0) {
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const from = queue[head];
    for (const to of succ[from]) {
      rank[to] = Math.max(rank[to], rank[from] + 1);
      indegree[to] -= 1;
      if (indegree[to] === 0) {
        queue.push(to);
      }
    }
  }
  return rank;
}

function barycenterPass(layers, layout, down) {
  const { adjacent, rank, band, position, place } = layout;
  const order = down
    ? layers.map((_, r) => r).slice(1)
    : layers.map((_, r) => r).slice(0, -1).reverse();
  for (const r of order) {
    const layer = layers[r];
    const near = down ? r - 1 : r + 1;
    const current = new Map(layer.map((box, k) => [box, k]));
    const key = new Map(layer.map((box) => {
      const neighbours = adjacent[box].filter((other) => rank[other] === near);
      const mean = neighbours.reduce((sum, other) => sum + position[other], 0) / neighbours.length;
      return [box, neighbours.length === 0 ? position[box] : mean];
    }));
    layer.sort((a, b) => band[a] - band[b] || key.get(a) - key.get(b) || current.get(a) - current.get(b));
    place(layer);
  }
}

function computedPositions(doc) {
  const count = doc.boxes.length;
  const index = new Map(doc.boxes.map((box, i) => [box.id, i]));
  const out = doc.boxes.map(() => []);
  const adjacent = doc.boxes.map(() => []);
  for (const arrow of doc.arrows) {
    const from = index.get(arrow.from);
    const to = index.get(arrow.to);
    if (from !== to) {
      out[from].push(to);
      adjacent[from].push(to);
      adjacent[to].push(from);
    }
  }
  const rank = longestPathRanks(count, acyclicRankingEdges(count, out));
  const layers = Array.from({ length: Math.max(0, ...rank) + 1 }, () => []);
  doc.boxes.forEach((_, i) => {
    layers[rank[i]].push(i);
  });

  const position = new Array(count).fill(0);
  const flat = { adjacent, rank, band: new Array(count).fill(0), position, place: (layer) => {
    layer.forEach((box, k) => {
      position[box] = k;
    });
  } };
  layers.forEach(flat.place);
  barycenterPass(layers, flat, true);
  barycenterPass(layers, flat, false);

  const groupIndex = new Map(doc.groups.map((group, g) => [group.id, g]));
  const members = doc.groups.map(() => []);
  doc.boxes.forEach((box, i) => {
    if (box.group !== undefined) {
      members[groupIndex.get(box.group)].push(position[i]);
    }
  });
  const mean = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
  const bandOrder = doc.groups
    .map((_, g) => g)
    .filter((g) => members[g].length > 0)
    .sort((a, b) => mean(members[a]) - mean(members[b]) || a - b);
  const bandOfGroup = new Map(bandOrder.map((g, b) => [g, b]));
  const ungrouped = bandOrder.length;
  const band = doc.boxes.map((box) => (box.group === undefined ? ungrouped : bandOfGroup.get(groupIndex.get(box.group))));

  const slots = new Array(ungrouped + 1).fill(0);
  for (const layer of layers) {
    const counts = new Array(ungrouped + 1).fill(0);
    for (const box of layer) {
      counts[band[box]] += 1;
    }
    counts.forEach((n, b) => {
      slots[b] = Math.max(slots[b], n);
    });
  }
  const offset = [];
  slots.reduce((top, n, b) => {
    offset[b] = top;
    return top + n * ROW_STEP + BAND_GAP;
  }, 0);

  const banded = { adjacent, rank, band, position, place: (layer) => {
    const used = new Array(ungrouped + 1).fill(0);
    for (const box of layer) {
      position[box] = offset[band[box]] + used[band[box]] * ROW_STEP;
      used[band[box]] += 1;
    }
  } };
  for (const layer of layers) {
    const current = new Map(layer.map((box, k) => [box, k]));
    layer.sort((a, b) => band[a] - band[b] || current.get(a) - current.get(b));
    banded.place(layer);
  }
  for (let pass = 0; pass < SWEEPS; pass++) {
    barycenterPass(layers, banded, pass % 2 === 0);
  }
  return doc.boxes.map((_, i) => ({ x: ORIGIN + rank[i] * RANK_STEP, y: ORIGIN + FRAME_LABEL + position[i] }));
}

function rectOf(box, x, y) {
  const { w, h } = boxSize(box);
  return { x, y, w, h };
}

function tooClose(a, b) {
  return a.x - CLEAR < b.x + b.w && b.x - CLEAR < a.x + a.w
    && a.y - CLEAR < b.y + b.h && b.y - CLEAR < a.y + a.h;
}

// Returns a new document in which every box has a position. Without `all`, a positioned box
// keeps its own, and a placed box steps down a row at a time until it clears every box already
// standing; with `all`, every box takes the computed layout.
export function layoutDiagram(doc, { all = false } = {}) {
  const result = structuredClone(doc);
  const partial = !all && result.boxes.some(isPositioned);
  if (!all && result.boxes.every(isPositioned)) {
    return result;
  }
  const computed = computedPositions(result);
  const standing = partial
    ? result.boxes.filter(isPositioned).map((box) => rectOf(box, box.x, box.y))
    : [];
  result.boxes.forEach((box, i) => {
    if (!all && isPositioned(box)) {
      return;
    }
    let { x, y } = computed[i];
    if (partial) {
      while (standing.some((other) => tooClose(rectOf(box, x, y), other))) {
        y += ROW_STEP;
      }
      standing.push(rectOf(box, x, y));
    }
    box.x = x;
    box.y = y;
  });
  return result;
}

// The frame of each group with at least one positioned member, in `groups` order: the members'
// bounds plus FRAME_PAD on every side and FRAME_LABEL more above for the label.
export function groupFrames(doc) {
  const frames = [];
  for (const group of doc.groups) {
    const rects = doc.boxes
      .filter((box) => box.group === group.id && isPositioned(box))
      .map((box) => rectOf(box, box.x, box.y));
    if (rects.length === 0) {
      continue;
    }
    const left = Math.min(...rects.map((r) => r.x));
    const top = Math.min(...rects.map((r) => r.y));
    const right = Math.max(...rects.map((r) => r.x + r.w));
    const bottom = Math.max(...rects.map((r) => r.y + r.h));
    frames.push({
      id: group.id,
      x: left - FRAME_PAD,
      y: top - FRAME_PAD - FRAME_LABEL,
      w: right - left + 2 * FRAME_PAD,
      h: bottom - top + 2 * FRAME_PAD + FRAME_LABEL,
    });
  }
  return frames;
}
