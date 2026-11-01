// The outline model for the margin viewer's Overview tab: it turns a checked overview document
// (CONTRACT.md §13) into groups of rows, one per folder scope entry, with folder rows above their files,
// and works out imported-by, candidate membership and bar fractions per file. It also counts
// notes per file, folder, candidate, box and arrow, for the tree, the outline and the diagram. It touches no DOM, so the
// self-test imports it in Node; app.js renders what it returns.

export const CANDIDATE_COLOURS = ['#3b82c4', '#d0702c', '#3f9a5a', '#9a5cc4', '#c49a2c', '#2c9a9a', '#c44f7a', '#7a8a3b'];

// `folder:<path>` counts folder notes, `file:<path>` file and range notes, `candidate:<name>`
// candidate notes, `box:<id>` and `arrow:<id>` box and arrow notes; a scope note counts nowhere.
export function noteCounts(annotations) {
  const counts = new Map();
  const add = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const a of annotations) {
    if (a.anchor.kind === 'candidate') {
      add(`candidate:${a.anchor.name}`);
    } else if (a.anchor.kind === 'box' || a.anchor.kind === 'arrow') {
      add(`${a.anchor.kind}:${a.anchor.id}`);
    } else if (a.anchor.path) {
      add(`${a.anchor.kind === 'folder' ? 'folder' : 'file'}:${a.anchor.path}`);
    }
  }
  return counts;
}

const byName = (a, b) => a.name.localeCompare(b.name);

function highestReadingAtLeastOne(files, field) {
  let max = 1;
  for (const file of files) {
    if (file[field] !== null && file[field] > max) {
      max = file[field];
    }
  }
  return max;
}

function longestEntryHolding(path, scope) {
  let best = null;
  let bestLength = -1;
  for (const entry of scope) {
    const length = entry === '.' ? 0 : entry.length;
    if ((entry === '.' || path.startsWith(`${entry}/`)) && length > bestLength) {
      best = entry;
      bestLength = length;
    }
  }
  return best;
}

const folderNode = (path, name) => ({ path, name, files: [], dirs: new Map() });

// `listed(anchor)` is the caller's anchor rule against the current listing.
export function buildOutline(doc, { listed }) {
  const byPath = new Map(doc.files.map((file) => [file.path, file]));
  const importedBy = new Map(doc.files.map((file) => [file.path, []]));
  for (const file of doc.files) {
    for (const target of file.imports) {
      importedBy.get(target)?.push(file.path);
    }
  }
  for (const list of importedBy.values()) {
    list.sort();
  }
  const membership = new Map();
  doc.candidates.forEach((candidate, index) => {
    for (const path of candidate.files) {
      if (!membership.has(path)) {
        membership.set(path, []);
      }
      membership.get(path).push(index);
    }
  });
  const candidatesOf = (path) => membership.get(path) ?? [];
  const maxChurn = highestReadingAtLeastOne(doc.files, 'churn');
  const maxIndent = highestReadingAtLeastOne(doc.files, 'indentation');

  const folderEntries = doc.scope.filter((entry) => !byPath.has(entry));
  const heads = new Map(folderEntries.map((entry) => [entry, folderNode(entry, entry)]));
  for (const file of doc.files) {
    const entry = longestEntryHolding(file.path, doc.scope) ?? '.';
    if (!heads.has(entry)) {
      heads.set(entry, folderNode('.', '.'));
    }
    const base = entry === '.' ? '' : `${entry}/`;
    const parts = file.path.slice(base.length).split('/');
    let node = heads.get(entry);
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!node.dirs.has(parts[i])) {
        node.dirs.set(parts[i], folderNode(base + parts.slice(0, i + 1).join('/'), parts[i]));
      }
      node = node.dirs.get(parts[i]);
    }
    node.files.push({ name: parts.at(-1), file });
  }

  const fileRow = ({ name, file }, depth) => {
    const slash = file.path.lastIndexOf('/');
    const folder = slash === -1 ? '' : file.path.slice(0, slash);
    return {
      type: 'file',
      path: file.path,
      name,
      depth,
      folder,
      file,
      candidates: candidatesOf(file.path),
      churnBar: file.churn === null ? null : file.churn / maxChurn,
      tangleBar: file.indentation === null ? null : file.indentation / maxIndent,
      listed: listed({ kind: 'file', path: file.path }),
      folderListed: folder !== '' && listed({ kind: 'folder', path: folder }),
    };
  };

  const rowsOf = (node, depth, rows) => {
    rows.push({
      type: 'folder',
      path: node.path,
      name: node.name,
      depth,
      files: node.files.length,
      folders: node.dirs.size,
      listed: node.path !== '.' && listed({ kind: 'folder', path: node.path }),
    });
    for (const entry of node.files.sort(byName)) {
      rows.push(fileRow(entry, depth + 1));
    }
    for (const dir of [...node.dirs.values()].sort(byName)) {
      rowsOf(dir, depth + 1, rows);
    }
    return rows;
  };

  const groups = [...heads].map(([entry, node]) => ({ entry, rows: rowsOf(node, 0, []) }));
  return { groups, byPath, importedBy, candidatesOf, maxChurn, maxIndent };
}
