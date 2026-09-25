import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertAbsolute } from './fsutil.mjs';

export const DEFAULT_CONFIG_PATH = '/etc/agent-teams/hosted-launcher.json';
const COMPOSE_PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const OPENCODE_MODE = /^official-v[0-9]+\.[0-9]+\.[0-9]+$/u;
const CONFIG_KEYS = new Set(['productRepo', 'stateDir', 'installRoot', 'runDir', 'logDir',
  'launcherKeyFile', 'secretsDir', 'composeProject', 'composeEnvFile', 'providerEnvFile',
  'agent', 'claudeRoot', 'workspaceRoot', 'opencode', 'timeouts']);
const AGENT_KEYS = new Set(['uid', 'gid', 'home', 'user']);

/** Values the launcher owns. The operator's compose env file may not set them. */
export const LAUNCHER_OWNED_COMPOSE_KEYS = Object.freeze([
  'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES', 'COMPOSE_FILE', 'CLAUDE_DIR', 'HOSTED_SECRETS_DIR',
  'HOSTED_LIFECYCLE_ORCHESTRATOR_RUN_DIR', 'HOSTED_WORKSPACE_ROOT', 'HOSTED_PRODUCT_IMAGE',
  'AUTH_DEPLOYMENT_ID', 'AUTH_RESTORE_GENERATION', 'HOSTED_WORKSPACE_IDS',
  'AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP', 'HOSTED_OPENCODE_RUNTIME_MODE',
]);

const DEFAULT_TIMEOUTS = Object.freeze({
  ownerSocketMs: 60_000, productHealthyMs: 600_000, productUnhealthyGraceMs: 120_000,
  healthPollMs: 10_000, productStopSeconds: 45, ownerStopMs: 30_000,
});

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`hostedctl-config-${label}-invalid`);
  return value;
}

export function parseConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(key => !CONFIG_KEYS.has(key))) {
    throw new Error('hostedctl-config-invalid');
  }
  const agent = raw.agent;
  if (!agent || Object.keys(agent).some(key => !AGENT_KEYS.has(key)) ||
      typeof agent.user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/u.test(agent.user)) {
    throw new Error('hostedctl-config-agent-invalid');
  }
  positiveInteger(agent.uid, 'agent-uid');
  positiveInteger(agent.gid, 'agent-gid');
  if (!COMPOSE_PROJECT.test(raw.composeProject ?? '')) throw new Error('hostedctl-config-compose-project-invalid');
  const opencode = raw.opencode ?? null;
  if (opencode !== null && (typeof opencode !== 'object' || !OPENCODE_MODE.test(opencode.runtimeMode ?? '') ||
      Object.keys(opencode).some(key => !['runtimeMode', 'binaryPath'].includes(key)))) {
    throw new Error('hostedctl-config-opencode-invalid');
  }
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(raw.timeouts ?? {}) };
  for (const [name, value] of Object.entries(timeouts)) {
    if (!(name in DEFAULT_TIMEOUTS)) throw new Error(`hostedctl-config-timeout-unknown:${name}`);
    positiveInteger(value, `timeout-${name}`);
  }
  const paths = ['productRepo', 'stateDir', 'installRoot', 'runDir', 'logDir', 'launcherKeyFile',
    'secretsDir', 'composeEnvFile', 'claudeRoot', 'workspaceRoot'];
  for (const name of paths) assertAbsolute(raw[name], `config-${name}`);
  assertAbsolute(agent.home, 'config-agent-home');
  if (raw.providerEnvFile !== undefined) assertAbsolute(raw.providerEnvFile, 'config-providerEnvFile');
  if (opencode?.binaryPath !== undefined) assertAbsolute(opencode.binaryPath, 'config-opencode-binaryPath');
  // Product binds the Claude root read-only into an internet-facing container. Provider
  // credentials and the agent home must never live below it.
  for (const path of [agent.home, raw.workspaceRoot]) {
    if (path === raw.claudeRoot || path.startsWith(`${raw.claudeRoot}/`) ||
        raw.claudeRoot.startsWith(`${path}/`)) {
      throw new Error('hostedctl-config-claude-root-must-be-separate');
    }
  }
  return Object.freeze({
    ...raw, agent: Object.freeze({ ...agent }), opencode, timeouts: Object.freeze(timeouts),
    composeFiles: Object.freeze([join(raw.productRepo, 'docker', 'docker-compose.yml'),
      join(raw.productRepo, 'deploy', 'hosted-launcher', 'compose.personal-host.yml')]),
    sessionEnvFile: join(raw.stateDir, 'session.env'),
  });
}

export async function loadConfig(path = DEFAULT_CONFIG_PATH) {
  return parseConfig(JSON.parse(await readFile(assertAbsolute(path, 'config'), 'utf8')));
}

/** Minimal dotenv reader for operator-owned files: KEY=value, optional single/double quotes. */
export function parseEnvFile(text) {
  const values = new Map();
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(trimmed);
    if (!match || values.has(match[1])) throw new Error(`hostedctl-env-file-line-invalid:${index + 1}`);
    let value = match[2];
    if (/^'.*'$/u.test(value) || /^".*"$/u.test(value)) value = value.slice(1, -1);
    values.set(match[1], value);
  }
  return values;
}
