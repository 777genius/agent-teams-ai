import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { DISPLAY_STEPS } from '@renderer/components/team/provisioningSteps';
import { StepProgressBar } from '@renderer/components/team/StepProgressBar';
import { TeamProvisioningPanel } from '@renderer/components/team/TeamProvisioningPanel';
import { useTeamProvisioningPresentation } from '@renderer/components/team/useTeamProvisioningPresentation';
import { Badge } from '@renderer/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { cn } from '@renderer/lib/utils';
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, X } from 'lucide-react';

import type { TeamProvisioningPresentation } from '@renderer/utils/teamProvisioningPresentation';
import type { CSSProperties } from 'react';

const MINI_STEPS = DISPLAY_STEPS.map((step) => ({ key: step.key, label: step.label }));
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
  return presentation != null;
}

function getToneClasses(tone: TeamProvisioningPresentation['compactTone']): {
  border: string;
  badge: string;
  icon: React.ReactNode;
  iconClassName: string;
} {
  switch (tone) {
    case 'error':
      return {
        border: 'border-red-400/35 bg-[rgba(26,10,16,0.92)]',
        badge: 'border-red-500/30 text-red-300',
        icon: <AlertTriangle size={13} />,
        iconClassName: 'text-red-400',
      };
    case 'warning':
      return {
        border: 'border-amber-400/35 bg-[rgba(31,18,8,0.92)]',
        badge: 'border-amber-500/30 text-amber-200',
        icon: <AlertTriangle size={13} />,
        iconClassName: 'text-amber-400',
      };
    case 'success':
      return {
        border: 'border-emerald-400/35 bg-[rgba(8,24,18,0.92)]',
        badge: 'border-emerald-500/30 text-emerald-200',
        icon: <CheckCircle2 size={13} />,
        iconClassName: 'text-emerald-400',
      };
    default:
      return {
        border: 'border-cyan-400/25 bg-[rgba(8,14,26,0.92)]',
        badge: 'border-cyan-500/20 text-cyan-200',
        icon: <Loader2 size={13} className="animate-spin" />,
        iconClassName: 'text-cyan-300',
      };
  }
}

export interface GraphProvisioningHudProps {
  teamName: string;
  leadNodeId: string | null;
  getLaunchAnchorScreenPlacement: (
    leadNodeId: string
  ) => { x: number; y: number; scale: number; visible: boolean } | null;
  enabled?: boolean;
}

export const GraphProvisioningHud = ({
  teamName,
  leadNodeId,
  getLaunchAnchorScreenPlacement,
  enabled = true,
}: GraphProvisioningHudProps): React.JSX.Element | null => {
  const { presentation, runInstanceKey } = useTeamProvisioningPresentation(teamName);
  const shellRef = useRef<HTMLDivElement>(null);
  const lastActiveStepRef = useRef(-1);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const shouldRender =
    enabled && shouldRenderLaunchHud(presentation) && !dismissed && Boolean(leadNodeId);
  const tone = presentation ? getToneClasses(presentation.compactTone) : null;
  const errorStepIndex = presentation?.isFailed
    ? lastActiveStepRef.current >= 0
      ? lastActiveStepRef.current
      : 0
    : undefined;

  useEffect(() => {
    setDetailsOpen(false);
    setDismissed(false);
    lastActiveStepRef.current = -1;
  }, [runInstanceKey, teamName]);

  useEffect(() => {
    if (!shouldRender || !leadNodeId) {
      setDetailsOpen(false);
    }
  }, [leadNodeId, shouldRender]);

  useEffect(() => {
    if (presentation && !presentation.isFailed && presentation.currentStepIndex >= 0) {
      lastActiveStepRef.current = presentation.currentStepIndex;
    }
  }, [presentation]);

  useLayoutEffect(() => {
    if (!shouldRender || !leadNodeId) {
      return;
    }
    let frameId = 0;
    const updatePosition = (): void => {
      const shell = shellRef.current;
      if (!shell) {
        frameId = window.requestAnimationFrame(updatePosition);
        return;
      }
      const placement = getLaunchAnchorScreenPlacement(leadNodeId);
      if (!placement) {
        shell.style.opacity = '0';
        frameId = window.requestAnimationFrame(updatePosition);
        return;
      }

      if (!placement.visible) {
        shell.style.opacity = '0';
        frameId = window.requestAnimationFrame(updatePosition);
        return;
      }

      shell.style.opacity = '1';
      shell.style.transform = `translate(${Math.round(placement.x)}px, ${Math.round(placement.y)}px) scale(${placement.scale.toFixed(3)})`;
      frameId = window.requestAnimationFrame(updatePosition);
    };

    updatePosition();
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [getLaunchAnchorScreenPlacement, leadNodeId, shouldRender]);

  const compactLabel = useMemo(() => {
    if (!presentation?.compactDetail) {
      return null;
    }
    return presentation.compactDetail.length > 88
      ? `${presentation.compactDetail.slice(0, 88)}...`
      : presentation.compactDetail;
  }, [presentation?.compactDetail]);

  if (!shouldRender || !presentation || !tone) {
    return null;
  }

  return (
    <div
      ref={shellRef}
      className="pointer-events-auto absolute z-10 w-[336px] origin-top-left opacity-0 transition-opacity"
    >
      <div
        className={cn(
          'rounded-xl border p-3 text-slate-100 shadow-[0_18px_48px_rgba(5,5,16,0.38)] backdrop-blur-xl',
          tone.border
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn('shrink-0', tone.iconClassName)}>{tone.icon}</span>
              <div className="truncate text-sm font-semibold text-slate-50">
                {presentation.compactTitle}
              </div>
              <Badge variant="outline" className={cn('px-1.5 py-0 text-[10px]', tone.badge)}>
                {presentation.isFailed
                  ? 'Issue'
                  : presentation.hasMembersStillJoining
                    ? 'Joining'
                    : presentation.isActive
                      ? 'Live'
                      : 'Ready'}
              </Badge>
            </div>
            {compactLabel ? (
              <div className="mt-1 text-[11px] leading-5 text-slate-300">{compactLabel}</div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="inline-flex size-7 items-center justify-center rounded-md border border-white/10 bg-white/5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100"
              onClick={() => setDetailsOpen(true)}
              aria-label="Open launch details"
            >
              <ExternalLink size={14} />
            </button>
            <button
              type="button"
              className="inline-flex size-7 items-center justify-center rounded-md border border-white/10 bg-white/5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100"
              onClick={() => setDismissed(true)}
              aria-label="Dismiss launch overlay"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <button
          type="button"
          className="border-cyan-300/12 mt-3 w-full rounded-xl border bg-[rgba(4,10,20,0.58)] p-3 text-left transition-colors hover:bg-[rgba(8,18,32,0.76)]"
          style={HUD_STEPPER_STYLE}
          onClick={() => setDetailsOpen(true)}
          aria-label="Open full launch details"
        >
          <StepProgressBar
            steps={MINI_STEPS}
            currentIndex={presentation.currentStepIndex}
            errorIndex={errorStepIndex}
            className="w-full"
          />
        </button>
      </div>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="w-[min(1120px,92vw)] max-w-5xl p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>Launch details</DialogTitle>
            <DialogDescription>
              Detailed team launch progress, live output and CLI logs.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[85vh] overflow-y-auto p-4">
            <TeamProvisioningPanel teamName={teamName} surface="flat" defaultLogsOpen />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
