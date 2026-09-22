import { describe, expect, it } from 'vitest';

import {
  type CollectFailedOpenCodeSecondaryRetryCandidatesPorts,
  createCollectFailedOpenCodeSecondaryRetryCandidatesUseCase,
  type OpenCodeSecondaryRetryRun,
} from '../TeamProvisioningCollectFailedOpenCodeSecondaryRetryCandidatesUseCase';

import type { TeamCreateRequest } from '@shared/types';

type EffectiveMember = TeamCreateRequest['members'][number] & {
  agentType?: string;
  removedAt?: number;
};

function createPorts(
  overrides: Partial<CollectFailedOpenCodeSecondaryRetryCandidatesPorts> = {}
): CollectFailedOpenCodeSecondaryRetryCandidatesPorts {
  const configMembers: EffectiveMember[] = [
    { name: 'Lead', agentType: 'team-lead' },
    { name: 'Alice', providerId: 'opencode' },
    { name: 'Bob', providerId: 'codex' },
    { name: 'Skipped', providerId: 'opencode' },
    { name: 'Pending', providerId: 'opencode' },
    { name: 'Alive', providerId: 'opencode' },
    { name: 'Removed', providerId: 'opencode', removedAt: 1 },
  ];
  const metaMembers: EffectiveMember[] = [{ name: 'Tom', providerId: 'opencode' }];

  return {
    hasOpenCodeRuntimeAdapter: () => true,
    readConfigForStrictDecision: async (teamName) => ({
      name: teamName,
      members: configMembers,
    }),
    readMetaMembers: async () => metaMembers,
    readLaunchStateSnapshot: async (teamName) =>
      ({
        version: 2,
        teamName,
        expectedMembers: ['Tom'],
        members: {
          Tom: {
            name: 'Tom',
            laneId: 'secondary:opencode:Tom',
            launchState: 'failed_to_start',
            hardFailure: true,
          },
        },
      }) as never,
    resolveEffectiveConfiguredMember: (config, meta, memberName) =>
      ([...(config ?? []), ...meta].find(
        (member) => member.name.trim().toLowerCase() === memberName.trim().toLowerCase()
      ) as EffectiveMember | undefined) ?? null,
    ...overrides,
  };
}

function createRun(input: Partial<OpenCodeSecondaryRetryRun> = {}): OpenCodeSecondaryRetryRun {
  return {
    teamName: 'retry-team',
    request: { providerId: 'anthropic' },
    mixedSecondaryLanes: [],
    memberSpawnStatuses: new Map([
      ['Alice', { launchState: 'failed_to_start' }],
      ['Bob', { status: 'error' }],
      ['Skipped', { launchState: 'skipped_for_launch' }],
      ['Pending', { launchState: 'runtime_pending_permission' }],
      ['Alive', { launchState: 'confirmed_alive' }],
      ['Removed', { launchState: 'failed_to_start' }],
    ] as never),
    ...input,
  };
}

describe('CollectFailedOpenCodeSecondaryRetryCandidatesUseCase', () => {
  it('collects retryable OpenCode secondary failures from live and persisted launch state', async () => {
    const useCase = createCollectFailedOpenCodeSecondaryRetryCandidatesUseCase(createPorts());

    await expect(useCase(createRun())).resolves.toEqual([
      { memberName: 'Alice', laneId: 'secondary:opencode:Alice' },
      { memberName: 'Tom', laneId: 'secondary:opencode:Tom' },
    ]);
  });

  it('requires an aggregate OpenCode run before retrying OpenCode-led secondary lanes', async () => {
    const useCase = createCollectFailedOpenCodeSecondaryRetryCandidatesUseCase(createPorts());

    await expect(
      useCase(
        createRun({
          request: { providerId: 'opencode' },
          mixedSecondaryLanes: [],
        })
      )
    ).rejects.toThrow(
      'Retrying OpenCode secondary lanes requires an active OpenCode worktree lane run.'
    );
  });

  it('uses existing aggregate lane ids and ignores lanes still launching', async () => {
    const useCase = createCollectFailedOpenCodeSecondaryRetryCandidatesUseCase(
      createPorts({
        readConfigForStrictDecision: async (teamName) => ({
          name: teamName,
          members: [
            { name: 'Alice', providerId: 'opencode' },
            { name: 'Bob', providerId: 'opencode' },
          ],
        }),
        readMetaMembers: async () => [],
        readLaunchStateSnapshot: async () => null,
      })
    );

    await expect(
      useCase(
        createRun({
          request: { providerId: 'opencode' },
          mixedSecondaryLanes: [
            {
              laneId: 'secondary:opencode:alice-runtime',
              member: { name: 'Alice', providerId: 'opencode' },
              state: 'finished',
            },
            {
              laneId: 'secondary:opencode:bob-runtime',
              member: { name: 'Bob', providerId: 'opencode' },
              state: 'launching',
            },
          ],
          memberSpawnStatuses: new Map([
            ['Alice', { status: 'error' }],
            ['Bob', { status: 'error' }],
          ] as never),
        })
      )
    ).resolves.toEqual([{ memberName: 'Alice', laneId: 'secondary:opencode:alice-runtime' }]);
  });
});
