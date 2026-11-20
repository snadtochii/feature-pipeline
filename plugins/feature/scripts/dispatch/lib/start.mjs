// The `start` verb (CONTRACT.md §10, `start`).
//
// Starts `run` for the project as a process in a session and process group of
// its own, holding no descriptor of this process, and answers with its pid at
// once. `detached: true` makes the child a session leader on POSIX, so no
// `setsid` binary is needed. It takes no lock and reads no configuration: the
// run it starts does both.
//
// Private to the implementation: only dispatch.mjs is a command.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ComputeError } from '../../lib/output.mjs';

const DISPATCH = fileURLToPath(new URL('../dispatch.mjs', import.meta.url));

/** The command, argument vector and options `start` spawns `run` with. */
export function startSpawnArgs({ projectRoot, scriptPath = DISPATCH, env = process.env }) {
  return [process.execPath, [scriptPath, 'run', '--project-root', projectRoot], { cwd: projectRoot, detached: true, stdio: 'ignore', env }];
}

export function start({ projectRoot, scriptPath = DISPATCH, env = process.env, spawnImpl = spawn }) {
  const [command, args, options] = startSpawnArgs({ projectRoot, scriptPath, env });
  const failed = (err) => new ComputeError(`could not start run: ${err.message}`);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, options);
    } catch (err) {
      reject(failed(err));
      return;
    }
    child.once('error', (err) => reject(failed(err)));
    child.once('spawn', () => {
      child.unref();
      resolve({ verb: 'start', ok: true, pid: child.pid });
    });
  });
}
