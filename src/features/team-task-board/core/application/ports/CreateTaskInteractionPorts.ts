import type {
  ConfirmedCreateTask,
  CreatedTaskReference,
  CreateTaskAvailability,
  CreateTaskEnvelope,
  CreateTaskScope,
} from '../models/CreateTaskInteraction';

/** The adapter may report not_applied/conflict only with proof that the effect boundary was not crossed. */
export type ExecuteCreateTaskOutcome =
  | {
      readonly kind: 'confirmed';
      readonly intentId: string;
      readonly scope: CreateTaskScope;
      readonly identity: CreateTaskEnvelope['identity'];
      readonly confirmation: Omit<ConfirmedCreateTask, 'origin'>;
    }
  | { readonly kind: 'not_applied'; readonly reason: string }
  | { readonly kind: 'conflict'; readonly reason: string }
  | { readonly kind: 'uncertain'; readonly reason: string };

export type ObserveCreateTaskOutcome =
  | {
      readonly kind: 'confirmed_task_write';
      readonly taskId: string;
      readonly state: 'active' | 'deleted';
    }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'deferred' };

export interface CreateTaskInteractionPorts<Draft> {
  readAvailability(scope: CreateTaskScope): CreateTaskAvailability;
  /** Maps and validates once, including identity and the complete declared effect profile. */
  prepareCreate(
    scope: CreateTaskScope,
    draft: Draft
  ): CreateTaskEnvelope | Promise<CreateTaskEnvelope>;
  executeCreate(envelope: CreateTaskEnvelope): Promise<ExecuteCreateTaskOutcome>;
  /** Supply only when the complete declared effect profile is proved replay safe. */
  recoverCreate?(envelope: CreateTaskEnvelope): Promise<ExecuteCreateTaskOutcome>;
  observeCreate?(envelope: CreateTaskEnvelope): Promise<ObserveCreateTaskOutcome>;
  refreshCreatedTask(scope: CreateTaskScope, reference: CreatedTaskReference): Promise<void>;
  /** Best-effort local output. Never performs required task/provider effects. */
  onConfirmed?(intentId: string, confirmation: ConfirmedCreateTask): void | Promise<void>;
}
