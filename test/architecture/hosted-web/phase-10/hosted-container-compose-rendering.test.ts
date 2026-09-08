import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  renderHostedContainerHardeningCompose,
  restoreExplicitBindCreateHostPathFalse,
} from '../../../../scripts/ci/verify-hosted-container-compose-rendering.mjs';
import { DEFAULT_RENDER_ENVIRONMENT } from '../../../../scripts/ci/verify-hosted-container-hardening-contracts.mjs';

const LIFECYCLE_TARGET = '/run/agent-teams-orchestrator';

function renderedCompose() {
  return {
    services: {
      application: {
        volumes: [
          {
            type: 'bind',
            source: '/tmp/orchestrator',
            target: LIFECYCLE_TARGET,
            read_only: true,
          },
          {
            type: 'bind',
            source: '/tmp/unrelated',
            target: '/run/unrelated',
            bind: { propagation: 'rprivate' },
          },
        ],
      },
      unrelated: {
        volumes: [
          {
            type: 'bind',
            source: '/tmp/other-service',
            target: LIFECYCLE_TARGET,
          },
        ],
      },
    },
  };
}

function rawCompose(createHostPath: boolean | undefined) {
  const bind =
    createHostPath === undefined
      ? '        bind:\n          propagation: rprivate\n'
      : `        bind:\n          create_host_path: ${createHostPath}\n`;
  return `services:
  application:
    volumes:
      - type: bind
        source: /tmp/orchestrator
        target: ${LIFECYCLE_TARGET}
${bind}`;
}

describe('hosted Compose rendering compatibility normalization', () => {
  it('restores an explicitly false raw long-syntax bind option', () => {
    const rendered = renderedCompose();

    expect(restoreExplicitBindCreateHostPathFalse(rendered, rawCompose(false))).toBe(rendered);
    expect(rendered.services.application.volumes[0].bind).toEqual({
      create_host_path: false,
    });
  });

  it.each([
    ['missing', undefined],
    ['true', true],
  ])('does not restore false when the raw bind option is %s', (_label, createHostPath) => {
    const rendered = renderedCompose();

    restoreExplicitBindCreateHostPathFalse(rendered, rawCompose(createHostPath));

    expect(rendered.services.application.volumes[0]).not.toHaveProperty('bind');
  });

  it('does not change mounts outside the matching raw service and target', () => {
    const rendered = renderedCompose();
    const unrelatedApplicationMount = structuredClone(rendered.services.application.volumes[1]);
    const unrelatedServiceMount = structuredClone(rendered.services.unrelated.volumes[0]);

    restoreExplicitBindCreateHostPathFalse(rendered, rawCompose(false));

    expect(rendered.services.application.volumes[1]).toEqual(unrelatedApplicationMount);
    expect(rendered.services.unrelated.volumes[0]).toEqual(unrelatedServiceMount);
  });

  it('does not overwrite an explicit true value emitted by Compose', () => {
    const rendered = renderedCompose();
    const renderedMount = rendered.services.application.volumes[0] as {
      bind?: Record<string, unknown>;
    };
    renderedMount.bind = { create_host_path: true };

    restoreExplicitBindCreateHostPathFalse(rendered, rawCompose(false));

    expect(renderedMount.bind).toEqual({
      create_host_path: true,
    });
  });
});

interface Mount {
  type: string;
  source: string;
  target: string;
  read_only?: boolean;
  bind?: { create_host_path?: boolean };
}

function expectPublicationMountScope(
  service: {
    read_only: boolean;
    user: string;
    cap_drop: string[];
    security_opt: string[];
    volumes: Mount[];
  },
  claudeRoot: string,
  protectedTargets: string[]
) {
  expect(service.read_only).toBe(true);
  expect(service.user).toBe('1000:1000');
  expect(service.cap_drop).toEqual(['ALL']);
  expect(service.security_opt).toEqual(['no-new-privileges:true']);
  expect(
    service.volumes.filter(
      ({ target }) => target === '/data/.claude' || target.startsWith('/data/.claude/')
    )
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'bind',
        source: claudeRoot,
        target: '/data/.claude',
        read_only: true,
      }),
      expect.objectContaining({
        type: 'bind',
        source: join(claudeRoot, 'teams'),
        target: '/data/.claude/teams',
        bind: expect.objectContaining({ create_host_path: false }),
      }),
    ])
  );
  const claudeMounts = service.volumes.filter(
    ({ target }) => target === '/data/.claude' || target.startsWith('/data/.claude/')
  );
  expect(claudeMounts).toHaveLength(2);
  expect(
    claudeMounts.find(({ target }) => target === '/data/.claude/teams')?.read_only ?? false
  ).toBe(false);
  for (const target of protectedTargets) {
    const mounts = service.volumes.filter((mount) => mount.target === target);
    expect(mounts).toHaveLength(1);
    expect(mounts[0].read_only).toBe(true);
  }
}

describe('resolved controller draft publication mount scope', () => {
  it.each(['personal', 'keycloak'] as const)(
    'keeps the %s controller hardened with only canonical teams writable',
    (profile) => {
      const rendered = renderHostedContainerHardeningCompose({ profile });
      expectPublicationMountScope(
        rendered.services[`agent-teams-${profile}`] as Parameters<
          typeof expectPublicationMountScope
        >[0],
        DEFAULT_RENDER_ENVIRONMENT.CLAUDE_DIR,
        [
          '/run/agent-teams-orchestrator',
          '/run/agent-teams-lifecycle-trust',
          ...(profile === 'keycloak' ? ['/caddy-trust', '/run/agent-teams-oidc'] : []),
        ]
      );
    }
  );

  it.each(['personal', 'oidc'])(
    'keeps the actual E2E %s controller on the owner teams source without changing owner mounts',
    (authMode) => {
      const composePath = 'docker/docker-compose.e2e.yml';
      const root = '/tmp/agent-teams-compose-scope';
      const environment = {
        ...process.env,
        ...DEFAULT_RENDER_ENVIRONMENT,
        COMPOSE_PROJECT_NAME: 'agent-teams-compose-scope',
        E2E_APP_IMAGE: 'agent-teams-compose-scope:local',
        E2E_SOURCE_HEAD_COMMIT: 'a'.repeat(40),
        E2E_SOURCE_PATCH_SHA256: 'b'.repeat(64),
        E2E_APP_UID: '1000',
        E2E_APP_GID: '1000',
        E2E_CLAUDE_DIR: `${root}/claude`,
        E2E_APP_DATA_DIR: `${root}/app-data`,
        E2E_CADDY_DATA_DIR: `${root}/caddy`,
        E2E_RUN_DIR: `${root}/run`,
        E2E_FAKE_RUNTIME_STATE_DIR: `${root}/fake-runtime`,
        E2E_LIFECYCLE_RUN_DIR: `${root}/lifecycle-run`,
        E2E_LIFECYCLE_HIGH_WATER_DIR: `${root}/high-water`,
        E2E_WORKSPACE_DIR: `${root}/workspace`,
        E2E_LIFECYCLE_LAUNCHER_DIR: `${root}/launcher`,
        E2E_LIFECYCLE_TRUST_DIR: `${root}/trust`,
        E2E_CADDY_PUBLISHED_PORT: '18443',
        HOSTED_HTTPS_PORT: '18443',
        HOSTED_E2E_AUTH_MODE: authMode,
        HOSTED_DOMAIN: 'agent-teams.localhost',
        OIDC_DOMAIN: 'auth.agent-teams.localhost',
        HOSTED_E2E_ORIGIN: 'https://agent-teams.localhost:18443',
        HOSTED_E2E_OIDC_ORIGIN: 'https://auth.agent-teams.localhost:18443',
        E2E_APP_IP: '172.30.255.3',
        E2E_CADDY_IP: '172.30.255.2',
        E2E_OIDC_IP: '172.30.255.4',
        E2E_NETWORK_SUBNET: '172.30.255.0/28',
        E2E_INGRESS_NETWORK_SUBNET: '172.30.253.0/28',
        E2E_RUNTIME_WORKSPACE_ID: `workspace_${'a'.repeat(32)}`,
        E2E_TEAM_RUNTIME_WORKSPACE_ID: `workspace_${'b'.repeat(32)}`,
        E2E_TEAM_ID: `team_${'c'.repeat(32)}`,
        E2E_BOOT_ID: 'boot_compose-scope',
        E2E_LIFECYCLE_BOOTSTRAP: '{}',
      };
      const result = spawnSync(
        'docker',
        ['compose', '-f', composePath, 'config', '--format', 'json'],
        {
          encoding: 'utf8',
          env: environment,
          timeout: 30_000,
          maxBuffer: 5 * 1024 * 1024,
        }
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const rendered = restoreExplicitBindCreateHostPathFalse(
        JSON.parse(result.stdout),
        readFileSync(composePath, 'utf8')
      );
      const controller = rendered.services['hosted-controller'];
      expectPublicationMountScope(controller, environment.E2E_CLAUDE_DIR, [
        '/caddy-data',
        '/run/agent-teams-auth-drain',
        '/run/agent-teams-orchestrator',
        '/run/agent-teams-lifecycle-trust',
      ]);
      const ownerMounts = rendered.services['fake-runtime'].volumes as Mount[];
      const ownerClaude = ownerMounts.find(({ target }) => target === '/data/.claude');
      expect(ownerClaude).toMatchObject({ type: 'bind', source: environment.E2E_CLAUDE_DIR });
      expect(ownerClaude?.read_only ?? false).toBe(false);
      expect(ownerMounts.some(({ target }) => target === '/data/.claude/teams')).toBe(false);
      for (const target of [
        '/data/.agent-teams',
        '/run/agent-teams-orchestrator',
        '/run/agent-teams-auth-drain',
      ]) {
        const ownerMount = ownerMounts.find((mount) => mount.target === target);
        const controllerMount = (controller.volumes as Mount[]).find(
          (mount) => mount.target === target
        );
        expect(ownerMount).toBeDefined();
        expect(ownerMount?.source).toBe(controllerMount?.source);
        expect(ownerMount?.read_only ?? false).toBe(false);
      }
    }
  );
});
