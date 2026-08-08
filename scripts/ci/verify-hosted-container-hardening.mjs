#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  APP_HEALTHCHECK,
  CADDY_HEALTHCHECK,
  COMPOSE_PATH,
  DEFAULT_RENDER_ENVIRONMENT,
  DIGEST_PATTERN,
  EXPECTED_DEPENDENCIES,
  EXPECTED_TMPFS,
  EXPECTED_USERS,
  LONG_RUNNING_SERVICES,
  POSTGRES_HEALTHCHECK,
  PROFILES,
  PROFILE_SERVICES,
  compareText,
  isObject,
  isPositive,
  isPositiveDuration,
  resultFor,
  sameSequence,
  sameValues,
} from './verify-hosted-container-hardening-contracts.mjs';
import { verifyHostedNoTerminalDockerfile } from './verify-hosted-no-terminal-artifact.mjs';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '../..');

/**
 * Verifies the effective Docker Compose model, not indentation or YAML spelling.
 * With no injected rendered configuration, this uses only `docker compose config`.
 * It never starts, builds, pulls, or otherwise runs a container.
 */
export function verifyHostedContainerHardening(options = {}) {
  const sources = loadSources(options);
  const violations = [...sources.violations];
  const profiles = requestedProfiles(options, violations);
  let checkedServices = 0;

  for (const profile of profiles) {
    const rendered = loadRenderedCompose(profile, options, sources.root, violations);
    if (!rendered) continue;
    checkedServices += verifyRenderedProfile(profile, rendered, sources.root, violations);
  }

  if (sources.dockerfile) verifyDockerfile(sources.dockerfile, violations);
  if (sources.volumeInitializer) verifyVolumeInitializer(sources.volumeInitializer, violations);

  return resultFor(checkedServices, profiles.length, violations);
}

/** Renders exactly one profile through Docker Compose's non-executing config command. */
export function renderHostedContainerHardeningCompose(options = {}) {
  const profile = options.profile;
  if (!PROFILES.includes(profile)) {
    throw new Error('profile must be personal or keycloak');
  }

  const root = resolve(options.root ?? REPOSITORY_ROOT);
  const dockerBinary = options.dockerBinary ?? defaultDockerBinary();
  const environment = composeRenderEnvironment(options.environment);
  const rendered = spawnSync(
    dockerBinary,
    ['compose', '-f', join(root, COMPOSE_PATH), '--profile', profile, 'config', '--format', 'json'],
    { cwd: root, encoding: 'utf8', env: environment, maxBuffer: 5 * 1024 * 1024 }
  );

  if (rendered.status !== 0 || rendered.error) {
    throw new Error(`docker compose config failed for ${profile}`);
  }

  return parseRenderedCompose(rendered.stdout);
}

function loadSources(options) {
  const root = resolve(options.root ?? REPOSITORY_ROOT);
  const sources = { root, violations: [] };
  for (const [key, relativePath] of [
    ['dockerfile', 'docker/Dockerfile'],
    ['volumeInitializer', 'docker/hosted-volume-init.sh'],
  ]) {
    if (typeof options[key] === 'string') {
      sources[key] = options[key];
      continue;
    }
    try {
      sources[key] = readFileSync(join(root, relativePath), 'utf8');
    } catch {
      sources.violations.push(`input_unreadable:${key}`);
    }
  }
  return sources;
}

function requestedProfiles(options, violations) {
  if (options.profile === undefined) return PROFILES;
  if (PROFILES.includes(options.profile)) return [options.profile];
  violations.push('profile_invalid');
  return [];
}

function loadRenderedCompose(profile, options, root, violations) {
  try {
    const injected = options.renderedComposes?.[profile] ?? options.renderedCompose;
    if (injected !== undefined) return parseRenderedCompose(injected);
    return renderHostedContainerHardeningCompose({
      profile,
      root,
      dockerBinary: options.dockerBinary,
      environment: options.environment,
    });
  } catch {
    violations.push(`compose_render_failed:${profile}`);
    return null;
  }
}

function parseRenderedCompose(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!isObject(parsed) || !isObject(parsed.services)) {
    throw new Error('rendered Compose JSON must contain services');
  }
  return parsed;
}

function composeRenderEnvironment(overrides) {
  return { ...process.env, ...DEFAULT_RENDER_ENVIRONMENT, ...overrides };
}

function defaultDockerBinary() {
  return existsSync('/usr/bin/docker') ? '/usr/bin/docker' : 'docker';
}

function verifyRenderedProfile(profile, rendered, root, violations) {
  const services = rendered.services;
  const expectedNames = PROFILE_SERVICES[profile];
  verifyExactNames(Object.keys(services), expectedNames, `profile:${profile}:service`, violations);

  for (const serviceName of expectedNames) {
    const service = services[serviceName];
    if (!isObject(service)) continue;
    verifyServiceProfile(serviceName, profile, service, violations);
    verifyServiceCommonHardening(serviceName, service, violations);
    verifyDependencies(serviceName, service, violations);
    verifyServiceMounts(serviceName, service, violations);
    verifyServiceSecrets(serviceName, service, violations);
    verifyServiceNetworks(serviceName, service, violations);
    verifyImageContract(serviceName, service, root, violations);
  }

  verifyTopLevelNetworks(profile, rendered, violations);
  verifyTopLevelVolumes(profile, rendered, violations);
  verifyApplicationDataContract(profile, rendered, violations);
  verifyTopLevelSecrets(profile, rendered, violations);
  verifyPortPolicy(services, violations);
  verifyHealthContracts(services, violations);
  verifyInitializerCommands(services, violations);
  verifyOidcSecretHandoff(services, violations);
  verifyKeycloakRuntimeContract(services, violations);

  return expectedNames.length;
}

function verifyServiceProfile(serviceName, profile, service, violations) {
  if (!sameValues(service.profiles, [profile]))
    violations.push(`service:${serviceName}:profile_invalid`);
}

function verifyServiceCommonHardening(serviceName, service, violations) {
  if (service.user !== EXPECTED_USERS[serviceName]) {
    violations.push(`service:${serviceName}:user_invalid`);
  }
  if (service.init !== true) violations.push(`service:${serviceName}:init_required`);
  if (service.read_only !== true) violations.push(`service:${serviceName}:read_only_required`);
  if (!sameValues(service.cap_drop, ['ALL'])) {
    violations.push(`service:${serviceName}:cap_drop_all_required`);
  }
  if (!sameValues(service.security_opt, ['no-new-privileges:true'])) {
    violations.push(`service:${serviceName}:security_opt_invalid`);
  }
  if (!isPositive(service.pids_limit)) {
    violations.push(`service:${serviceName}:pids_limit_required`);
  }
  if (!isPositive(service.cpus)) violations.push(`service:${serviceName}:cpu_limit_required`);
  if (!isPositive(service.mem_limit)) {
    violations.push(`service:${serviceName}:memory_limit_required`);
  }
  if (!isPositiveDuration(service.stop_grace_period)) {
    violations.push(`service:${serviceName}:stop_grace_period_required`);
  }

  const caddy = serviceName === 'caddy' || serviceName === 'caddy-personal';
  if (!sameValues(service.cap_add, caddy ? ['NET_BIND_SERVICE'] : [])) {
    violations.push(`service:${serviceName}:capability_contract_invalid`);
  }
  if (service.privileged === true) violations.push(`service:${serviceName}:privileged_forbidden`);
  if (
    service.devices !== undefined &&
    (!Array.isArray(service.devices) || service.devices.length > 0)
  ) {
    violations.push(`service:${serviceName}:devices_forbidden`);
  }
  if (
    service.volumes_from !== undefined &&
    (!Array.isArray(service.volumes_from) || service.volumes_from.length > 0)
  ) {
    violations.push(`service:${serviceName}:volumes_from_forbidden`);
  }
  if (service.pid === 'host') {
    violations.push(`service:${serviceName}:host_pid_namespace_forbidden`);
  }
  if (service.ipc === 'host') {
    violations.push(`service:${serviceName}:host_ipc_namespace_forbidden`);
  }

  const expectedRestart = LONG_RUNNING_SERVICES.has(serviceName) ? 'unless-stopped' : 'no';
  if (service.restart !== expectedRestart) {
    violations.push(`service:${serviceName}:restart_policy_invalid`);
  }

  if (!sameValues(service.tmpfs, EXPECTED_TMPFS[serviceName])) {
    violations.push(`service:${serviceName}:tmpfs_contract_invalid`);
  }
}

function verifyDependencies(serviceName, service, violations) {
  const expected = EXPECTED_DEPENDENCIES[serviceName] ?? {};
  const dependencies = isObject(service.depends_on) ? service.depends_on : {};
  if (!sameValues(Object.keys(dependencies), Object.keys(expected))) {
    violations.push(`service:${serviceName}:dependency_contract_invalid`);
    return;
  }
  for (const [dependency, condition] of Object.entries(expected)) {
    const contract = dependencies[dependency];
    if (!isObject(contract) || contract.condition !== condition || contract.required !== true) {
      violations.push(`service:${serviceName}:dependency_contract_invalid`);
      return;
    }
  }
}

function verifyServiceMounts(serviceName, service, violations) {
  const expected = expectedMounts(serviceName);
  const actual = Array.isArray(service.volumes) ? service.volumes : [];
  if (actual.length !== expected.length) {
    violations.push(`service:${serviceName}:mount_contract_invalid`);
    return;
  }

  for (const contract of expected) {
    const mount = actual.find((candidate) => candidate?.target === contract.target);
    if (!mount || !mountMatches(mount, contract)) {
      violations.push(`service:${serviceName}:mount_contract_invalid`);
      return;
    }
  }
}

function expectedMounts(serviceName) {
  const claude = { type: 'bind', target: '/data/.claude', readOnly: true };
  const state = {
    type: 'volume',
    source: 'agent-teams-data',
    target: '/data/.agent-teams',
    copyUpRequired: true,
  };
  const applicationData = {
    type: 'volume',
    source: 'agent-teams-application-data',
    target: '/data/.agent-teams/data',
    copyUpRequired: true,
  };
  const caddyTrust = {
    type: 'volume',
    source: 'agent-teams-keycloak-trust',
    target: '/caddy-trust',
    readOnly: true,
  };

  switch (serviceName) {
    case 'agent-teams-personal':
      return [claude, state, applicationData];
    case 'agent-teams-keycloak':
      return [
        claude,
        state,
        applicationData,
        caddyTrust,
        {
          type: 'volume',
          source: 'agent-teams-keycloak-secret',
          target: '/run/agent-teams-oidc',
          readOnly: true,
        },
      ];
    case 'keycloak':
      return [
        {
          type: 'bind',
          target: '/opt/keycloak/realm-template/realm-agent-teams.json',
          readOnly: true,
          sourceSuffix: '/docker/keycloak/realm-agent-teams.json',
        },
        caddyTrust,
      ];
    case 'keycloak-postgres':
      return [
        { type: 'volume', source: 'keycloak-postgres-data', target: '/var/lib/postgresql/data' },
      ];
    case 'caddy':
      return caddyMounts('./caddy/Caddyfile', 'caddy-data', 'caddy-config');
    case 'caddy-personal':
      return caddyMounts(
        './caddy/Caddyfile.personal',
        'caddy-personal-data',
        'caddy-personal-config'
      );
    case 'keycloak-volume-init':
      return [
        { type: 'volume', source: 'caddy-data', target: '/caddy-data', readOnly: true },
        { type: 'volume', source: 'agent-teams-keycloak-trust', target: '/caddy-trust' },
      ];
    case 'agent-teams-keycloak-secret-init':
      return [
        {
          type: 'volume',
          source: 'agent-teams-keycloak-secret',
          target: '/run/agent-teams-oidc',
        },
      ];
    default:
      return [];
  }
}

function caddyMounts(caddyfile, dataVolume, configVolume) {
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

function mountMatches(mount, contract) {
  if (mount.type !== contract.type || mount.target !== contract.target) return false;
  if ((mount.read_only === true) !== (contract.readOnly === true)) return false;
  if (contract.source && mount.source !== contract.source) return false;
  if (contract.sourceSuffix && !String(mount.source).endsWith(contract.sourceSuffix)) return false;
  if (contract.copyUpRequired === true && mount.volume?.nocopy === true) return false;
  return true;
}

function verifyServiceSecrets(serviceName, service, violations) {
  const expected = expectedSecrets(serviceName);
  const actual = Array.isArray(service.secrets) ? service.secrets : [];
  if (actual.length !== expected.length) {
    violations.push(`service:${serviceName}:secret_contract_invalid`);
    return;
  }
  for (const secret of expected) {
    if (
      !actual.some(
        (candidate) => candidate?.source === secret.source && candidate?.target === secret.target
      )
    ) {
      violations.push(`service:${serviceName}:secret_contract_invalid`);
      return;
    }
  }
}

function expectedSecrets(serviceName) {
  if (serviceName === 'keycloak') {
    return [
      { source: 'oidc_client_secret', target: '/run/secrets/oidc_client_secret' },
      { source: 'keycloak_admin_password', target: '/run/secrets/keycloak_admin_password' },
      { source: 'keycloak_database_password', target: '/run/secrets/keycloak_database_password' },
    ];
  }
  if (serviceName === 'keycloak-postgres') {
    return [
      { source: 'keycloak_database_password', target: '/run/secrets/keycloak_database_password' },
    ];
  }
  if (serviceName === 'agent-teams-keycloak-secret-init') {
    return [{ source: 'oidc_client_secret', target: '/run/secrets/oidc_client_secret' }];
  }
  return [];
}

function verifyServiceNetworks(serviceName, service, violations) {
  const expected = expectedNetworks(serviceName);
  const actual = isObject(service.networks) ? Object.keys(service.networks) : [];
  if (!sameValues(actual, expected)) {
    violations.push(`service:${serviceName}:network_contract_invalid`);
    return;
  }

  if (expected.length === 0) {
    if (service.network_mode !== 'none') {
      violations.push(`service:${serviceName}:network_contract_invalid`);
    }
    return;
  }
  if (service.network_mode !== undefined) {
    violations.push(`service:${serviceName}:network_contract_invalid`);
  }
}

function expectedNetworks(serviceName) {
  if (serviceName === 'keycloak') return ['hosted', 'keycloak-backend'];
  if (serviceName === 'keycloak-postgres') return ['keycloak-backend'];
  if (
    serviceName === 'agent-teams-personal' ||
    serviceName === 'agent-teams-keycloak' ||
    serviceName === 'caddy' ||
    serviceName === 'caddy-personal'
  ) {
    return ['hosted'];
  }
  return [];
}

function verifyImageContract(serviceName, service, root, violations) {
  if (
    serviceName === 'agent-teams-personal' ||
    serviceName === 'agent-teams-keycloak' ||
    serviceName === 'keycloak-volume-init' ||
    serviceName === 'agent-teams-keycloak-secret-init'
  ) {
    if (
      !buildContractMatches(service, root, undefined, [
        'NODE_IMAGE_DIGEST',
        'KEYCLOAK_IMAGE_DIGEST',
      ])
    ) {
      violations.push(`service:${serviceName}:image_contract_invalid`);
    }
    return;
  }
  if (serviceName === 'keycloak') {
    if (!buildContractMatches(service, root, 'keycloak-runtime', ['KEYCLOAK_IMAGE_DIGEST'])) {
      violations.push('service:keycloak:image_contract_invalid');
    }
    return;
  }

  const expectedImage =
    serviceName === 'keycloak-postgres'
      ? /^postgres:17\.5-alpine@sha256:[a-f0-9]{64}$/iu
      : /^caddy:2\.10\.0-alpine@sha256:[a-f0-9]{64}$/iu;
  if (typeof service.image !== 'string' || !expectedImage.test(service.image)) {
    violations.push(`service:${serviceName}:image_contract_invalid`);
  }
}

function buildContractMatches(service, root, target, requiredArguments) {
  if (!isObject(service.build) || service.image !== undefined) return false;
  if (service.build.dockerfile !== 'docker/Dockerfile' || service.build.target !== target)
    return false;
  if (service.build.context !== root) return false;
  if (!isObject(service.build.args)) return false;
  if (!sameValues(Object.keys(service.build.args), requiredArguments)) return false;
  return requiredArguments.every((argument) =>
    DIGEST_PATTERN.test(service.build.args[argument] ?? '')
  );
}

function verifyTopLevelNetworks(profile, rendered, violations) {
  const networks = isObject(rendered.networks) ? rendered.networks : {};
  const expected = profile === 'keycloak' ? ['hosted', 'keycloak-backend'] : ['hosted'];
  for (const networkName of expected) {
    const network = networks[networkName];
    if (!isObject(network) || network.internal !== true || !hasValidSubnet(network)) {
      violations.push(`network:${networkName}:contract_invalid`);
    }
  }
  if (profile === 'keycloak') {
    const backendMembers = Object.entries(rendered.services)
      .filter(([, service]) => isObject(service.networks) && 'keycloak-backend' in service.networks)
      .map(([serviceName]) => serviceName);
    if (!sameValues(backendMembers, ['keycloak', 'keycloak-postgres'])) {
      violations.push('network:keycloak-backend:postgres_isolation_invalid');
    }
  }
}

function hasValidSubnet(network) {
  const subnet = network.ipam?.config?.[0]?.subnet;
  return typeof subnet === 'string' && /^\d{1,3}(?:\.\d{1,3}){3}\/[1-9]\d?$/u.test(subnet);
}

function verifyTopLevelVolumes(profile, rendered, violations) {
  const volumes = isObject(rendered.volumes) ? rendered.volumes : {};
  for (const volumeName of ['agent-teams-data', 'agent-teams-application-data']) {
    if (!isObject(volumes[volumeName])) {
      violations.push(`volume:${volumeName}:missing`);
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
  for (const volumeName of ['keycloak-postgres-data', 'caddy-data', 'caddy-config']) {
    if (!isObject(volumes[volumeName])) {
      violations.push(`volume:${volumeName}:missing`);
    }
  }
}

function verifyApplicationDataContract(profile, rendered, violations) {
  const application = rendered.services?.[`agent-teams-${profile}`];
  const volumes = rendered.volumes;
  const projectName = rendered.name;
  if (!isObject(application)) return;

  if (
    application.environment?.AUTH_DATA_DIR !== '/data/.agent-teams/data' ||
    (profile === 'keycloak' &&
      application.environment?.AUTH_IDENTITY_KEY_FILE !==
        '/data/.agent-teams/data/hosted-auth-secrets/identity.key')
  ) {
    violations.push(`service:agent-teams-${profile}:application_data_path_invalid`);
  }

  if (
    !isObject(volumes) ||
    typeof projectName !== 'string' ||
    volumes['agent-teams-data']?.name !== `${projectName}_agent-teams-instance-lock` ||
    volumes['agent-teams-application-data']?.name !== `${projectName}_agent-teams-data`
  ) {
    violations.push(`profile:${profile}:application_data_volume_identity_invalid`);
  }
}

function verifyTopLevelSecrets(profile, rendered, violations) {
  if (profile !== 'keycloak') return;
  const secrets = isObject(rendered.secrets) ? rendered.secrets : {};
  for (const name of [
    'oidc_client_secret',
    'keycloak_admin_password',
    'keycloak_database_password',
  ]) {
    if (!isObject(secrets[name]) || !String(secrets[name].file).endsWith(`/${name}`)) {
      violations.push(`secret:${name}:file_contract_invalid`);
    }
  }
}

function verifyPortPolicy(services, violations) {
  for (const [serviceName, service] of Object.entries(services)) {
    const ports = Array.isArray(service.ports) ? service.ports : [];
    const caddy = serviceName === 'caddy' || serviceName === 'caddy-personal';
    if (!caddy && ports.length > 0) {
      violations.push(`service:${serviceName}:published_port_forbidden`);
      continue;
    }
    if (caddy && !hasCaddyPortContract(ports)) {
      violations.push(`service:${serviceName}:published_port_contract_invalid`);
    }
  }
}

function hasCaddyPortContract(ports) {
  if (ports.length !== 2) return false;
  const redirect = ports.find((port) => port?.target === 80 && port?.published === '80');
  const https = ports.find(
    (port) => isPositive(port?.target) && String(port?.target) === String(port?.published)
  );
  return Boolean(redirect && https && redirect !== https);
}

function verifyHealthContracts(services, violations) {
  for (const [serviceName, service] of Object.entries(services)) {
    if (!LONG_RUNNING_SERVICES.has(serviceName)) {
      if (service.healthcheck !== undefined) {
        violations.push(`service:${serviceName}:initializer_healthcheck_forbidden`);
      }
      continue;
    }
    const healthcheck = service.healthcheck;
    if (!isObject(healthcheck) || !healthContractMatches(serviceName, healthcheck)) {
      violations.push(`service:${serviceName}:healthcheck_contract_invalid`);
    }
  }
}

function healthContractMatches(serviceName, healthcheck) {
  if (
    !isPositiveDuration(healthcheck.interval) ||
    !isPositiveDuration(healthcheck.timeout) ||
    !isPositive(healthcheck.retries) ||
    !isPositiveDuration(healthcheck.start_period)
  ) {
    return false;
  }

  if (serviceName === 'agent-teams-personal' || serviceName === 'agent-teams-keycloak') {
    return sameSequence(healthcheck.test, APP_HEALTHCHECK);
  }
  if (serviceName === 'caddy' || serviceName === 'caddy-personal') {
    return sameSequence(healthcheck.test, CADDY_HEALTHCHECK);
  }
  if (serviceName === 'keycloak-postgres') {
    return sameSequence(healthcheck.test, POSTGRES_HEALTHCHECK);
  }
  if (serviceName === 'keycloak') {
    const test = healthcheck.test;
    return (
      Array.isArray(test) &&
      test[0] === 'CMD-SHELL' &&
      typeof test[1] === 'string' &&
      test[1].includes('/health/ready') &&
      test[1].includes('127.0.0.1/9000') &&
      test[1].includes("grep -q '200 OK'")
    );
  }
  return false;
}

function verifyInitializerCommands(services, violations) {
  const expected = {
    'keycloak-volume-init': ['/usr/local/bin/hosted-volume-init', 'caddy-trust'],
    'agent-teams-keycloak-secret-init': ['/usr/local/bin/hosted-volume-init', 'oidc-client-secret'],
  };
  for (const [serviceName, command] of Object.entries(expected)) {
    if (!services[serviceName]) continue;
    if (!sameSequence(services[serviceName]?.command, command)) {
      violations.push(`service:${serviceName}:initializer_command_invalid`);
    }
  }
}

function verifyOidcSecretHandoff(services, violations) {
  const application = services['agent-teams-keycloak'];
  const initializer = services['agent-teams-keycloak-secret-init'];
  if (!application || !initializer) return;

  if (
    services.keycloak &&
    [application, services.keycloak].some(
      (service) =>
        Array.isArray(service.volumes) &&
        service.volumes.some((mount) => mount?.source === 'caddy-data')
    )
  ) {
    violations.push('caddy_private_volume_exposure');
  }

  if (
    application.environment?.OIDC_CLIENT_SECRET_FILE !== '/run/agent-teams-oidc/oidc-client-secret'
  ) {
    violations.push('service:agent-teams-keycloak:oidc_secret_path_invalid');
  }
  if (Array.isArray(application.secrets) && application.secrets.length > 0) {
    violations.push('service:agent-teams-keycloak:direct_secret_mount_forbidden');
  }

  const applicationSecretMount = Array.isArray(application.volumes)
    ? application.volumes.find((mount) => mount?.target === '/run/agent-teams-oidc')
    : undefined;
  const initializerSecretMount = Array.isArray(initializer.volumes)
    ? initializer.volumes.find((mount) => mount?.target === '/run/agent-teams-oidc')
    : undefined;
  if (
    !mountMatches(applicationSecretMount ?? {}, {
      type: 'volume',
      source: 'agent-teams-keycloak-secret',
      target: '/run/agent-teams-oidc',
      readOnly: true,
    }) ||
    !mountMatches(initializerSecretMount ?? {}, {
      type: 'volume',
      source: 'agent-teams-keycloak-secret',
      target: '/run/agent-teams-oidc',
    })
  ) {
    violations.push('oidc_secret_handoff_mount_contract_invalid');
  }
}

function verifyKeycloakRuntimeContract(services, violations) {
  const keycloak = services.keycloak;
  if (!keycloak) return;
  const command = Array.isArray(keycloak.command) ? keycloak.command[0] : undefined;
  if (
    !sameSequence(keycloak.entrypoint, ['/bin/bash', '-euc']) ||
    typeof command !== 'string' ||
    !command.includes('start --optimized --import-realm') ||
    keycloak.environment?.KC_DB !== 'postgres' ||
    keycloak.environment?.KC_HEALTH_ENABLED !== 'true'
  ) {
    violations.push('service:keycloak:optimized_runtime_contract_invalid');
  }
}

function verifyDockerfile(dockerfile, violations) {
  // prettier-ignore
  const requiredTexts = ['ARG KEYCLOAK_VERSION=26.3.2', 'ARG KEYCLOAK_IMAGE_DIGEST', 'FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}@${KEYCLOAK_IMAGE_DIGEST} AS keycloak-build', 'RUN /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true', 'FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}@${KEYCLOAK_IMAGE_DIGEST} AS keycloak-runtime', 'COPY --from=keycloak-build /opt/keycloak/ /opt/keycloak/', 'touch /caddy-trust/root.crt', 'USER 1000', 'FROM base\n', 'COPY docker/hosted-volume-init.sh /usr/local/bin/hosted-volume-init', 'install -o node -g node -m 0600 /dev/null /run/agent-teams-oidc/oidc-client-secret', 'install -o node -g node -m 0600 /dev/null /caddy-trust/root.crt', 'chmod 0555 /usr/local/bin/hosted-volume-init', '\nUSER node\n'];
  for (const requiredText of requiredTexts) {
    if (!dockerfile.includes(requiredText)) {
      violations.push('dockerfile_hardening_contract_invalid');
      break;
    }
  }
  if (dockerfile.includes('gosu')) violations.push('dockerfile_root_dropper_forbidden');

  const noTerminal = verifyHostedNoTerminalDockerfile(dockerfile);
  for (const violation of noTerminal.violations) {
    violations.push(`hosted_terminal_guard:${violation}`);
  }
}

function verifyVolumeInitializer(initializer, violations) {
  // prettier-ignore
  const requiredTexts = ['set -eu', 'caddy-trust)', '[ "$(id -u)" -ne 1000 ]', "readonly caddy_root='/caddy-data/caddy/pki/authorities/local'", "readonly trust_directory='/caddy-trust'", 'readonly trust_certificate="$trust_directory/root.crt"', '1000:1000:600|1000:1000:444', 'find "$trust_directory" -mindepth 1 -maxdepth 1 ! -name root.crt -print -quit', 'chmod 0600 "$trust_certificate"', 'install -m 0444 "$root_certificate" "$trust_certificate"', "stat -c '%u:%g:%a' \"$trust_certificate\")\" != '1000:1000:444'", 'oidc-client-secret)', "readonly runtime_directory='/run/agent-teams-oidc'", 'OIDC runtime secret placeholder is unavailable', "stat -c '%u:%g'", 'chmod 0600 "$runtime_secret"', 'install -m 0400 "$source_secret" "$runtime_secret"', "stat -c '%u:%g:%a'"];
  for (const requiredText of requiredTexts) {
    if (!initializer.includes(requiredText)) {
      violations.push('volume_initializer_contract_invalid');
      break;
    }
  }
  for (const forbiddenText of ['root.key', 'gosu', 'chown ', 'chmod 0711']) {
    if (initializer.includes(forbiddenText)) {
      violations.push('volume_initializer_privilege_contract_invalid');
      break;
    }
  }
}

function verifyExactNames(actual, expected, prefix, violations) {
  if (!sameValues(actual, expected)) violations.push(`${prefix}_inventory_invalid`);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--root' && value) {
      options.root = value;
      index += 1;
      continue;
    }
    if (argument === '--profile' && value && PROFILES.includes(value)) {
      options.profile = value;
      index += 1;
      continue;
    }
    if (argument === '--rendered-compose' && value) {
      options.renderedCompose = readFileSync(value, 'utf8');
      index += 1;
      continue;
    }
    throw new Error(
      'usage: verify-hosted-container-hardening.mjs [--root <repository-root>] [--profile <personal|keycloak>] [--rendered-compose <json-path>]'
    );
  }
  if (options.renderedCompose !== undefined && options.profile === undefined) {
    throw new Error('--rendered-compose requires --profile');
  }
  return options;
}

function main() {
  let result;
  try {
    result = verifyHostedContainerHardening(parseArguments(process.argv.slice(2)));
  } catch {
    result = resultFor(0, 0, ['invalid_arguments']);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'passed' ? 0 : 1;
}

const entryPointUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPointUrl === import.meta.url) main();
