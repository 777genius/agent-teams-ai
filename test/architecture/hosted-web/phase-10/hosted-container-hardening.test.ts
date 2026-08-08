import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  renderHostedContainerHardeningCompose,
  verifyHostedContainerHardening,
} from '../../../../scripts/ci/verify-hosted-container-hardening.mjs';

const dockerfilePath = 'docker/Dockerfile';
const initializerPath = 'docker/hosted-volume-init.sh';

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
      summary: { checkedProfiles: 2, checkedServices: 8, violations: 0 },
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
