import {
  type ConfirmedCreateTask,
  createCreateTaskInteractionController,
  type CreateTaskAvailability,
  type CreateTaskEnvelope,
  type CreateTaskInteractionController,
  type CreateTaskScope,
  type ExecuteCreateTaskOutcome,
  type ObserveCreateTaskOutcome,
} from '@features/team-task-board';

import type { CreateTaskRequest, TeamTask } from '@shared/types';

export interface DesktopCreateTaskInteractionDependencies {
  teamName: string;
  createTask(teamName: string, request: CreateTaskRequest): Promise<TeamTask>;
  refreshCreatedTask(teamName: string, taskId: string): Promise<void>;
  readAvailability?(): CreateTaskAvailability;
  /** Exact command lookup only. Missing records must remain unresolved. */
  observeCreate?(envelope: CreateTaskEnvelope): Promise<ObserveCreateTaskOutcome>;
  /** Local presentation effects only; required task/provider effects stay in createTask. */
  onConfirmed?(
    intentId: string,
    request: CreateTaskRequest,
    confirmation: ConfirmedCreateTask
  ): void | Promise<void>;
}

export function createDesktopTaskInteraction(
  scope: CreateTaskScope,
  dependencies: DesktopCreateTaskInteractionDependencies
): CreateTaskInteractionController<CreateTaskRequest> {
  const execute = async (envelope: CreateTaskEnvelope): Promise<ExecuteCreateTaskOutcome> => {
    if (envelope.body.kind !== 'desktop') {
      return { kind: 'uncertain', reason: 'invalid_desktop_envelope' };
    }
    try {
      const task = await dependencies.createTask(envelope.body.teamName, envelope.body.request);
      if (typeof task?.id !== 'string' || task.id.length === 0) {
        return { kind: 'uncertain', reason: 'missing_task_receipt' };
      }
      return {
        kind: 'confirmed',
        intentId: envelope.intentId,
        scope: envelope.scope,
        identity: envelope.identity,
        confirmation: {
          // Desktop returns a task, not a receipt for the optional delivery effects.
          coverage:
            envelope.effects.kind === 'task_write_and_delivery' ? 'task_write' : 'declared_effects',
          reference: { taskId: task.id },
          recordState: 'active',
          replayed: 'unknown',
        },
      };
    } catch {
      // A renderer error cannot prove whether the durable task command was applied.
      return { kind: 'uncertain', reason: 'desktop_create_outcome_unknown' };
    }
  };

  const controller: CreateTaskInteractionController<CreateTaskRequest> =
    createCreateTaskInteractionController<CreateTaskRequest>(scope, {
      readAvailability: () =>
        dependencies.readAvailability?.() ?? { supported: true, available: true },
      prepareCreate: (submittedScope, draft) => {
        const subject = draft.subject.trim();
        // Match the IPC pre-dispatch limits before the controller freezes an intent.
        if (
          !subject ||
          subject.length > 500 ||
          (draft.prompt !== undefined && draft.prompt.length > 5000) ||
          draft.command
        ) {
          throw new TypeError('invalid_desktop_create_draft');
        }
        const commandId = crypto.randomUUID();
        const identity = { commandId, idempotencyKey: commandId };
        const request: CreateTaskRequest & { command: typeof identity } = {
          ...draft,
          subject,
          command: identity,
        };
        const hasDeliveryEffects = Boolean(request.prompt || request.startImmediately);
        return {
          intentId: commandId,
          scope: submittedScope,
          identity,
          body: { kind: 'desktop', teamName: dependencies.teamName, request },
          effects: hasDeliveryEffects
            ? { kind: 'task_write_and_delivery', recovery: 'observation_only' }
            : { kind: 'task_write', recovery: 'exact_replay' },
        };
      },
      executeCreate: execute,
      recoverCreate: execute,
      observeCreate: dependencies.observeCreate,
      refreshCreatedTask: (_scope, reference) =>
        dependencies.refreshCreatedTask(dependencies.teamName, reference.taskId),
      onConfirmed: (intentId, confirmation): void | Promise<void> => {
        const envelope = controller.getSnapshot().envelope;
        if (envelope?.intentId === intentId && envelope.body.kind === 'desktop') {
          return dependencies.onConfirmed?.(intentId, envelope.body.request, confirmation);
        }
      },
    });
  return controller;
}
