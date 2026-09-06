import type { TeamProvisioningPresentation } from './teamProvisioningPresentation';
import type { LeadActivityState } from '@shared/types';

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
    input.leadActivity !== 'active' ||
    input.currentRuntimeRunId !== presentation.progress.runId
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
