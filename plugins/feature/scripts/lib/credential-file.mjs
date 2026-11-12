// The credential-file rules the plugin's scripts share.
//
// A credential file holds `NAME=value` lines. It is read on one descriptor and
// only as a regular file that grants nothing to group or others and is at most
// 64 KiB. Every message names the file by path and line number — never a
// value, a line, or a URL that may carry userinfo.
//
// Private to the implementation: no file under this directory is a command.

import fs from 'node:fs';

import { ComputeError } from './output.mjs';

const MAX_FILE_BYTES = 64 * 1024;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A credential value holds no whitespace and no control character. */
export const UNSAFE_VALUE = /[\s\p{Cc}]/u;

/**
 * Parse a credential file's text into an object holding the `names` it sets.
 * Every line must be `NAME=value` (optional `export `); only the values of
 * `names` are held to the value grammar. Pure.
 */
export function parseCredentialFile(text, file, names) {
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
    if (!names.includes(name)) {
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
 * Read the `names` a credential file sets, all on one descriptor: a regular
 * file, no group or other permission bit, at most 64 KiB. Returns null when
 * the file does not exist; the caller decides what a missing file means.
 */
export function readCredentialFile(file, names) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
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
    if (stat.size > MAX_FILE_BYTES) {
      throw new ComputeError(`${file} is larger than ${MAX_FILE_BYTES / 1024} KiB`);
    }
    let text;
    try {
      text = fs.readFileSync(fd, 'utf8');
    } catch (err) {
      throw new ComputeError(`${file} cannot be read (${err.code ?? 'error'})`);
    }
    return parseCredentialFile(text, file, names);
  } finally {
    fs.closeSync(fd);
  }
}

/** An absolute http(s) URL with no userinfo, query or fragment, or undefined. */
export function cleanHttpUrl(value) {
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
