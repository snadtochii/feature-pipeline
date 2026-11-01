// The field that renames a box or an arrow on the diagram canvas: laid over what it renames, inside
// the pane. It owns the open field and hands the typed text to `finished`; what the text does to
// the document is the caller's.

import { arrowGeometry, boxSize } from './diagram.js';

const RENAME_HEIGHT = 28;
const RENAME_BOX_MIN = 160;
const RENAME_ARROW_WIDTH = 180;

// `view()` and `document()` are the view and the document drawn. `finished(target, value, keep)`
// says the field closed on `target`, as `open` was given it: `keep` for Enter, a blur or a commit
// the caller asked for, not for Escape or an abandon.
export function createRenameField({ pane, view, document: drawn, finished }) {
  // The field open: `open`'s target plus its { input }; null when closed.
  let rename = null;

  // Lays the field over the box, or centred on the arrow's label point, inside the pane.
  function place(input, type, entry) {
    const { x: vx, y: vy, k } = view();
    let width;
    let left;
    let top;
    if (type === 'box') {
      const { w, h } = boxSize(entry);
      width = Math.max(RENAME_BOX_MIN, w * k);
      left = entry.x * k + vx + (w * k - width) / 2;
      top = (entry.y + h / 2) * k + vy - RENAME_HEIGHT / 2;
    } else {
      const shape = arrowGeometry(drawn()).find((item) => item.id === entry.id);
      width = RENAME_ARROW_WIDTH;
      left = shape.lx * k + vx - width / 2;
      top = shape.ly * k + vy - RENAME_HEIGHT / 2;
    }
    width = Math.min(width, Math.max(0, pane.clientWidth - 8));
    input.style.width = `${width}px`;
    input.style.left = `${Math.min(Math.max(4, pane.clientWidth - width - 4), Math.max(4, left))}px`;
    input.style.top = `${Math.min(Math.max(4, pane.clientHeight - RENAME_HEIGHT - 4), Math.max(4, top))}px`;
  }

  function finish(keep) {
    if (rename === null) {
      return;
    }
    const target = rename;
    rename = null;
    const { value } = target.input;
    target.input.remove();
    finished(target, value, keep);
  }

  // `target` is { type, id }, with whatever else `finished` needs. Enter or a blur commits, Escape
  // cancels; both keys are marked handled on the field itself.
  function open(target) {
    finish(true);
    const doc = drawn();
    const entry = (target.type === 'box' ? doc.boxes : doc.arrows).find((item) => item.id === target.id);
    if (!entry) {
      return;
    }
    const input = pane.ownerDocument.createElement('input');
    input.className = 'd-rename';
    input.type = 'text';
    input.value = entry.label;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', target.type === 'box' ? 'Box label' : 'Arrow label');
    if (target.type === 'arrow') {
      input.placeholder = 'Label this arrow';
    }
    place(input, target.type, entry);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        finish(event.key === 'Enter');
      }
    });
    input.addEventListener('blur', () => finish(true));
    pane.append(input);
    rename = { ...target, input };
    setTimeout(() => {
      if (rename?.input === input) {
        input.focus();
        input.select();
      }
    }, 0);
  }

  return {
    open,
    finish,
    // The field goes with the nodes it sat in; its blur must not commit into the new drawing.
    forget() {
      rename = null;
    },
  };
}
