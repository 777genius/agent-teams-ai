import { hostedTaskBoardSelfWriteEffects } from './hostedTaskBoardSelfWrite';
import { productTaskWriteTarget } from './productTaskWriteCommitAuthority';

import type { HostedTaskBoardCommittedTarget } from './hostedTaskBoardMutationFileAuthorityTypes';
import type { HostedTaskMutationGrantFence } from './hostedTaskBoardMutationGrantAuthority';
import type { HostedTaskBoardSelfWriteCoordinator } from './hostedTaskBoardSelfWrite';
import type { ProductTaskWriteCommitAuthority } from './productTaskWriteCommitAuthority';
// eslint-disable-next-line no-restricted-imports -- Product composition owns hosted grant fencing.
import type { HostedMutationGrantFence } from '@features/team-message-delivery/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Product composition owns hosted task mutations.
import type {
  HostedTaskBoardAuthorityMutationRequest,
  HostedTaskBoardAuthorityMutationResult,
} from '@features/team-task-board/main/hosted';
import type { QueryContext, TeamId } from '@shared/contracts/hosted';

interface ProductTaskMutationFiles {
  bindGrantFence(context: QueryContext, fence: HostedMutationGrantFence): void;
  admitTaskMutation(
    request: HostedTaskBoardAuthorityMutationRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityMutationResult>;
}

/** Supply only a lock shared with the canonical agent task-file writer. */
export interface ProductTaskWriteSerialization {
  withTaskWrite<T>(teamId: TeamId, work: () => Promise<T>): Promise<T>;
}

/** Request-scoped sink for the file authority's `onCommittedTargets` hook. */
export class ProductTaskCommittedTargets {
  private readonly targets = new WeakMap<QueryContext, HostedTaskBoardCommittedTarget[]>();

  record(context: QueryContext, targets: readonly HostedTaskBoardCommittedTarget[]): void {
    const recorded = this.targets.get(context) ?? [];
    recorded.push(...targets);
    this.targets.set(context, recorded);
  }

  take(context: QueryContext): readonly HostedTaskBoardCommittedTarget[] {
    const recorded = this.targets.get(context) ?? [];
    this.targets.delete(context);
    return recorded;
  }
}

function unavailable(): HostedTaskBoardAuthorityMutationResult {
  return Object.freeze({ kind: 'unavailable' });
}

/**
 * Product is the only hosted task-file writer. Every Core v1 command runs the descriptor-bound
 * file authority under the shared Product lock, bracketed by an external-writer self-write
 * operation so the observer never classifies Product's own postimages as external edits.
 */
export class ProductTaskMutationAuthority {
  constructor(
    private readonly files: ProductTaskMutationFiles,
    private readonly serialization: ProductTaskWriteSerialization,
    private readonly commitAuthority: Pick<ProductTaskWriteCommitAuthority, 'bind'>,
    private readonly selfWrites: HostedTaskBoardSelfWriteCoordinator,
    private readonly committed: ProductTaskCommittedTargets
  ) {}

  bindGrantFence(context: QueryContext, fence: HostedTaskMutationGrantFence): void {
    this.commitAuthority.bind(context, fence);
    this.files.bindGrantFence(context, fence);
  }

  async admitTaskMutation(
    request: HostedTaskBoardAuthorityMutationRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityMutationResult> {
    if (productTaskWriteTarget(request.command) === null) return unavailable();
    const { commandId: operationId, teamId } = request.command;
    let begun = false;
    try {
      // Begin under the lock so a queued writer never holds the observer's task scope.
      const result = await this.serialization.withTaskWrite(teamId, async () => {
        await this.selfWrites.beginTaskSelfWrite(operationId, teamId);
        begun = true;
        return this.files.admitTaskMutation(request, context);
      });
      const published = this.committed.take(context);
      if (published.length === 0) {
        await this.selfWrites.abortTaskSelfWrite(operationId);
      } else {
        await this.selfWrites.completeTaskSelfWrite(
          operationId,
          hostedTaskBoardSelfWriteEffects(published)
        );
      }
      return result;
    } catch {
      // A failed completion after commit is retryable: the durable ledger replays the receipt.
      this.committed.take(context);
      if (begun) await this.selfWrites.abortTaskSelfWrite(operationId).catch(() => undefined);
      return unavailable();
    }
  }
}
