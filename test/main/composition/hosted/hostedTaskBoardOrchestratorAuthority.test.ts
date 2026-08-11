import {
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskCommandId,
  parseHostedTaskIdempotencyKey,
} from '@features/team-task-board/main/hosted';
import { HostedTaskBoardOrchestratorAuthority } from '@main/composition/hosted/hostedTaskBoardOrchestratorAuthority';
import {
  createQueryContext,
  parseAuthorizedScope,
  parseRevision,
  parseTeamId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type {
  HostedTaskBoardAuthorityMutationRequest,
  HostedTaskBoardAuthorityMutationResult,
} from '@features/team-task-board/main/hosted';
import type { HostedTeamMessageOrchestratorAuthority } from '@main/composition/hosted/hostedTeamMessageOrchestratorAuthority';

const TEAM_ID = parseTeamId(`team_${'a'.repeat(32)}`);
const SOURCE_GENERATION = parseHostedTaskBoardSourceGeneration(`generation_${'b'.repeat(64)}`);
const REVISION = parseRevision(`revision_${'c'.repeat(64)}`);
const NEXT_REVISION = parseRevision(`revision_${'d'.repeat(64)}`);
const FINGERPRINT = 'e'.repeat(64);

function request(): HostedTaskBoardAuthorityMutationRequest {
  return {
    payloadFingerprint: FINGERPRINT,
    command: {
      schemaVersion: 1,
      kind: 'create_task',
      commandId: parseHostedTaskCommandId('command_task-owner-bound'),
      idempotencyKey: parseHostedTaskIdempotencyKey('idempotency_task-owner-bound'),
      teamId: TEAM_ID,
      expectedSourceGeneration: SOURCE_GENERATION,
      expectedRevision: REVISION,
      subject: 'Owner-bound task',
      description: null,
      status: 'pending',
      ownerId: null,
      column: 'todo',
      order: 0,
    },
  };
}

function context() {
  return createQueryContext({
    actorId: 'actor_task-owner-bound',
    sessionId: 'session_task-owner-bound',
    deploymentId: 'deployment_task-owner-bound',
    bootId: 'boot_task-owner-bound',
    requestId: 'request_task-owner-bound',
    authorizedScope: parseAuthorizedScope('scope_task-owner-bound'),
    deadlineAtMs: Date.now() + 5_000,
    signal: new AbortController().signal,
  });
}

function response(kind: 'committed' | 'idempotent_replay'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind,
    currentSourceGeneration: SOURCE_GENERATION,
    payloadFingerprint: FINGERPRINT,
    receipt: {
      schemaVersion: 1,
      outcome: kind === 'committed' ? 'committed' : 'idempotent_replay',
      commandId: request().command.commandId,
      teamId: TEAM_ID,
      sourceGeneration: SOURCE_GENERATION,
      revision: NEXT_REVISION,
      affectedTaskIds: [`task_${'f'.repeat(32)}`],
    },
  };
}

function authority(result: unknown) {
  const exchangeOwnerMutation = vi.fn().mockResolvedValue(result);
  const adapter = new HostedTaskBoardOrchestratorAuthority({
    exchangeOwnerMutation,
  } as unknown as HostedTeamMessageOrchestratorAuthority);
  return { adapter, exchangeOwnerMutation };
}

describe('HostedTaskBoardOrchestratorAuthority', () => {
  it.each(['committed', 'idempotent_replay'] as const)(
    'borrows the lifecycle-owner task_mutate exchange for %s',
    async (kind) => {
      const harness = authority(response(kind));
      const result = await harness.adapter.admitTaskMutation(request(), context());
      expect(result.kind).toBe(kind);
      expect(harness.exchangeOwnerMutation).toHaveBeenCalledWith(
        'task_mutate',
        request(),
        TEAM_ID,
        expect.objectContaining({ actorId: 'actor_task-owner-bound' })
      );
    }
  );

  it('preserves exact idempotency mismatch and fails closed on malformed receipts', async () => {
    const mismatch = authority({
      schemaVersion: 1,
      kind: 'conflict',
      reason: 'idempotency_mismatch',
      currentSourceGeneration: SOURCE_GENERATION,
    });
    await expect(mismatch.adapter.admitTaskMutation(request(), context())).resolves.toEqual({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
      currentSourceGeneration: SOURCE_GENERATION,
    } satisfies HostedTaskBoardAuthorityMutationResult);

    const malformed = authority({
      ...response('committed'),
      payloadFingerprint: '0'.repeat(64),
    });
    await expect(malformed.adapter.admitTaskMutation(request(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it.each([
    ['relationship_conflict', false],
    ['relationship_conflict', true],
    ['state_conflict', true],
  ] as const)('preserves typed %s with revision=%s', async (reason, withRevision) => {
    const harness = authority({
      schemaVersion: 1,
      kind: 'conflict',
      reason,
      currentSourceGeneration: SOURCE_GENERATION,
      ...(withRevision ? { currentRevision: NEXT_REVISION } : {}),
    });
    await expect(harness.adapter.admitTaskMutation(request(), context())).resolves.toEqual({
      kind: 'conflict',
      reason,
      currentSourceGeneration: SOURCE_GENERATION,
      ...(withRevision ? { currentRevision: NEXT_REVISION } : {}),
    });
  });

  it.each([
    {
      schemaVersion: 1,
      kind: 'conflict',
      reason: 'state_conflict',
      currentSourceGeneration: SOURCE_GENERATION,
    },
    {
      schemaVersion: 1,
      kind: 'conflict',
      reason: 'relationship_conflict',
      currentSourceGeneration: `generation_${'9'.repeat(64)}`,
      currentRevision: NEXT_REVISION,
    },
    {
      schemaVersion: 1,
      kind: 'conflict',
      reason: 'relationship_conflict',
      currentSourceGeneration: SOURCE_GENERATION,
      currentRevision: 'revision_not-canonical',
    },
  ])('fails closed on malformed typed conflict %#', async (payload) => {
    await expect(
      authority(payload).adapter.admitTaskMutation(request(), context())
    ).resolves.toEqual({ kind: 'unavailable' });
  });
});
