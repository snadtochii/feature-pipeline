// The transcript accumulator (../CONTRACT.md §5): one agent's transcript
// lines folded into its digest fields — token usage, models, skill loads,
// commands, friction counts, check runs, timestamps and malformed lines — plus
// the transient recognition inputs finishAgentWithSignals hands back. Every
// value it keeps is a count, an ID, a timestamp or a validated name; message
// text is read only to classify it.
//
// Private to the implementation: only insights.mjs is a command.

import fs from 'node:fs';

import { closeResultOf, isCheckRun, rootStageOf, slashBuildTicket } from './recognize.mjs';

const CONVERSATION_TYPES = new Set(['assistant', 'user', 'attachment', 'system']);

const SKILL_PREFIX = 'Base directory for this skill: ';
const PLUGIN_SKILL_PATH = /\/plugins\/cache\/[^/]+\/([^/]+)\/([^/]+)\/skills\/(?:[^/\s]+\/)*([^/\s]+)\s*$/;
const BARE_SKILL_PATHS = [/\/skills\/(?:[^/\s]+\/)*([^/\s]+)\s*$/, /\/bundled-skills\/[^/\s]+\/[^/\s]+\/([^/\s]+)\s*$/];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const VERSION = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/;
const FEATURE_PLUGIN = 'feature';

const MODEL = /^[A-Za-z0-9<][A-Za-z0-9<>._:@/[\]-]{0,99}$/;
const AGENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

const COMMAND_NAME_TAG = /<command-name>\s*([^<]*?)\s*<\/command-name>/;
const COMMAND_ARGS_TAG = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_NAME = /^\/?[A-Za-z0-9:._-]{1,80}$/;
const TICKET_ID = /\b[A-Z][A-Z0-9]*-\d+\b/g;
const MAX_COMMAND_IDS = 10;
const MAX_COMMANDS = 50;

const MAX_CWD_CHARS = 4096;
const RESULT_PREFIX_CHARS = 300;

const REJECTION_TEXT = "The user doesn't want to proceed with this tool use";
const REJECTION_RESULT = 'User rejected tool use';
const PERMISSION_DENIED = /^Permission to use [\s\S]* has been denied/;
const PERMISSION_NOT_GRANTED = "but you haven't granted it yet";
const INTERRUPT_TEXT = '[Request interrupted by user]';

const TOKEN_KEYS = [
  ['input', 'input_tokens'],
  ['output', 'output_tokens'],
  ['cache_read', 'cache_read_input_tokens'],
  ['cache_write', 'cache_creation_input_tokens'],
];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const matchOrNull = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : null);

export function zeroTokens() {
  return { cache_read: 0, cache_write: 0, input: 0, output: 0 };
}

export function zeroFriction() {
  return { interrupts: 0, permission_denials: 0, rejections: 0, tool_errors: 0 };
}

export function countInto(counts, key, by = 1) {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

/**
 * The digest fields of a subagent's `.meta.json`, each kept only when it has
 * its expected shape. Its free-text fields are never read.
 */
export function metaFields(meta) {
  const source = isObject(meta) ? meta : {};
  return {
    agent_type: matchOrNull(source.agentType, AGENT_TYPE),
    parent_agent_id: matchOrNull(source.parentAgentId, OPAQUE_ID),
    spawn_depth: Number.isSafeInteger(source.spawnDepth) && source.spawnDepth >= 0 ? source.spawnDepth : null,
    tool_use_id: matchOrNull(source.toolUseId, OPAQUE_ID),
  };
}

/** A fresh accumulator for agent `agentId`; `meta` is its parsed `.meta.json`, or null. */
export function newAgent(agentId, meta = null) {
  return {
    agentId,
    meta: metaFields(meta),
    firstMs: null,
    lastMs: null,
    cwd: null,
    cwdMs: null,
    untimedCwd: null,
    usageOf: new Map(),
    modelOf: new Map(),
    turnIds: new Set(),
    featureVersions: new Set(),
    skills: new Map(),
    commands: [],
    friction: zeroFriction(),
    malformedLines: 0,
    anomalies: new Map(),
    slashBuild: null,
    checkUses: new Map(),
    checkRuns: { failed: 0, total: 0 },
    closeResult: null,
  };
}

function textOf(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const block = content.find((item) => isObject(item) && item.type === 'text' && typeof item.text === 'string');
    return block === undefined ? null : block.text;
  }
  return null;
}

function textsOf(content) {
  if (typeof content === 'string') {
    return [content];
  }
  if (Array.isArray(content)) {
    return content.filter((item) => isObject(item) && item.type === 'text' && typeof item.text === 'string').map((item) => item.text);
  }
  return [];
}

function ticketIds(text) {
  if (typeof text !== 'string') {
    return [];
  }
  return [...new Set(text.match(TICKET_ID) ?? [])].slice(0, MAX_COMMAND_IDS);
}

function addCommand(acc, name, ids) {
  if (!COMMAND_NAME.test(name)) {
    countInto(acc.anomalies, 'bad_command_name');
    return;
  }
  if (acc.commands.length >= MAX_COMMANDS) {
    countInto(acc.anomalies, 'commands_truncated');
    return;
  }
  acc.commands.push({ ids, name });
}

function noteTimestamp(acc, record) {
  const ms = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN;
  const cwd = typeof record.cwd === 'string' && record.cwd !== '' ? record.cwd.slice(0, MAX_CWD_CHARS) : null;
  if (!Number.isFinite(ms)) {
    countInto(acc.anomalies, 'bad_timestamp');
    if (cwd !== null && acc.untimedCwd === null) {
      acc.untimedCwd = cwd;
    }
    return;
  }
  acc.firstMs = acc.firstMs === null ? ms : Math.min(acc.firstMs, ms);
  acc.lastMs = acc.lastMs === null ? ms : Math.max(acc.lastMs, ms);
  if (cwd !== null && (acc.cwdMs === null || ms < acc.cwdMs)) {
    acc.cwd = cwd;
    acc.cwdMs = ms;
  }
}

function noteSkillLoad(acc, content) {
  const text = textOf(content);
  if (text === null || !text.startsWith(SKILL_PREFIX)) {
    return;
  }
  const firstLine = text.slice(SKILL_PREFIX.length).split('\n', 1)[0];
  const plugin = PLUGIN_SKILL_PATH.exec(firstLine);
  if (plugin !== null) {
    const [, pluginName, version, skill] = plugin;
    if (!NAME.test(pluginName) || !NAME.test(skill)) {
      countInto(acc.anomalies, 'bad_skill_path');
      return;
    }
    countInto(acc.skills, `${pluginName}:${skill}`);
    if (pluginName === FEATURE_PLUGIN && VERSION.test(version)) {
      acc.featureVersions.add(version);
    }
    return;
  }
  for (const pattern of BARE_SKILL_PATHS) {
    const bare = pattern.exec(firstLine);
    if (bare !== null && NAME.test(bare[1])) {
      countInto(acc.skills, bare[1]);
      return;
    }
  }
  countInto(acc.anomalies, 'bad_skill_path');
}

function noteSlashCommand(acc, content) {
  const text = textOf(content);
  if (text === null) {
    return;
  }
  const name = COMMAND_NAME_TAG.exec(text);
  if (name === null) {
    return;
  }
  addCommand(acc, name[1], ticketIds(COMMAND_ARGS_TAG.exec(text)?.[1]));
}

function resultPrefix(block) {
  const text = textOf(block.content);
  return text === null ? '' : text.slice(0, RESULT_PREFIX_CHARS);
}

/** Count one tool result's friction; returns its class, or null for a result that is none of them. */
function noteToolResult(acc, block, toolUseResult) {
  const prefix = resultPrefix(block);
  if (prefix.startsWith(REJECTION_TEXT) || toolUseResult === REJECTION_RESULT) {
    acc.friction.rejections += 1;
    return 'rejection';
  }
  if (PERMISSION_DENIED.test(prefix) || prefix.includes(PERMISSION_NOT_GRANTED)) {
    acc.friction.permission_denials += 1;
    return 'permission_denial';
  }
  if (block.is_error === true) {
    acc.friction.tool_errors += 1;
    return 'tool_error';
  }
  return null;
}

function noteCheckResult(acc, toolUseId, resultClass) {
  if (acc.checkUses.get(toolUseId) !== 'pending') {
    return;
  }
  acc.checkUses.set(toolUseId, 'done');
  if (resultClass === 'tool_error') {
    acc.checkRuns.failed += 1;
  }
}

function consumeUser(acc, record, message) {
  const content = message.content;
  if (record.isMeta === true) {
    noteSkillLoad(acc, content);
  }
  noteSlashCommand(acc, content);
  if (acc.slashBuild === null) {
    acc.slashBuild = slashBuildTicket(content);
  }
  for (const text of textsOf(content)) {
    if (text === INTERRUPT_TEXT) {
      acc.friction.interrupts += 1;
    }
  }
  if (Array.isArray(content)) {
    const toolUseResult = typeof record.toolUseResult === 'string' ? record.toolUseResult : null;
    for (const block of content) {
      if (isObject(block) && block.type === 'tool_result') {
        noteCheckResult(acc, block.tool_use_id, noteToolResult(acc, block, toolUseResult));
      }
    }
  }
}

function noteCloseResult(acc, text) {
  const result = closeResultOf(text);
  if (result !== null) {
    acc.closeResult = result;
  }
}

function noteCheckRun(acc, toolUseId, command) {
  if (typeof toolUseId !== 'string' || !OPAQUE_ID.test(toolUseId) || acc.checkUses.has(toolUseId) || !isCheckRun(command)) {
    return;
  }
  acc.checkUses.set(toolUseId, 'pending');
  acc.checkRuns.total += 1;
}

function noteToolUse(acc, block) {
  if (!isObject(block.input)) {
    return;
  }
  if (block.name === 'Skill' && typeof block.input.skill === 'string') {
    addCommand(acc, block.input.skill, ticketIds(block.input.args));
  } else if (block.name === 'Bash') {
    noteCheckRun(acc, block.id, block.input.command);
  } else if (block.name === 'SubagentHandback') {
    noteCloseResult(acc, block.input.message);
  }
}

function consumeAssistant(acc, message) {
  const messageId = message.id;
  if (typeof messageId !== 'string' || messageId === '') {
    countInto(acc.anomalies, 'no_message_id');
    return;
  }
  acc.turnIds.add(messageId);
  if (typeof message.model === 'string' && message.model !== '') {
    if (MODEL.test(message.model)) {
      acc.modelOf.set(messageId, message.model);
    } else {
      countInto(acc.anomalies, 'bad_model');
    }
  }
  if (isObject(message.usage)) {
    const terminal = message.stop_reason !== null && message.stop_reason !== undefined;
    const previous = acc.usageOf.get(messageId);
    if (previous === undefined || terminal || !previous.terminal) {
      acc.usageOf.set(messageId, { terminal, usage: message.usage });
    }
  }
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isObject(block) && block.type === 'tool_use') {
        noteToolUse(acc, block);
      } else if (isObject(block) && block.type === 'text') {
        noteCloseResult(acc, block.text);
      }
    }
  }
}

/** Fold one parsed transcript record into `acc`. A record of an unknown type is ignored. */
export function consumeRecord(acc, record) {
  const type = record.type;
  if (!CONVERSATION_TYPES.has(type)) {
    return;
  }
  noteTimestamp(acc, record);
  const message = isObject(record.message) ? record.message : {};
  if (type === 'user') {
    consumeUser(acc, record, message);
  } else if (type === 'assistant') {
    consumeAssistant(acc, message);
  }
}

/** Fold one raw transcript line into `acc`: blank lines are skipped, unparseable or non-object lines counted. */
export function consumeLine(acc, line) {
  if (line.trim() === '') {
    return;
  }
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    acc.malformedLines += 1;
    return;
  }
  if (!isObject(record)) {
    acc.malformedLines += 1;
    return;
  }
  consumeRecord(acc, record);
}

/**
 * Stream `file` into `acc`, split on `\n` alone: `readline` also splits on
 * U+2028, U+2029 and a lone `\r`, which a JSON string may hold. An unreadable
 * file counts as one malformed line; returns whether it was read.
 */
export async function readTranscript(file, acc) {
  try {
    let pending = [];
    for await (const chunk of fs.createReadStream(file, { encoding: 'utf8' })) {
      let start = 0;
      let end = chunk.indexOf('\n');
      while (end !== -1) {
        pending.push(chunk.slice(start, end));
        consumeLine(acc, pending.join(''));
        pending = [];
        start = end + 1;
        end = chunk.indexOf('\n', start);
      }
      if (start < chunk.length) {
        pending.push(chunk.slice(start));
      }
    }
    if (pending.length > 0) {
      consumeLine(acc, pending.join(''));
    }
    return true;
  } catch {
    acc.malformedLines += 1;
    countInto(acc.anomalies, 'unreadable_file');
    return false;
  }
}

function tokenCount(usage, key) {
  const value = Math.trunc(Number(usage[key]));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function addTokens(into, tokens) {
  for (const key of Object.keys(into)) {
    into[key] += tokens[key] ?? 0;
  }
}

export const isoOf = (ms) => (ms === null ? null : new Date(ms).toISOString());

export const sortedObject = (map) => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** The agent's digest entry as a plain object. */
export function finishAgent(acc) {
  const tokens = zeroTokens();
  const byModel = new Map();
  for (const [messageId, { usage }] of acc.usageOf) {
    const turnTokens = Object.fromEntries(TOKEN_KEYS.map(([name, key]) => [name, tokenCount(usage, key)]));
    addTokens(tokens, turnTokens);
    const model = acc.modelOf.get(messageId);
    if (model !== undefined) {
      if (!byModel.has(model)) {
        byModel.set(model, zeroTokens());
      }
      addTokens(byModel.get(model), turnTokens);
    }
  }
  return {
    agent_id: acc.agentId,
    ...acc.meta,
    anomalies: sortedObject(acc.anomalies),
    check_runs: { ...acc.checkRuns },
    commands: acc.commands,
    cwd: acc.cwd ?? acc.untimedCwd,
    duration_ms: acc.firstMs === null ? null : acc.lastMs - acc.firstMs,
    end: isoOf(acc.lastMs),
    feature_versions: [...acc.featureVersions].sort(),
    friction: { ...acc.friction },
    malformed_lines: acc.malformedLines,
    models: [...new Set(acc.modelOf.values())].sort(),
    skills: sortedObject(acc.skills),
    start: isoOf(acc.firstMs),
    tokens,
    tokens_by_model: Object.fromEntries([...byModel].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    turns: acc.turnIds.size,
    turns_without_usage: [...acc.turnIds].filter((messageId) => !acc.usageOf.has(messageId)).length,
  };
}

/** The digest entry plus the transient inputs recognition needs, which are never stored. */
export function finishAgentWithSignals(acc) {
  return {
    entry: finishAgent(acc),
    signals: { closeResult: acc.closeResult, rootStage: rootStageOf(acc.slashBuild, acc.commands), slashBuild: acc.slashBuild },
  };
}
