import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

import {
  CADDY_VOLUME_OWNER_SCRIPT_SHA256,
  isObject,
  sameSequence,
} from './verify-hosted-container-hardening-contracts.mjs';

export function caddyMounts(caddyfile, dataVolume, configVolume) {
  return [
    {
      type: 'bind',
      target: '/etc/caddy/Caddyfile',
      readOnly: true,
      sourceSuffix: `/docker/${caddyfile.slice(2)}`,
    },
    { type: 'volume', source: dataVolume, target: '/data' },
    { type: 'volume', source: configVolume, target: '/config' },
  ];
}

export function caddyVolumeOwnerInitializerMounts(dataVolume, configVolume) {
  return [
    {
      type: 'bind',
      target: '/usr/local/bin/init-caddy-volume-ownership',
      readOnly: true,
      absoluteSource: true,
      sourceSuffix: '/docker/caddy/init-volume-ownership.sh',
    },
    { type: 'volume', source: dataVolume, target: '/data' },
    { type: 'volume', source: configVolume, target: '/config' },
  ];
}

export function verifyTopLevelVolumes(profile, rendered, violations) {
  const volumes = isObject(rendered.volumes) ? rendered.volumes : {};
  for (const volumeName of ['agent-teams-data', 'agent-teams-application-data']) {
    if (!isObject(volumes[volumeName])) {
      violations.push(`volume:${volumeName}:missing`);
    }
  }
  const caddyVolumePrefix = profile === 'personal' ? 'caddy-personal' : 'caddy';
  for (const suffix of ['data', 'config']) {
    const name = `${caddyVolumePrefix}-${suffix}`;
    const volume = volumes[name];
    if (
      !isObject(volume) ||
      volume.external === true ||
      volume.driver_opts !== undefined ||
      (volume.driver !== undefined && volume.driver !== 'local')
    ) {
      violations.push(`volume:${name}:persistence_contract_invalid`);
    }
  }
  if (profile !== 'keycloak') return;
  for (const name of ['agent-teams-keycloak-secret', 'agent-teams-keycloak-trust']) {
    const volume = volumes[name];
    if (
      !isObject(volume) ||
      volume.driver_opts !== undefined ||
      (volume.driver !== undefined && volume.driver !== 'local')
    ) {
      violations.push(`volume:${name}:persistence_contract_invalid`);
    }
  }
  for (const volumeName of ['keycloak-postgres-data']) {
    if (!isObject(volumes[volumeName])) {
      violations.push(`volume:${volumeName}:missing`);
    }
  }
}

export function verifyCaddyVolumeOwnerInitializer(profile, services, root, violations) {
  const caddyName = profile === 'personal' ? 'caddy-personal' : 'caddy';
  const initializerName = `${caddyName}-volume-owner-init`;
  const initializer = services[initializerName];
  if (!isObject(initializer)) return;

  if (
    !sameSequence(initializer.entrypoint, [
      '/bin/sh',
      '/usr/local/bin/init-caddy-volume-ownership',
    ]) ||
    (initializer.command !== undefined && initializer.command !== null) ||
    initializer.environment !== undefined
  ) {
    violations.push(`service:${initializerName}:initializer_command_invalid`);
  }
  if (initializer.image !== services[caddyName]?.image) {
    violations.push(`service:${initializerName}:image_contract_invalid`);
  }
  const scriptMount = Array.isArray(initializer.volumes)
    ? initializer.volumes.find(
        (mount) => mount?.target === '/usr/local/bin/init-caddy-volume-ownership'
      )
    : undefined;
  try {
    if (
      realpathSync(scriptMount?.source) !==
      realpathSync(join(root, 'docker/caddy/init-volume-ownership.sh'))
    ) {
      violations.push(`service:${initializerName}:mount_contract_invalid`);
    }
  } catch {
    violations.push(`service:${initializerName}:mount_contract_invalid`);
  }
}

export function verifyCaddyVolumeOwnerScript(script, violations) {
  // Root + CAP_CHOWN is granted only to this reviewed fixed-directory script.
  const digest = createHash('sha256').update(script).digest('hex');
  if (digest !== CADDY_VOLUME_OWNER_SCRIPT_SHA256) {
    violations.push('caddy_volume_owner_script_contract_invalid');
  }
}
