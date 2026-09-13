import { createHostedTeamConfigurationAuthority } from '@features/team-configuration/main/hosted';
import {
  createQueryContext,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import { canonicalHostedTeamConfigurationCreate } from '../../../../src/features/team-configuration/core/application/hosted-authority/canonicalHostedTeamConfigurationCreate';

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
    expect(canonicalHostedTeamConfigurationCreate(request)).toBe(JSON.stringify({
      schemaVersion: 1, workspaceId, metadata: { name: 'Alpha' }, members: [{ name: 'lead' }],
    }));
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

  it('hashes every configuration selection and preserves ordered, property-order-independent replay identity', async () => {
    const gateway = storage();
    const authority = createHostedTeamConfigurationAuthority(gateway);
    const configuration = { schemaVersion: 1, toolApprovalMode: 'auto', lanes: [
      { kind: 'opencode', provider: 'opencode', selectedModel: 'openai/gpt-5', effort: 'high',
        members: [{ name: 'lead', prompt: 'Coordinate.' }, { name: 'reviewer', prompt: 'Review.' }] },
    ] } as const;
    const request = { workspaceId, idempotencyKey: 'idempotency_configuration-0001' as never,
      name: 'Alpha', members: [{ name: 'lead' }, { name: 'reviewer' }], configuration, context };
    await authority.createDraft(request);
    const initial = vi.mocked(gateway.createHostedTeamConfiguration).mock.calls[0][0];
    expect(initial.configuration).toEqual(configuration);
    await authority.createDraft({ ...request, configuration: {
      lanes: configuration.lanes, toolApprovalMode: 'auto', schemaVersion: 1,
    } });
    expect(vi.mocked(gateway.createHostedTeamConfiguration).mock.calls.at(-1)?.[0].payloadHash).toBe(initial.payloadHash);
    for (const changed of [
      { ...configuration, lanes: [{ ...configuration.lanes[0], selectedModel: 'openai/gpt-6' }] },
      { ...configuration, lanes: [{ ...configuration.lanes[0], effort: 'low' as const }] },
      { ...configuration, lanes: [{ ...configuration.lanes[0], members: [{ name: 'lead', prompt: 'Changed.' }, configuration.lanes[0].members[1]] }] },
      { ...configuration, lanes: [{ ...configuration.lanes[0], members: [...configuration.lanes[0].members].reverse() }] },
    ]) {
      await authority.createDraft({ ...request, configuration: changed });
      expect(vi.mocked(gateway.createHostedTeamConfiguration).mock.calls.at(-1)?.[0].payloadHash).not.toBe(initial.payloadHash);
    }
    await authority.updateDraft({ workspaceId, teamId }, revision, { configuration }, context);
    expect(gateway.updateHostedTeamConfiguration).toHaveBeenCalledWith({ workspaceId, teamId,
      expectedRevision: revision, updates: { configuration }, deadlineAtMs: context.deadlineAtMs,
    }, { signal: context.signal });
  });

  it('refuses manual mode on Hosted create and update without rewriting or reaching storage', async () => {
    const gateway = storage();
    const authority = createHostedTeamConfigurationAuthority(gateway);
    const configuration = { schemaVersion: 1, toolApprovalMode: 'manual', lanes: [
      { kind: 'opencode', provider: 'opencode', selectedModel: 'openai/gpt-5',
        members: [{ name: 'lead', prompt: 'Coordinate.' }] },
    ] } as const;
    const expected = { kind: 'error', error: {
      code: 'unsupported', reason: 'hosted_mvp_manual_approval_unavailable',
    } };

    await expect(authority.createDraft({ workspaceId,
      idempotencyKey: 'idempotency_manual-mode-create' as never, name: 'Manual',
      members: [{ name: 'lead' }], configuration, context })).resolves.toMatchObject(expected);
    await expect(authority.updateDraft({ workspaceId, teamId }, revision,
      { configuration }, context)).resolves.toMatchObject(expected);
    expect(gateway.createHostedTeamConfiguration).not.toHaveBeenCalled();
    expect(gateway.updateHostedTeamConfiguration).not.toHaveBeenCalled();
    expect(configuration.toolApprovalMode).toBe('manual');
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

  it('maps the atomic persisted-manual rejection to a safe unsupported result', async () => {
    const gateway = storage();
    vi.mocked(gateway.updateHostedTeamConfiguration).mockResolvedValueOnce({
      kind: 'unavailable', reason: 'manual_approval_unavailable',
    });
    const authority = createHostedTeamConfigurationAuthority(gateway);
    await expect(
      authority.updateDraft({ workspaceId, teamId }, revision, { name: 'Renamed' }, context)
    ).resolves.toMatchObject({
      kind: 'error',
      error: { code: 'unsupported', reason: 'hosted_mvp_manual_approval_unavailable' },
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
