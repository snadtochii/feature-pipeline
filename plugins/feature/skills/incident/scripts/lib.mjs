// The incident log reader's rules and verbs (../references/log-query.md):
// argument parsing, the `incident:` block's rules, credential resolution, the
// report gate, the query files, the request and the output documents. The
// output contract, the `config.yaml` reader and the credential-file rules are
// the plugin's shared script modules.
//
// Private to the implementation: only incident.mjs is a command.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { UNSAFE_VALUE, cleanHttpUrl, readCredentialFile } from '../../../scripts/lib/credential-file.mjs';
import { parseMiniYaml } from '../../../scripts/lib/mini-yaml.mjs';
import { ComputeError, UsageError, errorDoc as errorLine, oneLine, render } from '../../../scripts/lib/output.mjs';

const URL_NAME = 'INCIDENT_GRAFANA_URL';
const TOKEN_NAME = 'INCIDENT_GRAFANA_TOKEN';

/** The names this script reads from the credential file. */
export const READ_NAMES = [URL_NAME, TOKEN_NAME];

const GIT_TIMEOUT_MS = 10_000;

const INCIDENTS_DIR = ['claudedocs', 'incidents'];
const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{8}$/;
const QUERY_FILE_NAME = /^\.query-\d{8}-\d{6}-[0-9a-f]{8}\.logql$/;
const STALE_QUERY_MS = 60 * 60 * 1000;
const MAX_QUERY_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 16 * 1024;
const MAX_LINE_CHARS = 4000;
const MAX_DETAIL_CHARS = 300;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DIRECTIONS = ['forward', 'backward'];

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

/** The failure document for a thrown error: its message on one line, and `ok: false`. */
export function errorDoc(err) {
  return { ...errorLine(err), ok: false };
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
  const values = readCredentialFile(config.tokenFile, READ_NAMES);
  if (values === null) {
    throw new ComputeError(`${config.tokenFile} (incident.token_file) does not exist`);
  }
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

/**
 * The `keep` lines at the end `direction` keeps — the oldest for `forward`,
 * the newest for `backward` — together with the streams those lines name,
 * re-indexed: `{ lines, streams }`. Pure.
 */
export function keepLines({ lines, streams }, direction, keep) {
  const kept = direction === 'forward' ? lines.slice(0, keep) : lines.slice(lines.length - keep);
  const order = [...new Set(kept.map((entry) => entry.stream))].sort((a, b) => a - b);
  const position = new Map(order.map((index, at) => [index, at]));
  return {
    lines: kept.map((entry) => ({ ...entry, stream: position.get(entry.stream) })),
    streams: order.map((index) => streams[index]),
  };
}

/**
 * The largest count from 1 to `total` that `fits`, where a count that fits
 * leaves every smaller one fitting. One is the floor whether or not it fits,
 * and zero is the answer only when `total` is zero. Pure.
 */
export function largestFit(total, fits) {
  let low = Math.min(1, total);
  let high = total;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/** The `query` verb: one LogQL `query_range` through the datasource proxy. */
export async function query({ projectRoot, run, start, end, limit, direction }, env = process.env) {
  const text = takeQuery(projectRoot, run);
  const config = loadConfig(projectRoot, env.HOME);
  const access = resolveAccess(env, config);
  const params = new URLSearchParams({ query: text, start, end, limit: String(limit), direction });
  const url = `${config.base}/api/datasources/proxy/uid/${config.datasource}/loki/api/v1/query_range?${params}`;
  const shaped = shapeStreams(await fetchStreams(url, access, config));
  const documentKeeping = (keep) => {
    const omitted = shaped.lines.length - keep;
    return {
      ok: true,
      verb: 'query',
      origin: config.origin,
      datasource: config.datasource,
      window: { start, end },
      skipped: shaped.skipped,
      count: keep,
      omitted,
      truncated: shaped.received >= limit || omitted > 0,
      ...keepLines(shaped, direction, keep),
    };
  };
  const fits = (keep) => Buffer.byteLength(render(documentKeeping(keep))) <= MAX_DOCUMENT_BYTES;
  return documentKeeping(largestFit(shaped.lines.length, fits));
}
