import { useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { DISPLAY_STEPS } from '@renderer/components/team/provisioningSteps';
import { StepProgressBar } from '@renderer/components/team/StepProgressBar';
import { TeamProvisioningPanel } from '@renderer/components/team/TeamProvisioningPanel';
import { useTeamProvisioningPresentation } from '@renderer/components/team/useTeamProvisioningPresentation';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';

import type { TeamProvisioningPresentation } from '@renderer/utils/teamProvisioningPresentation';
import type { CSSProperties } from 'react';

const HUD_STEPPER_STYLE: CSSProperties = {
  ['--stepper-done' as string]: '#22c55e',
  ['--stepper-done-glow' as string]: 'rgba(34, 197, 94, 0.24)',
  ['--stepper-current' as string]: '#22c55e',
  ['--stepper-current-ring' as string]: 'rgba(34, 197, 94, 0.18)',
  ['--stepper-pending' as string]: 'rgba(148, 163, 184, 0.08)',
  ['--stepper-pending-text' as string]: '#cbd5e1',
  ['--stepper-pending-border' as string]: 'rgba(148, 163, 184, 0.2)',
  ['--stepper-line' as string]: 'rgba(148, 163, 184, 0.14)',
  ['--stepper-line-done' as string]: '#22c55e',
  ['--stepper-label' as string]: '#94a3b8',
  ['--stepper-label-active' as string]: '#e2e8f0',
  ['--stepper-error' as string]: '#ef4444',
  ['--stepper-error-glow' as string]: 'rgba(239, 68, 68, 0.22)',
  ['--stepper-label-error' as string]: '#fca5a5',
};

function shouldRenderLaunchHud(presentation: TeamProvisioningPresentation | null): boolean {
  return presentation != null && (presentation.isActive || presentation.isFailed);
}

export interface GraphProvisioningHudProps {
  teamName: string;
  enabled?: boolean;
}

export const GraphProvisioningHud = ({
  teamName,
  enabled = true,
}: GraphProvisioningHudProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const miniSteps = DISPLAY_STEPS.map((step) => ({ key: step.key, label: t(step.labelKey) }));
  const { presentation, runInstanceKey } = useTeamProvisioningPresentation(teamName);
  const lastActiveStepRef = useRef(-1);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const shouldRender = enabled && shouldRenderLaunchHud(presentation);
  const errorStepIndex = presentation?.isFailed
    ? lastActiveStepRef.current >= 0
      ? lastActiveStepRef.current
      : 0
    : undefined;

  useEffect(() => {
    setDetailsOpen(false);
    lastActiveStepRef.current = -1;
  }, [runInstanceKey, teamName]);

  useEffect(() => {
    if (presentation && !presentation.isFailed && presentation.currentStepIndex >= 0) {
      lastActiveStepRef.current = presentation.currentStepIndex;
    }
  }, [presentation]);

  const ariaLabel = useMemo(() => {
    const parts = [presentation?.compactTitle, presentation?.compactDetail].filter(Boolean);
    return parts.join(' - ') || 'Open launch details';
  }, [presentation?.compactDetail, presentation?.compactTitle]);

  if (!shouldRender || !presentation) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        className="focus-visible:ring-white/18 w-full touch-none select-none rounded-xl bg-transparent px-1 py-0.5 text-left text-slate-100 transition-opacity hover:opacity-95 focus-visible:outline-none focus-visible:ring-1"
        onClick={() => setDetailsOpen(true)}
        onMouseDown={(event) => event.preventDefault()}
        onDragStart={(event) => event.preventDefault()}
        aria-label={ariaLabel}
      >
        <div className="px-1 py-0.5" style={HUD_STEPPER_STYLE}>
          <StepProgressBar
            steps={miniSteps}
            currentIndex={presentation.currentStepIndex}
            active={presentation.isActive}
            errorIndex={errorStepIndex}
            className="w-full origin-top scale-[0.88]"
          />
        </div>
        <span className="sr-only">{ariaLabel}</span>
      </button>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="w-[min(1120px,92vw)] max-w-5xl p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>{t('agentGraph.provisioning.launchDetails')}</DialogTitle>
            <DialogDescription>
              {t('agentGraph.provisioning.launchDetailsDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[85vh] overflow-y-auto p-4">
            <TeamProvisioningPanel teamName={teamName} surface="flat" defaultLogsOpen />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};
