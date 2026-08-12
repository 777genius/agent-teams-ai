import { useMemo } from 'react';

import { createHostedReadinessTransport } from '@features/hosted-readiness/renderer';
import {
  createHostedTeamApprovalRendererSlice,
  createHostedTeamApprovalTransport,
} from '@features/team-approvals/renderer';
import { createHostedOperatorSurfaceController } from '@renderer/hosted/createHostedOperatorSurfaceController';
import { HostedOperatorWorkspacePanel } from '@renderer/hosted/HostedOperatorWorkspacePanel';

import type { HostedAuthStatus } from '@features/hosted-access/contracts';
import type { BootId, DeploymentId, TeamId } from '@shared/contracts/hosted';

export interface HostedProductionOperatorPanelProps {
  readonly teamId: TeamId;
  readonly runtimeIdentity: Readonly<{ deploymentId: DeploymentId; bootId: BootId }>;
  readonly getCsrfToken: () => HostedAuthStatus['csrfToken'];
}

const noPushSignals = Object.freeze({ subscribe: () => () => undefined });

export const HostedProductionOperatorPanel = ({ teamId, runtimeIdentity, getCsrfToken }: HostedProductionOperatorPanelProps): React.JSX.Element => {
  const controller = useMemo(() => {
    const approvalSlice = createHostedTeamApprovalRendererSlice({
      teamId,
      transport: createHostedTeamApprovalTransport({
        fetch: (input, init) => fetch(input, init),
        getCsrfToken,
      }),
      refresh: noPushSignals,
      reconnect: noPushSignals,
      idempotencyKeys: {
        create: () => globalThis.crypto.randomUUID() as never,
      },
    });
    return createHostedOperatorSurfaceController({
      readinessTransport: createHostedReadinessTransport({
        fetch: (input, init) => fetch(input, init),
        expectedDeploymentId: runtimeIdentity.deploymentId,
        expectedBootId: runtimeIdentity.bootId,
      }),
      approvalSlice,
    });
  }, [getCsrfToken, runtimeIdentity.bootId, runtimeIdentity.deploymentId, teamId]);

  return <HostedOperatorWorkspacePanel controller={controller} />;
};
