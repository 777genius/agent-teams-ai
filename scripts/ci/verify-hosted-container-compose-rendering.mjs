import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPOSE_PATH,
  DEFAULT_RENDER_ENVIRONMENT,
  PROFILES,
  isObject,
} from './verify-hosted-container-hardening-contracts.mjs';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '../..');

export function parseRenderedHostedCompose(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!isObject(parsed) || !isObject(parsed.services)) {
    throw new Error('rendered Compose JSON must contain services');
  }
  return parsed;
}

/** Renders exactly one profile through Docker Compose's non-executing config command. */
export function renderHostedContainerHardeningCompose(options = {}) {
  const profile = options.profile;
  if (!PROFILES.includes(profile)) {
    throw new Error('profile must be personal or keycloak');
  }

  const root = resolve(options.root ?? REPOSITORY_ROOT);
  const dockerBinary = options.dockerBinary ?? defaultDockerBinary();
  const environment = { ...process.env, ...DEFAULT_RENDER_ENVIRONMENT, ...options.environment };
  const rendered = spawnSync(
    dockerBinary,
    ['compose', '-f', join(root, COMPOSE_PATH), '--profile', profile, 'config', '--format', 'json'],
    {
      cwd: root,
      encoding: 'utf8',
      env: environment,
      killSignal: 'SIGKILL',
      maxBuffer: 5 * 1024 * 1024,
      timeout: 30_000,
    }
  );

  if (rendered.status !== 0 || rendered.error) {
    throw new Error(`docker compose config failed for ${profile}`);
  }
  return parseRenderedHostedCompose(rendered.stdout);
}

function defaultDockerBinary() {
  return existsSync('/usr/bin/docker') ? '/usr/bin/docker' : 'docker';
}
