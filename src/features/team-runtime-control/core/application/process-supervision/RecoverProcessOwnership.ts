import {
  isExactProcessOwnershipScope,
  type ProcessOwnershipScope,
  type ProcessSupervisionFailureReason,
} from '../../../contracts/processSupervision';
import {
  areOwnershipStatesEquivalent,
  markProcessOwnershipUnclassified,
  type ProcessOwnershipState,
} from '../../domain/process-supervision';

import {
  classifyBoundedProcessSupervisionFailure,
  createFailClosedPersistenceContext,
  createProcessSupervisionDeadline,
  isCancellationRequested,
  type MonotonicClockPort,
  type OwnedProcessControlPort,
  PROCESS_OWNERSHIP_CAS_RECONCILE_LIMIT,
  type ProcessOwnershipStoreContext,
  type ProcessOwnershipStorePort,
  runBoundedProcessSupervisionEffect,
} from './ports';

import type { RuntimeCancellation } from '../ports';

export interface RecoverProcessOwnershipRequest extends ProcessOwnershipScope {
  readonly timeoutMs: number;
  readonly cancellation: RuntimeCancellation;
}

export type RecoverProcessOwnershipOutcome =
  | { readonly status: 'not_started' | 'cancelled' }
  | {
      readonly status: 'recovered';
      readonly processRef: ProcessOwnershipState['intent']['processRef'];
    }
  | { readonly status: 'operator_required' }
  | {
      readonly status: 'rejected';
      readonly reason: Extract<
        ProcessSupervisionFailureReason,
        'timed_out' | 'concurrency_conflict' | 'store_unavailable'
      >;
    };

export class RecoverProcessOwnership {
  constructor(
    private readonly store: ProcessOwnershipStorePort,
    private readonly control: OwnedProcessControlPort,
    private readonly clock: MonotonicClockPort
  ) {}

  async execute(request: RecoverProcessOwnershipRequest): Promise<RecoverProcessOwnershipOutcome> {
    if (isCancellationRequested(request.cancellation)) return { status: 'cancelled' };
    const context = {
      deadline: createProcessSupervisionDeadline(this.clock, request.timeoutMs),
      clock: this.clock,
      cancellation: request.cancellation,
    };
    const loaded = await this.load(request, context);
    switch (loaded.status) {
      case 'cancelled':
        return { status: 'cancelled' };
      case 'timed_out':
        return { status: 'rejected', reason: 'timed_out' };
      case 'unavailable':
        return { status: 'rejected', reason: 'store_unavailable' };
      case 'missing':
        return { status: 'not_started' };
      case 'found':
        if (isCancellationRequested(request.cancellation)) return { status: 'cancelled' };
        return await this.reconcileLoaded(request, context, loaded.state);
    }
  }

  async failClosed(
    scope: ProcessOwnershipScope,
    reason: string,
    context: ProcessOwnershipStoreContext,
    forceNewBudget = false
  ): Promise<RecoverProcessOwnershipOutcome> {
    const persistenceContext = createFailClosedPersistenceContext(context, forceNewBudget);
    const loaded = await this.load(scope, persistenceContext);
    if (loaded.status === 'cancelled') return { status: 'cancelled' };
    if (loaded.status === 'timed_out') return { status: 'rejected', reason: 'timed_out' };
    if (loaded.status === 'unavailable') return { status: 'rejected', reason: 'store_unavailable' };
    if (loaded.status === 'missing') return { status: 'not_started' };
    if (loaded.state.phase === 'drained') return { status: 'not_started' };
    if (loaded.state.phase === 'unclassified_residual') return { status: 'operator_required' };
    return await this.persistUnclassified(scope, persistenceContext, loaded.state, reason);
  }

  private async reconcileLoaded(
    request: RecoverProcessOwnershipRequest,
    context: ProcessOwnershipStoreContext,
    state: ProcessOwnershipState
  ): Promise<RecoverProcessOwnershipOutcome> {
    if (!isExactProcessOwnershipScope(state.intent.scope, request)) {
      return { status: 'operator_required' };
    }
    switch (state.phase) {
      case 'drained':
        return { status: 'not_started' };
      case 'unclassified_residual':
        return { status: 'operator_required' };
      case 'spawn_intent':
        return await this.persistUnclassified(request, context, state, 'spawn-effect-ambiguous');
      case 'owned':
      case 'stopping': {
        let inspection;
        try {
          inspection = await runBoundedProcessSupervisionEffect(
            'owned-process-inspection',
            context.deadline,
            context.clock,
            context.cancellation,
            async () => await this.control.inspectLiveChannel(state.ownership, context)
          );
        } catch (error) {
          const failure = classifyBoundedProcessSupervisionFailure(error);
          if (failure === 'cancelled') return { status: 'cancelled' };
          if (failure === 'timed_out') {
            return await this.persistUnclassified(
              request,
              createFailClosedPersistenceContext(context, true),
              state,
              'live-channel-timed-out'
            );
          }
          inspection = { status: 'unavailable' as const };
        }
        if (inspection.status === 'live') {
          if (state.phase === 'stopping') return { status: 'operator_required' };
          return { status: 'recovered', processRef: state.intent.processRef };
        }
        return await this.persistUnclassified(
          request,
          context,
          state,
          `live-channel-${inspection.status}`
        );
      }
    }
  }

  private async persistUnclassified(
    request: ProcessOwnershipScope,
    context: ProcessOwnershipStoreContext,
    initial: ProcessOwnershipState,
    reason: string
  ): Promise<RecoverProcessOwnershipOutcome> {
    let current = initial;
    for (let attempt = 0; attempt < PROCESS_OWNERSHIP_CAS_RECONCILE_LIMIT; attempt += 1) {
      if (!isExactProcessOwnershipScope(current.intent.scope, request)) {
        return { status: 'operator_required' };
      }
      const desired = markProcessOwnershipUnclassified(current, reason);
      const written = await this.compareAndSwap({
        scope: request,
        expectedRevision: current.revision,
        next: desired,
        context,
      });
      switch (written.status) {
        case 'cancelled':
          return { status: 'cancelled' };
        case 'timed_out':
          if (!context.failClosedPersistence) {
            return await this.persistUnclassified(
              request,
              createFailClosedPersistenceContext(context, true),
              current,
              reason
            );
          }
          return { status: 'rejected', reason: 'timed_out' };
        case 'applied': {
          if (!areOwnershipStatesEquivalent(written.state, desired)) {
            return { status: 'rejected', reason: 'store_unavailable' };
          }
          return { status: 'operator_required' };
        }
        case 'unavailable':
          return { status: 'rejected', reason: 'store_unavailable' };
        case 'conflict': {
          const loaded = await this.load(request, context);
          switch (loaded.status) {
            case 'cancelled':
              return { status: 'cancelled' };
            case 'timed_out':
              return { status: 'rejected', reason: 'timed_out' };
            case 'unavailable':
              return { status: 'rejected', reason: 'store_unavailable' };
            case 'missing':
              return { status: 'operator_required' };
            case 'found':
              if (!isExactProcessOwnershipScope(loaded.state.intent.scope, request)) {
                return { status: 'operator_required' };
              }
              if (loaded.state.phase === 'unclassified_residual') {
                return { status: 'operator_required' };
              }
              if (loaded.state.phase === 'drained') return { status: 'not_started' };
              current = loaded.state;
              break;
          }
          break;
        }
      }
    }
    return { status: 'rejected', reason: 'concurrency_conflict' };
  }

  private async load(request: ProcessOwnershipScope, context: ProcessOwnershipStoreContext) {
    try {
      return await runBoundedProcessSupervisionEffect(
        'ownership-store-load-recovery',
        context.deadline,
        context.clock,
        context.cancellation,
        async () => await this.store.load(request, context)
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
        'ownership-store-cas-recovery',
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
