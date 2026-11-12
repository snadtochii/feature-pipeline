// The `gh` runner the plugin's scripts share: one command with an argument
// vector, a timeout and a bounded buffer, its failure carried as one line that
// names the command and ends with the tail of stderr.
//
// Private to the implementation: no file under this directory is a command.

import { spawnSync } from 'node:child_process';

import { ComputeError, oneLine } from './output.mjs';

const GH_TIMEOUT_MS = 60_000;
const GH_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Run one `gh` command: `{ ok: true, stdout }` or `{ ok: false, detail }`.
 * `cwd` and `env` default to the calling process's own.
 */
export function runGh(args, { cwd, env, runner = spawnSync } = {}) {
  const result = runner('gh', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GH_TIMEOUT_MS,
    maxBuffer: GH_MAX_BUFFER,
  });
  const label = `gh ${args.slice(0, 2).join(' ')}`;
  if (result.error) {
    return { ok: false, detail: result.error.code === 'ENOENT' ? 'gh not found on PATH' : `${label} could not run (${result.error.code ?? 'error'})` };
  }
  if (result.status !== 0) {
    const stderr = oneLine(result.stderr ?? '').slice(-200);
    return { ok: false, detail: `${label} exited ${result.status ?? `on ${result.signal}`}${stderr ? `: ${stderr}` : ''}` };
  }
  return { ok: true, stdout: result.stdout ?? '' };
}

/** `runGh`'s stdout, or a ComputeError carrying its detail. */
export function ghStdout(args, options) {
  const run = runGh(args, options);
  if (!run.ok) {
    throw new ComputeError(run.detail);
  }
  return run.stdout;
}
