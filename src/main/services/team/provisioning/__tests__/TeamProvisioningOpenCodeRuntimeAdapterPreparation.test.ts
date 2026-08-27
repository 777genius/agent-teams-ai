import { describe, expect, it, vi } from 'vitest';

import {
  type OpenCodeRuntimeAdapterPreparationPorts,
  prepareOpenCodeRuntimeAdapterLaunch,
} from '../TeamProvisioningOpenCodeRuntimeAdapterPreparation';

import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type { TeamCreateRequest, TeamLaunchRequest, TeamProviderId } from '@shared/types';

const inheritedRuntimeSelectionProvenance = {
  version: 1,
  providerBackendId: 'inherited',
  model: 'inherited',
  effort: 'inherited',
} as const;

const explicitModelRuntimeSelectionProvenance = {
  ...inheritedRuntimeSelectionProvenance,
  model: 'explicit',
} as const;

function createRequest(overrides: Partial<TeamCreateRequest> = {}): TeamCreateRequest {
  return {
    teamName: 'alpha',
    cwd: '/repo',
    members: [],
    leadPrompt: 'lead',
    tasks: [],
    providerId: 'opencode',
    providerBackendId: 'adapter',
    model: 'gpt-5',
    effort: 'high',
    ...overrides,
  } as TeamCreateRequest;
}

function launchRequest(overrides: Partial<TeamLaunchRequest> = {}): TeamLaunchRequest {
  return {
    teamName: 'alpha',
    cwd: '/repo',
    providerId: 'opencode',
    providerBackendId: 'adapter',
    model: 'gpt-5',
    effort: 'high',
    ...overrides,
  } as TeamLaunchRequest;
}

function lanePlan(members: TeamCreateRequest['members']): TeamRuntimeLanePlan {
  return {
    mode: 'pure_opencode',
    primaryMembers: members,
    allMembers: members,
    sideLanes: [],
  } as TeamRuntimeLanePlan;
}

function createPorts(
  overrides: Partial<OpenCodeRuntimeAdapterPreparationPorts> = {}
): OpenCodeRuntimeAdapterPreparationPorts {
  return {
    resolveClaudePath: vi.fn().mockResolvedValue('/usr/bin/claude'),
    buildProvisioningEnv: vi.fn().mockResolvedValue({ env: { A: 'B' }, providerArgs: ['--x'] }),
    resolveProviderDefaultModel: vi.fn().mockResolvedValue('opencode/default'),
    resolveOpenCodeMemberWorkspacesForRuntime: vi.fn(
      async (params: {
        teamName: string;
        baseCwd: string;
        leadProviderId?: TeamProviderId;
        members: TeamCreateRequest['members'];
      }) =>
        params.members.map((member) => ({
          ...member,
          cwd: member.cwd ?? `${params.baseCwd}/${member.name}`,
        }))
    ),
    planRuntimeLanesOrThrow: vi.fn((_leadProviderId, members) => lanePlan(members)),
    buildOpenCodeRuntimeAdapterLaunchMembers: vi.fn((request, members) => [
      {
        name: 'team-lead',
        role: 'Team Lead',
        providerId: request.providerId,
        providerBackendId: request.providerBackendId,
        model: request.model,
        effort: request.effort,
      },
      ...members,
    ]),
    ...overrides,
  };
}

describe('OpenCode runtime adapter preparation', () => {
  it('materializes defaults, resolves workspaces, plans lanes, and builds runtime members', async () => {
    const members: TeamCreateRequest['members'] = [
      {
        name: 'dev',
        role: 'Developer',
        providerId: 'opencode',
        runtimeSelectionProvenance: inheritedRuntimeSelectionProvenance,
      },
    ];
    const ports = createPorts();

    const result = await prepareOpenCodeRuntimeAdapterLaunch(
      {
        request: createRequest(),
        members,
      },
      ports
    );

    expect(ports.resolveOpenCodeMemberWorkspacesForRuntime).toHaveBeenCalledWith({
      teamName: 'alpha',
      baseCwd: '/repo',
      leadProviderId: 'opencode',
      members: [
        expect.objectContaining({
          name: 'dev',
          providerId: 'opencode',
          providerBackendId: 'adapter',
          model: 'gpt-5',
          effort: 'high',
          runtimeSelectionProvenance: inheritedRuntimeSelectionProvenance,
        }),
      ],
    });
    expect(ports.planRuntimeLanesOrThrow).toHaveBeenCalledWith(
      'opencode',
      [
        expect.objectContaining({
          name: 'dev',
          cwd: '/repo/dev',
          providerId: 'opencode',
          providerBackendId: 'adapter',
          model: 'gpt-5',
          effort: 'high',
          runtimeSelectionProvenance: inheritedRuntimeSelectionProvenance,
        }),
      ],
      '/repo'
    );
    expect(ports.buildOpenCodeRuntimeAdapterLaunchMembers).toHaveBeenCalledWith(
      expect.objectContaining({
        providerBackendId: 'adapter',
        model: 'gpt-5',
        effort: 'high',
      }),
      [
        expect.objectContaining({
          name: 'dev',
          cwd: '/repo/dev',
          providerId: 'opencode',
          providerBackendId: 'adapter',
          model: 'gpt-5',
          effort: 'high',
          runtimeSelectionProvenance: inheritedRuntimeSelectionProvenance,
        }),
      ],
      result.lanePlan
    );
    expect(result.launchRequest).toEqual(expect.objectContaining({ model: 'gpt-5' }));
    expect(result.effectiveMembers).toEqual([
      expect.objectContaining({
        name: 'dev',
        cwd: '/repo/dev',
        providerId: 'opencode',
        providerBackendId: 'adapter',
        model: 'gpt-5',
        effort: 'high',
        runtimeSelectionProvenance: inheritedRuntimeSelectionProvenance,
      }),
    ]);
    expect(result.runtimeLaunchMembers).toEqual([
      expect.objectContaining({
        name: 'team-lead',
        providerBackendId: 'adapter',
        model: 'gpt-5',
        effort: 'high',
      }),
      expect.objectContaining({
        name: 'dev',
        providerId: 'opencode',
        providerBackendId: 'adapter',
        model: 'gpt-5',
        effort: 'high',
        runtimeSelectionProvenance: inheritedRuntimeSelectionProvenance,
      }),
    ]);
  });

  it('uses launch request fields when preparing an existing team launch', async () => {
    const members: TeamCreateRequest['members'] = [
      {
        name: 'reviewer',
        role: 'Reviewer',
        providerId: 'opencode',
        model: 'gpt-5',
        runtimeSelectionProvenance: explicitModelRuntimeSelectionProvenance,
      },
    ];
    const ports = createPorts();

    const result = await prepareOpenCodeRuntimeAdapterLaunch(
      {
        request: launchRequest({ cwd: '/new-repo', limitContext: true }),
        members,
      },
      ports
    );

    expect(ports.resolveOpenCodeMemberWorkspacesForRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'alpha',
        baseCwd: '/new-repo',
        leadProviderId: 'opencode',
      })
    );
    expect(ports.planRuntimeLanesOrThrow).toHaveBeenCalledWith(
      'opencode',
      [
        expect.objectContaining({
          name: 'reviewer',
          cwd: '/new-repo/reviewer',
          providerId: 'opencode',
          providerBackendId: 'adapter',
          model: 'gpt-5',
          effort: 'high',
          runtimeSelectionProvenance: explicitModelRuntimeSelectionProvenance,
        }),
      ],
      '/new-repo'
    );
    expect(result.launchRequest).toEqual(
      expect.objectContaining({
        cwd: '/new-repo',
        providerId: 'opencode',
        providerBackendId: 'adapter',
        model: 'gpt-5',
        effort: 'high',
        limitContext: true,
      })
    );
    expect(result.runtimeLaunchMembers).toEqual([
      expect.objectContaining({
        name: 'team-lead',
        providerId: 'opencode',
        providerBackendId: 'adapter',
        model: 'gpt-5',
        effort: 'high',
      }),
      expect.objectContaining({
        name: 'reviewer',
        cwd: '/new-repo/reviewer',
        providerId: 'opencode',
        providerBackendId: 'adapter',
        model: 'gpt-5',
        effort: 'high',
        runtimeSelectionProvenance: explicitModelRuntimeSelectionProvenance,
      }),
    ]);
  });
});
