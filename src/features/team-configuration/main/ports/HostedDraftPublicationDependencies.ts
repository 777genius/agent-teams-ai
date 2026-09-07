import type { HostedDraftWorkspaceFence } from '../../core/application/hosted-authority/HostedDraftPublicationPort';
import type { TeamDraftPublicationStorageGateway } from '@features/internal-storage/contracts';
import type { HostedDraftPublicationFeature } from '@features/team-lifecycle/main';
import type { QueryContext, WorkspaceId } from '@shared/contracts/hosted';

export interface HostedDraftPublicationDependencies {
  readonly journal: TeamDraftPublicationStorageGateway;
  readonly publisher: HostedDraftPublicationFeature;
  readonly captureWorkspace: (workspaceId: WorkspaceId, context: QueryContext) => Promise<HostedDraftWorkspaceFence>;
  readonly now?: () => number;
}

