import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningCliHelpOutputPorts,
  getCliHelpOutputWithProvisioningPorts,
} from '../TeamProvisioningCliHelpOutputPortsFactory';

import type { CliHelpOutputCache } from '../TeamProvisioningProviderPreflight';

describe('TeamProvisioningCliHelpOutputPortsFactory', () => {
  it('wires CLI help cache, provider probe lookup, and runtime probes', async () => {
    const cache: CliHelpOutputCache = { output: null, cachedAtMs: 0 };
    const getCachedOrProbeResult = vi.fn().mockResolvedValue({ claudePath: '/fake/claude' });
    const providerRuntime = {
      buildProvisioningEnv: vi.fn().mockResolvedValue({ env: { PATH: '/bin' } }),
      spawnProbe: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'Usage', stderr: 'Flags' }),
    };

    await expect(
      getCliHelpOutputWithProvisioningPorts({
        cwd: '/repo',
        cache,
        getCachedOrProbeResult,
        providerRuntime,
        now: () => 1000,
      })
    ).resolves.toBe('Usage\nFlags');

    expect(getCachedOrProbeResult).toHaveBeenCalledWith('/repo', 'anthropic');
    expect(providerRuntime.buildProvisioningEnv).toHaveBeenCalledOnce();
    expect(providerRuntime.spawnProbe).toHaveBeenCalledWith(
      '/fake/claude',
      ['--help'],
      '/repo',
      { PATH: '/bin' },
      10_000
    );
    expect(cache).toEqual({ output: 'Usage\nFlags', cachedAtMs: 1000 });

    providerRuntime.spawnProbe.mockClear();
    await expect(
      getCliHelpOutputWithProvisioningPorts({
        cwd: '/repo',
        cache,
        getCachedOrProbeResult,
        providerRuntime,
        now: () => 1001,
      })
    ).resolves.toBe('Usage\nFlags');

    expect(providerRuntime.spawnProbe).not.toHaveBeenCalled();
  });

  it('does not update the cache when CLI help lookup fails', async () => {
    const cache: CliHelpOutputCache = { output: null, cachedAtMs: 0 };
    const getCachedOrProbeResult = vi.fn().mockResolvedValue(null);
    const providerRuntime = {
      buildProvisioningEnv: vi.fn(),
      spawnProbe: vi.fn(),
    };

    await expect(
      getCliHelpOutputWithProvisioningPorts({
        cwd: '/repo',
        cache,
        getCachedOrProbeResult,
        providerRuntime,
        now: () => 1000,
      })
    ).rejects.toThrow('not found');

    expect(cache).toEqual({ output: null, cachedAtMs: 0 });
    expect(providerRuntime.buildProvisioningEnv).not.toHaveBeenCalled();
    expect(providerRuntime.spawnProbe).not.toHaveBeenCalled();
  });

  it('creates ports that delegate through the provider runtime facade', async () => {
    const getCachedOrProbeResult = vi.fn().mockResolvedValue({ claudePath: '/fake/claude' });
    const providerRuntime = {
      buildProvisioningEnv: vi.fn().mockResolvedValue({ env: { PATH: '/usr/bin' } }),
      spawnProbe: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' }),
    };

    const ports = createTeamProvisioningCliHelpOutputPorts({
      getCachedOrProbeResult,
      providerRuntime,
    });

    await expect(ports.getCachedOrProbeResult('/repo', 'anthropic')).resolves.toEqual({
      claudePath: '/fake/claude',
    });
    await expect(ports.buildProvisioningEnv()).resolves.toEqual({ env: { PATH: '/usr/bin' } });
    await expect(
      ports.spawnProbe('/fake/claude', ['--help'], '/repo', { PATH: '/usr/bin' }, 10_000)
    ).resolves.toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });

    expect(providerRuntime.buildProvisioningEnv).toHaveBeenCalledWith();
    expect(providerRuntime.spawnProbe).toHaveBeenCalledWith(
      '/fake/claude',
      ['--help'],
      '/repo',
      { PATH: '/usr/bin' },
      10_000
    );
  });
});
