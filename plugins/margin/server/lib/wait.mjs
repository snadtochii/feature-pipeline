// Client half of `cli.mjs wait`: parses the URL a run printed on stderr and holds one request
// to the run's `GET /api/wait` open until the server answers — when the next round is sent or
// the run ends. One request, never polling. The token travels only in the `x-margin-token`
// header, and only to the 127.0.0.1 origin the URL names.

import http from 'node:http';
import { RunError } from './session.mjs';

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const URL_SHAPE = 'expected http://127.0.0.1:<port>/#<token>, the URL the run printed';

// The run URL is `http://127.0.0.1:<port>/#<token>`; anything else is refused before any
// request is made. The raw value is not echoed, since it carries the token.
export function parseRunUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new RunError(`bad run URL: ${URL_SHAPE}`, 2);
  }
  const token = url.hash.slice(1);
  const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '';
  const bare = url.pathname === '/' && url.search === '' && url.username === '' && url.password === '';
  if (!loopback || !bare || !TOKEN_PATTERN.test(token)) {
    throw new RunError(`bad run URL: ${URL_SHAPE}`, 2);
  }
  return { origin: url.origin, token };
}

// Resolves with the wait document the server answers. A request that cannot connect, or a
// connection that drops before the reply ends, rejects as an unreachable server; any reply
// other than a 200 wait document rejects with its status and error.
export function waitForRound({ url, after }) {
  const { origin, token } = parseRunUrl(url);
  const target = `${origin}/api/wait${after === undefined ? '' : `?after=${after}`}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        fn(value);
      }
    };
    const unreachable = (code) => settle(reject, new RunError(`server unreachable at ${origin}: ${code ?? 'connection closed'}`, 1));
    const req = http.get(target, { headers: { 'x-margin-token': token }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('aborted', () => unreachable());
      res.on('error', (err) => unreachable(err.code));
      res.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = null;
        }
        if (res.statusCode === 200 && body && typeof body.status === 'string') {
          settle(resolve, body);
          return;
        }
        settle(reject, new RunError(`wait: ${res.statusCode} ${body?.error ?? 'unexpected reply'}`, 1));
      });
      res.on('close', () => unreachable());
    });
    req.on('error', (err) => unreachable(err.code));
  });
}
