import { describe, expect, it, vi } from 'vitest';

import { createDesktopTaskInteraction } from './createDesktopTaskInteraction';

import type { CreateTaskRequest, TeamTask } from '@shared/types';

const scope = { key: 'context-1/team-a', authorityEpoch: 'epoch-1' };
const createdTask = { id: 'task-1', subject: 'First', status: 'pending' } as TeamTask;

describe('createDesktopTaskInteraction', () => {
  it('rejects IPC length violations before dispatch without freezing an uncertain intent', async () => {
    const createTask = vi.fn(async () => createdTask);
    const interaction = createDesktopTaskInteraction(scope, {
      teamName: 'team-a',
      createTask,
      refreshCreatedTask: vi.fn(async () => undefined),
    });

    await interaction.submit({ subject: 'x'.repeat(501) });
    expect(interaction.getSnapshot()).toMatchObject({ phase: 'not_applied', envelope: null });
    await interaction.submit({ subject: 'Valid', prompt: 'x'.repeat(5001) });
    expect(interaction.getSnapshot()).toMatchObject({ phase: 'not_applied', envelope: null });
    expect(createTask).not.toHaveBeenCalled();

    await interaction.submit({ subject: 'Valid', startImmediately: false });
    expect(interaction.getSnapshot().phase).toBe('confirmed');
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it('freezes the complete rich request and never replays an uncertain delivery', async () => {
    const createTask = vi.fn(async () => {
      throw new Error('response lost after dispatch');
    });
    const interaction = createDesktopTaskInteraction(scope, {
      teamName: 'team-a',
      createTask,
      refreshCreatedTask: vi.fn(async () => undefined),
    });
    const draft: CreateTaskRequest = {
      subject: ' First ',
      owner: 'member-a',
      blockedBy: ['task-2'],
      related: ['task-3'],
      prompt: 'Send instructions',
      startImmediately: true,
      descriptionTaskRefs: [{ taskId: 'task-4', displayId: '4', teamName: 'team-a' }],
    };

    const pending = interaction.submit(draft);
    draft.blockedBy?.push('task-5');
    await pending;

    expect(interaction.getSnapshot()).toMatchObject({
      phase: 'uncertain',
      recovery: 'operator_required',
      envelope: {
        body: {
          request: {
            subject: 'First',
            blockedBy: ['task-2'],
            related: ['task-3'],
            prompt: 'Send instructions',
            startImmediately: true,
          },
        },
        effects: { kind: 'task_write_and_delivery', recovery: 'observation_only' },
      },
    });
    expect(Object.isFrozen(interaction.getSnapshot().envelope?.body)).toBe(true);
    await interaction.retryExact();
    await interaction.submit({ subject: 'Second' });
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it('confirms only the task write for a rich Desktop receipt while emitting local output once', async () => {
    const onConfirmed = vi.fn();
    const interaction = createDesktopTaskInteraction(scope, {
      teamName: 'team-a',
      createTask: vi.fn(async () => createdTask),
      refreshCreatedTask: vi.fn(async () => undefined),
      onConfirmed,
    });

    await interaction.submit({ subject: 'First', owner: 'member-a', startImmediately: true });
    expect(interaction.getSnapshot()).toMatchObject({
      phase: 'confirmed',
      freshness: 'fresh',
      confirmed: { origin: 'mutation_receipt', coverage: 'task_write' },
    });
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    await interaction.refresh();
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it('replays only a basic task with the exact identity and reports refresh separately', async () => {
    const createTask = vi
      .fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(createdTask);
    const refreshCreatedTask = vi.fn(async () => {
      throw new Error('read failed');
    });
    const onConfirmed = vi.fn();
    const interaction = createDesktopTaskInteraction(scope, {
      teamName: 'team-a',
      createTask,
      refreshCreatedTask,
      onConfirmed,
    });

    await interaction.submit({ subject: 'First', startImmediately: false });
    expect(interaction.getSnapshot()).toMatchObject({
      phase: 'uncertain',
      recovery: 'exact_replay',
    });
    await interaction.retryExact();

    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask.mock.calls[0]).toEqual(createTask.mock.calls[1]);
    expect(interaction.getSnapshot()).toMatchObject({
      phase: 'confirmed',
      freshness: 'failed',
      confirmed: { coverage: 'declared_effects', reference: { taskId: 'task-1' } },
    });
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(refreshCreatedTask).toHaveBeenCalledWith('team-a', 'task-1');
  });
});
