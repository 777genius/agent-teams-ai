import { useEffect, useMemo, useRef, useState } from 'react';

import { createHostedReadinessTransport } from '@features/hosted-readiness/renderer';
import {
  type HostedTeamApprovalIdempotencyKey,
  parseHostedTeamApprovalIdempotencyKey,
} from '@features/team-approvals/contracts';
import {
  createHostedTeamApprovalRendererSlice,
  createHostedTeamApprovalTransport,
} from '@features/team-approvals/renderer';
import { HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION } from '@features/team-lifecycle/contracts';
import { createHostedTeamLifecycleTransport } from '@features/team-lifecycle/renderer';
import { createHostedOperatorSurfaceController } from '@renderer/hosted/createHostedOperatorSurfaceController';
import { HostedOperatorWorkspacePanel } from '@renderer/hosted/HostedOperatorWorkspacePanel';

import type { HostedAuthStatus } from '@features/hosted-access/contracts';
import type { BootId, DeploymentId, RunId, TeamId, WorkspaceId } from '@shared/contracts/hosted';

const CONTROL_STATE_POLL_INTERVAL_MS = 2_000;
const APPROVAL_POLL_INTERVAL_MS = 2_000;
const NOOP_APPROVAL_EVENT_SOURCE = Object.freeze({
  subscribe: (): (() => void) => () => undefined,
});

function createApprovalIdempotencyKey(): HostedTeamApprovalIdempotencyKey {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new TypeError('hosted-team-approval-secure-idempotency-unavailable');
  }
  return parseHostedTeamApprovalIdempotencyKey(`browser:${globalThis.crypto.randomUUID()}`);
}

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
  const getCsrfTokenRef = useRef(getCsrfToken);
  getCsrfTokenRef.current = getCsrfToken;
  const [currentRun, setCurrentRun] = useState<
    Readonly<{ teamId: TeamId; runId: RunId | null }> | undefined
  >();
  const currentRunId = currentRun?.teamId === teamId ? currentRun.runId : null;

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const transport = createHostedTeamLifecycleTransport({
      fetch: (input, init) => fetch(input, init),
      getCsrfToken: () => getCsrfTokenRef.current(),
    });
    const refresh = async (): Promise<void> => {
      const result = await transport.getControlState({
        schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
        workspaceId,
        teamId,
      });
      if (!active) return;
      if (result.kind === 'control_state') {
        setCurrentRun({ teamId, runId: result.runId });
      } else if (result.kind === 'not_found' || result.kind === 'invalid_request') {
        setCurrentRun({ teamId, runId: null });
      }
      timer = globalThis.setTimeout(() => void refresh(), CONTROL_STATE_POLL_INTERVAL_MS);
    };
    void refresh();
    return () => {
      active = false;
      if (timer !== null) globalThis.clearTimeout(timer);
    };
  }, [teamId, workspaceId]);

  const approvalSlice = useMemo(() => {
    if (currentRunId === null) return undefined;
    return createHostedTeamApprovalRendererSlice({
      teamId,
      currentRunId: () => currentRunId,
      transport: createHostedTeamApprovalTransport({
        fetch: (input, init) => fetch(input, init),
        getCsrfToken: () => getCsrfTokenRef.current(),
      }),
      refresh: NOOP_APPROVAL_EVENT_SOURCE,
      reconnect: NOOP_APPROVAL_EVENT_SOURCE,
      idempotencyKeys: { create: createApprovalIdempotencyKey },
      pollIntervalMs: APPROVAL_POLL_INTERVAL_MS,
    });
  }, [currentRunId, teamId]);

  const controller = useMemo(() => {
    return createHostedOperatorSurfaceController({
      readinessTransport: createHostedReadinessTransport({
        fetch: (input, init) => fetch(input, init),
        expectedDeploymentId: runtimeIdentity.deploymentId,
        expectedBootId: runtimeIdentity.bootId,
      }),
      approvalSlice,
    });
  }, [approvalSlice, runtimeIdentity.bootId, runtimeIdentity.deploymentId]);

  return <HostedOperatorWorkspacePanel controller={controller} />;
};
