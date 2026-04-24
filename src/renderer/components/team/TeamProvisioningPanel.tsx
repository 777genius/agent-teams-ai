import { memo, useEffect, useRef, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';
import { X } from 'lucide-react';

import { ProvisioningProgressBlock } from './ProvisioningProgressBlock';
import { useTeamProvisioningPresentation } from './useTeamProvisioningPresentation';

export interface TeamProvisioningPanelProps {
  teamName: string;
  surface?: 'raised' | 'flat';
  dismissible?: boolean;
  className?: string;
  defaultLogsOpen?: boolean;
}

export const TeamProvisioningPanel = memo(function TeamProvisioningPanel({
  teamName,
  surface = 'flat',
  dismissible = false,
  className,
  defaultLogsOpen,
}: TeamProvisioningPanelProps): React.JSX.Element | null {
  const { presentation, cancelProvisioning, runInstanceKey } =
    useTeamProvisioningPresentation(teamName);
  const [dismissed, setDismissed] = useState(false);
  const lastActiveStepRef = useRef(-1);

  useEffect(() => {
    setDismissed(false);
  }, [runInstanceKey]);

  if (!presentation || dismissed) {
    return null;
  }

  if (presentation.currentStepIndex >= 0 && !presentation.isFailed) {
    lastActiveStepRef.current = presentation.currentStepIndex;
  }

  const showRunningState = presentation.isActive || presentation.hasMembersStillJoining;

  const block = (
    <ProvisioningProgressBlock
      key={presentation.progress.runId}
      title={presentation.panelTitle}
      message={presentation.panelMessage}
      messageSeverity={presentation.panelMessageSeverity}
      tone={presentation.panelTone}
      surface={surface}
      currentStepIndex={presentation.currentStepIndex}
      errorStepIndex={
        presentation.isFailed
          ? lastActiveStepRef.current >= 0
            ? lastActiveStepRef.current
            : 0
          : undefined
      }
      loading={showRunningState}
      startedAt={presentation.progress.startedAt}
      pid={presentation.progress.pid}
      cliLogsTail={presentation.progress.cliLogsTail}
      assistantOutput={presentation.progress.assistantOutput}
      launchDiagnostics={presentation.progress.launchDiagnostics}
      defaultLiveOutputOpen={presentation.defaultLiveOutputOpen}
      defaultLogsOpen={defaultLogsOpen}
      onCancel={
        presentation.canCancel && cancelProvisioning
          ? () => {
              void cancelProvisioning(presentation.progress.runId);
            }
          : null
      }
      successMessage={presentation.successMessage}
      successMessageSeverity={presentation.successMessageSeverity}
      onDismiss={
        dismissible && presentation.isReady
          ? () => {
              setDismissed(true);
            }
          : null
      }
      className={!presentation.isFailed ? className : undefined}
    />
  );

  if (!presentation.isFailed) {
    return block;
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2">
        <p className="flex-1 text-xs text-[var(--step-error-text)]">
          {presentation.progress.message}
        </p>
        {dismissible ? (
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 border-red-500/40 px-2 text-xs text-[var(--step-error-text)] hover:bg-red-500/10"
            onClick={() => setDismissed(true)}
          >
            <X size={12} />
          </Button>
        ) : null}
      </div>
      {block}
    </div>
  );
});
