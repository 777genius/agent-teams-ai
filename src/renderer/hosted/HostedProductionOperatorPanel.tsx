import { useEffect, useMemo, useState } from 'react';

import { createHostedReadinessTransport } from '@features/hosted-readiness/renderer';
import { HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION } from '@features/team-lifecycle/contracts';
import { createHostedTeamLifecycleTransport } from '@features/team-lifecycle/renderer';
import { createHostedOperatorSurfaceController } from '@renderer/hosted/createHostedOperatorSurfaceController';
import { HostedOperatorWorkspacePanel } from '@renderer/hosted/HostedOperatorWorkspacePanel';

import type { HostedAuthStatus } from '@features/hosted-access/contracts';
import type { BootId, DeploymentId, RunId, TeamId, WorkspaceId } from '@shared/contracts/hosted';

export interface HostedProductionOperatorPanelProps {
  readonly teamId: TeamId;
  readonly workspaceId: WorkspaceId;
  readonly runtimeIdentity: Readonly<{ deploymentId: DeploymentId; bootId: BootId }>;
  readonly getCsrfToken: () => HostedAuthStatus['csrfToken'];
}

export const HostedProductionOperatorPanel = ({
  teamId,
  workspaceId,
  runtimeIdentity,
  getCsrfToken,
}: HostedProductionOperatorPanelProps): React.JSX.Element => {
  const [, setCurrentRunId] = useState<RunId | null>(null);
  useEffect(() => {
    let active = true;
    const transport = createHostedTeamLifecycleTransport({
      fetch: (input, init) => fetch(input, init),
      getCsrfToken,
    });
    const refresh = async (): Promise<void> => {
      const result = await transport.getControlState({
        schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
        workspaceId,
        teamId,
      });
      if (active) setCurrentRunId(result.kind === 'control_state' ? result.runId : null);
    };
    void refresh();
    const timer = globalThis.setInterval(() => void refresh(), 2_000);
    return () => {
      active = false;
      globalThis.clearInterval(timer);
    };
  }, [getCsrfToken, teamId, workspaceId]);
  const controller = useMemo(() => {
    return createHostedOperatorSurfaceController({
      readinessTransport: createHostedReadinessTransport({
        fetch: (input, init) => fetch(input, init),
        expectedDeploymentId: runtimeIdentity.deploymentId,
        expectedBootId: runtimeIdentity.bootId,
      }),
    });
  }, [runtimeIdentity.bootId, runtimeIdentity.deploymentId]);

  return <HostedOperatorWorkspacePanel controller={controller} />;
};
