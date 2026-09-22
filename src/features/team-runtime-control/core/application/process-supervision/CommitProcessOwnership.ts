import {
  isExactProcessOwnerAttestation,
  isExactProcessOwnershipScope,
  isExactProcessWorkspaceBinding,
  type ProcessOwnershipScope,
  type ProcessSupervisionFailureReason,
} from '../../../contracts/processSupervision';
import {
  areOwnershipStatesEquivalent,
  commitProcessOwnership,
  type LiveProcessOwnershipState,
  type ProcessOwnershipReadyProof,
  type ProcessOwnershipState,
} from '../../domain/process-supervision';

import {
  classifyBoundedProcessSupervisionFailure,
  isCancellationRequested,
  PROCESS_OWNERSHIP_CAS_RECONCILE_LIMIT,
  type ProcessOwnershipStoreContext,
  type ProcessOwnershipStorePort,
  runBoundedProcessSupervisionEffect,
} from './ports';

export interface CommitProcessOwnershipRequest {
  readonly scope: ProcessOwnershipScope;
  readonly proof: ProcessOwnershipReadyProof;
  readonly context: ProcessOwnershipStoreContext;
}

export type CommitProcessOwnershipOutcome =
  | {
      readonly status: 'committed' | 'already_committed';
      readonly state: LiveProcessOwnershipState;
    }
  | {
      readonly status: 'rejected';
      readonly reason: Extract<
        ProcessSupervisionFailureReason,
        | 'cancelled'
        | 'timed_out'
        | 'not_owned'
        | 'ownership_conflict'
        | 'concurrency_conflict'
        | 'store_unavailable'
      >;
    };

export class CommitProcessOwnership {
  constructor(private readonly store: ProcessOwnershipStorePort) {}

  async execute(request: CommitProcessOwnershipRequest): Promise<CommitProcessOwnershipOutcome> {
    for (let attempt = 0; attempt < PROCESS_OWNERSHIP_CAS_RECONCILE_LIMIT; attempt += 1) {
      if (isCancellationRequested(request.context.cancellation)) {
        return { status: 'rejected', reason: 'cancelled' };
      }
      const loaded = await this.load(request);
      switch (loaded.status) {
        case 'cancelled':
        case 'timed_out':
          return { status: 'rejected', reason: loaded.status };
        case 'unavailable':
          return { status: 'rejected', reason: 'store_unavailable' };
        case 'missing':
          return { status: 'rejected', reason: 'not_owned' };
        case 'found': {
          const current = loaded.state;
          if (current.phase === 'owned' && ownershipMatchesProof(current, request.proof)) {
            return { status: 'already_committed', state: current };
          }
          const transition = commitProcessOwnership(current, request.proof);
          if (transition.status === 'rejected' || transition.next.phase !== 'owned') {
            return { status: 'rejected', reason: 'ownership_conflict' };
          }
          if (isCancellationRequested(request.context.cancellation)) {
            return { status: 'rejected', reason: 'cancelled' };
          }
          const written = await this.compareAndSwap({
            scope: request.scope,
            expectedRevision: current.revision,
            next: transition.next,
            context: request.context,
          });
          switch (written.status) {
            case 'cancelled':
            case 'timed_out':
              return { status: 'rejected', reason: written.status };
            case 'applied':
              if (
                written.state.phase !== 'owned' ||
                !areOwnershipStatesEquivalent(written.state, transition.next)
              ) {
                return { status: 'rejected', reason: 'store_unavailable' };
              }
              return { status: 'committed', state: written.state };
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

  private async load(request: CommitProcessOwnershipRequest) {
    try {
      return await runBoundedProcessSupervisionEffect(
        'ownership-store-load-commit',
        request.context.deadline,
        request.context.clock,
        request.context.cancellation,
        async () => await this.store.load(request.scope, request.context)
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
        'ownership-store-cas-commit',
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

function ownershipMatchesProof(
  state: ProcessOwnershipState & { readonly phase: 'owned' },
  proof: ProcessOwnershipReadyProof
): boolean {
  const ownership = state.ownership;
  return (
    ownership.processRef === proof.processRef &&
    isExactProcessOwnershipScope(ownership.scope, proof.scope) &&
    isExactProcessWorkspaceBinding(ownership.workspaceBinding, proof.workspaceBinding) &&
    ownership.spawnNonceDigest === proof.spawnNonceDigest &&
    ownership.controllerInstanceId === proof.controllerInstanceId &&
    isExactProcessOwnerAttestation(ownership.ownerAttestation, proof.ownerAttestation) &&
    ownership.mainProcessIdentityRef === proof.mainProcessIdentityRef &&
    ownership.lastStatusSequence === proof.statusSequence
  );
}
