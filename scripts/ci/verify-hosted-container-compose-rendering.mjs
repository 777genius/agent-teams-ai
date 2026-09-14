import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

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

export function restoreExplicitBindCreateHostPathFalse(renderedCompose, rawComposeSource) {
  const rawCompose = parseYaml(rawComposeSource);
  if (!isObject(rawCompose) || !isObject(rawCompose.services)) {
    throw new Error('raw Compose YAML must contain services');
  }

  for (const [serviceName, rawService] of Object.entries(rawCompose.services)) {
    const renderedService = renderedCompose.services[serviceName];
    if (
      !isObject(rawService) ||
      !Array.isArray(rawService.volumes) ||
      !isObject(renderedService) ||
      !Array.isArray(renderedService.volumes)
    ) {
      continue;
    }

    const explicitFalseTargets = new Set(
      rawService.volumes
        .filter(
          (mount) =>
            isObject(mount) &&
            mount.type === 'bind' &&
            typeof mount.target === 'string' &&
            isObject(mount.bind) &&
            mount.bind.create_host_path === false
        )
        .map((mount) => mount.target)
    );

    for (const renderedMount of renderedService.volumes) {
      if (
        !isObject(renderedMount) ||
        renderedMount.type !== 'bind' ||
        !explicitFalseTargets.has(renderedMount.target) ||
        (isObject(renderedMount.bind) && renderedMount.bind.create_host_path !== undefined)
      ) {
        continue;
      }
      if (!isObject(renderedMount.bind)) renderedMount.bind = {};
      renderedMount.bind.create_host_path = false;
    }
  }

  return renderedCompose;
}

/** Renders exactly one profile through Docker Compose's non-executing config command. */
export function renderHostedContainerHardeningCompose(options = {}) {
  const profile = options.profile;
  if (!PROFILES.includes(profile)) {
    throw new Error('profile must be personal or keycloak');
  }

  const root = resolve(options.root ?? REPOSITORY_ROOT);
  const composePath = join(root, COMPOSE_PATH);
  const rawComposeSource = readFileSync(composePath, 'utf8');
  const dockerBinary = options.dockerBinary ?? defaultDockerBinary();
  const environment = { ...process.env, ...DEFAULT_RENDER_ENVIRONMENT, ...options.environment };
  const rendered = spawnSync(
    dockerBinary,
    ['compose', '-f', composePath, '--profile', profile, 'config', '--format', 'json'],
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
  return restoreExplicitBindCreateHostPathFalse(
    parseRenderedHostedCompose(rendered.stdout),
    rawComposeSource
  );
}

function defaultDockerBinary() {
  return existsSync('/usr/bin/docker') ? '/usr/bin/docker' : 'docker';
}
