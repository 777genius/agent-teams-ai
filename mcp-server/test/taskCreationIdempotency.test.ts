import { describe, expect, it, vi } from 'vitest';

import {
  createTaskWithOptionalIdempotency,
  resolveMessageTaskCommandId,
  resolveOptionalTaskCreateCommandId,
} from '../src/utils/taskCreationIdempotency';

describe('task creation idempotency', () => {
  it('keeps canonical task UUID keys stable and derives stable command ids for opaque keys', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    const uuidV7 = '019cce7c-f940-7777-8777-777777777777';
    expect(resolveOptionalTaskCreateCommandId({ teamName: 'alpha', commandId: uuid })).toBe(uuid);
    expect(resolveOptionalTaskCreateCommandId({ teamName: 'alpha', idempotencyKey: uuid })).toBe(
      uuid
    );
    expect(() =>
      resolveOptionalTaskCreateCommandId({ teamName: 'alpha', commandId: uuidV7 })
    ).toThrow('canonical task UUID (version 1-5)');
    expect(
      resolveOptionalTaskCreateCommandId({ teamName: 'alpha', idempotencyKey: uuidV7 })
    ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const first = resolveOptionalTaskCreateCommandId({
      teamName: 'alpha',
      idempotencyKey: 'retry-create-login',
    });
    expect(first).toBe(
      resolveOptionalTaskCreateCommandId({
        teamName: 'alpha',
        idempotencyKey: 'retry-create-login',
      })
    );
    expect(first).not.toBe(
      resolveOptionalTaskCreateCommandId({
        teamName: 'alpha',
        idempotencyKey: 'create-another-task',
      })
    );
    expect(resolveOptionalTaskCreateCommandId({ teamName: 'alpha' })).toBeUndefined();
    expect(() =>
      resolveOptionalTaskCreateCommandId({
        teamName: 'alpha',
        commandId: uuid,
        idempotencyKey: 'different-request',
      })
    ).toThrow('commandId and idempotencyKey identify different requests');
  });

  it('uses message id and request key as the task discriminator', () => {
    const first = resolveMessageTaskCommandId({
      teamName: 'alpha',
      messageId: 'msg-1',
      requestKey: 'login-task',
    });
    expect(first).toBe(
      resolveMessageTaskCommandId({
        teamName: 'alpha',
        messageId: 'msg-1',
        requestKey: 'login-task',
      })
    );
    expect(first).not.toBe(
      resolveMessageTaskCommandId({
        teamName: 'alpha',
        messageId: 'msg-1',
        requestKey: 'api-task',
      })
    );
    expect(first).not.toBe(
      resolveMessageTaskCommandId({
        teamName: 'alpha',
        messageId: 'msg-2',
        requestKey: 'login-task',
      })
    );
  });

  it('reconciles an existing command task and rejects payload reuse', () => {
    const commandId = '11111111-1111-4111-8111-111111111111';
    const createTask = vi.fn(() => {
      throw new Error(`Task already exists: ${commandId}`);
    });
    const reconcileTaskCreation = vi.fn(() => ({ id: commandId }));
    const taskBoard = { createTask, reconcileTaskCreation };

    expect(
      createTaskWithOptionalIdempotency({
        taskBoard,
        teamName: 'alpha',
        operation: 'task.create',
        payload: { subject: 'Stable task' },
        commandId,
      })
    ).toEqual({ id: commandId });
    expect(reconcileTaskCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: commandId,
        creationCommand: expect.objectContaining({
          commandId,
          payloadHash: expect.stringMatching(/^sha256:/),
        }),
      })
    );

    createTask.mockImplementationOnce(() => {
      throw new Error('Missing subject');
    });
    expect(() =>
      createTaskWithOptionalIdempotency({
        taskBoard,
        teamName: 'alpha',
        operation: 'task.create',
        payload: { subject: '' },
        commandId,
      })
    ).toThrow('Missing subject');
  });
});
