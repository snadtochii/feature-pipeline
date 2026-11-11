// Server access for the dispatcher (CONTRACT.md §6).
//
// Mirrors the `personal-server` CLI's rules in owned code: base URL and token
// from the environment, else from the CLI's credential file, else the default
// base; the file held to the CLI's checks; a token from the file sent only to
// the origin that file names. Every message names a server by origin and a
// file by path and line number — never a token, a file line, or a URL that
// may carry userinfo.
//
// Private to the implementation: only dispatch.mjs is a command.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanHttpUrl, readCredentialFile } from '../../lib/credential-file.mjs';
import { ComputeError } from '../../lib/output.mjs';

export const DEFAULT_BASE_URL = 'http://localhost:7717';
export const REQUEST_TIMEOUT_MS = 10_000;

const URL_NAME = 'PERSONAL_SERVER_URL';
const TOKEN_NAME = 'PERSONAL_SERVER_CLIENT_TOKEN';
const FILE_ENV = 'PERSONAL_SERVER_CLI_CONFIG';

/** The names the dispatcher reads from the CLI's credential file. */
export const READ_NAMES = [URL_NAME, TOKEN_NAME];

const isSet = (value) => typeof value === 'string' && value !== '';

/**
 * Resolve where to send the request and with which token:
 * `{ apiBase, origin, token, tokenSource }`, `tokenSource` ∈ env | file | none.
 * `home` is `$HOME` (or undefined); the file is read only when the URL or the
 * token is missing from `env`, and a missing file reads as empty.
 */
export function resolveServerAccess(env, home) {
  const envUrl = isSet(env[URL_NAME]) ? env[URL_NAME] : undefined;
  const envToken = isSet(env[TOKEN_NAME]) ? env[TOKEN_NAME] : undefined;
  let file;
  if (isSet(env[FILE_ENV])) {
    if (!path.isAbsolute(env[FILE_ENV])) {
      throw new ComputeError(`${FILE_ENV} must be an absolute path`);
    }
    file = env[FILE_ENV];
  } else if (isSet(home)) {
    file = path.join(home, '.config', 'personal-server', 'cli.env');
  }
  const needsFile = (envUrl === undefined || envToken === undefined) && file !== undefined;
  const fileValues = (needsFile ? readCredentialFile(file, READ_NAMES) : null) ?? {};
  const fileUrl = isSet(fileValues[URL_NAME]) ? fileValues[URL_NAME] : undefined;
  const fileToken = isSet(fileValues[TOKEN_NAME]) ? fileValues[TOKEN_NAME] : undefined;

  const urlSource = envUrl !== undefined ? 'the environment' : fileUrl !== undefined ? file : 'the default';
  const base = (envUrl ?? fileUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const target = cleanHttpUrl(base);
  if (target === undefined) {
    throw new ComputeError(
      `${URL_NAME} from ${urlSource} is not an absolute http(s) URL without credentials, query or fragment`,
    );
  }

  if (envToken !== undefined) {
    return { apiBase: `${base}/api`, origin: target.origin, token: envToken, tokenSource: 'env' };
  }
  if (fileToken !== undefined) {
    const bound = cleanHttpUrl(fileUrl ?? DEFAULT_BASE_URL);
    if (bound === undefined) {
      throw new ComputeError(
        `${file} sets ${URL_NAME} to something that is not an absolute http(s) URL without credentials, query or fragment, so its client token is not sent`,
      );
    }
    if (bound.origin !== target.origin) {
      throw new ComputeError(
        `the client token from ${file} is bound to ${bound.origin}; the target ${target.origin} from ${URL_NAME} in the environment is a different server — export ${TOKEN_NAME} to use another server`,
      );
    }
    return { apiBase: `${base}/api`, origin: target.origin, token: fileToken, tokenSource: 'file' };
  }
  return { apiBase: `${base}/api`, origin: target.origin, token: undefined, tokenSource: 'none' };
}

const ROW_STRINGS = ['id', 'status', 'kind', 'created_at', 'updated_at'];
const ROW_ARRAYS = ['tags', 'blocked_by'];

/**
 * Keep the fields selection needs from each row; drop a malformed row with a
 * note. Returns `{ rows, notes }`. Pure.
 */
export function normalizeRows(body) {
  const rows = [];
  const notes = [];
  body.forEach((row, index) => {
    const label = row !== null && typeof row === 'object' && isSet(row.id) ? row.id : `#${index}`;
    if (row === null || typeof row !== 'object') {
      notes.push(`dropped malformed ticket row ${label}: not an object`);
      return;
    }
    const missing = [
      ...ROW_STRINGS.filter((key) => !isSet(row[key])),
      ...ROW_ARRAYS.filter((key) => !Array.isArray(row[key]) || row[key].some((item) => typeof item !== 'string')),
    ];
    if (missing.length > 0) {
      notes.push(`dropped malformed ticket row ${label}: bad ${missing.join(', ')}`);
      return;
    }
    rows.push({
      id: row.id,
      status: row.status,
      kind: row.kind,
      parent_id: isSet(row.parent_id) ? row.parent_id : null,
      tags: [...row.tags],
      blocked_by: [...row.blocked_by],
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  });
  return { rows, notes };
}

/**
 * One request to the server: the bearer header only when a token is set, a
 * timeout, no redirect followed, a JSON body when `body` is given. Returns
 * `{ status, body }`; a status in `allowStatus` is returned with a null body
 * instead of failing. Throws ComputeError naming the server by origin only —
 * a rejection carries the HTTP status as `err.status`.
 */
async function request(access, { method = 'GET', route, query, body, parse = true, allowStatus = [], fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const search = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`;
  const headers = { accept: 'application/json' };
  if (isSet(access.token)) {
    headers.authorization = `Bearer ${access.token}`;
  }
  const init = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetchImpl(`${access.apiBase}${route}${search}`, init);
  } catch {
    throw new ComputeError(`server unreachable at ${access.origin}`);
  }
  if (allowStatus.includes(response.status) || !parse) {
    await response.text().catch(() => '');
    if (allowStatus.includes(response.status) || (response.status >= 200 && response.status <= 299)) {
      return { status: response.status, body: null };
    }
  }
  if (response.status < 200 || response.status > 299) {
    const err = new ComputeError(`server rejected the request: HTTP ${response.status} (token source: ${access.tokenSource})`);
    err.status = response.status;
    throw err;
  }
  try {
    return { status: response.status, body: await response.json() };
  } catch {
    throw new ComputeError(`server at ${access.origin} answered with a body that is not JSON`);
  }
}

/**
 * List the project's tickets: `{ rows, notes, status }`. One request, a
 * 10-second timeout, no redirect followed, the bearer header only when a token
 * is set.
 */
export async function listTickets({ access, projectId, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const { status, body } = await request(access, { route: '/pipeline/tickets', query: { project_id: projectId }, fetchImpl, timeoutMs });
  if (!Array.isArray(body)) {
    throw new ComputeError(`server at ${access.origin} answered with something other than a ticket list`);
  }
  const { rows, notes } = normalizeRows(body);
  if (body.length === 0) {
    notes.unshift(`server returned no tickets for project ${projectId}`);
  }
  return { rows, notes, status };
}

/**
 * A pull-request URL as the server stored it, when it is an `https:` URL with
 * no userinfo, query or fragment; else null. Pure.
 */
export function cleanPrUrl(value) {
  if (!isSet(value)) {
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return null;
  }
  return url.href;
}

/**
 * Read one ticket: `{ found: false }` on 404, else
 * `{ found: true, row: { id, status, kind, pr_url } }`. Throws ComputeError
 * on any other failure, so the caller decides what an unknown state means.
 */
export async function getTicket({ access, projectId, ticketId, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const { status, body } = await request(access, {
    route: `/pipeline/tickets/${encodeURIComponent(ticketId)}`,
    query: { project_id: projectId },
    allowStatus: [404],
    fetchImpl,
    timeoutMs,
  });
  if (status === 404) {
    return { found: false };
  }
  if (body === null || typeof body !== 'object' || !isSet(body.id) || !isSet(body.status)) {
    throw new ComputeError(`server at ${access.origin} answered with something other than a ticket`);
  }
  return {
    found: true,
    row: { id: body.id, status: body.status, kind: isSet(body.kind) ? body.kind : null, pr_url: cleanPrUrl(body.pr_url) },
  };
}

/**
 * The server's registry name for the project UUID: `{ name, note }`, `name`
 * null with a `note` when it cannot be resolved. Never throws.
 */
export async function findProjectName({ access, projectId, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  let body;
  try {
    ({ body } = await request(access, { route: '/projects', fetchImpl, timeoutMs }));
  } catch (err) {
    return { name: null, note: `project name not resolved: ${err.status ? `HTTP ${err.status}` : err.message}` };
  }
  const want = projectId.toLowerCase();
  const match = Array.isArray(body)
    ? body.find((project) => project !== null && typeof project === 'object' && typeof project.id === 'string' && project.id.toLowerCase() === want)
    : undefined;
  if (match === undefined || !isSet(match.name)) {
    return { name: null, note: `project name not resolved: the server lists no project ${projectId}` };
  }
  return { name: match.name, note: null };
}

/**
 * Capture one inbox item: `{ ok, detail }`. Never throws; the body is sent as
 * given, `project` only when it is set.
 */
export async function captureInbox({ access, body, project, metadata, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const payload = { body, source: 'feature:dispatch', metadata, ...(isSet(project) ? { project } : {}) };
  try {
    const { status } = await request(access, { method: 'POST', route: '/inbox', body: payload, parse: false, fetchImpl, timeoutMs });
    return { ok: true, detail: `HTTP ${status}` };
  } catch (err) {
    return { ok: false, detail: err.status ? `HTTP ${err.status}` : err.message };
  }
}

/**
 * Send a run's inbox item: resolve the project's registry name, then capture.
 * Returns the `notes` lines the attempt produced — none when the item went out
 * with its project. Never throws.
 */
export async function sendInbox({ access, projectId, runId, body, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const notes = [];
  const project = await findProjectName({ access, projectId, fetchImpl, timeoutMs });
  if (project.note !== null) {
    notes.push(`inbox item sent without a project: ${project.note}`);
  }
  const sent = await captureInbox({
    access,
    body,
    project: project.name,
    metadata: { project_id: projectId, run_id: runId },
    fetchImpl,
    timeoutMs,
  });
  if (!sent.ok) {
    notes.push(`inbox capture failed: ${sent.detail}`);
  }
  return notes;
}

export const SIGNAL_REQUEST_TIMEOUT_MS = 5_000;
const SIGNAL_SEND_SLACK_MS = 2_000;
const INBOX_HELPER = fileURLToPath(new URL('./inbox-send.mjs', import.meta.url));

/**
 * `sendInbox` from a synchronous context — the teardown of a signalled run,
 * where no promise settles before the process exits. A helper `node` process
 * makes the requests, each with a 5-second timeout; the request, token
 * included, reaches it on stdin, never in its arguments or environment, and
 * the wait is bounded at 12 seconds. Returns the same `notes` lines. Never
 * throws.
 */
export function sendInboxSync({ access, projectId, runId, body, env, timeoutMs = SIGNAL_REQUEST_TIMEOUT_MS }) {
  const waitMs = 2 * timeoutMs + SIGNAL_SEND_SLACK_MS;
  const child = spawnSync(process.execPath, [INBOX_HELPER], {
    input: JSON.stringify({ access, projectId, runId, body, timeoutMs }),
    env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: waitMs,
    killSignal: 'SIGKILL',
  });
  if (child.error) {
    return [`inbox capture failed: ${child.error.code === 'ETIMEDOUT' ? `no answer within ${waitMs / 1000} seconds` : 'the helper could not run'}`];
  }
  if (child.status !== 0) {
    return [`inbox capture failed: the helper exited ${child.status ?? child.signal}`];
  }
  let doc;
  try {
    doc = JSON.parse(child.stdout);
  } catch {
    doc = null;
  }
  if (doc === null || !Array.isArray(doc.notes) || doc.notes.some((note) => typeof note !== 'string')) {
    return ['inbox capture failed: the helper printed no result'];
  }
  return doc.notes;
}
