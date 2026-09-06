import { isProvisioningProgressActive } from './teamProvisioningPresentation';

import type { TeamProvisioningPresentation } from './teamProvisioningPresentation';
import type { LeadActivityState, TeamProvisioningProgress } from '@shared/types';

export function hasObservedLeadWorkDuringProvisioning(input: {
  progress: TeamProvisioningProgress | null | undefined;
  leadActivity?: LeadActivityState;
  currentRuntimeRunId?: string | null;
}): boolean {
  return (
    isProvisioningProgressActive(input.progress) &&
    input.leadActivity === 'active' &&
    input.currentRuntimeRunId != null &&
    input.currentRuntimeRunId === input.progress?.runId
  );
}

/** Keep observed work separate from the launch-success and teammate-readiness gates. */
export function applyLeadActivityToProvisioningPresentation(
  presentation: TeamProvisioningPresentation | null,
  input: {
    leadActivity?: LeadActivityState;
    currentRuntimeRunId?: string | null;
    title: string;
    detail: string;
  }
): TeamProvisioningPresentation | null {
  if (
    !presentation?.isActive ||
    presentation.isReady ||
    presentation.isFailed ||
    !hasObservedLeadWorkDuringProvisioning({ ...input, progress: presentation.progress })
  )
    return presentation;

  const canReplaceGenericDetail =
    presentation.failedSpawnCount === 0 &&
    presentation.skippedSpawnCount === 0 &&
    presentation.panelMessage === presentation.progress.message &&
    !presentation.progress.messageSeverity;
  return {
    ...presentation,
    panelTitle: input.title,
    compactTitle: input.title,
    ...(canReplaceGenericDetail ? { panelMessage: input.detail } : {}),
  };
}
