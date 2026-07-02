import { describe, expect, it, vi } from 'vitest';

import {
  buildRuntimeTurnSettledEnvironment,
  buildRuntimeTurnSettledEnvironmentForMembers,
  buildRuntimeTurnSettledHookSettingsArgs,
} from '../TeamProvisioningRuntimeTurnSettledPlanning';
import {
  collectWorkspaceTrustProviders,
  collectWorkspaceTrustWorkspaces,
  planWorkspaceTrustArgsOnlySafely,
  planWorkspaceTrustFullSafely,
  resolveWorkspaceTrustGitRoot,
  type WorkspaceTrustGitRootResolutionPorts,
  type WorkspaceTrustWorkspaceCollectionPorts,
} from '../TeamProvisioningWorkspaceTrust';

import type {
  WorkspaceTrustCoordinator,
  WorkspaceTrustFeatureFlags,
  WorkspaceTrustProvider,
} from '@features/workspace-trust/main';
import type { TeamCreateRequest, TeamProviderId } from '@shared/types';

const featureFlags: WorkspaceTrustFeatureFlags = {
  enabled: true,
  claudePty: true,
  codexArgs: true,
  retry: true,
  fileLock: true,
};

function members(
  values: Array<Partial<TeamCreateRequest['members'][number]>>
): TeamCreateRequest['members'] {
  return values.map((value, index) => ({
    name: value.name ?? `member-${index}`,
    role: value.role ?? 'Engineer',
    model: value.model ?? 'sonnet',
    ...value,
  })) as TeamCreateRequest['members'];
}

function createWorkspacePorts(
  overrides: Partial<WorkspaceTrustWorkspaceCollectionPorts> = {}
): WorkspaceTrustWorkspaceCollectionPorts {
  return {
    getHomeDir: vi.fn(() => '/home/tester'),
    realpath: vi.fn(async (value) => `/real${value}`),
    resolveGitRoot: vi.fn(async (cwd) => (cwd === '/repo' ? '/repo' : '/repo')),
    resolveCanonicalGitRoot: vi.fn(async (gitRoot) => `/canonical${gitRoot}`),
    platform: 'posix',
    ...overrides,
  };
}

describe('TeamProvisioningWorkspaceTrust', () => {
  it('collects workspace trust providers in stable provider order', () => {
    const result = collectWorkspaceTrustProviders({
      leadProviderId: 'codex',
      members: members([
        { providerId: 'opencode' },
        { providerId: 'anthropic' },
        { providerId: 'gemini' },
      ]),
    });

    expect(result).toEqual(['claude', 'codex', 'gemini', 'opencode']);
  });

  it('resolves git root through injected git and filesystem ports', async () => {
    const ports: WorkspaceTrustGitRootResolutionPorts = {
      resolveGitTopLevel: vi.fn(async () => 'relative-root'),
      resolveFilesystemGitRoot: vi.fn(async () => '/repo'),
      isAbsolutePath: vi.fn((value) => value.startsWith('/')),
    };

    await expect(resolveWorkspaceTrustGitRoot('/repo/packages/app', ports)).resolves.toBe('/repo');
    expect(ports.resolveFilesystemGitRoot).toHaveBeenCalledWith('/repo/packages/app');
  });

  it('collects workspace trust candidates with injected path and git ports', async () => {
    const ports = createWorkspacePorts({
      resolveGitRoot: vi.fn(async (cwd) => (cwd === '/repo/worktree' ? '/repo/.git/worktree' : '/repo')),
    });

    const result = await collectWorkspaceTrustWorkspaces({
      cwd: '/repo',
      members: members([
        { name: 'Ava', cwd: '/repo/worktree', isolation: 'worktree' },
        { name: 'Bo', cwd: '   ' },
      ]),
      ports,
    });

    expect(result.map((workspace) => workspace.source)).toContain('team-root');
    expect(result.map((workspace) => workspace.source)).toContain('member-worktree');
    expect(ports.realpath).toHaveBeenCalledWith('/repo');
    expect(ports.resolveCanonicalGitRoot).toHaveBeenCalledWith('/real/repo');
    expect(ports.resolveCanonicalGitRoot).toHaveBeenCalledWith('/real/repo/.git/worktree');
  });

  it('falls back to empty args-only plan when coordinator planning fails', async () => {
    const logger = { warn: vi.fn() };
    const coordinator = {
      planArgsOnly: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as unknown as WorkspaceTrustCoordinator;

    const result = await planWorkspaceTrustArgsOnlySafely({
      coordinator,
      request: { providers: ['codex'], workspaces: [], featureFlags },
      logger,
    });

    expect(result).toEqual({ launchArgPatches: [] });
    expect(logger.warn).toHaveBeenCalledWith(
      'Workspace trust args-only planning failed; continuing without trust arg patches: boom'
    );
  });

  it('preserves providers and workspaces when full planning fails', async () => {
    const logger = { warn: vi.fn() };
    const coordinator = {
      planFull: vi.fn(async () => {
        throw new Error('full boom');
      }),
    } as unknown as WorkspaceTrustCoordinator;
    const request = {
      providers: ['claude'] satisfies WorkspaceTrustProvider[],
      workspaces: [],
      featureFlags,
    };

    const result = await planWorkspaceTrustFullSafely({
      coordinator,
      request,
      logger,
    });

    expect(result).toEqual({ providers: ['claude'], workspaces: [], launchArgPatches: [] });
    expect(logger.warn).toHaveBeenCalledWith(
      'Workspace trust full planning failed; continuing without trust arg patches: full boom'
    );
  });

  it('builds turn-settled hook args only for Anthropic launches', async () => {
    const hookSettingsProvider = vi.fn(async () => ({ hooks: { Stop: [{ command: 'sync' }] } }));

    await expect(
      buildRuntimeTurnSettledHookSettingsArgs(
        { providerId: 'anthropic' },
        { hookSettingsProvider }
      )
    ).resolves.toEqual(['--settings', JSON.stringify({ hooks: { Stop: [{ command: 'sync' }] } })]);
    await expect(
      buildRuntimeTurnSettledHookSettingsArgs({ providerId: 'codex' }, { hookSettingsProvider })
    ).resolves.toEqual([]);
  });

  it('builds turn-settled environment when any launch member needs Codex', async () => {
    const environmentProvider = vi.fn(async () => ({ CODEX_TURN_SETTLED: '1' }));

    await expect(
      buildRuntimeTurnSettledEnvironmentForMembers(
        {
          primaryProviderId: 'anthropic',
          memberSpecs: members([{ model: 'gpt-5.4' }]),
        },
        { environmentProvider }
      )
    ).resolves.toEqual({ CODEX_TURN_SETTLED: '1' });
    expect(environmentProvider).toHaveBeenCalledWith({ provider: 'codex' });
  });

  it('returns an empty turn-settled environment after provider failure', async () => {
    const logger = { warn: vi.fn() };
    const environmentProvider = vi.fn(async () => {
      throw new Error('env boom');
    });

    await expect(
      buildRuntimeTurnSettledEnvironment(
        { providerId: 'codex' as TeamProviderId },
        { environmentProvider, logger }
      )
    ).resolves.toEqual({});
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to build member work sync runtime turn-settled environment: env boom'
    );
  });
});
