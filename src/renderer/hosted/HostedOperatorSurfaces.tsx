import {
  HostedDiagnosticsPanel,
  type HostedDiagnosticsPanelProps,
} from '@features/hosted-operations/renderer';
import { HostedReadinessBanner } from '@features/hosted-readiness/renderer';
import {
  HostedTeamApprovalPanel,
  type HostedTeamApprovalRendererSlice,
} from '@features/team-approvals/renderer';

import type {
  HostedReadinessDimension,
  HostedReadinessProjection,
} from '@features/hosted-readiness/contracts';
import type { ReactNode } from 'react';

export interface HostedOperatorSurfacesProps {
  readonly readiness: HostedReadinessProjection;
  readonly approvalSlice?: HostedTeamApprovalRendererSlice;
  readonly diagnostics?: HostedDiagnosticsPanelProps;
  /** Supplied by the member-log hosted renderer facet until production composition is admitted. */
  readonly memberLog?: ReactNode;
}

function dimensionsAvailable(
  projection: HostedReadinessProjection,
  required: readonly HostedReadinessDimension[]
): boolean {
  const dimensions = new Map(
    projection.dimensions.map((dimension) => [dimension.dimension, dimension.status])
  );
  return required.every((dimension) => dimensions.get(dimension) === 'ready');
}

/** Injectable operator UI. Production activation remains owned by a later hosted composition. */
export const HostedOperatorSurfaces = ({
  readiness,
  approvalSlice,
  diagnostics,
  memberLog,
}: HostedOperatorSurfacesProps): React.JSX.Element => {
  const readsAvailable = dimensionsAvailable(readiness, ['serve', 'auth', 'read']);
  const decisionsAvailable = dimensionsAvailable(readiness, ['serve', 'auth', 'mutation']);

  return (
    <div className="space-y-4" data-hosted-operator-surfaces="injectable">
      <HostedReadinessBanner projection={readiness} />
      {readsAvailable ? (
        <>
          {approvalSlice === undefined ? null : (
            <HostedTeamApprovalPanel slice={approvalSlice} decisionsEnabled={decisionsAvailable} />
          )}
          {memberLog ?? null}
          {diagnostics === undefined ? null : <HostedDiagnosticsPanel {...diagnostics} />}
        </>
      ) : (
        <p role="status" className="text-sm text-[var(--color-text-muted)]">
          Hosted operator reads are temporarily unavailable.
        </p>
      )}
    </div>
  );
};
