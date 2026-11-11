// The incident log reader's rules and verbs (../references/log-query.md):
// argument parsing, the configuration reader, credential resolution, the
// report gate, the query files, the request and the output documents.
//
// Private to the implementation: only incident.mjs is a command.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The invocation was wrong — exit 2. */
export class UsageError extends Error {}

/** The answer could not be computed — exit 1. */
export class ComputeError extends Error {}

const EXIT_CANNOT_COMPUTE = 1;
const EXIT_BAD_USAGE = 2;

const URL_NAME = 'INCIDENT_GRAFANA_URL';
const TOKEN_NAME = 'INCIDENT_GRAFANA_TOKEN';
const READ_NAMES = [URL_NAME, TOKEN_NAME];
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 10_000;

const INCIDENTS_DIR = ['claudedocs', 'incidents'];
const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{8}$/;
const QUERY_FILE_NAME = /^\.query-\d{8}-\d{6}-[0-9a-f]{8}\.logql$/;
const STALE_QUERY_MS = 60 * 60 * 1000;
const MAX_QUERY_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 16 * 1024;
const ELEMENT_INDENT = '    ';
const ARRAY_WRAP_BYTES = 8;
const MAX_LINE_CHARS = 4000;
const MAX_DETAIL_CHARS = 300;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DIRECTIONS = ['forward', 'backward'];

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNSAFE_VALUE = /[\s\p{Cc}]/u;
const KEY_LINE = /^([A-Za-z0-9_.-]+)\s*:(?:\s+(.*))?$/;
const DATASOURCE = /^[A-Za-z0-9_-]+$/;
const REPO_NAME = /^[A-Za-z0-9._-]+$/;
const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;
const COMMIT_SHA = /^[0-9a-f]{40,64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|([+-])([01]\d|2[0-3]):([0-5]\d))$/;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,3}$/;
const EPOCH_NANOSECONDS = /^\d{1,19}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;
const RESULT_TYPE = /^[a-z]{1,20}$/;

const USAGE =
  'usage: incident.mjs preflight --project-root <abs-path> [--repo <dir-name>] | ' +
  'incident.mjs query --project-root <abs-path> --run <run> --start <RFC3339> --end <RFC3339> [--limit <n>] [--direction forward|backward] | ' +
  'incident.mjs --self-test';

const FLAGS = {
  preflight: { '--project-root': 'projectRoot', '--repo': 'repo' },
  query: { '--project-root': 'projectRoot', '--run': 'run', '--start': 'start', '--end': 'end', '--limit': 'limit', '--direction': 'direction' },
};

const isSet = (value) => typeof value === 'string' && value !== '';

/**
 * Return a copy of `value` whose object keys are sorted recursively by code
 * unit. Arrays keep their order; `undefined` object members are dropped.
 */
export function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) {
        out[key] = sortKeys(value[key]);
      }
    }
    return out;
  }
  return value;
}

/** Serialise one output document: sorted keys, two-space indent, one newline. */
export function render(doc) {
  return `${JSON.stringify(sortKeys(doc), null, 2)}\n`;
}

/** The exit code a thrown error maps to. */
export function exitCodeFor(err) {
  if (err instanceof UsageError) {
    return EXIT_BAD_USAGE;
  }
  return EXIT_CANNOT_COMPUTE;
}

function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/** The failure document for a thrown error: its message on one line. */
export function errorDoc(err) {
  const message = err instanceof Error ? err.message : String(err);
  return { error: oneLine(message) || 'unknown error', ok: false };
}

/** Write `text` to stdout synchronously, whole, before the process exits. */
export function writeOut(text) {
  const buf = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += fs.writeSync(1, buf, offset, buf.length - offset);
    } catch (err) {
      if (err.code !== 'EAGAIN') {
        throw err;
      }
    }
  }
}

/** The date and time `ms` reads as at the offset its timestamp was written with. */
function wallClock(ms, [, sign, hours, minutes]) {
  const offsetMinutes = sign === undefined ? 0 : (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
  return new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 19);
}

/**
 * `Date.parse` rolls a date or time that does not exist over to the next one
 * that does, so a value is accepted only when it reads back as written.
 */
function instant(flag, value) {
  const match = RFC3339.exec(value);
  const ms = match === null ? Number.NaN : Date.parse(value.replace(/(\.\d{3})\d+/, '$1'));
  if (Number.isNaN(ms) || wallClock(ms, match) !== value.slice(0, 19)) {
    throw new UsageError(`query: ${flag} must be an RFC3339 timestamp naming a date and time that exist`);
  }
  return new Date(ms).toISOString();
}

function finishPreflight(parsed) {
  if (parsed.repo !== undefined && (!REPO_NAME.test(parsed.repo) || parsed.repo === '..')) {
    throw new UsageError('preflight: --repo must be one directory name, or "." for the project root');
  }
  return parsed;
}

function finishQuery(parsed) {
  for (const flag of ['--run', '--start', '--end']) {
    if (parsed[FLAGS.query[flag]] === undefined) {
      throw new UsageError(`query: ${flag} is required`);
    }
  }
  if (!RUN_ID.test(parsed.run)) {
    throw new UsageError('query: --run must be the run value preflight printed');
  }
  const start = instant('--start', parsed.start);
  const end = instant('--end', parsed.end);
  if (start >= end) {
    throw new UsageError('query: --start must be before --end');
  }
  const limit = parsed.limit === undefined ? DEFAULT_LIMIT : POSITIVE_INTEGER.test(parsed.limit) ? Number(parsed.limit) : Number.NaN;
  if (!(limit >= 1 && limit <= MAX_LIMIT)) {
    throw new UsageError(`query: --limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  const direction = parsed.direction ?? 'backward';
  if (!DIRECTIONS.includes(direction)) {
    throw new UsageError('query: --direction must be forward or backward');
  }
  return { ...parsed, start, end, limit, direction };
}

const FINISH = { preflight: finishPreflight, query: finishQuery };

/** Parse the command line into `{ selfTest }` or `{ verb, ...flags }`. Pure. */
export function parseArgv(argv) {
  if (argv.length === 1 && argv[0] === '--self-test') {
    return { selfTest: true };
  }
  const [verb, ...rest] = argv;
  if (verb === undefined || !Object.hasOwn(FLAGS, verb)) {
    throw new UsageError(USAGE);
  }
  const parsed = { verb };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!Object.hasOwn(FLAGS[verb], flag)) {
      throw new UsageError(`${verb}: unknown argument ${oneLine(flag).slice(0, 40)}`);
    }
    const field = FLAGS[verb][flag];
    const value = rest[index + 1];
    if (!isSet(value)) {
      throw new UsageError(`${verb}: ${flag} needs a value`);
    }
    if (Object.hasOwn(parsed, field)) {
      throw new UsageError(`${verb}: ${flag} given twice`);
    }
    parsed[field] = value;
  }
  if (parsed.projectRoot === undefined) {
    throw new UsageError(`${verb}: --project-root is required`);
  }
  if (!path.isAbsolute(parsed.projectRoot)) {
    throw new UsageError(`${verb}: --project-root must be an absolute path`);
  }
  return FINISH[verb](parsed);
}

/**
 * Parse the subset of YAML this script reads: top-level scalars and one level
 * of nested mapping. Deeper nesting, sequences and flow collections are
 * skipped without being interpreted. Pure.
 */
export function parseMiniYaml(text) {
  const out = {};
  let block = null;
  let blockIndent = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const body = line.trimStart();
    if (body === '' || body.startsWith('#')) {
      continue;
    }
    const indent = line.length - body.length;
    if (indent === 0) {
      block = null;
      blockIndent = null;
      const entry = splitKey(body);
      if (entry === null) {
        continue;
      }
      if (entry.value === '') {
        out[entry.key] = {};
        block = entry.key;
      } else {
        out[entry.key] = entry.value;
      }
      continue;
    }
    if (block === null || body.startsWith('-')) {
      continue;
    }
    if (blockIndent === null) {
      blockIndent = indent;
    }
    if (indent !== blockIndent) {
      continue;
    }
    const entry = splitKey(body);
    if (entry !== null) {
      out[block][entry.key] = entry.value;
    }
  }
  return out;
}

function splitKey(body) {
  const match = KEY_LINE.exec(body);
  if (match === null) {
    return null;
  }
  return { key: match[1], value: parseValue(match[2] ?? '') };
}

function parseValue(raw) {
  const value = raw.trim();
  if (value === '' || value.startsWith('#')) {
    return '';
  }
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    if (end !== -1) {
      const rest = value.slice(end + 1).trim();
      if (rest === '' || rest.startsWith('#')) {
        return value.slice(1, end);
      }
    }
  }
  const hash = value.search(/\s#/);
  return (hash === -1 ? value : value.slice(0, hash)).trim();
}

function cleanHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined;
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return undefined;
  }
  return url;
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || LOOPBACK_IPV4.test(hostname);
}

function grafanaUrl(value) {
  if (!isSet(value)) {
    throw new ComputeError('config.yaml: incident.grafana_url is not set');
  }
  const url = cleanHttpUrl(value);
  if (url === undefined) {
    throw new ComputeError('config.yaml: incident.grafana_url must be an absolute http(s) URL without credentials, query or fragment');
  }
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
    throw new ComputeError('config.yaml: incident.grafana_url must use https unless the host is loopback');
  }
  return url;
}

function tokenFilePath(value, home) {
  if (!isSet(value)) {
    return undefined;
  }
  let file;
  if (value.startsWith('~/')) {
    if (!isSet(home)) {
      throw new ComputeError('config.yaml: incident.token_file starts with ~/ but HOME is not set');
    }
    file = path.join(home, value.slice(2));
  } else if (path.isAbsolute(value)) {
    file = path.normalize(value);
  } else {
    throw new ComputeError('config.yaml: incident.token_file must be an absolute path or start with ~/');
  }
  const name = path.basename(file);
  if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) {
    throw new ComputeError('config.yaml: incident.token_file must not be a dotenv-family file (.env, .env.*, *.env)');
  }
  return file;
}

/**
 * The settings this script consumes from a parsed `config.yaml`:
 * `{ base, origin, datasource, tokenFile }`. `home` is `$HOME` or undefined.
 * Throws a ComputeError naming the key at fault. Pure.
 */
export function validateConfig(doc, home) {
  if (!Object.hasOwn(doc, 'incident')) {
    throw new ComputeError('config.yaml has no incident: block');
  }
  const block = doc.incident;
  if (block === null || typeof block !== 'object') {
    throw new ComputeError('config.yaml: incident must be a mapping');
  }
  const url = grafanaUrl(block.grafana_url);
  if (!isSet(block.datasource)) {
    throw new ComputeError('config.yaml: incident.datasource is not set');
  }
  if (!DATASOURCE.test(block.datasource)) {
    throw new ComputeError('config.yaml: incident.datasource must be a datasource UID ([A-Za-z0-9_-])');
  }
  return {
    base: `${url.origin}${url.pathname.replace(/\/+$/, '')}`,
    origin: url.origin,
    datasource: block.datasource,
    tokenFile: tokenFilePath(block.token_file, home),
  };
}

function loadConfig(projectRoot, home) {
  const file = path.join(projectRoot, 'claudedocs', 'tickets', 'config.yaml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      throw new ComputeError(`${file} does not exist — the incident: block is read from it`);
    }
    throw new ComputeError(`cannot read ${file} (${err.code ?? 'error'})`);
  }
  return validateConfig(parseMiniYaml(text), home);
}

/**
 * Parse the credential file's text into `{ INCIDENT_GRAFANA_URL?, INCIDENT_GRAFANA_TOKEN? }`.
 * Every line must be `NAME=value` (optional `export `); a failure names the
 * file and the line number, never the line. Pure.
 */
export function parseCredentialFile(text, file) {
  const values = {};
  const lines = text.replace(/^﻿/, '').split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const body = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
    const separator = body.indexOf('=');
    const name = separator > 0 ? body.slice(0, separator) : '';
    if (!NAME_PATTERN.test(name)) {
      throw malformedLine(file, index);
    }
    if (!READ_NAMES.includes(name)) {
      continue;
    }
    const value = unquote(body.slice(separator + 1));
    if (value === undefined || UNSAFE_VALUE.test(value)) {
      throw malformedLine(file, index);
    }
    values[name] = value;
  }
  return values;
}

function malformedLine(file, index) {
  return new ComputeError(`${file}:${index + 1}: malformed line (expected NAME=value)`);
}

function unquote(raw) {
  const first = raw.at(0);
  const last = raw.at(-1);
  const opens = first === '"' || first === "'";
  const closes = last === '"' || last === "'";
  if (!opens && !closes) {
    return raw;
  }
  if (raw.length >= 2 && opens && first === last) {
    return raw.slice(1, -1);
  }
  return undefined;
}

/**
 * Read the credential file on one descriptor: a regular file, no group or
 * other permission bit, at most 64 KiB.
 */
export function readCredentialFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      throw new ComputeError(`${file} (incident.token_file) does not exist`);
    }
    throw new ComputeError(`${file} cannot be read (${err.code ?? 'error'})`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new ComputeError(`${file} is not a regular file`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new ComputeError(`${file} must not grant any permission to group or others (mode 0600 required)`);
    }
    if (stat.size > MAX_CREDENTIAL_BYTES) {
      throw new ComputeError(`${file} is larger than ${MAX_CREDENTIAL_BYTES / 1024} KiB`);
    }
    let text;
    try {
      text = fs.readFileSync(fd, 'utf8');
    } catch (err) {
      throw new ComputeError(`${file} cannot be read (${err.code ?? 'error'})`);
    }
    return parseCredentialFile(text, file);
  } finally {
    fs.closeSync(fd);
  }
}

function credentialPair(env, config) {
  const envUrl = isSet(env[URL_NAME]) ? env[URL_NAME] : undefined;
  const envToken = isSet(env[TOKEN_NAME]) ? env[TOKEN_NAME] : undefined;
  if (envUrl !== undefined && envToken !== undefined) {
    return { url: envUrl, token: envToken, source: 'env', label: 'the environment' };
  }
  if (envUrl !== undefined || envToken !== undefined) {
    const [present, missing] = envUrl !== undefined ? [URL_NAME, TOKEN_NAME] : [TOKEN_NAME, URL_NAME];
    throw new ComputeError(`${present} is exported but ${missing} is not — export both, or neither to use incident.token_file`);
  }
  if (config.tokenFile === undefined) {
    throw new ComputeError(`no Grafana token source: set incident.token_file in config.yaml, or export ${URL_NAME} and ${TOKEN_NAME}`);
  }
  const values = readCredentialFile(config.tokenFile);
  for (const name of READ_NAMES) {
    if (!isSet(values[name])) {
      throw new ComputeError(`${config.tokenFile} does not set ${name}`);
    }
  }
  return { url: values[URL_NAME], token: values[TOKEN_NAME], source: 'file', label: config.tokenFile };
}

/**
 * Resolve the token and where it came from: `{ token, source }`, `source` ∈
 * env | file. The pair's URL must share its origin with
 * `incident.grafana_url`, so a token is never sent to another server.
 */
export function resolveAccess(env, config) {
  const pair = credentialPair(env, config);
  if (UNSAFE_VALUE.test(pair.token)) {
    throw new ComputeError(`${TOKEN_NAME} from ${pair.label} holds whitespace or a control character`);
  }
  const bound = cleanHttpUrl(pair.url);
  if (bound === undefined) {
    throw new ComputeError(
      `${URL_NAME} from ${pair.label} is not an absolute http(s) URL without credentials, query or fragment, so its token is not sent`,
    );
  }
  if (bound.origin !== config.origin) {
    throw new ComputeError(
      `the token from ${pair.label} is bound to ${bound.origin}; incident.grafana_url names ${config.origin} — a token is never sent to a different origin`,
    );
  }
  return { token: pair.token, source: pair.source };
}

function git(args, env) {
  return spawnSync('git', args, { encoding: 'utf8', env: { ...env, LC_ALL: 'C' }, timeout: GIT_TIMEOUT_MS });
}

/**
 * Whether a report may be written under `<projectRoot>/claudedocs/incidents/`:
 * `{ writable, reason }`. Outside a git work tree it may; inside one, only
 * when git ignores the path. Anything undecidable is not writable.
 */
export function reportGate(projectRoot, env) {
  const inside = git(['-C', projectRoot, 'rev-parse', '--is-inside-work-tree'], env);
  if (inside.error !== undefined || inside.status === null) {
    return { writable: false, reason: 'git could not be run, so whether claudedocs/incidents/ is committed is unknown' };
  }
  if (inside.status !== 0) {
    if (inside.status === 128 && inside.stderr.includes('not a git repository')) {
      return { writable: true, reason: 'the project root is not inside a git work tree' };
    }
    return { writable: false, reason: 'git could not inspect the project root, so whether claudedocs/incidents/ is committed is unknown' };
  }
  if (inside.stdout.trim() !== 'true') {
    return { writable: false, reason: 'the project root is inside a git directory, not a work tree' };
  }
  const ignored = git(['-C', projectRoot, 'check-ignore', '-q', 'claudedocs/incidents/report.md'], env);
  if (ignored.status === 0) {
    return { writable: true, reason: 'git ignores claudedocs/incidents/' };
  }
  if (ignored.status === 1) {
    return { writable: false, reason: 'git does not ignore claudedocs/incidents/, so a report there could be committed' };
  }
  return { writable: false, reason: 'git check-ignore failed, so whether claudedocs/incidents/ is ignored is unknown' };
}

function headOf(dir, env) {
  const res = git(['-C', dir, 'rev-parse', 'HEAD'], env);
  const sha = res.status === 0 ? res.stdout.trim() : '';
  return COMMIT_SHA.test(sha) ? sha : null;
}

function rfc3339(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function fileStamp(date) {
  return rfc3339(date).replace(/[-:Z]/g, '').replace('T', '-');
}

function queryFile(projectRoot, run) {
  return path.join(projectRoot, ...INCIDENTS_DIR, `.query-${run}.logql`);
}

/**
 * Remove the query files an interrupted run left under
 * `<projectRoot>/claudedocs/incidents/`: regular files with a query file's
 * name, last written more than an hour before `now`.
 */
function sweepQueryFiles(projectRoot, now) {
  const dir = path.join(projectRoot, ...INCIDENTS_DIR);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.filter((entry) => QUERY_FILE_NAME.test(entry))) {
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && now.getTime() - stat.mtimeMs > STALE_QUERY_MS) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      continue;
    }
  }
}

/**
 * The `preflight` verb: configuration, credentials, clock, run identifier,
 * report gate and repository head. No network call.
 */
export function preflight({ projectRoot, repo }, env = process.env, now = new Date()) {
  const config = loadConfig(projectRoot, env.HOME);
  const access = resolveAccess(env, config);
  sweepQueryFiles(projectRoot, now);
  const stamp = fileStamp(now);
  const doc = {
    ok: true,
    verb: 'preflight',
    now: rfc3339(now),
    stamp,
    run: `${stamp}-${randomBytes(4).toString('hex')}`,
    grafana: { origin: config.origin, datasource: config.datasource },
    token: { source: access.source },
    report: reportGate(projectRoot, env),
  };
  if (repo !== undefined) {
    const dir = repo === '.' ? projectRoot : path.join(projectRoot, repo);
    doc.repo = { dir, head: headOf(dir, env) };
  }
  return doc;
}

/**
 * Read the query text from the run's query file and remove the file. A
 * symbolic link is refused and left alone; a regular file is removed whether
 * or not its content is usable, so no query run leaves its query behind.
 */
export function takeQuery(projectRoot, run) {
  const file = queryFile(projectRoot, run);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      throw new ComputeError(`${file} does not exist — write the LogQL query there before each query run`);
    }
    if (err.code === 'ELOOP' || err.code === 'EMLINK') {
      throw new ComputeError(`${file} is a symbolic link, not a regular file`);
    }
    throw new ComputeError(`${file} cannot be read (${err.code ?? 'error'})`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new ComputeError(`${file} is not a regular file`);
    }
    fs.rmSync(file, { force: true });
    if (stat.size > MAX_QUERY_BYTES) {
      throw new ComputeError(`${file} is larger than ${MAX_QUERY_BYTES / 1024} KiB`);
    }
    const text = fs.readFileSync(fd, 'utf8').trim();
    if (text === '') {
      throw new ComputeError(`${file} is empty`);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function causeCode(err) {
  const code = err?.cause?.code ?? err?.code;
  return typeof code === 'string' && ERROR_CODE.test(code) ? ` (${code})` : '';
}

async function readCapped(response, origin) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        throw new ComputeError(`${origin} answered with more than ${MAX_RESPONSE_BYTES / (1024 * 1024)} MiB — narrow the query or the window`);
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof ComputeError) {
      throw err;
    }
    throw new ComputeError(`the answer from ${origin} was cut off${causeCode(err)}`);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function detailOf(body, token) {
  const detail = oneLine(body.replaceAll(token, '[token]')).slice(0, MAX_DETAIL_CHARS);
  return detail === '' ? '' : `: ${detail}`;
}

async function fetchStreams(url, { token }, { origin, datasource }) {
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      throw new ComputeError(`no answer from ${origin} within ${REQUEST_TIMEOUT_MS / 1000} seconds`);
    }
    throw new ComputeError(`could not reach ${origin}${causeCode(err)}`);
  }
  const { status } = response;
  if (status >= 300 && status < 400) {
    await response.body?.cancel();
    throw new ComputeError(`${origin} answered HTTP ${status}, a redirect — it is not followed, so the token goes nowhere else`);
  }
  if (status === 401 || status === 403) {
    await response.body?.cancel();
    throw new ComputeError(`${origin} answered HTTP ${status}: the service account behind the token cannot query datasource ${datasource}`);
  }
  const body = await readCapped(response, origin);
  if (!response.ok) {
    throw new ComputeError(`${origin} answered HTTP ${status}${status === 400 ? detailOf(body, token) : ''}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ComputeError(`${origin} answered HTTP ${status} with a body that is not JSON`);
  }
  const data = parsed !== null && typeof parsed === 'object' ? parsed.data : undefined;
  if (data === null || typeof data !== 'object' || data.resultType !== 'streams' || !Array.isArray(data.result)) {
    const type = typeof data?.resultType === 'string' && RESULT_TYPE.test(data.resultType) ? data.resultType : 'unknown';
    throw new ComputeError(`${origin} answered HTTP ${status} with a result that is not Loki streams (resultType: ${type}) — the query must select log lines`);
  }
  return data.result;
}

function stringLabels(stream) {
  const labels = {};
  if (stream !== null && typeof stream === 'object') {
    for (const [name, value] of Object.entries(stream)) {
      if (typeof value === 'string') {
        labels[name] = value;
      }
    }
  }
  return labels;
}

/**
 * Flatten Loki's `streams` result into `{ lines, streams, received, skipped }`:
 * one `{ ts, stream, line }` per entry, oldest first, each line cut at 4000
 * characters and marked `cut: true` when it was. `stream` indexes `streams`,
 * which holds the string labels of each stream that contributed a line, once.
 * An entry whose timestamp or line is malformed is skipped and counted. Pure.
 */
export function shapeStreams(result) {
  const streams = [];
  const entries = [];
  let received = 0;
  let skipped = 0;
  for (const stream of result) {
    let index;
    for (const value of Array.isArray(stream?.values) ? stream.values : []) {
      received += 1;
      const [ns, line] = Array.isArray(value) ? value : [];
      if (typeof ns !== 'string' || !EPOCH_NANOSECONDS.test(ns) || typeof line !== 'string') {
        skipped += 1;
        continue;
      }
      index ??= streams.push(stringLabels(stream.stream)) - 1;
      const at = BigInt(ns);
      const entry = { at, ts: new Date(Number(at / 1_000_000n)).toISOString(), stream: index, line };
      if (line.length > MAX_LINE_CHARS) {
        entry.line = line.slice(0, MAX_LINE_CHARS);
        entry.cut = true;
      }
      entries.push(entry);
    }
  }
  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { lines: entries.map(({ at, ...entry }) => entry), streams, received, skipped };
}

/** An upper bound on the bytes one element adds to an array of a rendered document. */
function elementBytes(value) {
  const text = JSON.stringify(sortKeys(value), null, 2).replaceAll('\n', `\n${ELEMENT_INDENT}`);
  return Buffer.byteLength(`${ELEMENT_INDENT}${text},\n`);
}

/**
 * Keep as many of `lines` as fit `room` bytes of rendered document, counted
 * from the end `direction` keeps — the oldest for `forward`, the newest for
 * `backward` — together with the streams those lines name, re-indexed. One
 * line is kept whatever its size. Returns `{ lines, streams, omitted }`. Pure.
 */
export function fitLines({ lines, streams }, direction, room) {
  const ordered = direction === 'forward' ? lines : lines.toReversed();
  const named = new Set();
  let used = 0;
  let keep = 0;
  for (const entry of ordered) {
    const cost = elementBytes(entry) + (named.has(entry.stream) ? 0 : elementBytes(streams[entry.stream]));
    if (keep > 0 && used + cost > room) {
      break;
    }
    used += cost;
    named.add(entry.stream);
    keep += 1;
  }
  const kept = direction === 'forward' ? lines.slice(0, keep) : lines.slice(lines.length - keep);
  const order = [...named].sort((a, b) => a - b);
  const position = new Map(order.map((index, at) => [index, at]));
  return {
    lines: kept.map((entry) => ({ ...entry, stream: position.get(entry.stream) })),
    streams: order.map((index) => streams[index]),
    omitted: lines.length - keep,
  };
}

/** The `query` verb: one LogQL `query_range` through the datasource proxy. */
export async function query({ projectRoot, run, start, end, limit, direction }, env = process.env) {
  const text = takeQuery(projectRoot, run);
  const config = loadConfig(projectRoot, env.HOME);
  const access = resolveAccess(env, config);
  const params = new URLSearchParams({ query: text, start, end, limit: String(limit), direction });
  const url = `${config.base}/api/datasources/proxy/uid/${config.datasource}/loki/api/v1/query_range?${params}`;
  const shaped = shapeStreams(await fetchStreams(url, access, config));
  const head = {
    ok: true,
    verb: 'query',
    origin: config.origin,
    datasource: config.datasource,
    window: { start, end },
    skipped: shaped.skipped,
  };
  const widestWithoutLines = { ...head, count: shaped.received, omitted: shaped.received, truncated: false, lines: [], streams: [] };
  const room = MAX_DOCUMENT_BYTES - Buffer.byteLength(render(widestWithoutLines)) - ARRAY_WRAP_BYTES;
  const { lines, streams, omitted } = fitLines(shaped, direction, room);
  return { ...head, count: lines.length, omitted, truncated: shaped.received >= limit || omitted > 0, lines, streams };
}
