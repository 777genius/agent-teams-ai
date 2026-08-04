import {
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskCommandId,
  parseHostedTaskId,
} from '@features/team-task-board/contracts/hosted';
import { ExecuteHostedTaskMutation } from '@features/team-task-board/core/application/use-cases/ExecuteHostedTaskMutation';
import {
  createQueryContext,
  parseMemberId,
  parseRevision,
  parseTeamId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { HostedTaskMutationAdmissionPort } from '@features/team-task-board/core/application/ports/HostedTeamTaskBoardPorts';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const task1 = parseHostedTaskId(`task_${'1'.repeat(32)}`);
const task2 = parseHostedTaskId(`task_${'2'.repeat(32)}`);
const memberId = parseMemberId(`member_${'b'.repeat(32)}`);
const expectedRevision = parseRevision(`revision_${'c'.repeat(64)}`);
const committedRevision = parseRevision(`revision_${'d'.repeat(64)}`);
const commandId = parseHostedTaskCommandId('command_execute-1');
const sourceGeneration = parseHostedTaskBoardSourceGeneration('generation_execute-1');
const replacementGeneration = parseHostedTaskBoardSourceGeneration(
  'generation_execute-replacement'
);

const common = {
  schemaVersion: 1 as const,
  commandId,
  idempotencyKey: 'execute-key-1',
  teamId,
  expectedSourceGeneration: sourceGeneration,
  expectedRevision,
};

function context() {
  return createQueryContext({
    actorId: 'actor_execute-test',
    sessionId: 'session_execute-test',
    deploymentId: 'deployment_execute-test',
    bootId: 'boot_execute-test',
    requestId: 'request_execute-test',
    authorizedScope: 'scope_execute-test',
    deadlineAtMs: 10_000,
    signal: new AbortController().signal,
  });
}

function receipt<const TOutcome extends 'committed' | 'idempotent_replay'>(outcome: TOutcome) {
  return {
    schemaVersion: 1 as const,
    outcome,
    commandId,
    teamId,
    sourceGeneration,
    revision: committedRevision,
    affectedTaskIds: [task1],
  };
}

const commands: Record<string, unknown>[] = [
  {
    ...common,
    kind: 'create_task',
    subject: 'Task',
    description: null,
    status: 'pending',
    ownerId: null,
    column: 'todo',
    order: 0,
  },
  { ...common, kind: 'update_details', taskId: task1, subject: 'Renamed' },
  { ...common, kind: 'update_status', taskId: task1, status: 'completed' },
  { ...common, kind: 'update_owner', taskId: task1, ownerId: memberId },
  { ...common, kind: 'move_task', taskId: task1, column: 'review', order: 2 },
  {
    ...common,
    kind: 'reorder_column',
    column: 'todo',
    orderedTaskIds: [task2, task1],
  },
  {
    ...common,
    kind: 'update_relationship',
    action: 'remove',
    taskId: task1,
    otherTaskId: task2,
    relationship: 'related',
  },
];

describe('ExecuteHostedTaskMutation', () => {
  it.each(commands)(
    'validates each command variant then delegates exactly once',
    async (command) => {
      const admit = vi.fn(() =>
        Promise.resolve({
          kind: 'committed' as const,
          receipt: receipt('committed'),
        })
      );
      const useCase = new ExecuteHostedTaskMutation({ admit });

      await expect(useCase.execute(command, context())).resolves.toEqual({
        kind: 'committed',
        receipt: receipt('committed'),
      });
      expect(admit).toHaveBeenCalledOnce();
      expect(admit).toHaveBeenCalledWith(
        expect.objectContaining({ kind: command.kind }),
        expect.any(Object)
      );
    }
  );

  it.each([
    { ...common, kind: 'update_status', taskId: task1, status: 'unknown' },
    {
      ...common,
      kind: 'reorder_column',
      column: 'todo',
      orderedTaskIds: [task1, task1],
    },
    {
      ...common,
      kind: 'update_relationship',
      action: 'add',
      taskId: task1,
      otherTaskId: task1,
      relationship: 'blocks',
    },
    { ...common, kind: 'update_details', taskId: task1, subject: 'x'.repeat(201) },
    {
      schemaVersion: 1,
      commandId,
      idempotencyKey: 'execute-key-1',
      teamId,
      expectedSourceGeneration: sourceGeneration,
      kind: 'update_status',
      taskId: task1,
      status: 'pending',
    },
  ])('rejects invalid input before mutation admission', async (command) => {
    const admit = vi.fn();
    const useCase = new ExecuteHostedTaskMutation({ admit } as HostedTaskMutationAdmissionPort);

    await expect(useCase.execute(command, context())).resolves.toEqual({
      kind: 'invalid_request',
    });
    expect(admit).not.toHaveBeenCalled();
  });

  it('returns a typed idempotent replay receipt', async () => {
    const admission: HostedTaskMutationAdmissionPort = {
      admit: vi.fn(() =>
        Promise.resolve({
          kind: 'idempotent_replay' as const,
          receipt: receipt('idempotent_replay'),
        })
      ),
    };

    await expect(
      new ExecuteHostedTaskMutation(admission).execute(commands[0], context())
    ).resolves.toEqual({
      kind: 'idempotent_replay',
      receipt: receipt('idempotent_replay'),
    });
  });

  it.each([
    {
      result: {
        kind: 'stale_generation' as const,
        currentSourceGeneration: replacementGeneration,
      },
      expected: {
        kind: 'stale_generation',
        currentSourceGeneration: replacementGeneration,
      },
    },
    {
      result: { kind: 'stale_revision' as const, currentRevision: committedRevision },
      expected: { kind: 'stale_revision', currentRevision: committedRevision },
    },
    {
      result: {
        kind: 'conflict' as const,
        reason: 'idempotency_mismatch' as const,
      },
      expected: { kind: 'conflict', reason: 'idempotency_mismatch' },
    },
    {
      result: {
        kind: 'conflict' as const,
        reason: 'relationship_conflict' as const,
        currentRevision: committedRevision,
      },
      expected: {
        kind: 'conflict',
        reason: 'relationship_conflict',
        currentRevision: committedRevision,
      },
    },
    {
      result: {
        kind: 'conflict' as const,
        reason: 'state_conflict' as const,
        currentRevision: committedRevision,
      },
      expected: {
        kind: 'conflict',
        reason: 'state_conflict',
        currentRevision: committedRevision,
      },
    },
    { result: { kind: 'not_found' as const }, expected: { kind: 'not_found' } },
    { result: { kind: 'unsafe_active' as const }, expected: { kind: 'unsafe_active' } },
    {
      result: { kind: 'unavailable' as const, retryAfterMs: 250 },
      expected: { kind: 'unavailable', retryAfterMs: 250 },
    },
  ])('passes through the safe $result.kind outcome without retry', async ({ result, expected }) => {
    const admit = vi.fn(() => Promise.resolve(result));
    const useCase = new ExecuteHostedTaskMutation({
      admit,
    } as HostedTaskMutationAdmissionPort);

    await expect(useCase.execute(commands[0], context())).resolves.toEqual(expected);
    expect(admit).toHaveBeenCalledOnce();
  });

  it('strict-parses the generation before admission and rejects revision ABA by generation', async () => {
    const admit = vi.fn(() =>
      Promise.resolve({
        kind: 'stale_generation' as const,
        currentSourceGeneration: replacementGeneration,
      })
    );
    const useCase = new ExecuteHostedTaskMutation({ admit });

    await expect(
      useCase.execute({ ...commands[0], expectedSourceGeneration: 'generation/invalid' }, context())
    ).resolves.toEqual({ kind: 'invalid_request' });
    expect(admit).not.toHaveBeenCalled();

    await expect(useCase.execute(commands[0], context())).resolves.toEqual({
      kind: 'stale_generation',
      currentSourceGeneration: replacementGeneration,
    });
    expect(admit).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSourceGeneration: sourceGeneration,
        expectedRevision,
      }),
      expect.any(Object)
    );
  });

  it('fails closed on stale or conflict outcomes that do not advance the expected revision', async () => {
    const sameRevision = expectedRevision;
    for (const result of [
      { kind: 'stale_revision' as const, currentRevision: sameRevision },
      {
        kind: 'conflict' as const,
        reason: 'state_conflict' as const,
        currentRevision: sameRevision,
      },
      { kind: 'conflict' as const, reason: 'state_conflict' as const },
      {
        kind: 'conflict' as const,
        reason: 'idempotency_mismatch' as const,
        currentRevision: committedRevision,
      },
    ]) {
      const admit = vi.fn(() => Promise.resolve(result));
      await expect(
        new ExecuteHostedTaskMutation({ admit } as HostedTaskMutationAdmissionPort).execute(
          commands[0],
          context()
        )
      ).resolves.toEqual({ kind: 'unavailable' });
    }
  });

  it('contains raw port errors as an unavailable outcome without retrying', async () => {
    const admit = vi.fn(() => Promise.reject(new Error('provider token at /private/path')));
    const useCase = new ExecuteHostedTaskMutation({ admit });

    const result = await useCase.execute(commands[0], context());

    expect(result).toEqual({ kind: 'unavailable' });
    expect(JSON.stringify(result)).not.toMatch(/provider|token|private|path/);
    expect(admit).toHaveBeenCalledOnce();
  });

  it('rejects a widened or mismatched receipt instead of serializing it', async () => {
    const admit = vi.fn(() =>
      Promise.resolve({
        kind: 'committed' as const,
        receipt: { ...receipt('committed'), rawError: 'private path' },
      })
    );
    const useCase = new ExecuteHostedTaskMutation({ admit } as never);

    await expect(useCase.execute(commands[0], context())).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(admit).toHaveBeenCalledOnce();
  });

  it('rejects a receipt from a different generation instead of accepting stale admission', async () => {
    const admit = vi.fn(() =>
      Promise.resolve({
        kind: 'committed' as const,
        receipt: {
          ...receipt('committed'),
          sourceGeneration: replacementGeneration,
        },
      })
    );

    await expect(
      new ExecuteHostedTaskMutation({ admit }).execute(commands[0], context())
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(admit).toHaveBeenCalledOnce();
  });
});
