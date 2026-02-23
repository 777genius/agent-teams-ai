import { useEffect, useRef, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { CheckCircle2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { ProvisioningProgressBlock } from './ProvisioningProgressBlock';
import { STEP_ORDER } from './provisioningSteps';

import type { ProvisioningStep } from './provisioningSteps';
import type { TeamProvisioningProgress } from '@shared/types';

interface TeamProvisioningBannerProps {
  teamName: string;
}

function findProgressForTeam(
  runs: Record<string, TeamProvisioningProgress>,
  teamName: string
): TeamProvisioningProgress | null {
  const entries = Object.values(runs);
  const matching = entries
    .filter((r) => r.teamName === teamName)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return matching[0] ?? null;
}

const READY_DISMISS_MS = 5_000;

export const TeamProvisioningBanner = ({
  teamName,
}: TeamProvisioningBannerProps): React.JSX.Element | null => {
  const { provisioningRuns, cancelProvisioning } = useStore(
    useShallow((s) => ({
      provisioningRuns: s.provisioningRuns,
      cancelProvisioning: s.cancelProvisioning,
    }))
  );

  const progress = findProgressForTeam(provisioningRuns, teamName);
  const [dismissed, setDismissed] = useState(false);
  const prevRunIdRef = useRef(progress?.runId);

  if (prevRunIdRef.current !== progress?.runId) {
    prevRunIdRef.current = progress?.runId;
    if (dismissed) {
      setDismissed(false);
    }
  }

  useEffect(() => {
    if (progress?.state !== 'ready') {
      return;
    }
    const timer = window.setTimeout(() => {
      setDismissed(true);
    }, READY_DISMISS_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [progress?.state, progress?.runId]);

  if (!progress || dismissed) {
    return null;
  }

  if (progress.state === 'cancelled') {
    return null;
  }

  const isReady = progress.state === 'ready';
  const isFailed = progress.state === 'failed';
  const isDisconnected = progress.state === 'disconnected';
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
      <div className="mb-3 flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2">
        <p className="flex-1 text-xs text-red-200">{progress.message}</p>
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 border-red-500/40 px-2 text-xs text-red-300 hover:bg-red-500/10 hover:text-red-200"
          onClick={() => setDismissed(true)}
        >
          <X size={12} />
        </Button>
      </div>
    );
  }

  if (isDisconnected) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
        <p className="flex-1 text-xs text-amber-200">Team offline</p>
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 border-amber-500/40 px-2 text-xs text-amber-300 hover:bg-amber-500/10 hover:text-amber-200"
          onClick={() => setDismissed(true)}
        >
          <X size={12} />
        </Button>
      </div>
    );
  }

  if (isReady) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2">
        <CheckCircle2 size={14} className="shrink-0 text-emerald-400" />
        <p className="flex-1 text-xs text-emerald-200">Team launched — process alive</p>
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 border-emerald-500/40 px-2 text-xs text-emerald-300 hover:bg-emerald-500/10 hover:text-emerald-200"
          onClick={() => setDismissed(true)}
        >
          <X size={12} />
        </Button>
      </div>
    );
  }

  if (isActive) {
    return (
      <div className="mb-3">
        <ProvisioningProgressBlock
          title="Launching team"
          message={progress.message}
          currentStepIndex={progressStepIndex >= 0 ? progressStepIndex : -1}
          loading
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
