import { isAbsolute, resolve } from 'node:path';

import { isObject } from './verify-hosted-container-hardening-contracts.mjs';

const BROAD_LIFECYCLE_RUN_DIRECTORIES = new Set([
  '/',
  '/bin',
  '/boot',
  '/data',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib64',
  '/media',
  '/mnt',
  '/opt',
  '/private',
  '/private/tmp',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/srv',
  '/sys',
  '/tmp',
  '/Users',
  '/usr',
  '/var',
  '/var/run',
  '/Volumes',
  '/workspace',
  '/workspaces',
]);

export const LIFECYCLE_OWNER_MOUNTS = Object.freeze([
  Object.freeze({
    type: 'bind',
    target: '/run/agent-teams-orchestrator',
    readOnly: true,
    absoluteSource: true,
    createHostPath: false,
  }),
  Object.freeze({
    type: 'volume',
    source: 'agent-teams-lifecycle-owner-high-water',
    target: '/var/lib/agent-teams/lifecycle-owner-high-water',
    readOnly: false,
    copyUpRequired: true,
  }),
]);

export const LIFECYCLE_TRUST_SECRET = Object.freeze({
  source: 'lifecycle_orchestrator_trust_anchor',
  target: '/run/secrets/lifecycle_orchestrator_trust_anchor',
});
export const LIFECYCLE_RELEASE_PIN_SECRET = Object.freeze({
  source: 'lifecycle_owner_release_pin',
  target: '/run/secrets/lifecycle_owner_release_pin',
});
export const LIFECYCLE_TRUST_SECRETS = Object.freeze([
  LIFECYCLE_TRUST_SECRET,
  LIFECYCLE_RELEASE_PIN_SECRET,
]);

const LIFECYCLE_TRUST_VOLUME = 'agent-teams-lifecycle-trust';
const LIFECYCLE_TRUST_TARGET = '/run/agent-teams-lifecycle-trust';
const LIFECYCLE_TRUST_INITIALIZER = 'agent-teams-lifecycle-trust-init';
const LIFECYCLE_OWNER_MANIFEST_PATH =
  '/run/agent-teams-orchestrator/lifecycle-owner-admission.json';
const LEGACY_OWNER_ENVIRONMENT_KEYS = Object.freeze([
  'HOSTED_LIFECYCLE_OWNER_ARTIFACT_DIGEST',
  'HOSTED_LIFECYCLE_OWNER_IMAGE_REFERENCE',
  'HOSTED_LIFECYCLE_OWNER_PROTOCOL_VERSION',
  'HOSTED_LIFECYCLE_OWNER_AUTHORITY',
]);

function isPrivateManagedLocalVolume(volume, expectedName) {
  return (
    isObject(volume) &&
    volume.name === expectedName &&
    (volume.external === undefined || volume.external === false) &&
    volume.driver_opts === undefined &&
    (volume.driver === undefined || volume.driver === 'local')
  );
}

export function hasOnlyLifecycleTrustSecret(secrets) {
  return (
    !Array.isArray(secrets) ||
    secrets.every((secret) =>
      LIFECYCLE_TRUST_SECRETS.some((expected) => expected.source === secret?.source)
    )
  );
}

export function isNarrowExternalLifecycleRunDirectory(value) {
  return (
    typeof value === 'string' &&
    isAbsolute(value) &&
    resolve(value) === value &&
    !BROAD_LIFECYCLE_RUN_DIRECTORIES.has(value)
  );
}

export function verifyHostedLifecycleOwnerContainerContract(profile, rendered, violations) {
  const applicationName = `agent-teams-${profile}`;
  const application = rendered.services?.[applicationName];
  const trustInitializer = rendered.services?.[LIFECYCLE_TRUST_INITIALIZER];
  const volumes = rendered.volumes;
  const secrets = rendered.secrets;
  const projectName = rendered.name;
  if (!isObject(application)) return;

  const lifecycleSocketConsumers = Object.entries(rendered.services ?? {})
    .filter(([, service]) => {
      if (!isObject(service)) return false;
      const mounts = Array.isArray(service.volumes) ? service.volumes : [];
      return (
        service.environment?.HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET !== undefined ||
        mounts.some((mount) => mount?.target === '/run/agent-teams-orchestrator')
      );
    })
    .map(([serviceName]) => serviceName);
  if (lifecycleSocketConsumers.length !== 1 || lifecycleSocketConsumers[0] !== applicationName) {
    violations.push(`profile:${profile}:external_lifecycle_owner_consumer_inventory_invalid`);
  }
  if (
    application.container_name !== 'agent-teams-hosted-controller' ||
    (application.deploy?.replicas !== undefined && application.deploy.replicas !== 1)
  ) {
    violations.push(`service:${applicationName}:lifecycle_consumer_singleton_contract_invalid`);
  }
  const lifecycleRunMount = Array.isArray(application.volumes)
    ? application.volumes.find((mount) => mount?.target === '/run/agent-teams-orchestrator')
    : undefined;
  if (!isNarrowExternalLifecycleRunDirectory(lifecycleRunMount?.source)) {
    violations.push(`service:${applicationName}:external_lifecycle_owner_source_invalid`);
  }
  const lifecycleBootstrapConsumers = Object.entries(rendered.services ?? {})
    .filter(
      ([, service]) =>
        isObject(service) &&
        service.environment?.AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP !== undefined
    )
    .map(([serviceName]) => serviceName);
  if (
    lifecycleBootstrapConsumers.length !== 1 ||
    lifecycleBootstrapConsumers[0] !== applicationName
  ) {
    violations.push(`profile:${profile}:lifecycle_read_bootstrap_consumer_inventory_invalid`);
  }
  const lifecycleManifestConsumers = Object.entries(rendered.services ?? {})
    .filter(
      ([, service]) =>
        isObject(service) &&
        service.environment?.HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_FILE !== undefined
    )
    .map(([serviceName]) => serviceName);
  if (
    lifecycleManifestConsumers.length !== 1 ||
    lifecycleManifestConsumers[0] !== applicationName
  ) {
    violations.push(`profile:${profile}:lifecycle_owner_manifest_consumer_inventory_invalid`);
  }
  const lifecycleReleasePinConsumers = Object.entries(rendered.services ?? {})
    .filter(
      ([, service]) =>
        isObject(service) &&
        service.environment?.HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FILE !== undefined
    )
    .map(([serviceName]) => serviceName);
  if (
    lifecycleReleasePinConsumers.length !== 1 ||
    lifecycleReleasePinConsumers[0] !== applicationName
  ) {
    violations.push(`profile:${profile}:lifecycle_owner_release_pin_consumer_inventory_invalid`);
  }

  if (
    application.environment?.HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET !==
      '/run/agent-teams-orchestrator/orchestrator-lifecycle.sock' ||
    application.environment?.HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_FILE !==
      LIFECYCLE_OWNER_MANIFEST_PATH ||
    application.environment?.HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR_FILE !==
      `${LIFECYCLE_TRUST_TARGET}/trust-anchor` ||
    application.environment?.HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FILE !==
      `${LIFECYCLE_TRUST_TARGET}/release-owner-pin.json` ||
    application.environment?.HOSTED_LIFECYCLE_ORCHESTRATOR_HIGH_WATER_ROOT !==
      '/var/lib/agent-teams/lifecycle-owner-high-water'
  ) {
    violations.push(`service:${applicationName}:application_data_path_invalid`);
  }
  if (
    typeof application.environment?.AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP !== 'string' ||
    application.environment.AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP.length === 0
  ) {
    violations.push(`service:${applicationName}:lifecycle_read_bootstrap_binding_invalid`);
  }
  if (
    application.environment?.AGENT_TEAMS_HOSTED_PHASE2_READ_BOOTSTRAP !== undefined ||
    application.environment?.HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR !== undefined ||
    LEGACY_OWNER_ENVIRONMENT_KEYS.some(
      (environmentKey) => application.environment?.[environmentKey] !== undefined
    )
  ) {
    violations.push(`service:${applicationName}:lifecycle_owner_environment_fallback_forbidden`);
  }
  const highWaterVolume = volumes?.['agent-teams-lifecycle-owner-high-water'];
  if (!isObject(highWaterVolume)) {
    violations.push('volume:agent-teams-lifecycle-owner-high-water:missing');
  } else if (
    typeof projectName !== 'string' ||
    !isPrivateManagedLocalVolume(
      highWaterVolume,
      `${projectName}_agent-teams-lifecycle-owner-high-water`
    )
  ) {
    violations.push('volume:agent-teams-lifecycle-owner-high-water:persistence_contract_invalid');
  }
  const lifecycleTrustSourceConsumers = Object.entries(rendered.services ?? {})
    .filter(
      ([, service]) =>
        isObject(service) &&
        Array.isArray(service.secrets) &&
        service.secrets.some((secret) =>
          LIFECYCLE_TRUST_SECRETS.some((expected) => expected.source === secret?.source)
        )
    )
    .map(([serviceName]) => serviceName);
  if (
    lifecycleTrustSourceConsumers.length !== 1 ||
    lifecycleTrustSourceConsumers[0] !== LIFECYCLE_TRUST_INITIALIZER
  ) {
    violations.push(`profile:${profile}:lifecycle_trust_source_consumer_inventory_invalid`);
  }
  if (
    !isObject(trustInitializer) ||
    typeof projectName !== 'string' ||
    !isPrivateManagedLocalVolume(
      volumes?.[LIFECYCLE_TRUST_VOLUME],
      `${projectName}_${LIFECYCLE_TRUST_VOLUME}`
    )
  ) {
    violations.push(`profile:${profile}:lifecycle_trust_handoff_invalid`);
  }
  if (
    isObject(volumes?.[LIFECYCLE_TRUST_VOLUME]) &&
    (typeof projectName !== 'string' ||
      !isPrivateManagedLocalVolume(
        volumes[LIFECYCLE_TRUST_VOLUME],
        `${projectName}_${LIFECYCLE_TRUST_VOLUME}`
      ))
  ) {
    violations.push(`volume:${LIFECYCLE_TRUST_VOLUME}:persistence_contract_invalid`);
  }
  if (
    typeof projectName !== 'string' ||
    volumes?.['agent-teams-lifecycle-owner-high-water']?.name !==
      `${projectName}_agent-teams-lifecycle-owner-high-water`
  ) {
    violations.push(`profile:${profile}:application_data_volume_identity_invalid`);
  }
  if (
    !isObject(secrets?.lifecycle_orchestrator_trust_anchor) ||
    !String(secrets.lifecycle_orchestrator_trust_anchor.file).endsWith(
      '/lifecycle_orchestrator_trust_anchor'
    )
  ) {
    violations.push('secret:lifecycle_orchestrator_trust_anchor:file_contract_invalid');
  }
  if (
    !isObject(secrets?.lifecycle_owner_release_pin) ||
    !String(secrets.lifecycle_owner_release_pin.file).endsWith('/lifecycle_owner_release_pin.json')
  ) {
    violations.push('secret:lifecycle_owner_release_pin:file_contract_invalid');
  }
}
