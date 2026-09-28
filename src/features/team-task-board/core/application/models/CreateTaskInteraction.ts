import type { HostedTaskMutationCommand } from '../../../contracts/hosted';
import type { CreateTaskRequest } from './TeamTaskBoardPortModels';

export interface CreateTaskScope {
  /** Stable workspace/team identity, never a component or transport identity. */
  readonly key: string;
  readonly authorityEpoch: string;
}

export interface CreateTaskIdentity {
  readonly commandId: string;
  readonly idempotencyKey: string;
}

export type HostedCreateTaskCommand = Extract<
  HostedTaskMutationCommand,
  { readonly kind: 'create_task' }
>;

export type CreateTaskBody =
  | {
      readonly kind: 'desktop';
      readonly teamName: string;
      readonly request: CreateTaskRequest & { readonly command: CreateTaskIdentity };
    }
  | {
      readonly kind: 'hosted';
      readonly command: HostedCreateTaskCommand;
    };

export type CreateTaskEffects =
  | { readonly kind: 'task_write'; readonly recovery: 'exact_replay' | 'observation_only' }
  | {
      readonly kind: 'task_write_and_delivery';
      readonly recovery: 'exact_replay' | 'observation_only';
    };

export interface CreateTaskEnvelope {
  readonly intentId: string;
  readonly scope: CreateTaskScope;
  readonly identity: CreateTaskIdentity;
  readonly body: CreateTaskBody;
  readonly effects: CreateTaskEffects;
}

export interface CreatedTaskReference {
  readonly taskId: string;
}

export type CreateTaskCoverage = 'task_write' | 'declared_effects';

export interface ConfirmedCreateTask {
  readonly origin: 'mutation_receipt' | 'observed_task_record';
  readonly coverage: CreateTaskCoverage;
  readonly reference: CreatedTaskReference;
  readonly recordState: 'active' | 'deleted' | 'unknown';
  readonly replayed: 'yes' | 'no' | 'unknown';
}

export type CreateTaskPhase =
  | 'idle'
  | 'preparing'
  | 'submitting'
  | 'uncertain'
  | 'confirmed'
  | 'not_applied'
  | 'conflict'
  | 'dismissed_unconfirmed'
  | 'disposed';

export type ReadFreshness = 'unknown' | 'refreshing' | 'fresh' | 'failed';

export interface CreateTaskAvailability {
  readonly supported: boolean;
  readonly available: boolean;
}

export interface CreateTaskInteractionSnapshot {
  readonly phase: CreateTaskPhase;
  readonly scope: CreateTaskScope;
  readonly availability: CreateTaskAvailability;
  readonly freshness: ReadFreshness;
  readonly envelope: CreateTaskEnvelope | null;
  readonly confirmed: ConfirmedCreateTask | null;
  readonly recovery: 'none' | 'exact_replay' | 'observe' | 'operator_required';
  readonly reason: string | null;
}
