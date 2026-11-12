// The insights extractor's self-test (../CONTRACT.md §11): the runner.
//
// Every case is `[name, fn(world)]`, and the case lists live beside the
// modules they test: extraction (selftest-extract.mjs), ticket outcomes
// (selftest-tickets.mjs), the ordered cache scenario (selftest-scenario.mjs)
// and the report (selftest-report.mjs). One world (selftest-world.mjs) is
// built per run and every list runs over it in that order: the extraction
// and ticket cases only read it, the scenario's reruns change the store step
// by step, and the end-to-end report case reads the cache the scenario left.
//
// Private to the implementation: only insights.mjs is a command.

import fs from 'node:fs';

import { ComputeError } from '../../lib/output.mjs';
import { EXTRACT_CASES } from './selftest-extract.mjs';
import { REPORT_CASES } from './selftest-report.mjs';
import { SCENARIO_CASES } from './selftest-scenario.mjs';
import { TICKET_CASES } from './selftest-tickets.mjs';
import { makeWorld } from './selftest-world.mjs';

const CASES = [...EXTRACT_CASES, ...TICKET_CASES, ...SCENARIO_CASES, ...REPORT_CASES];

/** Run every case; return the document, or throw a ComputeError naming the first failure. */
export async function runSelfTest() {
  let world = null;
  try {
    world = makeWorld();
    for (const [name, fn] of CASES) {
      try {
        await fn(world);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new ComputeError(`self-test: ${name} — ${detail}`);
      }
    }
  } finally {
    if (world !== null) {
      fs.rmSync(world.dir, { force: true, recursive: true });
    }
  }
  return { cases: CASES.length, ok: true };
}
