// Real mouse and keyboard input over CDP (CONTRACT.md §7).
//
// A click is a move, press and release at a point; a key press is a key-down
// and key-up carrying the key's code, so the page sees the same events a user
// would produce.
//
// Private to the implementation: only cli.mjs is a command.

const KEY_DEFS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

function keyDef(key) {
  if (Object.hasOwn(KEY_DEFS, key)) {
    return KEY_DEFS[key];
  }
  const upper = key.toUpperCase();
  const keyCode = /^[A-Z0-9]$/.test(upper) ? upper.charCodeAt(0) : 0;
  return { key, keyCode, text: key };
}

/** Left-click at a point in CSS pixels. */
export async function clickAt(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/** Press and release one named key or printable character. */
export async function pressKey(cdp, key) {
  const def = keyDef(key);
  const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode };
  await cdp.send('Input.dispatchKeyEvent', { type: def.text ? 'keyDown' : 'rawKeyDown', ...base, text: def.text, unmodifiedText: def.text });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** Insert text at the focused element as typed input. */
export async function insertText(cdp, text) {
  await cdp.send('Input.insertText', { text });
}
