import { HostedProductionOperatorPanel } from '@renderer/hosted/HostedProductionOperatorPanel';

import type { BootId, DeploymentId, TeamId, WorkspaceId } from '@shared/contracts/hosted';

interface HostedOperatorControlProps {
  readonly admitted: boolean;
  readonly teamId: TeamId | null;
  readonly workspaceId: WorkspaceId;
  readonly runtimeIdentity: Readonly<{ deploymentId: DeploymentId; bootId: BootId }> | undefined;
  readonly getCsrfToken: () => string | null;
  readonly refreshSignal: number;
}

export const HostedOperatorControl = ({
  admitted,
  teamId,
  workspaceId,
  runtimeIdentity,
  getCsrfToken,
  refreshSignal,
}: HostedOperatorControlProps): React.JSX.Element | null => {
  if (!admitted || teamId === null || runtimeIdentity === undefined) return null;
  return (
    <HostedProductionOperatorPanel
      key={`${workspaceId}:${teamId}`}
      teamId={teamId}
      workspaceId={workspaceId}
      runtimeIdentity={runtimeIdentity}
      getCsrfToken={getCsrfToken}
      refreshSignal={refreshSignal}
    />
  );
};
