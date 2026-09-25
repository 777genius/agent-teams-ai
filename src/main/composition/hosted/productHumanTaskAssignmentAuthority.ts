// eslint-disable-next-line no-restricted-imports -- Product composition owns hosted grant fencing.
import type { HostedMutationGrantFence } from '@features/team-message-delivery/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Product composition owns hosted task mutations.
import type {
  HostedTaskBoardAuthorityMutationRequest,
  HostedTaskBoardAuthorityMutationResult,
} from '@features/team-task-board/main/hosted';
import type { QueryContext, TeamId } from '@shared/contracts/hosted';

interface ProductAssignmentFiles {
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

/** Inactive composition seam. No production route constructs it until shared serialization exists. */
export class ProductHumanTaskAssignmentAuthority {
  constructor(
    private readonly files: ProductAssignmentFiles,
    private readonly serialization: ProductTaskWriteSerialization
  ) {}

  bindGrantFence(context: QueryContext, fence: HostedMutationGrantFence): void {
    this.files.bindGrantFence(context, fence);
  }

  async admitTaskMutation(
    request: HostedTaskBoardAuthorityMutationRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityMutationResult> {
    if (request.command.kind !== 'update_owner' || request.command.ownerId === null) {
      return Object.freeze({ kind: 'unavailable' });
    }
    return this.serialization.withTaskWrite(request.command.teamId, () =>
      this.files.admitTaskMutation(request, context)
    );
  }
}
