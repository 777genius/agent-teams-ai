import { useEffect, useRef, useState } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { STEP_LABELS, STEP_ORDER } from './provisioningSteps';

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

  if (progress.state === 'ready' || progress.state === 'cancelled') {
    return null;
  }

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

  if (isActive) {
    return (
      <div className="mb-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-[var(--color-text-muted)]">{progress.message}</p>
          {canCancel ? (
            <Button
              variant="outline"
              size="sm"
              className="h-6 shrink-0 px-2 text-xs"
              onClick={() => {
                void cancelProvisioning(progress.runId);
              }}
            >
              Cancel
            </Button>
          ) : null}
        </div>
        <div className="mt-2 flex items-center gap-1 overflow-x-auto pb-0.5">
          {STEP_ORDER.map((step, index) => {
            const isDone = progressStepIndex >= 0 && index < progressStepIndex;
            const isCurrent = progressStepIndex >= 0 && index === progressStepIndex;

            return (
              <div key={step} className="flex items-center gap-1">
                <Badge
                  variant="secondary"
                  className={cn(
                    'whitespace-nowrap px-2 py-0.5 text-[11px] font-normal',
                    isDone && 'border-emerald-400/60 bg-emerald-500/10 text-emerald-200',
                     
                    isCurrent &&
                      'border-[var(--color-accent)]/70 bg-[var(--color-accent)]/15 text-[var(--color-text)]'
                  )}
                >
                  <span className="mr-1 inline-flex size-4 items-center justify-center rounded-full border border-current text-[10px]">
                    {index + 1}
                  </span>
                  {STEP_LABELS[step]}
                </Badge>
                {index < STEP_ORDER.length - 1 ? (
                  <span className="text-[var(--color-text-muted)]">&rarr;</span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return null;
};
