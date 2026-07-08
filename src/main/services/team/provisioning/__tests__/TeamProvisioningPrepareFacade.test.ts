import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningPrepareFacadeFromService,
  TeamProvisioningPrepareFacade,
  type TeamProvisioningPrepareFacadePorts,
  type TeamProvisioningPrepareFacadeServiceHost,
} from '../TeamProvisioningPrepareFacade';

import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type { TeamCreateRequest } from '@shared/types';

function buildLanePlan(members: TeamCreateRequest['members']): TeamRuntimeLanePlan {
  return {
    mode: 'pure_opencode',
    primaryMembers: members,
    allMembers: members,
    sideLanes: [],
  } as TeamRuntimeLanePlan;
}

function createFacade(
  overrides: Partial<TeamProvisioningPrepareFacadePorts> = {}
): TeamProvisioningPrepareFacade {
  return new TeamProvisioningPrepareFacade({
    getOpenCodeRuntimeAdapter: vi.fn(() => null),
    buildProvisioningEnv: vi.fn().mockResolvedValue({
      env: { PATH: '/bin' },
      authSource: 'none',
      geminiRuntimeAuth: null,
      providerArgs: [],
    }),
    runProviderOneShotDiagnostic: vi.fn().mockResolvedValue({}),
    readRuntimeProviderLaunchFacts: vi.fn().mockResolvedValue({
      defaultModel: null,
      modelIds: new Set(),
      runtimeCapabilities: null,
      modelCatalog: null,
    }),
    resolveClaudeBinaryPath: vi.fn().mockResolvedValue('/fake/claude'),
    probeClaudeRuntime: vi.fn().mockResolvedValue({}),
    ensureMemberWorktree: vi.fn(async ({ baseCwd, memberName }) => ({
      worktreePath: path.join(baseCwd, '.worktrees', memberName),
    })),
    execCli: vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        providers: {
          opencode: {
            defaultModel: 'opencode/default',
            models: [],
          },
        },
      }),
    }),
    planRuntimeLanesOrThrow: vi.fn((_leadProviderId, members) => buildLanePlan(members)),
    info: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  });
}

describe('TeamProvisioningPrepareFacade', () => {
  it('builds facade ports from service-shaped dependencies', async () => {
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'prepare-facade-host-'));
    const buildProvisioningEnv = vi.fn().mockResolvedValue({
      env: { PATH: '/bin' },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
      providerArgs: ['--codex'],
    });
    const probeClaudeRuntime = vi.fn().mockResolvedValue({});
    const service = {
      appShellBoundary: {
        getOpenCodeRuntimeAdapter: vi.fn(() => null),
      },
      buildProvisioningEnv,
      providerRuntime: {
        runProviderOneShotDiagnostic: vi.fn().mockResolvedValue({}),
        probeClaudeRuntime,
      },
      readRuntimeProviderLaunchFacts: vi.fn().mockResolvedValue({
        defaultModel: null,
        modelIds: new Set(),
        runtimeCapabilities: null,
        modelCatalog: null,
      }),
      memberWorktreeManager: {
        ensureMemberWorktree: vi.fn(async ({ baseCwd, memberName }) => ({
          worktreePath: path.join(baseCwd, '.worktrees', memberName),
        })),
      },
      planRuntimeLanesOrThrow: vi.fn((_leadProviderId, members) => buildLanePlan(members)),
    } satisfies TeamProvisioningPrepareFacadeServiceHost;
    const facade = createTeamProvisioningPrepareFacadeFromService(service, {
      resolveClaudeBinaryPath: vi.fn().mockResolvedValue('/fake/claude'),
      execCli: vi.fn().mockResolvedValue({ stdout: '{}' }),
      info: vi.fn(),
      warn: vi.fn(),
    });

    await facade.prepareForProvisioning(cwd, { providerId: 'codex' });

    expect(buildProvisioningEnv).toHaveBeenCalledWith('codex', undefined, undefined);
    expect(probeClaudeRuntime).toHaveBeenCalledWith(
      '/fake/claude',
      cwd,
      { PATH: '/bin' },
      'codex',
      ['--codex']
    );
  });

  it('owns probe caching and preserves forceFresh cache invalidation', async () => {
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'prepare-facade-cache-'));
    const probeClaudeRuntime = vi.fn().mockResolvedValue({});
    const facade = createFacade({
      buildProvisioningEnv: vi.fn().mockResolvedValue({
        env: { PATH: '/bin' },
        authSource: 'codex_runtime',
        geminiRuntimeAuth: null,
        providerArgs: ['--codex'],
      }),
      probeClaudeRuntime,
    });

    await facade.prepareForProvisioning(cwd, { providerId: 'codex' });
    await facade.prepareForProvisioning(cwd, { providerId: 'codex' });
    await facade.prepareForProvisioning(cwd, { providerId: 'codex', forceFresh: true });

    expect(probeClaudeRuntime).toHaveBeenCalledTimes(2);
    expect(probeClaudeRuntime).toHaveBeenNthCalledWith(
      1,
      '/fake/claude',
      cwd,
      { PATH: '/bin' },
      'codex',
      ['--codex']
    );
  });

  it('isolates default probe caches per facade instance', async () => {
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'prepare-facade-isolated-'));
    const buildProvisioningEnv = vi.fn().mockResolvedValue({
      env: { PATH: '/bin' },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
      providerArgs: ['--codex'],
    });
    const probeClaudeRuntime = vi.fn().mockResolvedValue({});
    const first = createFacade({ buildProvisioningEnv, probeClaudeRuntime });
    const second = createFacade({ buildProvisioningEnv, probeClaudeRuntime });

    await first.prepareForProvisioning(cwd, { providerId: 'codex' });
    await first.prepareForProvisioning(cwd, { providerId: 'codex' });
    await second.prepareForProvisioning(cwd, { providerId: 'codex' });
    await second.prepareForProvisioning(cwd, { providerId: 'codex' });

    expect(buildProvisioningEnv).toHaveBeenCalledTimes(2);
    expect(probeClaudeRuntime).toHaveBeenCalledTimes(2);
  });

  it('prepares OpenCode runtime adapter launches through explicit facade ports', async () => {
    const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'prepare-facade-opencode-'));
    const buildProvisioningEnv = vi.fn().mockResolvedValue({
      env: { PATH: '/bin' },
      authSource: 'none',
      geminiRuntimeAuth: null,
      providerArgs: ['--from-env'],
    });
    const ensureMemberWorktree = vi.fn(async ({ baseCwd, memberName }) => ({
      worktreePath: path.join(baseCwd, '.worktrees', memberName),
    }));
    const planRuntimeLanesOrThrow = vi.fn((_leadProviderId, members) => buildLanePlan(members));
    const execCli = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        providers: {
          opencode: {
            defaultModel: 'opencode/default',
            models: [],
          },
        },
      }),
    });
    const facade = createFacade({
      buildProvisioningEnv,
      ensureMemberWorktree,
      planRuntimeLanesOrThrow,
      execCli,
    });

    const request = {
      teamName: 'alpha',
      cwd,
      members: [],
      leadPrompt: 'lead',
      tasks: [],
      providerId: 'opencode',
      providerBackendId: 'adapter',
    } as TeamCreateRequest;
    const members: TeamCreateRequest['members'] = [
      { name: 'dev', role: 'Developer', providerId: 'opencode', isolation: 'worktree' },
    ];

    const result = await facade.prepareOpenCodeRuntimeAdapterLaunch({ request, members });

    expect(buildProvisioningEnv).toHaveBeenCalledWith('opencode', 'adapter');
    expect(execCli).toHaveBeenCalledWith(
      '/fake/claude',
      expect.arrayContaining(['model', 'list', '--json', '--provider', 'opencode']),
      expect.objectContaining({ cwd, env: { PATH: '/bin' } })
    );
    expect(ensureMemberWorktree).toHaveBeenCalledWith({
      teamName: 'alpha',
      memberName: 'dev',
      baseCwd: cwd,
    });
    expect(planRuntimeLanesOrThrow).toHaveBeenCalledWith(
      'opencode',
      [expect.objectContaining({ name: 'dev', model: 'opencode/default' })],
      cwd
    );
    expect(result.launchRequest.model).toBe('opencode/default');
    expect(result.effectiveMembers).toEqual([
      expect.objectContaining({
        name: 'dev',
        cwd: path.join(cwd, '.worktrees', 'dev'),
        model: 'opencode/default',
      }),
    ]);
    expect(result.runtimeLaunchMembers).toEqual([
      expect.objectContaining({ name: 'team-lead', model: 'opencode/default' }),
      expect.objectContaining({ name: 'dev', model: 'opencode/default' }),
    ]);
  });
});
