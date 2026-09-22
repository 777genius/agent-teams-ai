import {
  areOwnershipStatesEquivalent,
  beginOwnedProcessStop,
  completeOwnedProcessStop,
  doesStateMatchStopFence,
  type LiveProcessOwnershipState,
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

import type {
  ProcessStopFence,
  ProcessSupervisionFailureReason,
} from '../../../contracts/processSupervision';
import type { RuntimeCancellation } from '../ports';

export interface StopOwnedProcessRequest extends ProcessStopFence {
  readonly mode: 'graceful' | 'immediate';
  readonly timeoutMs: number;
  readonly cancellation: RuntimeCancellation;
}

export type StopOwnedProcessOutcome =
  | { readonly status: 'drained' | 'already_drained' | 'already_stopping' | 'cancelled' }
  | { readonly status: 'unclassified_residual' }
  | {
      readonly status: 'rejected';
      readonly reason: Extract<
        ProcessSupervisionFailureReason,
        | 'timed_out'
        | 'not_owned'
        | 'ownership_conflict'
        | 'concurrency_conflict'
        | 'store_unavailable'
      >;
    };

export class StopOwnedProcess {
  constructor(
    private readonly store: ProcessOwnershipStorePort,
    private readonly control: OwnedProcessControlPort,
    private readonly clock: MonotonicClockPort
  ) {}

  async execute(request: StopOwnedProcessRequest): Promise<StopOwnedProcessOutcome> {
    if (isCancellationRequested(request.cancellation)) return { status: 'cancelled' };
    const deadline = createProcessSupervisionDeadline(this.clock, request.timeoutMs);
    const context = { deadline, clock: this.clock, cancellation: request.cancellation };
    const acquired = await this.acquireStopMarker(request, context);
    if (acquired.status !== 'acquired') return acquired.outcome;
    if (isCancellationRequested(request.cancellation)) {
      return await this.persistUnclassified(
        request,
        createFailClosedPersistenceContext(context),
        acquired.state,
        'stop-cancelled-after-marker'
      );
    }

    let effect;
    try {
      effect = await runBoundedProcessSupervisionEffect(
        'owned-process-stop-and-drain',
        deadline,
        this.clock,
        request.cancellation,
        async () =>
          await this.control.stopAndDrain({
            fence: request,
            ownership: acquired.state.ownership,
            mode: request.mode,
            deadline,
            cancellation: request.cancellation,
          })
      );
    } catch (error) {
      effect = { status: classifyBoundedProcessSupervisionFailure(error) } as const;
    }

    if (effect.status === 'drained' || effect.status === 'unclassified') {
      return await this.persistStopResult(
        request,
        createFailClosedPersistenceContext(context),
        acquired.state,
        (current) => {
          const transition = completeOwnedProcessStop(current, effect.proof);
          return transition.status === 'accepted'
            ? transition.next
            : markProcessOwnershipUnclassified(current, 'invalid-anchor-drain-proof');
        }
      );
    }

    // Once the durable stop marker exists, cancellation/timeout cannot prove that no signal occurred.
    return await this.persistUnclassified(
      request,
      createFailClosedPersistenceContext(context, effect.status === 'timed_out'),
      acquired.state,
      `stop-effect-${effect.status.replaceAll('_', '-')}`
    );
  }

  private async acquireStopMarker(
    request: StopOwnedProcessRequest,
    context: ProcessOwnershipStoreContext
  ): Promise<
    | {
        readonly status: 'acquired';
        readonly state: LiveProcessOwnershipState & { phase: 'stopping' };
      }
    | { readonly status: 'terminal'; readonly outcome: StopOwnedProcessOutcome }
  > {
    for (let attempt = 0; attempt < PROCESS_OWNERSHIP_CAS_RECONCILE_LIMIT; attempt += 1) {
      if (isCancellationRequested(request.cancellation)) {
        return { status: 'terminal', outcome: { status: 'cancelled' } };
      }
      const loaded = await this.loadByProcessRef(request.processRef, context);
      switch (loaded.status) {
        case 'cancelled':
          return { status: 'terminal', outcome: { status: 'cancelled' } };
        case 'timed_out':
          return {
            status: 'terminal',
            outcome: { status: 'rejected', reason: 'timed_out' },
          };
        case 'unavailable':
          return {
            status: 'terminal',
            outcome: { status: 'rejected', reason: 'store_unavailable' },
          };
        case 'missing':
          return { status: 'terminal', outcome: { status: 'rejected', reason: 'not_owned' } };
        case 'found': {
          const current = loaded.state;
          if (!doesStateMatchStopFence(current, request)) {
            return {
              status: 'terminal',
              outcome: { status: 'rejected', reason: 'ownership_conflict' },
            };
          }
          if (current.phase === 'drained') {
            return { status: 'terminal', outcome: { status: 'already_drained' } };
          }
          if (current.phase === 'unclassified_residual') {
            return { status: 'terminal', outcome: { status: 'unclassified_residual' } };
          }
          if (current.phase === 'stopping') {
            return { status: 'terminal', outcome: { status: 'already_stopping' } };
          }
          const transition = beginOwnedProcessStop(current, request);
          if (transition.status === 'rejected' || transition.next.phase !== 'stopping') {
            return { status: 'terminal', outcome: { status: 'rejected', reason: 'not_owned' } };
          }
          if (isCancellationRequested(request.cancellation)) {
            return { status: 'terminal', outcome: { status: 'cancelled' } };
          }
          const written = await this.compareAndSwap({
            scope: request,
            expectedRevision: current.revision,
            next: transition.next,
            context,
          });
          switch (written.status) {
            case 'cancelled':
              return {
                status: 'terminal',
                outcome: await this.persistUnclassified(
                  request,
                  createFailClosedPersistenceContext(context, true),
                  current,
                  'stop-marker-write-cancelled'
                ),
              };
            case 'timed_out':
              return {
                status: 'terminal',
                outcome: await this.persistUnclassified(
                  request,
                  createFailClosedPersistenceContext(context, true),
                  current,
                  'stop-marker-write-timed-out'
                ),
              };
            case 'applied':
              if (
                written.state.phase !== 'stopping' ||
                !areOwnershipStatesEquivalent(written.state, transition.next)
              ) {
                return {
                  status: 'terminal',
                  outcome: { status: 'rejected', reason: 'store_unavailable' },
                };
              }
              return { status: 'acquired', state: written.state };
            case 'unavailable':
              return {
                status: 'terminal',
                outcome: await this.persistUnclassified(
                  request,
                  createFailClosedPersistenceContext(context),
                  current,
                  'stop-marker-write-unavailable'
                ),
              };
            case 'conflict':
              break;
          }
          break;
        }
      }
    }
    return {
      status: 'terminal',
      outcome: { status: 'rejected', reason: 'concurrency_conflict' },
    };
  }

  private async persistUnclassified(
    request: StopOwnedProcessRequest,
    context: ProcessOwnershipStoreContext,
    state: ProcessOwnershipState,
    reason: string
  ): Promise<StopOwnedProcessOutcome> {
    return await this.persistStopResult(request, context, state, (current) =>
      markProcessOwnershipUnclassified(current, reason)
    );
  }

  private async persistStopResult(
    request: StopOwnedProcessRequest,
    context: ProcessOwnershipStoreContext,
    basis: ProcessOwnershipState,
    derive: (current: ProcessOwnershipState) => ProcessOwnershipState
  ): Promise<StopOwnedProcessOutcome> {
    let expected = basis;
    for (let attempt = 0; attempt < PROCESS_OWNERSHIP_CAS_RECONCILE_LIMIT; attempt += 1) {
      if (!doesStateMatchStopFence(expected, request)) {
        return { status: 'rejected', reason: 'ownership_conflict' };
      }
      if (expected.phase === 'drained') return { status: 'drained' };
      if (expected.phase === 'unclassified_residual') {
        return { status: 'unclassified_residual' };
      }
      const next = derive(expected);
      if (next.phase !== 'drained' && next.phase !== 'unclassified_residual') {
        return { status: 'unclassified_residual' };
      }
      const written = await this.compareAndSwap({
        scope: request,
        expectedRevision: expected.revision,
        next,
        context,
      });
      switch (written.status) {
        case 'cancelled':
          return { status: 'cancelled' };
        case 'timed_out':
          if (!context.failClosedPersistence) {
            return await this.persistStopResult(
              request,
              createFailClosedPersistenceContext(context, true),
              expected,
              derive
            );
          }
          return { status: 'rejected', reason: 'timed_out' };
        case 'applied':
          if (!areOwnershipStatesEquivalent(written.state, next)) {
            return { status: 'rejected', reason: 'store_unavailable' };
          }
          return { status: next.phase === 'drained' ? 'drained' : 'unclassified_residual' };
        case 'unavailable':
          return { status: 'rejected', reason: 'store_unavailable' };
        case 'conflict': {
          const reloaded = await this.loadByProcessRef(request.processRef, context);
          switch (reloaded.status) {
            case 'cancelled':
              return { status: 'cancelled' };
            case 'timed_out':
              return { status: 'rejected', reason: 'timed_out' };
            case 'unavailable':
              return { status: 'rejected', reason: 'store_unavailable' };
            case 'missing':
              return { status: 'rejected', reason: 'not_owned' };
            case 'found':
              if (!doesStateMatchStopFence(reloaded.state, request)) {
                return { status: 'rejected', reason: 'ownership_conflict' };
              }
              if (reloaded.state.phase === 'drained') return { status: 'drained' };
              if (reloaded.state.phase === 'unclassified_residual') {
                return { status: 'unclassified_residual' };
              }
              expected = reloaded.state;
              break;
          }
          break;
        }
      }
    }
    return { status: 'rejected', reason: 'concurrency_conflict' };
  }

  private async loadByProcessRef(
    processRef: StopOwnedProcessRequest['processRef'],
    context: ProcessOwnershipStoreContext
  ) {
    try {
      return await runBoundedProcessSupervisionEffect(
        'ownership-store-load-stop',
        context.deadline,
        context.clock,
        context.cancellation,
        async () => await this.store.loadByProcessRef(processRef, context)
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
        'ownership-store-cas-stop',
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
