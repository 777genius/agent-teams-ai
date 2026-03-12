import { useRef, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { getCurrentProvisioningProgressForTeam } from '@renderer/store/slices/teamSlice';
import { CheckCircle2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { ProvisioningProgressBlock } from './ProvisioningProgressBlock';
import { STEP_ORDER } from './provisioningSteps';

import type { ProvisioningStep } from './provisioningSteps';
interface TeamProvisioningBannerProps {
  teamName: string;
}

export const TeamProvisioningBanner = ({
  teamName,
}: TeamProvisioningBannerProps): React.JSX.Element | null => {
  const { progress, cancelProvisioning, teamMembers } = useStore(
    useShallow((s) => ({
      progress: getCurrentProvisioningProgressForTeam(s, teamName),
      cancelProvisioning: s.cancelProvisioning,
      teamMembers: s.selectedTeamData?.members,
    }))
  );
  const [dismissed, setDismissed] = useState(false);
  const prevRunIdRef = useRef(progress?.runId);

  if (prevRunIdRef.current !== progress?.runId) {
    prevRunIdRef.current = progress?.runId;
    setDismissed(false);
  }

  // NOTE: we intentionally do NOT auto-dismiss "ready" banners.
  // Users frequently need to inspect launch output after fast stop→start cycles,
  // and auto-dismiss can make it look like no progress/logs were produced.

  if (!progress || dismissed) {
    return null;
  }

  if (progress.state === 'cancelled' || progress.state === 'disconnected') {
    return null;
  }

  const isReady = progress.state === 'ready';
  const isFailed = progress.state === 'failed';
  const isActive =
    progress.state === 'validating' ||
    progress.state === 'spawning' ||
    progress.state === 'monitoring' ||
    progress.state === 'verifying';

  const canCancel =
    progress.state === 'spawning' ||
    progress.state === 'monitoring' ||
    progress.state === 'verifying';

  const progressStepIndex = STEP_ORDER.indexOf(progress.state as ProvisioningStep);

  if (isFailed) {
    return (
      <div className="mb-3">
        <div className="mb-2 flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2">
          <p className="flex-1 text-xs text-[var(--step-error-text)]">{progress.message}</p>
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 border-red-500/40 px-2 text-xs text-[var(--step-error-text)] hover:bg-red-500/10"
            onClick={() => setDismissed(true)}
          >
            <X size={12} />
          </Button>
        </div>
        <ProvisioningProgressBlock
          key={progress.runId}
          title="Launch failed"
          message={progress.error ?? null}
          tone="error"
          currentStepIndex={progressStepIndex >= 0 ? progressStepIndex : -1}
          startedAt={progress.startedAt}
          pid={progress.pid}
          cliLogsTail={progress.cliLogsTail}
          assistantOutput={progress.assistantOutput}
          defaultLiveOutputOpen
          onCancel={null}
        />
      </div>
    );
  }

  const allTeammatesOnline =
    teamMembers != null &&
    teamMembers.length > 0 &&
    teamMembers.every((m) => m.status === 'active' || m.status === 'idle');

  if (isReady) {
    const readyMessage = allTeammatesOnline
      ? `Team launched — all ${teamMembers!.length} teammates online`
      : 'Team launched — teammates may still be starting';

    return (
      <div className="mb-3">
        <div className="flex items-center gap-2 rounded-md border border-[var(--step-done-border)] bg-[var(--step-done-bg)] px-3 py-2">
          <CheckCircle2 size={14} className="shrink-0 text-[var(--step-done-text)]" />
          <p className="flex-1 text-xs text-[var(--step-success-text)]">{readyMessage}</p>
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 border-[var(--step-done-border)] px-2 text-xs text-[var(--step-done-text)] hover:bg-[var(--step-done-bg)]"
            onClick={() => setDismissed(true)}
          >
            <X size={12} />
          </Button>
        </div>
        <ProvisioningProgressBlock
          key={progress.runId}
          title="Launch details"
          message={progress.message}
          currentStepIndex={progressStepIndex >= 0 ? progressStepIndex : -1}
          startedAt={progress.startedAt}
          pid={progress.pid}
          cliLogsTail={progress.cliLogsTail}
          assistantOutput={progress.assistantOutput}
          defaultLiveOutputOpen={false}
          onCancel={null}
        />
      </div>
    );
  }

  if (isActive) {
    return (
      <div className="mb-3">
        <ProvisioningProgressBlock
          key={progress.runId}
          title="Launching team"
          message={progress.message}
          currentStepIndex={progressStepIndex >= 0 ? progressStepIndex : -1}
          loading
          startedAt={progress.startedAt}
          pid={progress.pid}
          cliLogsTail={progress.cliLogsTail}
          assistantOutput={progress.assistantOutput}
          defaultLiveOutputOpen
          onCancel={
            canCancel
              ? () => {
                  void cancelProvisioning(progress.runId);
                }
              : null
          }
        />
      </div>
    );
  }

  return null;
};
