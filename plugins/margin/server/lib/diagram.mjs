// The diagram file for the margin command (CONTRACT §15). `readDiagram` bounds, reads and parses
// a file, checks it with the shared model in `ui/diagram.js`, and reports whether its text is
// already canonical. Every refusal is a `RunError` with exit 1, so `cli.mjs` stays the only
// place that exits; the model stays free of Node so the viewer can load it too. `linkedFiles`
// is a diagram session's listing (CONTRACT §10), `runListing` an `annotate` run's,
// `diagramSessionInputs` everything a diagram session reads before its port is bound
// (CONTRACT §1), `diagramWriter` the save of a diagram session or an `annotate` run and the
// re-read of a file the agent redrew, and `restoreBaseline` a resumed run's round starting file.
// `diffDiagrams` is the shared change model a Send records (CONTRACT §6), re-exported so
// `cli.mjs` hands it to the server without importing `ui/`.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DiagramViolation, checkDiagram, serializeDiagram } from '../../ui/diagram.js';
import { gitRoot, listFiles, listPaths } from './files.mjs';
import { RunError, writeAtomic } from './session.mjs';

export { diffDiagrams } from '../../ui/diagram-diff.js';

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
  return { document, text, canonical: text === serializeDiagram(document) };
}

const CHANGED_ON_DISK = { status: 409, error: 'the diagram file changed on disk' };

// The save of a diagram session or an `annotate` run (CONTRACT §8, `PUT /api/diagram`). `text`
// is the file's text as the run read it; every successful save replaces it with the text written,
// and a save finding any other text on disk writes nothing. `save(document)` returns
// `{ status: 200, document }` with the checked document once its canonical text is written, or
// `{ status: 400 | 409, error }` with the file untouched; a failed write throws.
// `reread()` reads and checks the file again, for a reply after the agent may have redrawn it:
// `{ status: 400, error }` when it is refused, else `{ status: 200, document, adopt }`, where
// `adopt()` makes the re-read text the one the next save compares the file with. The caller
// adopts only once the reply is accepted, so a refused reply leaves the writer as it was.
export function diagramWriter(file, text) {
  let last = text;
  return {
    reread() {
      let read;
      try {
        read = readDiagram(file);
      } catch (err) {
        if (err instanceof RunError) {
          return { status: 400, error: err.message };
        }
        throw err;
      }
      return {
        status: 200,
        document: read.document,
        adopt() {
          last = read.text;
        },
      };
    },
    save(document) {
      if (document === null || typeof document !== 'object' || Array.isArray(document)) {
        return { status: 400, error: 'document is not an object' };
      }
      let checked;
      try {
        checked = checkDiagram(document);
      } catch (err) {
        if (err instanceof DiagramViolation) {
          return { status: 400, error: err.message };
        }
        throw err;
      }
      const canonical = serializeDiagram(checked);
      if (Buffer.byteLength(canonical) > MAX_DIAGRAM_BYTES) {
        return { status: 400, error: 'diagram too large' };
      }
      let onDisk;
      try {
        onDisk = readFileSync(file, 'utf8');
      } catch {
        return CHANGED_ON_DISK;
      }
      if (onDisk !== last) {
        return CHANGED_ON_DISK;
      }
      writeAtomic(file, canonical);
      last = canonical;
      return { status: 200, document: checked };
    },
  };
}

// The current round's starting file of an `annotate` run (CONTRACT §5, §6): the notes file's
// `baseline` on a resume whose diagram is the one the file records, checked by §15, else
// `document`, the diagram as read now; null for a run without a diagram. A recorded baseline
// that fails §15 stops the run.
export function restoreBaseline(stored, out, diagramFile, document) {
  if (document === null) {
    return null;
  }
  const recorded = stored?.baseline;
  if (recorded === undefined || recorded === null || typeof stored.diagram !== 'string' || resolve(stored.diagram) !== diagramFile) {
    return document;
  }
  try {
    return checkDiagram(recorded);
  } catch (err) {
    if (err instanceof DiagramViolation) {
      throw new RunError(`${out}: baseline is malformed (${err.message}); fix it or pass another --out`, 1);
    }
    throw err;
  }
}

// Every path a box of `document` links that is a regular file under `root`, without `ownFiles`.
export function linkedFiles(root, document, ownFiles = []) {
  return listPaths(root, document.boxes.flatMap((box) => box.files), ownFiles);
}

// An `annotate` run's listing (CONTRACT §10). Without a diagram it is the scope's; with one, an
// empty scope lists the diagram's linked files instead of the whole root, and a scope lists its
// files and the linked ones together.
export function runListing(root, scope, ownFiles, document) {
  if (document === null) {
    return listFiles(root, scope, ownFiles);
  }
  const linked = linkedFiles(root, document, ownFiles);
  if (scope.length === 0) {
    return linked;
  }
  return [...new Set([...listFiles(root, scope, ownFiles), ...linked])].sort();
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
  const { document, text } = readDiagram(file);
  const real = realpathSync(file);
  let root;
  if (givenRoot === undefined) {
    root = realpathSync(gitRoot(dirname(real)) ?? dirname(real));
  } else if (isDirectory(givenRoot)) {
    root = realpathSync(givenRoot);
  } else {
    throw new RunError(`root ${givenRoot} is not a directory`, 1);
  }
  return { document, text, file: real, root, files: linkedFiles(root, document, [real]) };
}
