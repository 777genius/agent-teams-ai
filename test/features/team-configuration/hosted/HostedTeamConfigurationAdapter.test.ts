import { describe, expect, it, vi } from 'vitest';

import { HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION } from '../../../../src/features/team-configuration/contracts';
import {
  createHostedTeamConfigurationFeature,
  type HostedTeamConfigurationApplicationPort,
  type HostedTeamConfigurationAuthorizationPort,
} from '../../../../src/features/team-configuration/main/hosted';
import {
  createQueryContext,
  createSafeAppError,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
  type QueryContext,
} from '../../../../src/shared/contracts/hosted';

const workspaceId = parseWorkspaceId(`workspace_${'1'.repeat(32)}`);
const otherWorkspaceId = parseWorkspaceId(`workspace_${'2'.repeat(32)}`);
const teamId = parseTeamId(`team_${'3'.repeat(32)}`);
const revision = parseRevision('revision_team-configuration-0001');
const nextRevision = parseRevision('revision_team-configuration-0002');
const idempotencyKey = 'idempotency_team-configuration-create-0001';

function context(): QueryContext {
  return createQueryContext({
    actorId: 'actor_authenticated-user',
    sessionId: 'session_authenticated-session',
    deploymentId: 'deployment_test-deployment',
    bootId: 'boot_test-boot',
    requestId: 'request_test-request',
    authorizedScope: 'scope_team-configuration-test',
    deadlineAtMs: Date.now() + 60_000,
    signal: new AbortController().signal,
  });
}

function application(): HostedTeamConfigurationApplicationPort {
  const draft = {
    workspaceId,
    teamId,
    revision,
    metadata: { name: 'Alpha' },
    members: [{ name: 'lead' }],
  };
  return {
    createDraft: vi.fn(async () => ({
      kind: 'created' as const,
      teamId,
      revision,
      outcome: 'created' as const,
    })),
    getSavedRequest: vi.fn(async () => ({ kind: 'found' as const, draft })),
    updateDraft: vi.fn(async () => ({ kind: 'updated' as const, draft })),
    deleteDraft: vi.fn(async () => ({ kind: 'deleted' as const, outcome: 'deleted' as const })),
  };
}

function authority(
  principal: QueryContext,
  mutate?: (
    result: Extract<
      Awaited<ReturnType<HostedTeamConfigurationAuthorizationPort['authorize']>>,
      { kind: 'authorized' }
    >
  ) => unknown
): HostedTeamConfigurationAuthorizationPort {
  return {
    authorize: vi.fn(async (request) => {
      const result = {
        kind: 'authorized' as const,
        principalId: principal.actorId,
        scope: request.scope,
      };
      return (mutate?.(result) ?? result) as never;
    }),
  };
}

function identified() {
  return { schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION, workspaceId, teamId };
}

describe('HostedTeamConfigurationAdapter', () => {
  it('authorizes create by workspace and returns the immutable TeamId from the application port', async () => {
    const principal = context();
    const useCases = application();
    const authorization = authority(principal);
    const adapter = createHostedTeamConfigurationFeature(useCases, authorization);

    await expect(
      adapter.createDraft(
        {
          schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
          workspaceId,
          idempotencyKey,
          name: ' Alpha ',
          members: [{ name: ' lead ' }],
        },
        principal
      )
    ).resolves.toEqual({
      schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
      kind: 'created',
      identity: { workspaceId, teamId },
      revision,
      outcome: 'created',
    });
    expect(authorization.authorize).toHaveBeenCalledBefore(useCases.createDraft as never);
    expect(useCases.createDraft).toHaveBeenCalledWith({
      workspaceId,
      idempotencyKey,
      name: 'Alpha',
      members: [{ name: 'lead' }],
      context: principal,
    });
  });

  it('passes WorkspaceId and TeamId as one identity and never calls by mutable name', async () => {
    const principal = context();
    const useCases = application();
    const adapter = createHostedTeamConfigurationFeature(useCases, authority(principal));

    await adapter.getSavedRequest(identified(), principal);
    await adapter.updateDraft(
      { ...identified(), expectedRevision: revision, updates: { name: 'Renamed' } },
      principal
    );
    await adapter.deleteDraft({ ...identified(), expectedRevision: revision }, principal);

    const identity = { workspaceId, teamId };
    expect(useCases.getSavedRequest).toHaveBeenCalledWith(identity, principal);
    expect(useCases.updateDraft).toHaveBeenCalledWith(
      identity,
      revision,
      { name: 'Renamed' },
      principal
    );
    expect(useCases.deleteDraft).toHaveBeenCalledWith(identity, revision, principal);
  });

  it('projects only bounded provider-neutral draft metadata across the hosted boundary', async () => {
    const principal = context();
    const useCases = application();
    vi.mocked(useCases.getSavedRequest).mockResolvedValueOnce({
      kind: 'found',
      draft: {
        workspaceId,
        teamId,
        revision,
        metadata: {
          name: ' Alpha ',
          description: ' Draft ',
          runtime: 'external-provider',
        },
        members: [{ name: ' lead ' }],
        cwd: '/host/private/path',
      } as never,
    });
    const adapter = createHostedTeamConfigurationFeature(useCases, authority(principal));

    await expect(adapter.getSavedRequest(identified(), principal)).resolves.toEqual({
      schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
      kind: 'found',
      draft: {
        workspaceId,
        teamId,
        revision,
        metadata: { name: 'Alpha', description: 'Draft' },
        members: [{ name: 'lead' }],
      },
    });
  });

  it('fails closed before application calls on cross-principal or cross-identity grants', async () => {
    const principal = context();
    for (const authorization of [
      authority(principal, (result) => ({ ...result, principalId: 'actor_another-user' })),
      authority(principal, (result) => ({
        ...result,
        scope: { kind: 'team', identity: { workspaceId: otherWorkspaceId, teamId } },
      })),
    ]) {
      const useCases = application();
      const adapter = createHostedTeamConfigurationFeature(useCases, authorization);
      await expect(adapter.getSavedRequest(identified(), principal)).resolves.toMatchObject({
        kind: 'error',
        error: { code: 'forbidden' },
      });
      expect(useCases.getSavedRequest).not.toHaveBeenCalled();
    }
  });

  it('rejects mutable-name selectors before authorization', async () => {
    const principal = context();
    const useCases = application();
    const authorization = authority(principal);
    const adapter = createHostedTeamConfigurationFeature(useCases, authorization);
    await expect(
      adapter.updateDraft(
        { schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION, workspaceId, teamName: 'alpha' },
        principal
      )
    ).resolves.toMatchObject({ kind: 'error', error: { code: 'invalid_request' } });
    expect(authorization.authorize).not.toHaveBeenCalled();
    expect(useCases.updateDraft).not.toHaveBeenCalled();
  });

  it('maps typed application errors without message sniffing or a second orchestration path', async () => {
    const principal = context();
    const useCases = application();
    vi.mocked(useCases.updateDraft).mockResolvedValueOnce({
      kind: 'error',
      error: createSafeAppError({ code: 'not_found', reason: 'team_configuration_not_found' }),
    });
    const adapter = createHostedTeamConfigurationFeature(useCases, authority(principal));

    await expect(
      adapter.updateDraft(
        { ...identified(), expectedRevision: revision, updates: { name: 'New name' } },
        principal
      )
    ).resolves.toMatchObject({ kind: 'error', error: { code: 'not_found' } });
    expect(useCases.updateDraft).toHaveBeenCalledTimes(1);
    expect(useCases.getSavedRequest).not.toHaveBeenCalled();
  });

  it('returns the same TeamId and revision for a deterministic create replay', async () => {
    const principal = context();
    const useCases = application();
    vi.mocked(useCases.createDraft)
      .mockResolvedValueOnce({ kind: 'created', teamId, revision, outcome: 'created' })
      .mockResolvedValueOnce({
        kind: 'created',
        teamId,
        revision,
        outcome: 'idempotent_replay',
      });
    const adapter = createHostedTeamConfigurationFeature(useCases, authority(principal));
    const request = {
      schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
      workspaceId,
      idempotencyKey,
      name: 'Alpha',
      members: [{ name: 'lead' }],
    } as const;

    const first = await adapter.createDraft(request, principal);
    const replay = await adapter.createDraft(request, principal);

    expect(first).toMatchObject({
      identity: { workspaceId, teamId },
      revision,
      outcome: 'created',
    });
    expect(replay).toMatchObject({
      identity: { workspaceId, teamId },
      revision,
      outcome: 'idempotent_replay',
    });
    expect(useCases.createDraft).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey })
    );
  });

  it('forwards the expected revision and exposes a finite conflict without applying a stale write', async () => {
    const principal = context();
    const useCases = application();
    const mutate = vi.fn();
    vi.mocked(useCases.updateDraft).mockImplementationOnce(async (_identity, expected) => {
      if (expected !== nextRevision) {
        return {
          kind: 'error',
          error: createSafeAppError({
            code: 'conflict',
            reason: 'opencode_process_revision_mismatch',
            diagnosticId: 'electron.provider-process',
          }),
        };
      }
      mutate();
      throw new Error('unexpected fresh revision');
    });
    const adapter = createHostedTeamConfigurationFeature(useCases, authority(principal));

    const result = await adapter.updateDraft(
      { ...identified(), expectedRevision: revision, updates: { name: 'Stale' } },
      principal
    );
    expect(result).toMatchObject({
      kind: 'error',
      error: { code: 'conflict', reason: 'team_configuration_revision_conflict' },
      retryable: false,
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/opencode|electron|provider|process/);
  });

  it('rejects a stale delete through the application revision fence without deleting', async () => {
    const principal = context();
    const useCases = application();
    const remove = vi.fn();
    vi.mocked(useCases.deleteDraft).mockImplementationOnce(async (_identity, expected) => {
      if (expected !== nextRevision) {
        return {
          kind: 'error',
          error: createSafeAppError({
            code: 'conflict',
            reason: 'internal_delete_revision_mismatch',
          }),
        };
      }
      remove();
      return { kind: 'deleted', outcome: 'deleted' };
    });
    const adapter = createHostedTeamConfigurationFeature(useCases, authority(principal));

    const result = await adapter.deleteDraft(
      { ...identified(), expectedRevision: revision },
      principal
    );

    expect(result).toMatchObject({
      kind: 'error',
      error: { code: 'conflict', reason: 'team_configuration_revision_conflict' },
    });
    expect(remove).not.toHaveBeenCalled();
  });
});
