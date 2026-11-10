import { memo, useEffect, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { X } from 'lucide-react';

import { ProvisioningProgressBlock } from './ProvisioningProgressBlock';
import { useTeamProvisioningPresentation } from './useTeamProvisioningPresentation';

import type { RetryFailedOpenCodeSecondaryLanesResult } from '@shared/types';

export interface TeamProvisioningPanelProps {
  teamName: string;
  surface?: 'raised' | 'flat';
  dismissible?: boolean;
  className?: string;
  defaultLogsOpen?: boolean;
}

function formatOpenCodeSecondaryRetryResult(
  result: RetryFailedOpenCodeSecondaryLanesResult
): string {
  const parts: string[] = [];
  if (result.confirmed.length > 0) {
    parts.push(`${result.confirmed.length} confirmed`);
  }
  if (result.pending.length > 0) {
    parts.push(`${result.pending.length} pending`);
  }
  if (result.failed.length > 0) {
    parts.push(`${result.failed.length} failed`);
  }
  if (result.skipped.length > 0) {
    parts.push(`${result.skipped.length} skipped`);
  }
  return parts.length > 0
    ? `OpenCode retry: ${parts.join(', ')}`
    : 'No retryable OpenCode failures';
}

export const TeamProvisioningPanel = memo(function TeamProvisioningPanel({
  teamName,
  surface = 'flat',
  dismissible = false,
  className,
  defaultLogsOpen,
}: TeamProvisioningPanelProps): React.JSX.Element | null {
  const { t } = useAppTranslation('common');
  const provisioningError = useStore((s) => s.provisioningErrorByTeam[teamName]);
  const clearProvisioningError = useStore((s) => s.clearProvisioningError);
  const {
    presentation,
    cancelProvisioning,
    retryFailedOpenCodeSecondaryLanes,
    memberDiagnostics,
    runInstanceKey,
  } = useTeamProvisioningPresentation(teamName);
  const [dismissed, setDismissed] = useState(false);
  const [retryingOpenCode, setRetryingOpenCode] = useState(false);
  const [openCodeRetryMessage, setOpenCodeRetryMessage] = useState<string | null>(null);
  const [openCodeRetryError, setOpenCodeRetryError] = useState<string | null>(null);
  const [cancelAttempt, setCancelAttempt] = useState<{
    owner: string;
    pending: boolean;
    error: string | null;
  } | null>(null);
  const pendingCancelRef = useRef<{ owner: string } | null>(null);
  const lastActiveStepRef = useRef(-1);

  useEffect(
    () => () => {
      pendingCancelRef.current = null;
    },
    []
  );

  useEffect(() => {
    setDismissed(false);
    setRetryingOpenCode(false);
    setOpenCodeRetryMessage(null);
    setOpenCodeRetryError(null);
  }, [runInstanceKey]);

  const currentCancel =
    cancelAttempt?.owner === (runInstanceKey ?? undefined) ? cancelAttempt : null;
  const cancelError = currentCancel?.error ?? null;
  const cancelPending = currentCancel?.pending ?? false;

  if (!presentation) {
    const visibleError = cancelError ?? provisioningError;
    return visibleError ? (
      <div
        role="alert"
        className={cn(
          'flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2',
          className
        )}
      >
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-xs text-[var(--step-error-text)] [overflow-wrap:anywhere]">
          {cancelError
            ? t('provisioning.cancelFailed', {
                defaultValue: 'Could not cancel launch: {{error}}',
                error: cancelError,
              })
            : provisioningError}
        </p>
        {dismissible ? (
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 border-red-500/40 px-2 text-xs text-[var(--step-error-text)] hover:bg-red-500/10"
            aria-label={t('actions.close')}
            onClick={() => {
              if (cancelError) setCancelAttempt(null);
              else clearProvisioningError(teamName);
            }}
          >
            <X size={12} />
          </Button>
        ) : null}
      </div>
    ) : null;
  }

  if (dismissed) {
    return null;
  }

  if (presentation.currentStepIndex >= 0 && !presentation.isFailed) {
    lastActiveStepRef.current = presentation.currentStepIndex;
  }

  const showRunningState = presentation.isActive || presentation.hasMembersStillJoining;
  const canRetryFailedOpenCode =
    !presentation.isActive &&
    presentation.retryableOpenCodeSecondaryFailedCount > 0 &&
    Boolean(retryFailedOpenCodeSecondaryLanes);

  const retryOpenCodeAction = canRetryFailedOpenCode ? (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
      <p className="min-w-0 flex-1 text-xs text-[var(--step-warning-text)]">
        {openCodeRetryError ??
          openCodeRetryMessage ??
          `${presentation.retryableOpenCodeSecondaryFailedCount} failed OpenCode teammate${
            presentation.retryableOpenCodeSecondaryFailedCount === 1 ? '' : 's'
          } can be retried.`}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 border-amber-500/40 px-2 text-xs text-[var(--step-warning-text)] hover:bg-amber-500/10"
        disabled={retryingOpenCode}
        onClick={() => {
          if (!retryFailedOpenCodeSecondaryLanes || retryingOpenCode) {
            return;
          }
          setRetryingOpenCode(true);
          setOpenCodeRetryError(null);
          setOpenCodeRetryMessage(null);
          void retryFailedOpenCodeSecondaryLanes(teamName)
            .then((result) => {
              setOpenCodeRetryMessage(formatOpenCodeSecondaryRetryResult(result));
            })
            .catch((error: unknown) => {
              setOpenCodeRetryError(error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
              setRetryingOpenCode(false);
            });
        }}
      >
        {retryingOpenCode ? 'Retrying OpenCode...' : 'Retry failed OpenCode teammates'}
      </Button>
    </div>
  ) : null;

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
      teamName={teamName}
      runId={presentation.progress.runId}
      pid={presentation.progress.pid}
      cliLogsTail={presentation.progress.cliLogsTail}
      assistantOutput={presentation.progress.assistantOutput}
      launchDiagnostics={presentation.progress.launchDiagnostics}
      warnings={presentation.progress.warnings}
      memberDiagnostics={memberDiagnostics}
      defaultLiveOutputOpen={presentation.defaultLiveOutputOpen}
      defaultLogsOpen={defaultLogsOpen}
      onCancel={
        presentation.canCancel && cancelProvisioning && runInstanceKey && !cancelPending
          ? () => {
              if (pendingCancelRef.current?.owner === runInstanceKey) return;
              const attempt = { owner: runInstanceKey };
              pendingCancelRef.current = attempt;
              setCancelAttempt({ owner: attempt.owner, pending: true, error: null });
              void (async () => {
                try {
                  await cancelProvisioning(presentation.progress.runId);
                  if (pendingCancelRef.current === attempt) {
                    setCancelAttempt({ owner: attempt.owner, pending: false, error: null });
                  }
                } catch (error: unknown) {
                  if (pendingCancelRef.current === attempt) {
                    setCancelAttempt({
                      owner: attempt.owner,
                      pending: false,
                      error: error instanceof Error ? error.message : String(error),
                    });
                  }
                } finally {
                  if (pendingCancelRef.current === attempt) pendingCancelRef.current = null;
                }
              })();
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
    />
  );

  return (
    <div className={cn('space-y-2', className)}>
      {presentation.isFailed ? (
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
      ) : null}
      {block}
      {cancelPending ? (
        <p role="status" className="text-xs text-[var(--color-text-muted)]">
          {t('provisioning.cancelling', { defaultValue: 'Cancelling...' })}
        </p>
      ) : null}
      {cancelError ? (
        <p role="alert" className="text-xs text-[var(--step-error-text)] [overflow-wrap:anywhere]">
          {t('provisioning.cancelFailed', {
            defaultValue: 'Could not cancel launch: {{error}}',
            error: cancelError,
          })}
        </p>
      ) : null}
      {retryOpenCodeAction}
    </div>
  );
});
