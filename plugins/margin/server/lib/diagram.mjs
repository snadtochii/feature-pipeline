// The diagram file for the margin command (CONTRACT §15). `readDiagram` bounds, reads and parses
// a file, checks it with the shared model in `ui/diagram.js`, and reports whether its text is
// already canonical. Every refusal is a `RunError` with exit 1, so `cli.mjs` stays the only
// place that exits; the model stays free of Node so the viewer can load it too. `linkedFiles`
// is a diagram session's listing (CONTRACT §10), and `diagramSessionInputs` everything a
// diagram session reads before its port is bound (CONTRACT §1).

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DiagramViolation, checkDiagram, serializeDiagram } from '../../ui/diagram.js';
import { gitRoot, listPaths } from './files.mjs';
import { RunError } from './session.mjs';

export const MAX_DIAGRAM_BYTES = 2 * 1024 * 1024;

export function readDiagram(file) {
  const label = `diagram ${file}`;
  let stat;
  try {
    stat = statSync(file);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      throw new RunError(`${label}: not found`, 1);
    }
    throw new RunError(`${label}: could not be read (${err?.code ?? err?.message})`, 1);
  }
  if (!stat.isFile()) {
    throw new RunError(`${label}: not a regular file`, 1);
  }
  if (stat.size > MAX_DIAGRAM_BYTES) {
    throw new RunError(`${label}: ${(stat.size / 1024 / 1024).toFixed(1)} MB is above the ${MAX_DIAGRAM_BYTES / 1024 / 1024} MB diagram limit`, 1);
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new RunError(`${label}: could not be read (${err?.code ?? err?.message})`, 1);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RunError(`${label}: not valid JSON (${err.message})`, 1);
  }
  let document;
  try {
    document = checkDiagram(parsed);
  } catch (err) {
    if (err instanceof DiagramViolation) {
      throw new RunError(`${label}: ${err.message}`, 1);
    }
    throw err;
  }
  return { document, canonical: text === serializeDiagram(document) };
}

// Every path a box of `document` links that is a regular file under `root`, without `ownFiles`.
export function linkedFiles(root, document, ownFiles = []) {
  return listPaths(root, document.boxes.flatMap((box) => box.files), ownFiles);
}

function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// `givenRoot` is the resolved --root, or undefined: then the git top level of the diagram file's
// directory, else that directory. `file` and the root are real paths, so the own-file exclusion
// compares like with like.
export function diagramSessionInputs(file, givenRoot) {
  const { document } = readDiagram(file);
  const real = realpathSync(file);
  let root;
  if (givenRoot === undefined) {
    root = realpathSync(gitRoot(dirname(real)) ?? dirname(real));
  } else if (isDirectory(givenRoot)) {
    root = realpathSync(givenRoot);
  } else {
    throw new RunError(`root ${givenRoot} is not a directory`, 1);
  }
  return { document, file: real, root, files: linkedFiles(root, document, [real]) };
}
