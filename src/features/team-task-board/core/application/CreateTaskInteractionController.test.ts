import { describe, expect, it, vi } from 'vitest';

import { createCreateTaskInteractionController } from './CreateTaskInteractionController';

import type { CreateTaskEnvelope, CreateTaskScope } from './models/CreateTaskInteraction';
import type {
  CreateTaskInteractionPorts,
  ExecuteCreateTaskOutcome,
} from './ports/CreateTaskInteractionPorts';

const scope: CreateTaskScope = { key: 'workspace/team-a', authorityEpoch: 'epoch-1' };
interface Draft {
  subject: string;
  blockedBy: string[];
}

function envelope(draft: Draft, commandId = 'command-1'): CreateTaskEnvelope {
  const identity = { commandId, idempotencyKey: `key-${commandId}` };
  return {
    intentId: commandId,
    scope,
    identity,
    body: {
      kind: 'desktop',
      teamName: 'team-a',
      request: { ...draft, command: identity },
    },
    effects: { kind: 'task_write', recovery: 'exact_replay' },
  };
}

function confirmed(
  commandId = 'command-1',
  coverage: 'task_write' | 'declared_effects' = 'declared_effects'
): ExecuteCreateTaskOutcome {
  return {
    kind: 'confirmed',
    intentId: commandId,
    scope,
    identity: { commandId, idempotencyKey: `key-${commandId}` },
    confirmation: {
      coverage,
      reference: { taskId: `task-${commandId}` },
      recordState: 'unknown',
      replayed: 'unknown',
    },
  };
}

function ports(
  overrides: Partial<CreateTaskInteractionPorts<Draft>> = {}
): CreateTaskInteractionPorts<Draft> {
  return {
    readAvailability: () => ({ supported: true, available: true }),
    prepareCreate: (_scope, draft) => envelope(draft),
    executeCreate: async () => confirmed(),
    refreshCreatedTask: async () => undefined,
    ...overrides,
  };
}

describe('CreateTaskInteractionController', () => {
  it('gates synchronous double submit and freezes the submitted draft and envelope', async () => {
    let finish!: (outcome: ExecuteCreateTaskOutcome) => void;
    const executeCreate = vi.fn(
      () =>
        new Promise<ExecuteCreateTaskOutcome>((resolve) => {
          finish = resolve;
        })
    );
    const controller = createCreateTaskInteractionController(scope, ports({ executeCreate }));
    const draft = { subject: 'First', blockedBy: ['task-1'] };

    const first = controller.submit(draft);
    const second = controller.submit(draft);
    draft.subject = 'Edited';
    draft.blockedBy.push('task-2');
    await Promise.resolve();

    expect(executeCreate).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().envelope?.body).toMatchObject({
      request: { subject: 'First', blockedBy: ['task-1'] },
    });
    expect(Object.isFrozen(controller.getSnapshot().envelope?.body)).toBe(true);
    const submittedBody = controller.getSnapshot().envelope?.body;
    expect(submittedBody?.kind).toBe('desktop');
    if (submittedBody?.kind !== 'desktop') throw new Error('desktop body missing');
    expect(Object.isFrozen(submittedBody.request.blockedBy)).toBe(true);
    finish(confirmed());
    await Promise.all([first, second]);
  });

  it('keeps a confirmed write after read refresh fails and fires output once for each new intent', async () => {
    let count = 0;
    const onConfirmed = vi.fn();
    const recoverCreate = vi.fn(async () => confirmed());
    const controller = createCreateTaskInteractionController(
      scope,
      ports({
        prepareCreate: (_scope, draft) => envelope(draft, `command-${++count}`),
        executeCreate: async (submitted) => confirmed(submitted.identity.commandId, 'task_write'),
        recoverCreate,
        refreshCreatedTask: async () => {
          throw new Error('read failed');
        },
        onConfirmed,
      })
    );

    await controller.submit({ subject: 'First', blockedBy: [] });
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'confirmed',
      freshness: 'failed',
      confirmed: { coverage: 'task_write' },
    });
    await controller.retryExact();
    expect(recoverCreate).not.toHaveBeenCalled();
    controller.acknowledgeConfirmed();
    await controller.submit({ subject: 'Second', blockedBy: [] });
    expect(onConfirmed.mock.calls.map(([intentId]) => intentId)).toEqual([
      'command-1',
      'command-2',
    ]);
  });

  it('keeps an uncertain intent after rejected exact replay; positive observation proves only task write', async () => {
    const onConfirmed = vi.fn();
    const recoverCreate = vi.fn(
      async () => ({ kind: 'conflict', reason: 'stale_generation' }) as const
    );
    const controller = createCreateTaskInteractionController(
      scope,
      ports({
        executeCreate: async () => ({ kind: 'uncertain', reason: 'lost_ack' }),
        recoverCreate,
        observeCreate: async () => ({
          kind: 'confirmed_task_write',
          taskId: 'task-1',
          state: 'deleted',
        }),
        onConfirmed,
      })
    );

    await controller.submit({ subject: 'First', blockedBy: [] });
    const original = controller.getSnapshot().envelope;
    controller.setAvailability(scope, { supported: true, available: false });
    await controller.retryExact();
    expect(recoverCreate).not.toHaveBeenCalled();
    expect(controller.getSnapshot().envelope).toBe(original);
    controller.setAvailability(scope, { supported: true, available: true });
    await controller.retryExact();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'uncertain',
      reason: 'stale_generation',
    });
    expect(recoverCreate).toHaveBeenCalledWith(original);
    expect(controller.getSnapshot().envelope).toBe(original);
    await controller.observe();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'confirmed',
      confirmed: {
        origin: 'observed_task_record',
        coverage: 'task_write',
        recordState: 'deleted',
      },
    });
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('fences late results after authority disposal and ignores another scope availability', async () => {
    let finish!: (outcome: ExecuteCreateTaskOutcome) => void;
    const onConfirmed = vi.fn();
    const controller = createCreateTaskInteractionController(
      scope,
      ports({
        executeCreate: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        onConfirmed,
      })
    );
    const pending = controller.submit({ subject: 'First', blockedBy: [] });
    await Promise.resolve();
    controller.setAvailability(
      { key: 'workspace/team-b', authorityEpoch: 'epoch-1' },
      {
        supported: false,
        available: false,
      }
    );
    expect(controller.getSnapshot().availability.available).toBe(true);
    controller.dispose();
    finish(confirmed());
    await pending;
    expect(controller.getSnapshot()).toMatchObject({ phase: 'disposed', envelope: null });
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('does not accept a receipt for another scope or make a failed observation mean not applied', async () => {
    const controller = createCreateTaskInteractionController(
      scope,
      ports({
        executeCreate: async () =>
          ({
            ...confirmed(),
            scope: { key: scope.key, authorityEpoch: 'epoch-2' },
          }) as ExecuteCreateTaskOutcome,
        observeCreate: async () => {
          throw new Error('read aborted');
        },
      })
    );

    await controller.submit({ subject: 'First', blockedBy: [] });
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'uncertain',
      reason: 'receipt_identity_mismatch',
    });
    await controller.observe();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'uncertain',
      recovery: 'operator_required',
      reason: 'observation_unavailable',
    });
    expect(controller.getSnapshot().envelope?.identity.commandId).toBe('command-1');
  });

  it.each(['preparing', 'submitting'] as const)(
    'does not dispatch when a subscriber disposes during %s',
    async (phase) => {
      const prepareCreate = vi.fn((_scope: CreateTaskScope, draft: Draft) => envelope(draft));
      const executeCreate = vi.fn(async () => confirmed());
      const controller = createCreateTaskInteractionController(
        scope,
        ports({
          prepareCreate,
          executeCreate,
        })
      );
      controller.subscribe(() => {
        if (controller.getSnapshot().phase === phase) controller.dispose();
      });

      await controller.submit({ subject: 'First', blockedBy: [] });
      expect(controller.getSnapshot().phase).toBe('disposed');
      expect(prepareCreate).toHaveBeenCalledTimes(phase === 'preparing' ? 0 : 1);
      expect(executeCreate).not.toHaveBeenCalled();
    }
  );

  it('does not run post-confirm output when a subscriber disposes on confirmation', async () => {
    const onConfirmed = vi.fn();
    const refreshCreatedTask = vi.fn(async () => undefined);
    const controller = createCreateTaskInteractionController(
      scope,
      ports({
        onConfirmed,
        refreshCreatedTask,
      })
    );
    controller.subscribe(() => {
      if (controller.getSnapshot().phase === 'confirmed') controller.dispose();
    });

    await controller.submit({ subject: 'First', blockedBy: [] });
    expect(controller.getSnapshot().phase).toBe('disposed');
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(refreshCreatedTask).not.toHaveBeenCalled();
  });

  it('does not start read refresh or replay after disposal from those transition notifications', async () => {
    const refreshCreatedTask = vi.fn(async () => undefined);
    const controller = createCreateTaskInteractionController(scope, ports({ refreshCreatedTask }));
    controller.subscribe(() => {
      if (controller.getSnapshot().freshness === 'refreshing') controller.dispose();
    });
    await controller.submit({ subject: 'First', blockedBy: [] });
    expect(refreshCreatedTask).not.toHaveBeenCalled();

    const recoverCreate = vi.fn(async () => confirmed());
    const recoveryController = createCreateTaskInteractionController(
      scope,
      ports({
        executeCreate: async () => ({ kind: 'uncertain', reason: 'lost_ack' }),
        recoverCreate,
      })
    );
    await recoveryController.submit({ subject: 'Second', blockedBy: [] });
    recoveryController.subscribe(() => {
      if (recoveryController.getSnapshot().phase === 'submitting') recoveryController.dispose();
    });
    await recoveryController.retryExact();
    expect(recoverCreate).not.toHaveBeenCalled();
  });
});
