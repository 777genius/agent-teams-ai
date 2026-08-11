import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  renderHostedContainerHardeningCompose,
  verifyHostedContainerHardening,
} from '../../../../scripts/ci/verify-hosted-container-hardening.mjs';

const dockerfilePath = 'docker/Dockerfile';
const initializerPath = 'docker/hosted-volume-init.sh';
const lifecycleOwnerAdmissionPath =
  'src/main/composition/hosted/hostedLifecycleProductionOwnerAdmission.ts';
const hostedAuthenticationDocsPath = 'docs/hosted-authentication.md';

function sources() {
  return {
    dockerfile: readFileSync(dockerfilePath, 'utf8'),
    volumeInitializer: readFileSync(initializerPath, 'utf8'),
    renderedComposes: {
      personal: renderHostedContainerHardeningCompose({ profile: 'personal' }),
      keycloak: renderHostedContainerHardeningCompose({ profile: 'keycloak' }),
    },
  };
}

describe('Phase 10 hosted container hardening', () => {
  it('requires the complete rendered-Compose hardening contract without starting containers', () => {
    expect(verifyHostedContainerHardening(sources())).toEqual({
      format: 'hosted-container-hardening-verifier-result/v2',
      status: 'passed',
      summary: { checkedProfiles: 2, checkedServices: 10, violations: 0 },
      violations: [],
    });
  });

  it('fails closed when workloads lose identity, filesystem, capability, resource, or image guards', () => {
    const input = sources();
    const application = input.renderedComposes.personal.services['agent-teams-personal'];
    const caddy = input.renderedComposes.personal.services['caddy-personal'];
    const keycloak = input.renderedComposes.keycloak.services.keycloak;
    const keycloakCaddy = input.renderedComposes.keycloak.services.caddy;
    const postgres = input.renderedComposes.keycloak.services['keycloak-postgres'];

    application.user = '0:0';
    application.read_only = false;
    application.cap_drop = ['NET_RAW'];
    application.security_opt = [];
    application.pids_limit = 0;
    application.cpus = 0;
    application.mem_limit = '0m';
    application.stop_grace_period = '0s';
    application.restart = 'no';
    application.volumes = [];
    application.healthcheck = {};
    application.depends_on = {};
    application.networks = {};
    application.build!.context = '/untrusted-build-context';
    application.build!.args.KEYCLOAK_VERSION = 'latest';
    caddy.cap_add = [];
    keycloak.build!.target = 'keycloak-build';
    keycloakCaddy.image = 'caddy:latest';
    postgres.image = 'postgres:latest';

    expect(verifyHostedContainerHardening(input).violations).toEqual(
      expect.arrayContaining([
        'service:agent-teams-personal:user_invalid',
        'service:agent-teams-personal:read_only_required',
        'service:agent-teams-personal:cap_drop_all_required',
        'service:agent-teams-personal:security_opt_invalid',
        'service:agent-teams-personal:pids_limit_required',
        'service:agent-teams-personal:cpu_limit_required',
        'service:agent-teams-personal:memory_limit_required',
        'service:agent-teams-personal:stop_grace_period_required',
        'service:agent-teams-personal:restart_policy_invalid',
        'service:agent-teams-personal:mount_contract_invalid',
        'service:agent-teams-personal:healthcheck_contract_invalid',
        'service:agent-teams-personal:dependency_contract_invalid',
        'service:agent-teams-personal:network_contract_invalid',
        'service:agent-teams-personal:image_contract_invalid',
        'service:caddy-personal:capability_contract_invalid',
        'service:caddy:image_contract_invalid',
        'service:keycloak:image_contract_invalid',
        'service:keycloak-postgres:image_contract_invalid',
      ])
    );
  });

  it('requires private topology and permits published ports only at the Caddy edge', () => {
    const input = sources();
    const keycloakProfile = input.renderedComposes.keycloak;

    keycloakProfile.networks.hosted.internal = false;
    keycloakProfile.services['keycloak-volume-init'].network_mode = 'bridge';
    keycloakProfile.services['agent-teams-keycloak'].ports = [
      { target: 3456, published: '3456', protocol: 'tcp' },
    ];
    keycloakProfile.services.caddy.networks!['keycloak-backend'] = {};

    expect(verifyHostedContainerHardening(input).violations).toEqual(
      expect.arrayContaining([
        'network:hosted:contract_invalid',
        'network:keycloak-backend:postgres_isolation_invalid',
        'service:agent-teams-keycloak:published_port_forbidden',
        'service:caddy:network_contract_invalid',
        'service:keycloak-volume-init:network_contract_invalid',
      ])
    );
  });

  it('requires the legacy application volume beneath the hardened lock-parent volume', () => {
    const input = sources();
    const personal = input.renderedComposes.personal;
    const keycloak = input.renderedComposes.keycloak;
    const personalApplication = personal.services['agent-teams-personal'];
    const keycloakApplication = keycloak.services['agent-teams-keycloak'];

    personalApplication.volumes = personalApplication.volumes!.filter(
      (mount: { target?: string }) => mount.target !== '/data/.agent-teams/data'
    );
    keycloakApplication.volumes!.find(
      (mount: { target?: string }) => mount.target === '/data/.agent-teams'
    )!.volume = { nocopy: true };
    personalApplication.environment!.AUTH_DATA_DIR = '/data/.agent-teams';
    keycloakApplication.environment!.AUTH_IDENTITY_KEY_FILE =
      '/data/.agent-teams/hosted-auth-secrets/identity.key';
    personal.volumes!['agent-teams-application-data'].name = 'replacement-volume';

    expect(verifyHostedContainerHardening(input).violations).toEqual(
      expect.arrayContaining([
        'service:agent-teams-personal:mount_contract_invalid',
        'service:agent-teams-keycloak:mount_contract_invalid',
        'service:agent-teams-personal:application_data_path_invalid',
        'service:agent-teams-keycloak:application_data_path_invalid',
        'profile:personal:application_data_volume_identity_invalid',
      ])
    );
  });

  it('requires one read-only external owner socket, independent release trust, and private high water', () => {
    const input = sources();
    const personal = input.renderedComposes.personal;
    const application = personal.services['agent-teams-personal'];
    const trustInitializer = personal.services['agent-teams-lifecycle-trust-init'];
    application.volumes!.find(
      (mount: { target?: string }) =>
        mount.target === '/var/lib/agent-teams/lifecycle-owner-high-water'
    )!.volume = { nocopy: true };
    application.volumes!.find(
      (mount: { target?: string }) =>
        mount.target === '/var/lib/agent-teams/lifecycle-owner-high-water'
    )!.read_only = true;
    application.volumes = application.volumes!.filter(
      (mount: { target?: string }) => mount.target !== '/run/agent-teams-orchestrator'
    );
    trustInitializer.secrets = [];
    application.environment!.HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET =
      '/run/agent-teams/orchestrator-lifecycle.sock';
    delete application.environment!.HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_FILE;
    delete application.environment!.HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FILE;
    delete application.environment!.AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP;
    delete personal.volumes!['agent-teams-lifecycle-owner-high-water'];
    delete personal.volumes!['agent-teams-lifecycle-trust'];
    delete personal.secrets!.lifecycle_orchestrator_trust_anchor;
    delete personal.secrets!.lifecycle_owner_release_pin;

    expect(verifyHostedContainerHardening(input).violations).toEqual(
      expect.arrayContaining([
        'service:agent-teams-personal:mount_contract_invalid',
        'service:agent-teams-lifecycle-trust-init:secret_contract_invalid',
        'service:agent-teams-personal:application_data_path_invalid',
        'service:agent-teams-personal:lifecycle_read_bootstrap_binding_invalid',
        'profile:personal:application_data_volume_identity_invalid',
        'profile:personal:lifecycle_read_bootstrap_consumer_inventory_invalid',
        'profile:personal:lifecycle_owner_manifest_consumer_inventory_invalid',
        'profile:personal:lifecycle_owner_release_pin_consumer_inventory_invalid',
        'secret:lifecycle_orchestrator_trust_anchor:file_contract_invalid',
        'secret:lifecycle_owner_release_pin:file_contract_invalid',
        'profile:personal:lifecycle_trust_handoff_invalid',
        'profile:personal:lifecycle_trust_source_consumer_inventory_invalid',
        'volume:agent-teams-lifecycle-owner-high-water:missing',
      ])
    );
  });

  it('requires one fixed owner manifest and forbids forgeable environment fallbacks', () => {
    const input = sources();
    const personal = input.renderedComposes.personal;
    const application = personal.services['agent-teams-personal'];
    const caddy = personal.services['caddy-personal'];
    application.environment!.HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_FILE =
      '/run/agent-teams-orchestrator/replacement.json';
    application.environment!.HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FILE =
      '/run/agent-teams-orchestrator/self-attested-release-pin.json';
    application.environment!.AGENT_TEAMS_HOSTED_PHASE2_READ_BOOTSTRAP = '{}';
    application.environment!.HOSTED_LIFECYCLE_OWNER_ARTIFACT_DIGEST = `sha256:${'a'.repeat(64)}`;
    caddy.environment!.HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_FILE =
      '/run/agent-teams-orchestrator/lifecycle-owner-admission.json';
    caddy.environment!.HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FILE =
      '/run/agent-teams-lifecycle-trust/release-owner-pin.json';

    expect(verifyHostedContainerHardening(input).violations).toEqual(
      expect.arrayContaining([
        'service:agent-teams-personal:application_data_path_invalid',
        'service:agent-teams-personal:lifecycle_owner_environment_fallback_forbidden',
        'profile:personal:lifecycle_owner_manifest_consumer_inventory_invalid',
        'profile:personal:lifecycle_owner_release_pin_consumer_inventory_invalid',
      ])
    );
  });

  it('keeps launcher signatures asymmetric and the frame HMAC outside manifest authority', () => {
    const admission = readFileSync(lifecycleOwnerAdmissionPath, 'utf8');
    const documentation = readFileSync(hostedAuthenticationDocsPath, 'utf8');

    expect(admission).toContain('agent-teams.hosted-lifecycle-owner-admission/v2');
    expect(admission).toContain("authentication.algorithm !== 'ed25519'");
    expect(admission).toContain('createPublicKey({');
    expect(admission).toContain('!verify(');
    expect(admission).not.toContain('createHmac');
    expect(admission).not.toContain("authentication.algorithm !== 'hmac-sha256'");
    expect(documentation).toContain('readiness and command frames only');
    expect(documentation).toContain('test-only and is not an acceptable production');
  });

  it('requires application health to prove the exact owner-capability readiness header', () => {
    const input = sources();
    const application = input.renderedComposes.personal.services['agent-teams-personal'];
    application.healthcheck!.test = [
      'CMD',
      'node',
      '-e',
      "fetch('http://127.0.0.1:3456/api/auth/status').then(r=>{if(!r.ok)process.exit(1)})",
    ];

    expect(verifyHostedContainerHardening(input).violations).toContain(
      'service:agent-teams-personal:healthcheck_contract_invalid'
    );
  });

  it('rejects any second in-Compose lifecycle socket consumer or owner candidate', () => {
    const input = sources();
    const personal = input.renderedComposes.personal;
    personal.services['agent-teams-personal'].deploy = { replicas: 2 };
    personal.services['second-lifecycle-owner'] = structuredClone(
      personal.services['agent-teams-personal']
    );
    personal.services['second-lifecycle-owner'].volumes!.find(
      (mount: { target?: string }) => mount.target === '/run/agent-teams-orchestrator'
    )!.read_only = false;

    expect(verifyHostedContainerHardening(input).violations).toEqual(
      expect.arrayContaining([
        'profile:personal:service_inventory_invalid',
        'profile:personal:external_lifecycle_owner_consumer_inventory_invalid',
        'service:agent-teams-personal:lifecycle_consumer_singleton_contract_invalid',
      ])
    );
  });

  it('requires the rendered lifecycle high-water mount to stay writable', () => {
    const input = sources();
    const highWater = input.renderedComposes.personal.services[
      'agent-teams-personal'
    ].volumes!.find(
      (mount: { target?: string }) =>
        mount.target === '/var/lib/agent-teams/lifecycle-owner-high-water'
    );
    expect(highWater?.read_only).not.toBe(true);
    highWater!.read_only = true;

    expect(verifyHostedContainerHardening(input).violations).toContain(
      'service:agent-teams-personal:mount_contract_invalid'
    );
  });

  it('requires lifecycle authority volumes to remain private managed local volumes', () => {
    const input = sources();
    const volumes = input.renderedComposes.personal.volumes!;
    const highWater = volumes['agent-teams-lifecycle-owner-high-water'];
    const trust = volumes['agent-teams-lifecycle-trust'];
    highWater.external = true;
    trust.driver = 'nfs';
    trust.driver_opts = { type: 'none', o: 'bind', device: '/host/lifecycle-trust' };

    expect(verifyHostedContainerHardening(input).violations).toEqual(
      expect.arrayContaining([
        'volume:agent-teams-lifecycle-owner-high-water:persistence_contract_invalid',
        'volume:agent-teams-lifecycle-trust:persistence_contract_invalid',
      ])
    );
  });

  it('rejects broad host directories as the external lifecycle owner socket source', () => {
    const input = sources();
    const application = input.renderedComposes.personal.services['agent-teams-personal'];
    const ownerMount = application.volumes!.find(
      (mount: { target?: string }) => mount.target === '/run/agent-teams-orchestrator'
    )!;

    const ownerBind = { create_host_path: true };
    ownerMount.bind = ownerBind;
    expect(verifyHostedContainerHardening(input).violations).toContain(
      'service:agent-teams-personal:mount_contract_invalid'
    );
    ownerBind.create_host_path = false;

    for (const broadSource of ['/', '/dev', '/etc', '/proc', '/run', '/tmp']) {
      ownerMount.source = broadSource;
      expect(verifyHostedContainerHardening(input).violations).toContain(
        'service:agent-teams-personal:external_lifecycle_owner_source_invalid'
      );
    }
  });

  it('rejects privileged runtime escapes, devices, inherited volumes, and host namespaces', () => {
    const input = sources();
    const application = input.renderedComposes.personal.services['agent-teams-personal'];

    application.privileged = true;
    application.devices = [{ path: '/dev/null' }];
    application.volumes_from = ['caddy-personal'];
    application.pid = 'host';
    application.ipc = 'host';

    expect(verifyHostedContainerHardening(input).violations).toEqual(
      expect.arrayContaining([
        'service:agent-teams-personal:privileged_forbidden',
        'service:agent-teams-personal:devices_forbidden',
        'service:agent-teams-personal:volumes_from_forbidden',
        'service:agent-teams-personal:host_pid_namespace_forbidden',
        'service:agent-teams-personal:host_ipc_namespace_forbidden',
      ])
    );
  });

  it('requires one non-networked lifecycle trust initializer and a read-only application handoff', () => {
    const input = sources();
    const personal = input.renderedComposes.personal;
    const application = personal.services['agent-teams-personal'];
    const initializer = personal.services['agent-teams-lifecycle-trust-init'];
    application.secrets = structuredClone(initializer.secrets);
    application.volumes!.find(
      (mount: { target?: string }) => mount.target === '/run/agent-teams-lifecycle-trust'
    )!.read_only = false;
    initializer.command = ['/usr/local/bin/hosted-volume-init', 'unsafe-copy'];
    initializer.network_mode = 'bridge';
    initializer.volumes![0]!.volume = { nocopy: true };
    personal.volumes!['agent-teams-lifecycle-trust'].name = 'replacement-volume';
    input.volumeInitializer = input.volumeInitializer.replaceAll(
      '64 lowercase hexadecimal characters',
      'arbitrary lifecycle key'
    );

    expect(verifyHostedContainerHardening(input).violations).toEqual(
      expect.arrayContaining([
        'service:agent-teams-personal:mount_contract_invalid',
        'service:agent-teams-personal:secret_contract_invalid',
        'service:agent-teams-lifecycle-trust-init:initializer_command_invalid',
        'service:agent-teams-lifecycle-trust-init:network_contract_invalid',
        'profile:personal:lifecycle_trust_handoff_invalid',
        'profile:personal:lifecycle_trust_source_consumer_inventory_invalid',
        'volume_initializer_contract_invalid',
      ])
    );
  });

  it('requires the one-shot non-root trust and OIDC handoff initializers', () => {
    const input = sources();
    const applicationTrust = input.renderedComposes.keycloak.services[
      'agent-teams-keycloak'
    ].volumes!.find((mount: { target?: string }) => mount.target === '/caddy-trust')!;
    const initializerSource = input.renderedComposes.keycloak.services[
      'keycloak-volume-init'
    ].volumes!.find((mount: { target?: string }) => mount.target === '/caddy-data')!;
    input.renderedComposes.keycloak.services['keycloak-volume-init'].command = [
      '/usr/local/bin/hosted-volume-init',
      'repair-all',
    ];
    applicationTrust.source = 'caddy-data';
    initializerSource.read_only = false;
    input.volumeInitializer = input.volumeInitializer
      .replace(
        'install -m 0444 "$root_certificate" "$trust_certificate"',
        'install -m 0444 "$root_certificate" "$trust_certificate"\n    chmod 0444 "$caddy_root/root.key"'
      )
      .replace('1000:1000:444', '1000:1000:644');

    expect(verifyHostedContainerHardening(input).violations).toEqual(
      expect.arrayContaining([
        'service:keycloak-volume-init:initializer_command_invalid',
        'service:agent-teams-keycloak:mount_contract_invalid',
        'service:keycloak-volume-init:mount_contract_invalid',
        'caddy_private_volume_exposure',
        'volume_initializer_contract_invalid',
        'volume_initializer_privilege_contract_invalid',
      ])
    );
  });
});
