import { useEffect, useSyncExternalStore } from 'react';

// eslint-disable-next-line no-restricted-imports -- Hosted browser composition requires the bounded browser-safe facet.
import { HostedMemberLogPanel } from '@features/member-log-stream/renderer/hosted';
import { Button } from '@renderer/components/ui/button';
import { HostedOperatorSurfaces } from '@renderer/hosted/HostedOperatorSurfaces';

import type { HostedOperatorSurfaceController } from './createHostedOperatorSurfaceController';

export interface HostedOperatorWorkspacePanelProps {
  readonly controller: HostedOperatorSurfaceController;
}

/** Browser-only composition panel; all feature behavior remains behind injected public ports. */
export const HostedOperatorWorkspacePanel = ({
  controller,
}: HostedOperatorWorkspacePanelProps): React.JSX.Element => {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );

  useEffect(() => controller.mount(), [controller]);

  if (snapshot.status === 'idle' || snapshot.status === 'loading') {
    return (
      <section className="p-4" aria-label="Hosted operator workspace">
        <p role="status" className="text-sm text-[var(--color-text-muted)]">
          Loading hosted operator workspace…
        </p>
      </section>
    );
  }

  if (snapshot.status === 'error' || snapshot.readiness === null) {
    return (
      <section className="space-y-3 p-4" aria-label="Hosted operator workspace">
        <p role="alert" className="text-sm text-red-500">
          {snapshot.error ?? 'Hosted operator readiness is temporarily unavailable.'}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void controller.reload()}>
          Retry readiness
        </Button>
      </section>
    );
  }

  const memberLog = snapshot.bindings.memberLog;
  return (
    <section className="p-4" aria-label="Hosted operator workspace">
      <HostedOperatorSurfaces
        readiness={snapshot.readiness}
        approvalSlice={snapshot.bindings.approvalSlice}
        diagnostics={snapshot.bindings.diagnostics}
        memberLog={
          memberLog === undefined ? undefined : (
            <HostedMemberLogPanel
              selectionId={memberLog.selectionId}
              transport={memberLog.transport}
              heading={memberLog.heading}
            />
          )
        }
      />
    </section>
  );
};
