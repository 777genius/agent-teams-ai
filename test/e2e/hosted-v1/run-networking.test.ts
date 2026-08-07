import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

import {
  CADDY_HTTPS_TARGET_PORT,
  parseDockerComposeCaddyPort,
  runComposeUpWithDockerAssignedPort,
} from '../../../scripts/e2e/hosted-v1/run';

describe('hosted-v1 Docker-assigned Compose port', () => {
  it('renders an explicit loopback-only ephemeral publication for Caddy target port 443', async () => {
    const compose = YAML.parse(await readFile('docker/docker-compose.e2e.yml', 'utf8')) as {
      services: { caddy: { ports: unknown } };
    };

    expect(compose.services.caddy.ports).toEqual([
      {
        host_ip: '127.0.0.1',
        protocol: 'tcp',
        published: '49152-65535',
        target: CADDY_HTTPS_TARGET_PORT,
      },
    ]);
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
