import type { HostedTeamConfigurationIdentity } from '../../../contracts/hosted';
import type { HostedDraftPublicationLookup, HostedDraftPublicationStatus } from '../../../contracts/hostedDraftPublication';
import type { ActorId, DeploymentId, QueryContext, TeamId, WorkspaceId } from '@shared/contracts/hosted';

/** Current grant/mount authority stays separate from the stable identity binding. */
export interface HostedDraftWorkspaceFence {
  readonly runtimeWorkspaceId: WorkspaceId;
  readonly bindingGeneration: number;
  assertCurrent(): Promise<void>;
}
export interface HostedDraftPublicationBinding {
  readonly actorId: ActorId;
  readonly deploymentId: DeploymentId;
  readonly runtimeWorkspaceId: WorkspaceId;
  readonly bindingGeneration: number;
}
export interface HostedDraftPublicationCapture {
  readonly binding: HostedDraftPublicationBinding;
  readonly workspaceId: WorkspaceId;
  readonly context: QueryContext;
  assertCurrent(): Promise<void>;
}
export interface HostedDraftPublicationPort {
  capture(workspaceId: WorkspaceId, context: QueryContext): Promise<HostedDraftPublicationCapture>;
  settle(identity: HostedTeamConfigurationIdentity, context: QueryContext, captured?: HostedDraftPublicationCapture): Promise<HostedDraftPublicationStatus | null>;
  lookup(request: HostedDraftPublicationLookup, context: QueryContext, recover: boolean): Promise<{
    readonly teamId: TeamId; readonly publication: HostedDraftPublicationStatus;
  } | null>;
}
