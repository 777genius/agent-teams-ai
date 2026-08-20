import { retainSourceOwnedCleanupOwner } from './TeamProvisioningAuthRetryCleanupOwnership';

import type {
  AnthropicApiKeyHelperCleanupRetryOwner,
  AnthropicApiKeyHelperRunOwner,
} from './TeamProvisioningAnthropicApiKeyHelperLease';
import type { TeamProvisioningCleanupSourceOwnerRun } from './TeamProvisioningAuthRetryCleanupOwnership';
import type { TeamProvisioningProgress, TeamProvisioningState } from '@shared/types';

export interface DeterministicTimeoutFinalizationRun
  extends AnthropicApiKeyHelperRunOwner, TeamProvisioningCleanupSourceOwnerRun {
  runId: string;
  teamName: string;
  progress: TeamProvisioningProgress;
  child: unknown;
  processKilled: boolean;
  provisioningComplete: boolean;
  finalizingByTimeout: boolean;
  cancelRequested: boolean;
  onProgress(progress: TeamProvisioningProgress): void;
}

export interface DeterministicTimeoutFinalizationPorts<
  TRun extends DeterministicTimeoutFinalizationRun,
  TChild,
> {
  killTeamProcessAndWait(child: TChild): Promise<void>;
  handleProcessExit(run: TRun, code: number | null): Promise<void>;
  cleanupHelper(run: TRun): Promise<void>;
  cleanupRetryOwner?: AnthropicApiKeyHelperCleanupRetryOwner;
  tryCompleteAfterTimeout(run: TRun): Promise<boolean>;
  cleanupRun(run: TRun): void;
  updateProgress(
    run: TRun,
    state: Exclude<TeamProvisioningState, 'idle'>,
    message: string,
    extras?: Pick<TeamProvisioningProgress, 'error' | 'cliLogsTail'>
  ): TeamProvisioningProgress;
  extractCliLogsFromRun(run: TRun): string | undefined;
}

export interface DeterministicTimeoutFinalizationMessages {
  terminationMessage: string;
  terminationError: string;
  revocationMessage: string;
  revocationError: string;
  helperMessage: string;
  helperError: string;
  timeoutMessage: string;
  timeoutError: string;
}

/**
 * Finalizes a deterministic timeout in security order. Child close/error events may join this
 * finalizer, but cannot replace it before termination, revocation, and helper ownership settle.
 */
export async function finalizeDeterministicProvisioningTimeout<
  TRun extends DeterministicTimeoutFinalizationRun,
  TChild,
>(input: {
  run: TRun;
  child: TChild;
  ownerKey: string;
  ports: DeterministicTimeoutFinalizationPorts<TRun, TChild>;
  messages: DeterministicTimeoutFinalizationMessages;
}): Promise<void> {
  const { run, child, ports, messages } = input;
  run.processKilled = true;
  try {
    await ports.killTeamProcessAndWait(child);
  } catch (error) {
    run.finalizingByTimeout = false;
    reportRetainedFailure(run, ports, messages.terminationMessage, messages.terminationError);
    throw error;
  }

  try {
    await ports.handleProcessExit(run, null);
  } catch (error) {
    run.finalizingByTimeout = false;
    reportRetainedFailure(run, ports, messages.revocationMessage, messages.revocationError);
    throw error;
  }

  try {
    await ports.cleanupHelper(run);
  } catch (error) {
    if (!ports.cleanupRetryOwner) {
      run.finalizingByTimeout = false;
      reportRetainedFailure(run, ports, messages.helperMessage, messages.helperError);
      throw error;
    }
    const retention = await ports.cleanupRetryOwner.retainRunOwner(run, {
      ownerIdentity: { teamName: run.teamName, ownerKey: input.ownerKey },
      cleanup: () => ports.cleanupHelper(run),
      onReleased: () => ports.cleanupRun(run),
    });
    if (retention.kind === 'source-owned') {
      retainSourceOwnedCleanupOwner(run, retention.owner);
    }
    run.finalizingByTimeout = false;
    reportRetainedFailure(run, ports, messages.helperMessage, messages.helperError);
    return;
  }

  const readyOnTimeout = await ports.tryCompleteAfterTimeout(run).catch(() => false);
  if (readyOnTimeout) return;

  const progress = ports.updateProgress(run, 'failed', messages.timeoutMessage, {
    error: messages.timeoutError,
    cliLogsTail: ports.extractCliLogsFromRun(run),
  });
  run.onProgress(progress);
  ports.cleanupRun(run);
}

function reportRetainedFailure<TRun extends DeterministicTimeoutFinalizationRun>(
  run: TRun,
  ports: Pick<
    DeterministicTimeoutFinalizationPorts<TRun, unknown>,
    'updateProgress' | 'extractCliLogsFromRun'
  >,
  message: string,
  error: string
): void {
  const progress = ports.updateProgress(run, 'failed', message, {
    error,
    cliLogsTail: ports.extractCliLogsFromRun(run),
  });
  run.onProgress(progress);
}
