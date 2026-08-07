import { describe, expect, it, vi } from 'vitest';

import {
  COMPOSE_BIND_ATTEMPT_LIMIT,
  isDockerHostPortBindCollision,
  runComposeUpWithExactBindRetry,
} from '../../../scripts/e2e/hosted-v1/run';

function bindCollision(port: number): Error & { stderr: string } {
  return Object.assign(new Error('docker compose up failed'), {
    stderr:
      `Error response from daemon: failed to set up container networking: ` +
      `driver failed programming external connectivity: failed to bind host port for ` +
      `127.0.0.1:${port}: address already in use`,
  });
}

function genericBindCollision(): Error & { stderr: string } {
  return Object.assign(new Error('docker compose up failed'), {
    stderr:
      'Error response from daemon: failed to set up container networking: Address already in use',
  });
}

describe('hosted-v1 Compose port selection', () => {
  it('builds the image before selecting the runtime port and starts without rebuilding', async () => {
    const trace: string[] = [];
    const environment = await runComposeUpWithExactBindRetry({
      buildImage: async () => {
        trace.push('build');
      },
      cleanupBindCollision: vi.fn(),
      createEnvironment: (port) => {
        trace.push(`environment:${port}`);
        return {
          HOSTED_E2E_OIDC_ORIGIN: `https://oidc-v1-e2e.localhost:${port}`,
          HOSTED_E2E_ORIGIN: `https://hosted-v1-e2e.localhost:${port}`,
          HOSTED_HTTPS_PORT: String(port),
        };
      },
      selectPort: async () => {
        trace.push('select-port');
        return 41_001;
      },
      up: async () => {
        trace.push('up-no-build');
      },
    });

    expect(trace).toEqual(['build', 'select-port', 'environment:41001', 'up-no-build']);
    expect(environment.HOSTED_E2E_ORIGIN).toBe('https://hosted-v1-e2e.localhost:41001');
    expect(environment.HOSTED_E2E_OIDC_ORIGIN).toBe('https://oidc-v1-e2e.localhost:41001');
    expect(environment.HOSTED_HTTPS_PORT).toBe('41001');
  });

  it('classifies the daemon localhost bind collision for the selected port', () => {
    expect(isDockerHostPortBindCollision(bindCollision(41_001), 41_001)).toBe(true);
    expect(isDockerHostPortBindCollision(bindCollision(41_002), 41_001)).toBe(false);
    expect(
      isDockerHostPortBindCollision(
        new Error('hosted-controller startup failed: address already in use on 127.0.0.1:41001'),
        41_001
      )
    ).toBe(false);
    expect(
      isDockerHostPortBindCollision(
        new Error('Error response from daemon: hosted-controller exited with code 1'),
        41_001
      )
    ).toBe(false);
  });

  it('classifies the exact generic daemon networking collision emitted for the single published port', () => {
    expect(isDockerHostPortBindCollision(genericBindCollision(), 41_001)).toBe(true);
    expect(
      isDockerHostPortBindCollision(
        new Error('Error response from daemon: Address already in use'),
        41_001
      )
    ).toBe(false);
    expect(
      isDockerHostPortBindCollision(
        new Error('failed to set up container networking: Address already in use'),
        41_001
      )
    ).toBe(false);
    expect(
      isDockerHostPortBindCollision(
        new Error(
          'Error response from daemon: failed to set up container networking: operation not permitted'
        ),
        41_001
      )
    ).toBe(false);
  });

  it('does not assemble a generic daemon networking collision across output fields or lines', () => {
    const splitAcrossFields = Object.assign(new Error('Error response from daemon:'), {
      stderr: 'failed to set up container networking:\nunrelated daemon output',
      stdout: 'Address already in use',
    });
    const splitAcrossLines = Object.assign(new Error('docker compose up failed'), {
      stderr:
        'Error response from daemon:\nfailed to set up container networking: Address already in use',
    });

    expect(isDockerHostPortBindCollision(splitAcrossFields, 41_001)).toBe(false);
    expect(isDockerHostPortBindCollision(splitAcrossLines, 41_001)).toBe(false);
  });

  it('cleans the failed attempt and selects a fresh port only for an exact bind collision', async () => {
    const ports = [41_001, 41_002];
    const cleanupBindCollision = vi.fn(async () => undefined);
    const up = vi.fn(async (environment: NodeJS.ProcessEnv) => {
      const port = Number(environment.HOSTED_HTTPS_PORT);
      if (port === 41_001) throw bindCollision(port);
    });

    const environment = await runComposeUpWithExactBindRetry({
      cleanupBindCollision,
      createEnvironment: (port) => ({ HOSTED_HTTPS_PORT: String(port) }),
      selectPort: async () => ports.shift() ?? 0,
      up,
    });

    expect(environment.HOSTED_HTTPS_PORT).toBe('41002');
    expect(up).toHaveBeenCalledTimes(2);
    expect(cleanupBindCollision).toHaveBeenCalledTimes(1);
    expect(cleanupBindCollision).toHaveBeenCalledWith({ HOSTED_HTTPS_PORT: '41001' });
  });

  it('cleans and retries when Compose omits the single published port from its collision', async () => {
    const ports = [41_001, 41_002];
    const cleanupBindCollision = vi.fn(async () => undefined);
    const up = vi.fn(async () => {
      if (up.mock.calls.length === 1) throw genericBindCollision();
    });

    const environment = await runComposeUpWithExactBindRetry({
      cleanupBindCollision,
      createEnvironment: (port) => ({ HOSTED_HTTPS_PORT: String(port) }),
      selectPort: async () => ports.shift() ?? 0,
      up,
    });

    expect(environment.HOSTED_HTTPS_PORT).toBe('41002');
    expect(up).toHaveBeenCalledTimes(2);
    expect(cleanupBindCollision).toHaveBeenCalledOnce();
    expect(cleanupBindCollision).toHaveBeenCalledWith({ HOSTED_HTTPS_PORT: '41001' });
  });

  it('does not retry or run retry cleanup for any other Compose failure', async () => {
    const failure = new Error(
      'Error response from daemon: failed to start container: Address already in use'
    );
    const cleanupBindCollision = vi.fn();
    const selectPort = vi.fn(async () => 41_001);

    await expect(
      runComposeUpWithExactBindRetry({
        cleanupBindCollision,
        createEnvironment: (port) => ({ HOSTED_HTTPS_PORT: String(port) }),
        selectPort,
        up: async () => {
          throw failure;
        },
      })
    ).rejects.toBe(failure);
    expect(selectPort).toHaveBeenCalledTimes(1);
    expect(cleanupBindCollision).not.toHaveBeenCalled();
  });

  it('stops at the exact retry bound when every selected port collides', async () => {
    const cleanupBindCollision = vi.fn(async () => undefined);
    const selectPort = vi.fn(async () => 41_000 + selectPort.mock.calls.length);
    const up = vi.fn(async (environment: NodeJS.ProcessEnv) => {
      throw bindCollision(Number(environment.HOSTED_HTTPS_PORT));
    });

    await expect(
      runComposeUpWithExactBindRetry({
        cleanupBindCollision,
        createEnvironment: (port) => ({ HOSTED_HTTPS_PORT: String(port) }),
        selectPort,
        up,
      })
    ).rejects.toMatchObject({ stderr: expect.stringContaining('address already in use') });
    expect(selectPort).toHaveBeenCalledTimes(COMPOSE_BIND_ATTEMPT_LIMIT);
    expect(up).toHaveBeenCalledTimes(COMPOSE_BIND_ATTEMPT_LIMIT);
    expect(cleanupBindCollision).toHaveBeenCalledTimes(COMPOSE_BIND_ATTEMPT_LIMIT - 1);
  });
});
