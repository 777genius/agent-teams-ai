import { useCallback } from 'react';

import { HostedDashboardRecent } from './HostedDashboardRecent';

import type { createHostedDashboardTransport } from './hostedDashboardTransport';
import type { HostedRecentProjectDto } from '@features/recent-projects/contracts';
import type { OpenResult } from '@features/recent-projects/renderer/hosted';
import type { HostedWorkspaceDto } from '@features/workspace-registry/contracts';
import type { BootId, DeploymentId, WorkspaceId } from '@shared/contracts/hosted';

interface Input {
  readonly runtimeIdentity: Readonly<{ deploymentId: DeploymentId; bootId: BootId }> | undefined;
  readonly workspaces: readonly HostedWorkspaceDto[];
  readonly transport: ReturnType<typeof createHostedDashboardTransport>;
  readonly authAvailable: boolean;
  readonly isActive: boolean;
  readonly onAuthFailure: () => void;
  readonly onOpenWorkspace: (
    workspaceId: WorkspaceId,
    expected?: HostedRecentProjectDto
  ) => Promise<OpenResult>;
  readonly onShowChooser: () => void;
  readonly registerRefresh: (refresh: () => void) => void;
  readonly openHistory: Map<WorkspaceId, number>;
}

export function useHostedRecentProjectsConnector({
  runtimeIdentity,
  workspaces,
  transport,
  authAvailable,
  isActive,
  onAuthFailure,
  onOpenWorkspace,
  onShowChooser,
  registerRefresh,
  openHistory,
}: Input): React.ComponentType<{ searchQuery: string }> {
  return useCallback(
    ({ searchQuery }: { searchQuery: string }) => (
      <HostedDashboardRecent
        runtimeIdentity={runtimeIdentity}
        workspaces={workspaces}
        transport={transport}
        authAvailable={authAvailable}
        isActive={isActive}
        onAuthFailure={onAuthFailure}
        onOpenWorkspace={onOpenWorkspace}
        onShowChooser={onShowChooser}
        registerRefresh={registerRefresh}
        openHistory={openHistory}
        searchQuery={searchQuery}
      />
    ),
    [
      runtimeIdentity,
      workspaces,
      transport,
      authAvailable,
      isActive,
      onAuthFailure,
      onOpenWorkspace,
      onShowChooser,
      registerRefresh,
      openHistory,
    ]
  );
}
