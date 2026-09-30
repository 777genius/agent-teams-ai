import type { UserId } from '../../contracts';
import type { HostedWorkspaceGrant } from './identityPorts';

interface HostedWorkspaceGrantRevision {
  readonly runtimeWorkspaceId: string;
  readonly workspaceId: HostedWorkspaceGrant['workspaceId'];
  readonly grantGeneration: number;
  readonly grantRevision: string;
  readonly grantedAt: number;
}

export interface HostedWorkspaceGrantSetFence {
  readonly userId: UserId;
  readonly grants: readonly HostedWorkspaceGrantRevision[];
}

export class HostedWorkspaceGrantSetFenceRegistry {
  private readonly fences = new WeakSet<object>();

  constructor(
    private readonly readGrants: (userId: UserId) => Promise<readonly HostedWorkspaceGrant[]>
  ) {}

  async capture(userId: UserId): Promise<HostedWorkspaceGrantSetFence> {
    const fence = Object.freeze({ userId, grants: await this.readRevisionSet(userId) });
    this.fences.add(fence);
    return fence;
  }

  async revalidate(fence: HostedWorkspaceGrantSetFence): Promise<boolean> {
    if (!this.fences.has(fence)) return false;
    const current = await this.readRevisionSet(fence.userId);
    return (
      current.length === fence.grants.length &&
      current.every((grant, index) => sameRevision(grant, fence.grants[index]))
    );
  }

  private async readRevisionSet(userId: UserId): Promise<readonly HostedWorkspaceGrantRevision[]> {
    const revisions = (await this.readGrants(userId))
      .map((grant) => {
        if (grant.userId !== userId || !/^[0-9a-f]{64}$/u.test(grant.grantRevision)) {
          throw new Error('hosted_workspace_grant_revision_invalid');
        }
        return Object.freeze({
          runtimeWorkspaceId: grant.runtimeWorkspaceId,
          workspaceId: grant.workspaceId,
          grantGeneration: grant.grantGeneration,
          grantRevision: grant.grantRevision,
          grantedAt: grant.grantedAt,
        });
      })
      .sort((left, right) =>
        left.runtimeWorkspaceId === right.runtimeWorkspaceId
          ? left.workspaceId.localeCompare(right.workspaceId)
          : left.runtimeWorkspaceId.localeCompare(right.runtimeWorkspaceId)
      );
    const runtimeWorkspaceIds = new Set<string>();
    const publicWorkspaceIds = new Set<string>();
    for (const revision of revisions) {
      if (
        runtimeWorkspaceIds.has(revision.runtimeWorkspaceId) ||
        publicWorkspaceIds.has(revision.workspaceId)
      ) {
        throw new Error('hosted_workspace_grant_set_ambiguous');
      }
      runtimeWorkspaceIds.add(revision.runtimeWorkspaceId);
      publicWorkspaceIds.add(revision.workspaceId);
    }
    return Object.freeze(revisions);
  }
}

function sameRevision(
  left: HostedWorkspaceGrantRevision,
  right: HostedWorkspaceGrantRevision | undefined
): boolean {
  return (
    right !== undefined &&
    left.runtimeWorkspaceId === right.runtimeWorkspaceId &&
    left.workspaceId === right.workspaceId &&
    left.grantGeneration === right.grantGeneration &&
    left.grantRevision === right.grantRevision &&
    left.grantedAt === right.grantedAt
  );
}
