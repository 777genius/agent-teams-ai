import { describe, expect, it, vi } from 'vitest';

import { UpdateTaskFieldsUseCase } from './UpdateTaskFieldsUseCase';

describe('UpdateTaskFieldsUseCase', () => {
  it('persists fields and notifies a live team lead with the existing message contract', async () => {
    const fields = { updateTaskFields: vi.fn(async () => undefined) };
    const runtime = { isTeamAlive: vi.fn(() => true) };
    const notifications = { sendMessageToTeam: vi.fn(async () => undefined) };
    const logger = { warn: vi.fn() };
    const useCase = new UpdateTaskFieldsUseCase({ fields, runtime, notifications, logger });

    await useCase.execute('my-team', 'task-1', {
      subject: 'New title',
      description: 'New description',
    });

    expect(fields.updateTaskFields).toHaveBeenCalledWith('my-team', 'task-1', {
      subject: 'New title',
      description: 'New description',
    });
    expect(notifications.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      'Task #task-1 has been updated by the user (changed: title, description). New title: "New title".'
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps persistence successful when the best-effort lead notification fails', async () => {
    const fields = { updateTaskFields: vi.fn(async () => undefined) };
    const runtime = { isTeamAlive: vi.fn(() => true) };
    const notifications = {
      sendMessageToTeam: vi.fn(async () => Promise.reject(new Error('runtime unavailable'))),
    };
    const logger = { warn: vi.fn() };
    const useCase = new UpdateTaskFieldsUseCase({ fields, runtime, notifications, logger });

    await expect(
      useCase.execute('my-team', 'task-1', { description: 'New description' })
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to notify lead about task fields update for #task-1 in my-team'
    );
  });

  it('does not notify an offline team', async () => {
    const fields = { updateTaskFields: vi.fn(async () => undefined) };
    const runtime = { isTeamAlive: vi.fn(() => false) };
    const notifications = { sendMessageToTeam: vi.fn(async () => undefined) };
    const useCase = new UpdateTaskFieldsUseCase({
      fields,
      runtime,
      notifications,
      logger: { warn: vi.fn() },
    });

    await useCase.execute('my-team', 'task-1', { subject: 'New title' });

    expect(notifications.sendMessageToTeam).not.toHaveBeenCalled();
  });
});
