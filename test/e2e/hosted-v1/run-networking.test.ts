import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
  CADDY_HTTPS_TARGET_PORT,
  parseDockerComposeCaddyPort,
  runComposeUpWithDockerAssignedPort,
} from '../../../scripts/e2e/hosted-v1/run';

const execFileAsync = promisify(execFile);
const fixtureDigest = `sha256:${'0'.repeat(64)}`;
const composeFixtureEnvironment = {
  ...process.env,
  CADDY_IMAGE_DIGEST: fixtureDigest,
  COMPOSE_PROJECT_NAME: 'hosted-v1-networking-test',
  E2E_APP_DATA_DIR: '/tmp/hosted-v1-networking-test/app-data',
  E2E_APP_GID: '1000',
  E2E_APP_IMAGE: 'hosted-v1-networking-test-app:latest',
  E2E_APP_IP: '172.30.0.10',
  E2E_APP_UID: '1000',
  E2E_BOOT_ID: 'boot_hosted-v1-networking-test',
  E2E_CADDY_DATA_DIR: '/tmp/hosted-v1-networking-test/caddy-data',
  E2E_CADDY_IP: '172.30.0.11',
  E2E_CLAUDE_DIR: '/tmp/hosted-v1-networking-test/claude',
  E2E_FAKE_RUNTIME_STATE_DIR: '/tmp/hosted-v1-networking-test/fake-runtime',
  E2E_LIFECYCLE_BOOTSTRAP: '{}',
  E2E_NETWORK_SUBNET: '172.30.0.0/24',
  E2E_RUN_DIR: '/tmp/hosted-v1-networking-test/run',
  E2E_RUNTIME_WORKSPACE_ID: '-workspaces-sandbox',
  E2E_TEAM_ID: 'team_hosted-v1-networking-test',
  E2E_TEAM_RUNTIME_WORKSPACE_ID: '-workspaces-team-sandbox',
  E2E_WORKSPACE_DIR: '/tmp/hosted-v1-networking-test/workspace',
  HOSTED_DOMAIN: 'hosted-v1-e2e.localhost',
  HOSTED_E2E_AUTH_MODE: 'oidc',
  HOSTED_E2E_OIDC_ORIGIN: 'https://oidc-v1-e2e.localhost:443',
  HOSTED_E2E_OIDC_ROLE: 'owner',
  HOSTED_E2E_ORIGIN: 'https://hosted-v1-e2e.localhost:443',
  HOSTED_HTTPS_PORT: '443',
  KEYCLOAK_IMAGE_DIGEST: fixtureDigest,
  NODE_IMAGE_DIGEST: fixtureDigest,
  OIDC_DOMAIN: 'oidc-v1-e2e.localhost',
} satisfies NodeJS.ProcessEnv;

describe('hosted-v1 Docker-assigned Compose port', () => {
  it('renders an explicit loopback-only ephemeral publication for Caddy target port 443', async () => {
    const { stdout } = await execFileAsync(
      'docker',
      ['compose', '--file', 'docker/docker-compose.e2e.yml', 'config', '--format', 'json'],
      { env: composeFixtureEnvironment }
    );
    const rendered = JSON.parse(stdout) as {
      services: Record<
        string,
        {
          ports?: Array<Record<string, unknown>>;
        }
      > & {
        caddy: {
          ports: Array<Record<string, unknown>>;
          volumes: Array<Record<string, unknown>>;
        };
      };
    };

    expect(rendered.services.caddy.ports).toEqual([
      {
        host_ip: '127.0.0.1',
        mode: 'ingress',
        protocol: 'tcp',
        published: '0',
        target: CADDY_HTTPS_TARGET_PORT,
      },
    ]);
    for (const [service, configuration] of Object.entries(rendered.services)) {
      if (service !== 'caddy') expect(configuration).not.toHaveProperty('ports');
    }
    expect(rendered.services.caddy.volumes).toContainEqual({
      bind: {},
      source: composeFixtureEnvironment.E2E_CADDY_DATA_DIR,
      target: '/data',
      type: 'bind',
    });
  });

  it('strictly parses the loopback IPv4 mapping for Caddy target port 443', () => {
    expect(parseDockerComposeCaddyPort('127.0.0.1:41001')).toBe(41_001);
    expect(() => parseDockerComposeCaddyPort('0.0.0.0:41001')).toThrow(
      'hosted_e2e_caddy_port_invalid'
    );
    expect(() => parseDockerComposeCaddyPort('[::1]:41001')).toThrow(
      'hosted_e2e_caddy_port_invalid'
    );
    expect(() => parseDockerComposeCaddyPort('127.0.0.1:41001\n127.0.0.1:41002')).toThrow(
      'hosted_e2e_caddy_port_invalid'
    );
    expect(() => parseDockerComposeCaddyPort('127.0.0.1:0')).toThrow(
      'hosted_e2e_caddy_port_invalid'
    );
    expect(() => parseDockerComposeCaddyPort('127.0.0.1:65536')).toThrow(
      'hosted_e2e_caddy_port_invalid'
    );
  });

  it('starts Caddy first, derives origins, then starts services without replacing Caddy', async () => {
    const trace: string[] = [];
    const startCaddy = vi.fn(async (environment: NodeJS.ProcessEnv) => {
      trace.push(`start-caddy:${environment.HOSTED_HTTPS_PORT}`);
    });
    const readCaddyPort = vi.fn(async (environment: NodeJS.ProcessEnv) => {
      trace.push(`read-caddy-port:${environment.HOSTED_HTTPS_PORT}`);
      return '127.0.0.1:41001';
    });
    const startRemainingServices = vi.fn(async (environment: NodeJS.ProcessEnv) => {
      trace.push(`start-services:${environment.HOSTED_HTTPS_PORT}`);
    });

    const environment = await runComposeUpWithDockerAssignedPort({
      buildImage: async () => {
        trace.push('build');
      },
      createEnvironment: (port) => {
        trace.push(`environment:${port}`);
        return {
          HOSTED_E2E_OIDC_ORIGIN: `https://oidc-v1-e2e.localhost:${port}`,
          HOSTED_E2E_ORIGIN: `https://hosted-v1-e2e.localhost:${port}`,
          HOSTED_HTTPS_PORT: String(port),
        };
      },
      readCaddyPort,
      startCaddy,
      startRemainingServices,
    });

    expect(trace).toEqual([
      'build',
      `environment:${CADDY_HTTPS_TARGET_PORT}`,
      `start-caddy:${CADDY_HTTPS_TARGET_PORT}`,
      `read-caddy-port:${CADDY_HTTPS_TARGET_PORT}`,
      'environment:41001',
      'start-services:41001',
    ]);
    expect(environment.HOSTED_E2E_ORIGIN).toBe('https://hosted-v1-e2e.localhost:41001');
    expect(environment.HOSTED_E2E_OIDC_ORIGIN).toBe('https://oidc-v1-e2e.localhost:41001');
    expect(environment.HOSTED_HTTPS_PORT).toBe('41001');
    expect(startCaddy).toHaveBeenCalledOnce();
    expect(readCaddyPort).toHaveBeenCalledOnce();
    expect(startRemainingServices).toHaveBeenCalledOnce();
  });

  it('fails closed before starting other services when Compose reports an invalid mapping', async () => {
    const startRemainingServices = vi.fn(async () => undefined);

    await expect(
      runComposeUpWithDockerAssignedPort({
        createEnvironment: (port) => ({ HOSTED_HTTPS_PORT: String(port) }),
        readCaddyPort: async () => '0.0.0.0:41001',
        startCaddy: async () => undefined,
        startRemainingServices,
      })
    ).rejects.toThrow('hosted_e2e_caddy_port_invalid');
    expect(startRemainingServices).not.toHaveBeenCalled();
  });

  it('propagates Caddy startup failure without querying the port or starting services', async () => {
    const failure = new Error('caddy startup failed');
    const readCaddyPort = vi.fn(async () => '127.0.0.1:41001');
    const startRemainingServices = vi.fn(async () => undefined);

    await expect(
      runComposeUpWithDockerAssignedPort({
        createEnvironment: (port) => ({ HOSTED_HTTPS_PORT: String(port) }),
        readCaddyPort,
        startCaddy: async () => {
          throw failure;
        },
        startRemainingServices,
      })
    ).rejects.toBe(failure);
    expect(readCaddyPort).not.toHaveBeenCalled();
    expect(startRemainingServices).not.toHaveBeenCalled();
  });
});
