import { readFile } from 'node:fs/promises';
import { atomicWriteFile } from './fsutil.mjs';
import { LAUNCHER_OWNED_COMPOSE_KEYS, parseEnvFile } from './config.mjs';
import { docker as defaultDocker } from './process.mjs';

export const PRODUCT_SERVICE = 'agent-teams-personal';
export const TRUST_INIT_SERVICE = 'agent-teams-lifecycle-trust-init';
export const CADDY_SERVICE = 'caddy-personal';

export const productImageTag = config => `agent-teams-hosted-product:${config.composeProject}`;

/**
 * Launcher-owned Compose values. Before the first session the bootstrap is a placeholder: only
 * `install product` (a build) runs without a session, and it never starts a container.
 */
export function launcherComposeValues(config, state, session = null) {
  const values = {
    COMPOSE_PROJECT_NAME: config.composeProject,
    COMPOSE_PROFILES: 'personal',
    CLAUDE_DIR: config.claudeRoot,
    HOSTED_SECRETS_DIR: config.secretsDir,
    HOSTED_LIFECYCLE_ORCHESTRATOR_RUN_DIR: session?.runDirectory ?? config.runDir,
    HOSTED_WORKSPACE_ROOT: config.workspaceRoot,
    HOSTED_PRODUCT_IMAGE: productImageTag(config),
    AUTH_DEPLOYMENT_ID: state.deploymentId,
    AUTH_RESTORE_GENERATION: String(state.restoreGeneration),
    HOSTED_WORKSPACE_IDS: state.workspaceId,
    AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP: session?.bootstrap ?? 'hostedctl-no-session',
    HOSTED_OPENCODE_RUNTIME_MODE: config.opencode?.runtimeMode ?? '',
  };
  for (const [key, value] of Object.entries(values)) {
    if (/['\n\r\0]/u.test(value)) throw new Error(`hostedctl-compose-value-unquotable:${key}`);
  }
  return values;
}

/** Single quotes keep Compose from interpolating the JSON bootstrap. */
export function renderEnvFile(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}='${value}'`).join('\n')}\n`;
}

export async function assertOperatorEnv(path) {
  const values = parseEnvFile(await readFile(path, 'utf8'));
  const owned = LAUNCHER_OWNED_COMPOSE_KEYS.filter(key => values.has(key));
  if (owned.length > 0) throw new Error(`hostedctl-compose-env-sets-launcher-keys:${owned.join(',')}`);
  return values;
}

export async function writeSessionEnv(config, values) {
  await atomicWriteFile(config.sessionEnvFile, renderEnvFile(values), { mode: 0o600 });
}

export function composeArgs(config, envFile = config.sessionEnvFile) {
  return ['compose', '-p', config.composeProject,
    ...config.composeFiles.flatMap(file => ['-f', file]),
    '--env-file', config.composeEnvFile, '--env-file', envFile, '--profile', 'personal'];
}

/** Compose reads only the env files; the launcher's own environment is not forwarded. */
export const composeProcessEnv = () => ({ PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: '/root', DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? '/root/.docker' });

export function createCompose(config, docker = defaultDocker) {
  const compose = (args, timeoutMs = 120_000) => docker([...composeArgs(config), ...args],
    { env: composeProcessEnv(), cwd: config.productRepo, timeoutMs });
  const labelled = service => ['ps', '-aq', '--filter', `label=com.docker.compose.project=${config.composeProject}`,
    '--filter', `label=com.docker.compose.service=${service}`];

  async function containerIds(service) {
    return (await docker(labelled(service))).split('\n').filter(Boolean);
  }

  return {
    compose,
    containerIds,
    /**
     * Stops Product by label, so it works even when no session env file exists yet (for
     * example after a reboot or a crashed supervisor).
     */
    async stopProduct() {
      const ids = await containerIds(PRODUCT_SERVICE);
      if (ids.length > 0) {
        await docker(['stop', '--time', String(config.timeouts.productStopSeconds), ...ids],
          { timeoutMs: (config.timeouts.productStopSeconds + 30) * 1000 });
      }
      for (const id of ids) {
        const state = await docker(['inspect', '--format', '{{.State.Status}}', id]);
        if (!['exited', 'created', 'dead'].includes(state)) throw new Error('hostedctl-product-still-running');
      }
    },
    async startProduct() {
      await compose(['up', '-d', '--no-build', '--pull', 'never', '--wait', CADDY_SERVICE], 300_000);
      await compose(['up', '-d', '--no-build', '--pull', 'never', '--no-deps', '--force-recreate',
        TRUST_INIT_SERVICE], 120_000);
      const [initId] = await containerIds(TRUST_INIT_SERVICE);
      if (!initId || await docker(['wait', initId], { timeoutMs: 120_000 }) !== '0') {
        throw new Error('hostedctl-trust-init-failed');
      }
      await compose(['up', '-d', '--no-build', '--pull', 'never', '--no-deps', '--force-recreate',
        '--wait', '--wait-timeout', String(Math.ceil(config.timeouts.productHealthyMs / 1000)),
        PRODUCT_SERVICE], config.timeouts.productHealthyMs + 60_000);
    },
    /** 'healthy' | 'starting' | 'unhealthy' | 'stopped' | 'missing' */
    async productHealth() {
      const [id] = await containerIds(PRODUCT_SERVICE);
      if (!id) return 'missing';
      const raw = await docker(['inspect', '--format', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', id]);
      const [status, health] = raw.split(' ');
      if (status !== 'running') return 'stopped';
      return ['healthy', 'starting', 'unhealthy'].includes(health) ? health : 'unhealthy';
    },
    async stopAll() {
      await compose(['stop', '--timeout', String(config.timeouts.productStopSeconds)], 300_000);
    },
  };
}
