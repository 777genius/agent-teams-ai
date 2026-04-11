import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { getCurrentProvisioningProgressForTeam } from '@renderer/store/slices/teamSlice';
import { X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { ProvisioningProgressBlock } from './ProvisioningProgressBlock';
import {
  DISPLAY_COMPLETE_STEP_INDEX,
  getDisplayStepIndex,
  getLaunchJoinMilestonesFromMembers,
  getLaunchJoinState,
} from './provisioningSteps';

interface TeamProvisioningBannerProps {
  teamName: string;
}

export const TeamProvisioningBanner = memo(function TeamProvisioningBanner({
  teamName,
}: TeamProvisioningBannerProps): React.JSX.Element | null {
  const { progress, cancelProvisioning, teamMembers, memberSpawnStatuses, memberSpawnSnapshot } =
    useStore(
      useShallow((s) => ({
        progress: getCurrentProvisioningProgressForTeam(s, teamName),
        cancelProvisioning: s.cancelProvisioning,
        teamMembers: s.selectedTeamName === teamName ? s.selectedTeamData?.members : undefined,
        memberSpawnStatuses: s.memberSpawnStatusesByTeam[teamName],
        memberSpawnSnapshot: s.memberSpawnSnapshotsByTeam[teamName],
      }))
    );
  const [dismissed, setDismissed] = useState(false);
  const lastActiveStepRef = useRef(-1);
  const bannerInstanceKey = useMemo(() => {
    if (!progress) return null;
    return `${teamName}:${progress.runId}:${progress.startedAt}`;
  }, [teamName, progress?.runId, progress?.startedAt]);

  useEffect(() => {
    setDismissed(false);
  }, [bannerInstanceKey]);

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
    progress.state === 'configuring' ||
    progress.state === 'assembling' ||
    progress.state === 'finalizing' ||
    progress.state === 'verifying';

  const canCancel =
    progress.state === 'spawning' ||
    progress.state === 'configuring' ||
    progress.state === 'assembling' ||
    progress.state === 'finalizing' ||
    progress.state === 'verifying';

  const {
    expectedTeammateCount: fallbackTeammateCount,
    heartbeatConfirmedCount,
    processOnlyAliveCount,
    pendingSpawnCount,
    failedSpawnCount,
  } = getLaunchJoinMilestonesFromMembers({
    members: teamMembers ?? [],
    memberSpawnStatuses,
    memberSpawnSnapshot,
  });
  const { allTeammatesConfirmedAlive, hasMembersStillJoining, remainingJoinCount } =
    getLaunchJoinState({
      expectedTeammateCount: fallbackTeammateCount,
      heartbeatConfirmedCount,
      processOnlyAliveCount,
      pendingSpawnCount,
      failedSpawnCount,
    });
  const progressStepIndex = getDisplayStepIndex({
    progress,
    expectedTeammateCount: fallbackTeammateCount,
    heartbeatConfirmedCount,
    processOnlyAliveCount,
    pendingSpawnCount,
    failedSpawnCount,
  });

  // Keep the error marker aligned to the last meaningful UI milestone, not the
  // raw backend phase enum. The launch flow now moves through some backend
  // states too quickly for the old enum mapping to stay user-meaningful.
  if (progressStepIndex >= 0 && !isFailed) {
    lastActiveStepRef.current = progressStepIndex;
  }

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
          surface="flat"
          currentStepIndex={lastActiveStepRef.current}
          errorStepIndex={lastActiveStepRef.current >= 0 ? lastActiveStepRef.current : 0}
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

  if (isReady) {
    const joiningPhrase =
      remainingJoinCount === 1
        ? '1 teammate still joining'
        : `${remainingJoinCount} teammates still joining`;
    const readyDetailMessage =
      failedSpawnCount > 0
        ? progress.message
        : fallbackTeammateCount === 0
          ? 'Team provisioned - lead online'
          : allTeammatesConfirmedAlive
            ? `Team provisioned - all ${fallbackTeammateCount} teammates joined`
            : hasMembersStillJoining
              ? joiningPhrase
              : 'Team provisioned - teammates are still joining';
    const readyDetailSeverity =
      failedSpawnCount > 0 ? 'warning' : hasMembersStillJoining ? 'info' : undefined;
    const readyMessage =
      failedSpawnCount > 0
        ? `Launch finished with errors - ${failedSpawnCount}/${Math.max(fallbackTeammateCount, failedSpawnCount)} teammates failed to start`
        : fallbackTeammateCount === 0
          ? 'Team launched - lead online'
          : allTeammatesConfirmedAlive
            ? `Team launched - all ${fallbackTeammateCount} teammates joined`
            : hasMembersStillJoining
              ? 'Finishing launch'
              : 'Finishing launch';
    const readyStepIndex = hasMembersStillJoining ? 2 : DISPLAY_COMPLETE_STEP_INDEX;

    return (
      <div className="mb-3">
        <ProvisioningProgressBlock
          key={progress.runId}
          title="Launch details"
          message={failedSpawnCount > 0 || hasMembersStillJoining ? readyDetailMessage : null}
          messageSeverity={readyDetailSeverity}
          surface="flat"
          currentStepIndex={readyStepIndex}
          startedAt={progress.startedAt}
          pid={progress.pid}
          cliLogsTail={progress.cliLogsTail}
          assistantOutput={progress.assistantOutput}
          defaultLiveOutputOpen={false}
          onCancel={null}
          successMessage={readyMessage}
          successMessageSeverity={
            failedSpawnCount > 0 ? 'warning' : hasMembersStillJoining ? 'info' : 'success'
          }
          onDismiss={() => setDismissed(true)}
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
          messageSeverity={progress.messageSeverity}
          surface="flat"
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
});
