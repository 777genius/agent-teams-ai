import {
  HOSTED_TASK_BOARD_SCHEMA_VERSION,
  type HostedTaskBoardItem,
  type HostedTaskBoardSourceGeneration,
  type HostedTaskCreationCommand,
  parseHostedTaskCommandId,
  parseHostedTaskIdempotencyKey,
} from '../../contracts/hosted';
import { createCreateTaskInteractionController } from '../../core/application/CreateTaskInteractionController';
import { hostedMutationNonce } from '../utils/hostedTaskMutationIdentity';

import { HostedNonCreatePendingHandle } from './HostedNonCreatePendingHandle';

import type {
  CreateTaskEnvelope,
  CreateTaskScope,
} from '../../core/application/models/CreateTaskInteraction';
import type { ExecuteCreateTaskOutcome } from '../../core/application/ports/CreateTaskInteractionPorts';
import type { HostedTaskBoardTransport } from '../ports/HostedTaskBoardRendererPorts';
import type { Revision, TeamId } from '@shared/contracts/hosted';

export interface HostedCreateTaskDraft {
  readonly subject: string;
}

export interface HostedCreateTaskBasis {
  readonly sourceGeneration: HostedTaskBoardSourceGeneration;
  readonly revision: Revision;
  readonly items: readonly HostedTaskBoardItem[];
}

export interface HostedCreateTaskView {
  readonly transport: HostedTaskBoardTransport;
  readonly getBasis: () => HostedCreateTaskBasis | null;
  readonly refresh: () => Promise<void>;
}

/** Owned above the keyed workspace; a remounted page binds a new view to the same intent. */
export interface HostedCreateTaskRegistry {
  getOrCreate(
    scope: CreateTaskScope,
    create: () => HostedCreateTaskSession
  ): HostedCreateTaskSession;
}

function hostedCommand(envelope: CreateTaskEnvelope): HostedTaskCreationCommand {
  if (envelope.body.kind !== 'hosted') throw new TypeError('hosted-create-envelope-expected');
  return envelope.body.command;
}

export class HostedCreateTaskSession {
  private view: HostedCreateTaskView | null = null;
  private observationFence = 0;
  readonly nonCreate = new HostedNonCreatePendingHandle();
  readonly controller;

  constructor(
    readonly scope: CreateTaskScope,
    private readonly teamId: TeamId
  ) {
    this.controller = createCreateTaskInteractionController<HostedCreateTaskDraft>(scope, {
      readAvailability: () => this.availability(),
      prepareCreate: (currentScope, draft) => {
        const basis = this.view?.getBasis();
        if (!basis) throw new TypeError('hosted-create-basis-unavailable');
        const subject = draft.subject.trim();
        if (!subject || subject.length > 200) throw new TypeError('hosted-create-subject-invalid');
        const id = hostedMutationNonce();
        const command: HostedTaskCreationCommand = Object.freeze({
          schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
          commandId: parseHostedTaskCommandId(`command_${id}`),
          idempotencyKey: parseHostedTaskIdempotencyKey(`mutation_${id}`),
          teamId: this.teamId,
          expectedSourceGeneration: basis.sourceGeneration,
          expectedRevision: basis.revision,
          kind: 'create_task',
          subject,
          description: null,
          status: 'pending',
          ownerId: null,
          column: 'todo',
          order: Math.min(
            1_000_000,
            basis.items
              .filter((item) => item.column === 'todo')
              .reduce((highest, item) => Math.max(highest, item.order), -1) + 1
          ),
        });
        return Object.freeze({
          intentId: id,
          scope: currentScope,
          identity: Object.freeze({
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
          }),
          body: Object.freeze({ kind: 'hosted' as const, command }),
          effects: Object.freeze({
            kind: 'task_write' as const,
            recovery: 'exact_replay' as const,
          }),
        });
      },
      executeCreate: (envelope) => this.execute(envelope),
      recoverCreate: (envelope) => this.execute(envelope),
      observeCreate: async (envelope) => {
        const boundView = this.view;
        const observation = boundView?.transport.observeCreation;
        if (!observation) return Object.freeze({ kind: 'deferred' as const });
        const fence = this.observationFence;
        let result: Awaited<ReturnType<typeof observation>>;
        try {
          result = await observation.call(boundView.transport, hostedCommand(envelope));
        } catch {
          return Object.freeze({ kind: 'deferred' as const });
        }
        if (!this.observationAdmitted(fence) || result.kind === 'unavailable') {
          return Object.freeze({ kind: 'deferred' as const });
        }
        return result.kind === 'confirmed_task_write'
          ? Object.freeze({ kind: result.kind, taskId: result.taskId, state: result.state })
          : Object.freeze({ kind: 'unresolved' as const });
      },
      refreshCreatedTask: async () => {
        if (!this.view) throw new Error('hosted-create-view-unmounted');
        await this.view.refresh();
      },
    });
  }

  bind(view: HostedCreateTaskView): () => void {
    if (view.transport.observeCreation === undefined) this.observationFence += 1;
    this.view = view;
    this.controller.setAvailability(this.scope, this.availability());
    return () => {
      if (this.view !== view) return;
      this.view = null;
      this.controller.setAvailability(this.scope, this.availability());
    };
  }

  dispose(): void {
    this.observationFence += 1;
    this.view = null;
    this.controller.dispose();
    this.nonCreate.dismiss();
  }

  private observationAdmitted(fence: number): boolean {
    return this.observationFence === fence && this.view?.transport.observeCreation !== undefined;
  }

  private availability() {
    return Object.freeze({
      supported: true,
      available: this.view !== null && typeof this.view.transport.executeMutation === 'function',
    });
  }

  private async execute(envelope: CreateTaskEnvelope): Promise<ExecuteCreateTaskOutcome> {
    const mutation = this.view?.transport.executeMutation;
    if (!mutation || !this.view)
      return Object.freeze({ kind: 'uncertain', reason: 'create_transport_unavailable' });
    const result = await mutation.call(this.view.transport, hostedCommand(envelope));
    if (result.kind === 'committed' || result.kind === 'idempotent_replay') {
      const taskId = result.receipt.affectedTaskIds[0];
      if (
        result.receipt.affectedTaskIds.length !== 1 ||
        !taskId ||
        result.receipt.commandId !== envelope.identity.commandId ||
        result.receipt.teamId !== this.teamId ||
        result.receipt.sourceGeneration !== hostedCommand(envelope).expectedSourceGeneration
      )
        return Object.freeze({ kind: 'uncertain', reason: 'create_receipt_mismatch' });
      return Object.freeze({
        kind: 'confirmed',
        intentId: envelope.intentId,
        scope: envelope.scope,
        identity: envelope.identity,
        confirmation: Object.freeze({
          coverage: 'declared_effects',
          reference: Object.freeze({ taskId }),
          recordState: 'active',
          replayed: result.kind === 'idempotent_replay' ? 'yes' : 'no',
        }),
      });
    }
    if (result.kind === 'stale_generation' || result.kind === 'stale_revision') {
      return Object.freeze({ kind: 'conflict', reason: result.kind });
    }
    if (result.kind === 'conflict' && result.reason !== 'idempotency_mismatch') {
      return Object.freeze({ kind: 'conflict', reason: result.reason });
    }
    if (
      result.kind === 'invalid_request' ||
      (result.kind === 'unavailable' && result.dispatchKnowledge === 'not_dispatched')
    ) {
      return Object.freeze({ kind: 'not_applied', reason: result.kind });
    }
    return Object.freeze({ kind: 'uncertain', reason: result.kind });
  }
}
