import { parseDeploymentId, parseMemberId } from '@shared/contracts/hosted';

import { parseProductTaskGrantEvidence } from './hostedTaskBoardMutationGrantAuthority';

import type { HostedTaskBoardProductCommitAuthority } from './hostedTaskBoardMutationGrantAuthority';
import type {
  HostedTaskAssignmentCurrentPin,
  HostedTaskAssignmentCurrentSelector,
} from '@features/internal-storage/contracts';
// eslint-disable-next-line no-restricted-imports -- Product composition owns hosted grant fencing.
import type { HostedMutationGrantFence } from '@features/team-message-delivery/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Product composition owns hosted task mutations.
import type {
  HostedTaskBoardAuthorityMutationRequest,
  HostedTaskBoardAuthorityMutationResult,
  HostedTaskMutationCommand,
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

export interface ProductTaskAssignmentCurrentGateway {
  resolveCurrent(
    input: HostedTaskAssignmentCurrentSelector
  ): Promise<HostedTaskAssignmentCurrentPin | null>;
}

/** The Product writer makes one current assignment decision under BEGIN IMMEDIATE. */
export class ProductTaskAssignmentCommitAuthority implements HostedTaskBoardProductCommitAuthority {
  private readonly grants = new WeakMap<
    QueryContext,
    Readonly<{
      grantRevision: string;
      identityChecksum: string;
    }>
  >();

  constructor(
    private readonly current: ProductTaskAssignmentCurrentGateway,
    private readonly deploymentId: string
  ) {
    parseDeploymentId(deploymentId);
  }

  bind(context: QueryContext, fence: HostedMutationGrantFence): void {
    const evidence = parseProductTaskGrantEvidence(fence.ownerEffectFence);
    if (evidence.runPin !== undefined) throw new TypeError('hosted-task-assignment-grant-invalid');
    this.grants.set(
      context,
      Object.freeze({
        grantRevision: evidence.grantRevision,
        identityChecksum: evidence.identityChecksum,
      })
    );
  }

  async assertCurrent(
    command: HostedTaskMutationCommand,
    context: QueryContext
  ): Promise<HostedTaskAssignmentCurrentPin> {
    const grant = this.grants.get(context);
    if (
      context.signal.aborted ||
      !grant ||
      command.kind !== 'update_owner' ||
      command.ownerId === null
    )
      throw new Error('hosted-task-assignment-unavailable');
    const pin = await this.current.resolveCurrent({
      deploymentId: parseDeploymentId(this.deploymentId),
      teamId: command.teamId,
      ownerId: parseMemberId(command.ownerId),
      grantRevision: grant.grantRevision,
      identityChecksum: grant.identityChecksum,
    });
    if (context.signal.aborted || !pin)
      throw new Error('hosted-task-assignment-current-authority-stale');
    return pin;
  }
}

/** Inactive composition seam. No production route constructs it until shared serialization exists. */
export class ProductHumanTaskAssignmentAuthority {
  constructor(
    private readonly files: ProductAssignmentFiles,
    private readonly serialization: ProductTaskWriteSerialization,
    private readonly commitAuthority: ProductTaskAssignmentCommitAuthority
  ) {}

  bindGrantFence(context: QueryContext, fence: HostedMutationGrantFence): void {
    this.commitAuthority.bind(context, fence);
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
