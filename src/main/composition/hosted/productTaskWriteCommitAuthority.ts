import {
  parseActorId,
  parseDeploymentId,
  parseMemberId,
  parseWorkspaceId,
  type QueryContext,
} from '@shared/contracts/hosted';

import {
  type OrchestratorLifecycleOwnerBinding,
  sameOrchestratorLifecycleOwnerBinding,
} from './hostedLifecycleOrchestratorReadiness';
import { parseProductTaskGrantEvidence } from './hostedTaskBoardMutationGrantAuthority';

import type {
  HostedTaskBoardProductCommitAuthority,
  HostedTaskMutationGrantFence,
  ProductTaskRunPin,
} from './hostedTaskBoardMutationGrantAuthority';
import type {
  HostedLifecycleAuthorityEpoch,
  HostedTaskAssignmentCurrentPin,
  HostedTaskAssignmentCurrentRequester,
  HostedTaskAssignmentCurrentSelector,
  HostedTaskAssignmentCurrentTarget,
} from '@features/internal-storage/contracts';
// eslint-disable-next-line no-restricted-imports -- Product composition owns hosted task mutations.
import type { HostedTaskMutationCommand } from '@features/team-task-board/main/hosted';

export interface ProductTaskAssignmentCurrentGateway {
  resolveCurrent(
    input: HostedTaskAssignmentCurrentSelector
  ): Promise<HostedTaskAssignmentCurrentPin | null>;
}

export interface ProductTaskWriteCommitAuthorityDependencies {
  /** Lazy: the promotion storage worker is admitted after routes are composed. */
  readonly current: () => ProductTaskAssignmentCurrentGateway | null;
  readonly deploymentId: string;
  readonly bootId: HostedLifecycleAuthorityEpoch['bootId'];
  /** Launcher-signed Owner binding: the same epoch lifecycle retirement tombstones on loss. */
  readonly expectedOwner: OrchestratorLifecycleOwnerBinding;
  readonly currentOwner: () => OrchestratorLifecycleOwnerBinding | null;
  readonly restoreGeneration: number;
  readonly mountGeneration: number;
}

type BoundRequest = Readonly<{
  identityChecksum: string;
  requester: HostedTaskAssignmentCurrentRequester;
}>;

/** Core v1 kinds only. `update_relationship` is not admitted before any Product decision. */
export function productTaskWriteTarget(
  command: HostedTaskMutationCommand
): HostedTaskAssignmentCurrentTarget | null {
  switch (command.kind) {
    case 'update_details':
    case 'update_status':
    case 'move_task':
    case 'reorder_column':
      return Object.freeze({ kind: 'none' });
    case 'create_task':
    case 'update_owner':
      return command.ownerId === null
        ? Object.freeze({ kind: 'none' })
        : Object.freeze({ kind: 'member', memberId: parseMemberId(command.ownerId) });
    default:
      return null;
  }
}

/** Makes one current Writer/Team/Requester/Member decision under Product's BEGIN IMMEDIATE. */
export class ProductTaskWriteCommitAuthority implements HostedTaskBoardProductCommitAuthority {
  private readonly requests = new WeakMap<QueryContext, BoundRequest>();
  private readonly writerEpoch: HostedLifecycleAuthorityEpoch;

  constructor(private readonly deps: ProductTaskWriteCommitAuthorityDependencies) {
    this.writerEpoch = Object.freeze({
      deploymentId: parseDeploymentId(deps.deploymentId),
      bootId: deps.bootId,
      ownerAuthority: deps.expectedOwner.ownerAuthority,
      ownerGeneration: deps.expectedOwner.ownerGeneration,
      ownerSessionId: deps.expectedOwner.ownerSessionId,
      restoreGeneration: deps.restoreGeneration,
      mountGeneration: deps.mountGeneration,
    });
  }

  bind(context: QueryContext, fence: HostedTaskMutationGrantFence): void {
    const evidence = parseProductTaskGrantEvidence(fence.ownerEffectFence);
    const requester = fence.requester;
    if (evidence.runPin !== undefined || requester === undefined) {
      throw new TypeError('hosted-task-write-grant-invalid');
    }
    this.requests.set(
      context,
      Object.freeze({
        identityChecksum: evidence.identityChecksum,
        requester: Object.freeze({
          workspaceId: parseWorkspaceId(requester.publicWorkspaceId),
          actorId: parseActorId(context.actorId),
          userId: requester.userId,
          sessionId: requester.sessionId,
          grantRevision: evidence.grantRevision,
          // Grant generations are restore-scoped, matching lifecycle authority evidence.
          grantGeneration: this.deps.restoreGeneration,
        }),
      })
    );
  }

  async assertCurrent(
    command: HostedTaskMutationCommand,
    context: QueryContext
  ): Promise<ProductTaskRunPin> {
    const bound = this.requests.get(context);
    const target = productTaskWriteTarget(command);
    const gateway = this.deps.current();
    if (context.signal.aborted || !bound || !target || !gateway) {
      throw new Error('hosted-task-write-unavailable');
    }
    const live = this.deps.currentOwner();
    if (live !== null && !sameOrchestratorLifecycleOwnerBinding(live, this.deps.expectedOwner)) {
      throw new Error('hosted-task-write-current-authority-stale');
    }
    const pin = await gateway.resolveCurrent({
      deploymentId: this.writerEpoch.deploymentId,
      teamId: command.teamId,
      writerEpoch: this.writerEpoch,
      requester: bound.requester,
      identityChecksum: bound.identityChecksum,
      target,
    });
    if (context.signal.aborted || !pin) {
      throw new Error('hosted-task-write-current-authority-stale');
    }
    return Object.freeze({ ...pin });
  }
}
