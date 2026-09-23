import { useEffect, useMemo, useRef, useState } from 'react';

import { createHostedDiagnosticsTransport } from '@features/hosted-operations/renderer';
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
const EMPTY_DIAGNOSTIC_REFERENCES = Object.freeze([]);
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
  readonly refreshSignal?: number;
}

export const HostedProductionOperatorPanel = ({
  teamId,
  workspaceId,
  runtimeIdentity,
  getCsrfToken,
  refreshSignal,
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
  }, [teamId, workspaceId, refreshSignal]);

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

  const diagnostics = useMemo(
    () => ({
      bindingKey: `${runtimeIdentity.deploymentId}:${runtimeIdentity.bootId}:${workspaceId}`,
      referenceIds: EMPTY_DIAGNOSTIC_REFERENCES,
      recentServerLogs: true as const,
      heading: 'Server logs',
      transport: createHostedDiagnosticsTransport({
        async post(path, request, context) {
          const csrfToken = getCsrfTokenRef.current();
          if (typeof csrfToken !== 'string' || !/^[A-Za-z0-9_-]{32,512}$/.test(csrfToken)) {
            throw new Error('hosted-diagnostics-auth-unavailable');
          }
          const response = await fetch(path, {
            method: 'POST',
            credentials: 'include',
            cache: 'no-store',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'x-agent-teams-csrf': csrfToken,
            },
            body: JSON.stringify(request),
            signal: context.signal,
          });
          return response.json();
        },
      }),
    }),
    [runtimeIdentity.bootId, runtimeIdentity.deploymentId, workspaceId]
  );

  const controller = useMemo(() => {
    return createHostedOperatorSurfaceController({
      readinessTransport: createHostedReadinessTransport({
        fetch: (input, init) => fetch(input, init),
        expectedDeploymentId: runtimeIdentity.deploymentId,
        expectedBootId: runtimeIdentity.bootId,
      }),
      approvalSlice,
      diagnostics,
    });
  }, [approvalSlice, diagnostics, runtimeIdentity.bootId, runtimeIdentity.deploymentId]);

  useEffect(() => {
    if (refreshSignal !== undefined) void controller.reload(true);
  }, [controller, refreshSignal]);

  return <HostedOperatorWorkspacePanel controller={controller} />;
};
