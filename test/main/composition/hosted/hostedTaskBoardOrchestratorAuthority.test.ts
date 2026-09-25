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
import type { HostedTaskBoardSelfWriteCoordinator } from '@main/composition/hosted/hostedTaskBoardSelfWrite';
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

function authority(
  result: unknown,
  selfWrites?: HostedTaskBoardSelfWriteCoordinator,
  selfWriteTimeoutMs?: number
) {
  const exchangeOwnerMutation = vi.fn().mockResolvedValue(result);
  const report = vi.fn();
  const adapter = new HostedTaskBoardOrchestratorAuthority(
    {
      exchangeOwnerMutation,
      reportOwnerUnavailable: vi.fn(),
      report,
    } as unknown as HostedTeamMessageOrchestratorAuthority,
    selfWrites,
    selfWriteTimeoutMs
  );
  return { adapter, exchangeOwnerMutation, report };
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

  it('gates watcher attribution around a trusted committed owner postimage', async () => {
    const selfWrites: HostedTaskBoardSelfWriteCoordinator = {
      beginTaskSelfWrite: vi.fn().mockResolvedValue(undefined),
      completeTaskSelfWrite: vi.fn().mockResolvedValue(undefined),
      abortTaskSelfWrite: vi.fn().mockResolvedValue(undefined),
    };
    const payload = {
      ...response('committed'),
      selfWriteEffects: [{ fileKey: 'hosted-task-1', expectedChecksum: '1'.repeat(64) }],
    };
    const harness = authority(payload, selfWrites);

    await expect(harness.adapter.admitTaskMutation(request(), context())).resolves.toMatchObject({
      kind: 'committed',
    });
    expect(selfWrites.beginTaskSelfWrite).toHaveBeenCalledWith(
      request().command.commandId,
      TEAM_ID
    );
    expect(selfWrites.completeTaskSelfWrite).toHaveBeenCalledWith(
      request().command.commandId,
      payload.selfWriteEffects
    );
    expect(selfWrites.abortTaskSelfWrite).not.toHaveBeenCalled();
  });

  it('releases watcher attribution for a committed no-op without fabricated effects', async () => {
    const selfWrites: HostedTaskBoardSelfWriteCoordinator = {
      beginTaskSelfWrite: vi.fn().mockResolvedValue(undefined),
      completeTaskSelfWrite: vi.fn().mockResolvedValue(undefined),
      abortTaskSelfWrite: vi.fn().mockResolvedValue(undefined),
    };
    const harness = authority({ ...response('committed'), selfWriteEffects: [] }, selfWrites);

    await expect(harness.adapter.admitTaskMutation(request(), context())).resolves.toMatchObject({
      kind: 'committed',
    });
    expect(selfWrites.completeTaskSelfWrite).toHaveBeenCalledWith(request().command.commandId, []);
    expect(selfWrites.abortTaskSelfWrite).not.toHaveBeenCalled();
  });

  it('keeps a committed Owner receipt when self-write bookkeeping fails afterwards', async () => {
    const selfWrites: HostedTaskBoardSelfWriteCoordinator = {
      beginTaskSelfWrite: vi.fn().mockResolvedValue(undefined),
      completeTaskSelfWrite: vi.fn().mockResolvedValue(undefined),
      abortTaskSelfWrite: vi.fn().mockResolvedValue(undefined),
    };

    // Owner effects missing: the gate is released, the receipt still reaches the browser.
    const missing = authority(response('committed'), selfWrites);
    await expect(missing.adapter.admitTaskMutation(request(), context())).resolves.toMatchObject({
      kind: 'committed',
    });
    expect(selfWrites.completeTaskSelfWrite).not.toHaveBeenCalled();
    expect(selfWrites.abortTaskSelfWrite).toHaveBeenCalledWith(request().command.commandId);
    expect(missing.report).toHaveBeenCalledWith('task_mutate', 'self-write-effects-missing');

    // Completion (and the observer convergence it triggers) fails after the Owner commit.
    vi.mocked(selfWrites.completeTaskSelfWrite).mockRejectedValueOnce(
      new Error('catalog_rebuild_handoff_dirty')
    );
    const failing = authority(
      {
        ...response('committed'),
        selfWriteEffects: [{ fileKey: 'hosted-task-1', expectedChecksum: '1'.repeat(64) }],
      },
      selfWrites
    );
    await expect(failing.adapter.admitTaskMutation(request(), context())).resolves.toMatchObject({
      kind: 'committed',
    });
    expect(failing.report).toHaveBeenCalledWith(
      'task_mutate',
      'self-write-completion-failed:catalog_rebuild_handoff_dirty'
    );
    expect(selfWrites.abortTaskSelfWrite).toHaveBeenCalledTimes(2);
  });

  it('never lets stuck self-write bookkeeping hold the browser answer', async () => {
    const never = () => new Promise<void>(() => undefined);
    const committed = {
      ...response('committed'),
      selfWriteEffects: [{ fileKey: 'hosted-task-1', expectedChecksum: '1'.repeat(64) }],
    };

    // Completion fails after the Owner commit and the gate release then never settles (live35).
    const stuckAbort: HostedTaskBoardSelfWriteCoordinator = {
      beginTaskSelfWrite: vi.fn().mockResolvedValue(undefined),
      completeTaskSelfWrite: vi
        .fn()
        .mockRejectedValue(new Error('external-writer-observer:catalog_invalid')),
      abortTaskSelfWrite: vi.fn(never),
    };
    const failed = authority(committed, stuckAbort, 20);
    await expect(failed.adapter.admitTaskMutation(request(), context())).resolves.toMatchObject({
      kind: 'committed',
    });
    expect(failed.report.mock.calls).toEqual([
      ['task_mutate', 'self-write-completion-failed:external-writer-observer:catalog_invalid'],
      ['task_mutate', 'self-write-bookkeeping-timeout'],
    ]);

    // Completion itself never settles.
    const stuckCompletion: HostedTaskBoardSelfWriteCoordinator = {
      beginTaskSelfWrite: vi.fn().mockResolvedValue(undefined),
      completeTaskSelfWrite: vi.fn(never),
      abortTaskSelfWrite: vi.fn().mockResolvedValue(undefined),
    };
    const hung = authority(committed, stuckCompletion, 20);
    await expect(hung.adapter.admitTaskMutation(request(), context())).resolves.toMatchObject({
      kind: 'committed',
    });
    expect(hung.report).toHaveBeenCalledWith('task_mutate', 'self-write-bookkeeping-timeout');

    // A gate that never opens answers unavailable without asking the Owner, then is released.
    let openGate!: () => void;
    const stuckBegin: HostedTaskBoardSelfWriteCoordinator = {
      beginTaskSelfWrite: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            openGate = resolve;
          })
      ),
      completeTaskSelfWrite: vi.fn().mockResolvedValue(undefined),
      abortTaskSelfWrite: vi.fn().mockResolvedValue(undefined),
    };
    const closed = authority(committed, stuckBegin, 20);
    await expect(closed.adapter.admitTaskMutation(request(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(closed.exchangeOwnerMutation).not.toHaveBeenCalled();
    expect(closed.report).toHaveBeenCalledWith('task_mutate', 'self-write-begin-timeout');
    openGate();
    await vi.waitFor(() =>
      expect(stuckBegin.abortTaskSelfWrite).toHaveBeenCalledWith(request().command.commandId)
    );
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
