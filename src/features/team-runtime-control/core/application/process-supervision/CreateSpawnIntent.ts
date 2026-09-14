import {
  areSpawnIntentBindingsExact,
  areSpawnIntentsExact,
  createSpawnIntent,
  type CreateSpawnIntentValue,
  initializeProcessOwnershipState,
  type ProcessOwnershipState,
  type SpawnIntentState,
  SpawnIntentValidationError,
} from '../../domain/process-supervision';

import {
  classifyBoundedProcessSupervisionFailure,
  isCancellationRequested,
  PROCESS_OWNERSHIP_CAS_RECONCILE_LIMIT,
  type ProcessOwnershipStoreContext,
  type ProcessOwnershipStorePort,
  runBoundedProcessSupervisionEffect,
} from './ports';

import type { ProcessSupervisionFailureReason } from '../../../contracts/processSupervision';

export interface CreateSpawnIntentRequest extends CreateSpawnIntentValue {
  readonly context: ProcessOwnershipStoreContext;
}

export type CreateSpawnIntentOutcome =
  | { readonly status: 'created'; readonly state: SpawnIntentState }
  | { readonly status: 'already_created'; readonly state: ProcessOwnershipState }
  | {
      readonly status: 'rejected';
      readonly reason: Extract<
        ProcessSupervisionFailureReason,
        | 'cancelled'
        | 'timed_out'
        | 'invalid_request'
        | 'argv_digest_mismatch'
        | 'ownership_conflict'
        | 'concurrency_conflict'
        | 'store_unavailable'
      >;
    };

export class CreateSpawnIntent {
  constructor(private readonly store: ProcessOwnershipStorePort) {}

  async execute(request: CreateSpawnIntentRequest): Promise<CreateSpawnIntentOutcome> {
    if (isCancellationRequested(request.context.cancellation)) {
      return { status: 'rejected', reason: 'cancelled' };
    }

    // This recomputation is deliberately first: no store or process effect may precede it.
    let desired: SpawnIntentState;
    try {
      desired = initializeProcessOwnershipState(createSpawnIntent(request));
    } catch (error) {
      return {
        status: 'rejected',
        reason:
          error instanceof SpawnIntentValidationError && error.reason === 'argv-digest-mismatch'
            ? 'argv_digest_mismatch'
            : 'invalid_request',
      };
    }

    for (let attempt = 0; attempt < PROCESS_OWNERSHIP_CAS_RECONCILE_LIMIT; attempt += 1) {
      if (isCancellationRequested(request.context.cancellation)) {
        return { status: 'rejected', reason: 'cancelled' };
      }
      const loaded = await this.load(request, request.context);
      switch (loaded.status) {
        case 'cancelled':
        case 'timed_out':
          return { status: 'rejected', reason: loaded.status };
        case 'unavailable':
          return { status: 'rejected', reason: 'store_unavailable' };
        case 'found':
          if (areSpawnIntentBindingsExact(loaded.state.intent, desired.intent)) {
            return { status: 'already_created', state: loaded.state };
          }
          return { status: 'rejected', reason: 'ownership_conflict' };
        case 'missing': {
          if (isCancellationRequested(request.context.cancellation)) {
            return { status: 'rejected', reason: 'cancelled' };
          }
          const written = await this.compareAndSwap({
            scope: desired.intent.scope,
            expectedRevision: null,
            next: desired,
            context: request.context,
          });
          switch (written.status) {
            case 'cancelled':
            case 'timed_out':
              return { status: 'rejected', reason: written.status };
            case 'applied':
              if (
                written.state.phase !== 'spawn_intent' ||
                written.state.revision !== desired.revision ||
                !areSpawnIntentsExact(written.state.intent, desired.intent)
              ) {
                return { status: 'rejected', reason: 'store_unavailable' };
              }
              return { status: 'created', state: written.state };
            case 'unavailable':
              return { status: 'rejected', reason: 'store_unavailable' };
            case 'conflict':
              break;
          }
          break;
        }
      }
    }
    return { status: 'rejected', reason: 'concurrency_conflict' };
  }

  private async load(request: CreateSpawnIntentValue, context: ProcessOwnershipStoreContext) {
    try {
      return await runBoundedProcessSupervisionEffect(
        'ownership-store-load-intent',
        context.deadline,
        context.clock,
        context.cancellation,
        async () => await this.store.load(request.scope, context)
      );
    } catch (error) {
      const status = classifyBoundedProcessSupervisionFailure(error);
      if (status === 'cancelled') return { status: 'cancelled' as const };
      if (status === 'timed_out') return { status: 'timed_out' as const };
      return { status: 'unavailable' as const };
    }
  }

  private async compareAndSwap(
    request: Parameters<ProcessOwnershipStorePort['compareAndSwap']>[0]
  ) {
    try {
      return await runBoundedProcessSupervisionEffect(
        'ownership-store-cas-intent',
        request.context.deadline,
        request.context.clock,
        request.context.cancellation,
        async () => await this.store.compareAndSwap(request)
      );
    } catch (error) {
      const status = classifyBoundedProcessSupervisionFailure(error);
      if (status === 'cancelled') return { status: 'cancelled' as const };
      if (status === 'timed_out') return { status: 'timed_out' as const };
      return { status: 'unavailable' as const };
    }
  }
}
