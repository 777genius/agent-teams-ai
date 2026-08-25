import { createHostedTeamConfigurationAuthority } from '@features/team-configuration/main/hosted';
import {
  createQueryContext,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { HostedTeamConfigurationStorageGateway } from '@features/internal-storage/contracts';

const workspaceId = parseWorkspaceId(`workspace_${'1'.repeat(32)}`);
const teamId = parseTeamId(`team_${'2'.repeat(32)}`);
const revision = parseRevision('revision_initial');
const context = createQueryContext({
  actorId: 'actor_test',
  sessionId: 'session_test',
  deploymentId: 'deployment_test',
  bootId: 'boot_test',
  requestId: 'request_test',
  authorizedScope: 'scope_team-configuration-test',
  deadlineAtMs: Date.now() + 60_000,
  signal: new AbortController().signal,
});

function storage(): HostedTeamConfigurationStorageGateway {
  return {
    createHostedTeamConfiguration: vi.fn(
      async () =>
        ({
          kind: 'created',
          teamId,
          revision,
          outcome: 'created',
        }) as const
    ),
    readHostedTeamConfiguration: vi.fn(async () => ({ kind: 'not_found' }) as const),
    updateHostedTeamConfiguration: vi.fn(
      async () => ({ kind: 'conflict', reason: 'revision_mismatch' }) as const
    ),
    deleteHostedTeamConfiguration: vi.fn(
      async () => ({ kind: 'deleted', outcome: 'already_absent' }) as const
    ),
  };
}

describe('hosted team configuration application authority', () => {
  it('passes a stable canonical create hash and maps idempotency mismatch without retry mutation', async () => {
    const gateway = storage();
    const authority = createHostedTeamConfigurationAuthority(gateway);
    const request = {
      workspaceId,
      idempotencyKey: 'idempotency_application-create-0001' as never,
      name: 'Alpha',
      members: [{ name: 'lead' }],
      context,
    };
    await authority.createDraft(request);
    await authority.createDraft(request);
    expect(gateway.createHostedTeamConfiguration).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        deadlineAtMs: context.deadlineAtMs,
      }),
      { signal: context.signal }
    );
    expect(vi.mocked(gateway.createHostedTeamConfiguration).mock.calls[0]?.[0].payloadHash).toBe(
      vi.mocked(gateway.createHostedTeamConfiguration).mock.calls[1]?.[0].payloadHash
    );

    vi.mocked(gateway.createHostedTeamConfiguration).mockResolvedValueOnce({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });
    await expect(authority.createDraft({ ...request, name: 'Changed' })).resolves.toMatchObject({
      kind: 'error',
      error: { code: 'conflict', reason: 'team_configuration_idempotency_conflict' },
    });

    await authority.createDraft({ ...request, members: [{ name: 'lead' }, { name: 'reviewer' }] });
    const orderedHash = vi
      .mocked(gateway.createHostedTeamConfiguration)
      .mock.calls.at(-1)?.[0].payloadHash;
    await authority.createDraft({ ...request, members: [{ name: 'reviewer' }, { name: 'lead' }] });
    const reversedHash = vi
      .mocked(gateway.createHostedTeamConfiguration)
      .mock.calls.at(-1)?.[0].payloadHash;
    expect(orderedHash).not.toBe(reversedHash);
  });

  it('maps storage CAS and absence outcomes to the existing application contract', async () => {
    const gateway = storage();
    const authority = createHostedTeamConfigurationAuthority(gateway);
    await expect(
      authority.getSavedRequest({ workspaceId, teamId }, context)
    ).resolves.toMatchObject({
      kind: 'error',
      error: { code: 'not_found' },
    });
    await expect(
      authority.updateDraft({ workspaceId, teamId }, revision, { name: 'Stale' }, context)
    ).resolves.toMatchObject({
      kind: 'error',
      error: { code: 'conflict', reason: 'team_configuration_revision_conflict' },
    });
    await expect(
      authority.deleteDraft({ workspaceId, teamId }, revision, context)
    ).resolves.toEqual({
      kind: 'deleted',
      outcome: 'already_absent',
    });
  });

  it('rejects cancelled and expired work in the application before storage admission', async () => {
    const gateway = storage();
    const authority = createHostedTeamConfigurationAuthority(gateway);
    const controller = new AbortController();
    controller.abort();
    const cancelled = createQueryContext({ ...context, signal: controller.signal });
    const expired = createQueryContext({ ...context, deadlineAtMs: 0 });

    await expect(
      authority.getSavedRequest({ workspaceId, teamId }, cancelled)
    ).resolves.toMatchObject({
      kind: 'error',
      error: { code: 'cancelled' },
    });
    await expect(
      authority.getSavedRequest({ workspaceId, teamId }, expired)
    ).resolves.toMatchObject({
      kind: 'error',
      error: { code: 'unavailable' },
    });
    expect(gateway.readHostedTeamConfiguration).not.toHaveBeenCalled();
  });
});
