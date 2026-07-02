import { describe, expect, it, vi } from 'vitest';

import {
  createDefaultTeamProvisioningPrepareCoordinatorPorts,
  TeamProvisioningPrepareCoordinator,
} from '../TeamProvisioningPrepareCoordinator';

import type { TeamProvisioningPrepareCoordinatorPorts } from '../TeamProvisioningPrepareCoordinator';
import type { TeamCreateRequest } from '@shared/types';

function createCoordinator(
  overrides: Partial<TeamProvisioningPrepareCoordinatorPorts> = {}
): TeamProvisioningPrepareCoordinator {
  return new TeamProvisioningPrepareCoordinator(
    createDefaultTeamProvisioningPrepareCoordinatorPorts({
      getCachedOrProbeResult: vi.fn().mockResolvedValue({
        claudePath: '/fake/claude',
        authSource: 'none',
      }),
      validatePrepareCwd: vi.fn().mockResolvedValue(undefined),
      getFreshCachedProbeResult: vi.fn().mockReturnValue(null),
      buildProvisioningEnv: vi.fn().mockResolvedValue({
        env: { PATH: '/bin' },
        authSource: 'none',
        geminiRuntimeAuth: null,
        providerArgs: [],
      }),
      ...overrides,
    })
  );
}

describe('TeamProvisioningPrepareCoordinator', () => {
  it('coalesces matching prepare requests and returns cloned results', async () => {
    let releaseProbe: ((value: { claudePath: string; authSource: 'none' }) => void) | null = null;
    const getCachedOrProbeResult = vi.fn(
      () =>
        new Promise<{ claudePath: string; authSource: 'none' }>((resolve) => {
          releaseProbe = resolve;
        })
    );
    const coordinator = createCoordinator({
      getCachedOrProbeResult,
      runProviderOneShotDiagnostic: vi.fn().mockResolvedValue({ warning: 'diagnostic note' }),
    });

    const first = coordinator.prepareForProvisioning('/tmp/coalesced-prepare', {
      providerId: 'anthropic',
      modelVerificationMode: 'deep',
    });
    const second = coordinator.prepareForProvisioning('/tmp/coalesced-prepare', {
      providerId: 'anthropic',
      modelVerificationMode: 'deep',
    });

    await vi.waitFor(() => expect(releaseProbe).not.toBeNull());
    releaseProbe?.({ claudePath: '/fake/claude', authSource: 'none' });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(getCachedOrProbeResult).toHaveBeenCalledOnce();
    expect(firstResult).toEqual(secondResult);
    expect(firstResult).not.toBe(secondResult);

    firstResult.warnings?.push('mutated');
    expect(secondResult.warnings).toEqual(['diagnostic note']);
  });

  it('clears one probe cache entry per requested provider when forceFresh is set', async () => {
    const clearProbeCache = vi.fn();
    const coordinator = createCoordinator({ clearProbeCache });

    await coordinator.prepareForProvisioning('/tmp/force-fresh-prepare', {
      forceFresh: true,
      providerIds: ['anthropic', 'codex', 'codex'],
    });

    expect(clearProbeCache.mock.calls).toEqual([
      ['/tmp/force-fresh-prepare', 'anthropic'],
      ['/tmp/force-fresh-prepare', 'codex'],
    ]);
  });

  it('materializes non-Anthropic teammate defaults once per provider through ports', async () => {
    const resolveProviderDefaultModel = vi.fn().mockResolvedValue(' codex-default ');
    const buildProvisioningEnv = vi.fn();
    const coordinator = createCoordinator({
      buildProvisioningEnv,
      resolveProviderDefaultModel,
    });

    const members: TeamCreateRequest['members'] = [
      { name: 'one', role: 'One', providerId: 'codex' },
      { name: 'two', role: 'Two', providerId: 'codex' },
      { name: 'three', role: 'Three', providerId: 'anthropic' },
    ];

    const result = await coordinator.materializeEffectiveTeamMemberSpecs({
      claudePath: '/fake/claude',
      cwd: '/tmp/materialize',
      members,
      defaults: {},
      primaryProviderId: 'codex',
      primaryEnv: {
        env: { PATH: '/bin' },
        authSource: 'codex_runtime',
        geminiRuntimeAuth: null,
        providerArgs: ['--from-env'],
      },
      providerArgsResolver: ({ providerArgs }) => [...providerArgs, '--resolved'],
    });

    expect(buildProvisioningEnv).not.toHaveBeenCalled();
    expect(resolveProviderDefaultModel).toHaveBeenCalledOnce();
    expect(resolveProviderDefaultModel).toHaveBeenCalledWith(
      '/fake/claude',
      '/tmp/materialize',
      'codex',
      { PATH: '/bin' },
      ['--from-env', '--resolved'],
      false
    );
    expect(result.map((member) => member.model)).toEqual([
      'codex-default',
      'codex-default',
      undefined,
    ]);
  });

  it('resolves missing OpenCode worktree member paths through the worktree port', async () => {
    const ensureMemberWorktree = vi
      .fn()
      .mockResolvedValue({ worktreePath: '/tmp/member-worktree' });
    const coordinator = createCoordinator({ ensureMemberWorktree });

    const result = await coordinator.resolveOpenCodeMemberWorkspacesForRuntime({
      teamName: 'team',
      baseCwd: '/tmp/base',
      members: [{ name: 'dev', role: 'Developer', providerId: 'opencode', isolation: 'worktree' }],
    });

    expect(ensureMemberWorktree).toHaveBeenCalledWith({
      teamName: 'team',
      memberName: 'dev',
      baseCwd: '/tmp/base',
    });
    expect(result[0]?.cwd).toBe('/tmp/member-worktree');
  });

  it('caches successful probes but does not pin auth failures', async () => {
    const cwd = `/tmp/probe-cache-${Date.now()}`;
    const probeClaudeRuntime = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ warning: 'Run `claude auth login` to continue' })
      .mockResolvedValueOnce({ warning: 'Run `claude auth login` to continue' });
    const coordinator = createCoordinator({
      resolveClaudeBinaryPath: vi.fn().mockResolvedValue('/fake/claude'),
      probeClaudeRuntime,
    });

    coordinator.clearProbeCache(cwd, 'anthropic');
    await coordinator.getCachedOrProbeResult(cwd, 'anthropic');
    await coordinator.getCachedOrProbeResult(cwd, 'anthropic');

    expect(probeClaudeRuntime).toHaveBeenCalledOnce();

    coordinator.clearProbeCache(cwd, 'anthropic');
    await coordinator.getCachedOrProbeResult(cwd, 'anthropic');
    await coordinator.getCachedOrProbeResult(cwd, 'anthropic');

    expect(probeClaudeRuntime).toHaveBeenCalledTimes(3);
  });
});
