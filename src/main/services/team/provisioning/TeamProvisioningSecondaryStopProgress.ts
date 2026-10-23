import { randomUUID } from 'crypto';

import type { TeamProvisioningProgress } from '@shared/types';

export interface SecondaryStopProgressCustody {
  baseline: TeamProvisioningProgress | undefined;
  hadProgress: boolean;
  current: TeamProvisioningProgress;
  operations: Set<string>;
  metadataChanged: boolean;
  failed: boolean;
}

interface ProgressCustodyRun {
  progress?: TeamProvisioningProgress;
  secondaryStopProgressCustody?: SecondaryStopProgressCustody;
}

type ProgressMetadata = Partial<
  Pick<
    TeamProvisioningProgress,
    'updatedAt' | 'assistantOutput' | 'cliLogsTail' | 'launchDiagnostics'
  >
>;

/** Only these four metadata fields may preserve an owned secondary-stop phase. */
export function updateProvisioningProgressMetadata(
  run: ProgressCustodyRun & { progress: TeamProvisioningProgress },
  metadata: ProgressMetadata
): void {
  const previous = run.progress;
  const next = { ...previous };
  if ('updatedAt' in metadata && metadata.updatedAt !== undefined)
    next.updatedAt = metadata.updatedAt;
  if ('assistantOutput' in metadata) next.assistantOutput = metadata.assistantOutput;
  if ('cliLogsTail' in metadata) next.cliLogsTail = metadata.cliLogsTail;
  if ('launchDiagnostics' in metadata) next.launchDiagnostics = metadata.launchDiagnostics;
  run.progress = next;
  const custody = run.secondaryStopProgressCustody;
  if (custody?.current === previous) {
    custody.current = next;
    custody.metadataChanged = true;
  }
}

export function beginSecondaryStopProgress(
  run: ProgressCustodyRun,
  pending: TeamProvisioningProgress
): { custody: SecondaryStopProgressCustody; operationId: string } {
  const previous = run.secondaryStopProgressCustody;
  const custody =
    previous && previous.current === run.progress && !previous.failed
      ? previous
      : {
          baseline: run.progress,
          hadProgress: Object.prototype.hasOwnProperty.call(run, 'progress'),
          current: pending,
          operations: new Set<string>(),
          metadataChanged: false,
          failed: false,
        };
  const operationId = randomUUID();
  custody.operations.add(operationId);
  custody.current = pending;
  run.secondaryStopProgressCustody = custody;
  run.progress = pending;
  return { custody, operationId };
}

export function ownsSecondaryStopProgress(
  run: ProgressCustodyRun,
  custody: SecondaryStopProgressCustody
): boolean {
  return run.secondaryStopProgressCustody === custody && run.progress === custody.current;
}

export function failSecondaryStopProgress(
  run: ProgressCustodyRun,
  custody: SecondaryStopProgressCustody,
  error: unknown
): TeamProvisioningProgress | null {
  custody.failed = true;
  if (!ownsSecondaryStopProgress(run, custody)) return null;
  const failed: TeamProvisioningProgress = {
    ...custody.current,
    state: 'disconnected',
    message: 'OpenCode runtime lane stopped but exact cleanup failed',
    messageSeverity: 'error',
    updatedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  };
  custody.current = failed;
  run.progress = failed;
  return failed;
}

export function finishSecondaryStopProgress(
  run: ProgressCustodyRun,
  operation: { custody: SecondaryStopProgressCustody; operationId: string },
  authorized: boolean
): TeamProvisioningProgress | undefined {
  const { custody, operationId } = operation;
  custody.operations.delete(operationId);
  if (custody.operations.size || run.secondaryStopProgressCustody !== custody) return undefined;
  const restore = authorized && !custody.failed && ownsSecondaryStopProgress(run, custody);
  delete run.secondaryStopProgressCustody;
  if (!restore) return undefined;
  const baseline = custody.baseline;
  if (baseline) {
    run.progress = custody.metadataChanged
      ? {
          ...custody.current,
          state: baseline.state,
          message: baseline.message,
          messageSeverity: baseline.messageSeverity,
          error: baseline.error,
        }
      : baseline;
    return run.progress;
  }
  if (custody.hadProgress) run.progress = undefined;
  else delete run.progress;
  return undefined;
}
