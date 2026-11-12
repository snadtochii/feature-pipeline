// The fixtures the incident log reader's self-test modules share: the
// fixture credential and origin, a workspace with a config and a home holding
// the credential file, a minimal child environment, and the child run that
// checks the token reaches neither output stream.
//
// Private to the implementation: only incident.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CaseFailure, runNode, withTemp as withTempDir } from '../../../scripts/lib/selftest-kit.mjs';

const ENTRY = fileURLToPath(new URL('./incident.mjs', import.meta.url));
export const TOKEN = 'glsa_selftest_7f3c9e10';
export const ORIGIN = 'https://grafana.example.invalid';
export const DATASOURCE = 'loki-uid';
export const CREDENTIALS = '~/.config/feature-incident/grafana.credentials';
export const RUN = '20261111-040300-0123abcd';
export const OTHER_RUN = '20261111-040300-89abcdef';

export const withTemp = (label, fn) => withTempDir(`fp-incident-${label}`, fn);

export function configText({ url = ORIGIN, datasource = DATASOURCE, tokenFile = CREDENTIALS } = {}) {
  const lines = ['prefix: FP', 'incident:'];
  if (url !== null) {
    lines.push(`  grafana_url: ${url}`);
  }
  if (datasource !== null) {
    lines.push(`  datasource: ${datasource}`);
  }
  if (tokenFile !== null) {
    lines.push(`  token_file: ${tokenFile}`);
  }
  lines.push('  services:', '    api:', '      repo: api', "      selector: '{app=\"api\"}'", '      runbook: docs/alerts.md', '');
  return lines.join('\n');
}

export function writeConfig(root, text) {
  const dir = path.join(root, 'claudedocs', 'tickets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), text);
}

export function writeCredentials(file, text = `INCIDENT_GRAFANA_URL=${ORIGIN}\nINCIDENT_GRAFANA_TOKEN=${TOKEN}\n`, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, mode);
  return file;
}

function gitBinDir() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir !== '' && fs.existsSync(path.join(dir, 'git'))) {
      return dir;
    }
  }
  return null;
}

export function childEnv(home, extra = {}) {
  const dirs = [gitBinDir(), '/usr/bin', '/bin'].filter(Boolean);
  return { PATH: dirs.join(path.delimiter), HOME: home, ...extra };
}

/** A workspace with a config, and a home holding the credential file. */
export function world(dir, { url = ORIGIN, credentialUrl = url } = {}) {
  const root = path.join(dir, 'workspace');
  const home = path.join(dir, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  writeConfig(root, configText({ url }));
  writeCredentials(path.join(home, CREDENTIALS.slice(2)), `INCIDENT_GRAFANA_URL=${credentialUrl}\nINCIDENT_GRAFANA_TOKEN=${TOKEN}\n`);
  return { root, home, env: childEnv(home) };
}

/** Run the entry as a child; the fixture token must reach neither stream. */
export async function runEntry(args, env) {
  const run = await runNode(ENTRY, args, env);
  if (run.stdout.includes(TOKEN) || run.stderr.includes(TOKEN)) {
    throw new CaseFailure(`the token reached the output of: ${args.join(' ')}`);
  }
  return run;
}
