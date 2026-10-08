// Minimal Chrome DevTools Protocol client over Node's global WebSocket.
//
// One connection per WebSocket URL (the browser endpoint or one page target).
// `send` correlates responses by id and bounds every call with a timeout; a
// closed socket rejects every pending call with a ComputeError, which is the
// "CDP lost" exit 1 of CONTRACT.md §3. A protocol-level error reply (a method
// failing, e.g. a context destroyed by navigation) rejects with a CdpError,
// which callers may retry.
//
// Private to the implementation: only cli.mjs is a command. This module, with
// chrome.mjs, drive.mjs, locate.mjs, input.mjs, auth.mjs's importAuth and
// doctor.mjs's debugging-port probe, is the transport the contract's switch rule would replace — every
// module that speaks to Chrome's debugging interface.

import { ComputeError } from './output.mjs';

/** A CDP method returned an error reply. */
export class CdpError extends Error {
  constructor(method, error) {
    super(`${method}: ${error && error.message ? error.message : 'protocol error'}`);
    this.code = error ? error.code : undefined;
  }
}

/** Throw a ComputeError unless this Node has a global WebSocket. */
export function requireWebSocket() {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new ComputeError(`Node 22 or newer with a global WebSocket is required (running ${process.version})`);
  }
}

function frameText(data) {
  if (typeof data === 'string') {
    return data;
  }
  return Buffer.from(data).toString('utf8');
}

export class CdpConnection {
  constructor(ws, url) {
    this.ws = ws;
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    ws.addEventListener('message', (event) => this.onMessage(event.data));
    ws.addEventListener('close', () => this.onClose());
    ws.addEventListener('error', () => this.onClose());
  }

  onMessage(data) {
    let message;
    try {
      message = JSON.parse(frameText(data));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const call = this.pending.get(message.id);
      if (call === undefined) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) {
        call.reject(new CdpError(call.method, message.error));
      } else {
        call.resolve(message.result || {});
      }
      return;
    }
    const fns = this.listeners.get(message.method);
    if (fns) {
      for (const fn of [...fns]) {
        fn(message.params || {});
      }
    }
  }

  onClose() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new ComputeError(`CDP connection lost during ${call.method}`));
    }
    this.pending.clear();
  }

  /** Send a CDP command; resolves with its result. */
  send(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (this.closed) {
      return Promise.reject(new ComputeError(`CDP connection lost before ${method}`));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(method, { message: `no reply within ${timeoutMs} ms` }));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new ComputeError(`CDP send failed for ${method}: ${err.message}`));
      }
    });
  }

  /** Subscribe to a CDP event; returns an unsubscribe function. */
  on(method, fn) {
    if (!this.listeners.has(method)) {
      this.listeners.set(method, new Set());
    }
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method).delete(fn);
  }

  /** Resolve with the next `method` event's params, or reject after `timeoutMs`. */
  waitFor(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
      const timer = setTimeout(() => {
        off();
        reject(new CdpError(method, { message: `no event within ${timeoutMs} ms` }));
      }, timeoutMs);
    });
  }

  close() {
    this.onClose();
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

/** Open a CDP connection to a WebSocket debugger URL. */
export function connect(url, { timeoutMs = 10000 } = {}) {
  requireWebSocket();
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      reject(new ComputeError(`cannot open CDP connection to ${url}: ${err.message}`));
      return;
    }
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new ComputeError(`CDP connection to ${url} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(new CdpConnection(ws, url));
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new ComputeError(`cannot connect to CDP at ${url}`));
    }, { once: true });
  });
}
