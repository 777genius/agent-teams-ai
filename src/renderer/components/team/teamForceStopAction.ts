import type { TeamForceStopResult } from '@shared/types';

/** Confirm, stop, report incomplete cleanup, then refresh independently. */
export interface TeamForceStopActionLabels {
  confirmTitle: string;
  confirmMessage: string;
  confirmLabel: string;
  cancelLabel: string;
  failureTitle: string;
  failureFallbackMessage: string;
  failureConfirmLabel: string;
}

export interface TeamForceStopActionPorts {
  teamName: string;
  labels: TeamForceStopActionLabels;
  confirm(options: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'default' | 'danger';
  }): Promise<boolean>;
  forceStop(teamName: string): Promise<TeamForceStopResult>;
  refreshTeamData(teamName: string): Promise<void>;
  /** Drives the control's pending state; never set while the user is deciding. */
  setBusy(busy: boolean): void;
  logError(error: unknown): void;
  /** Separate from `logError` so the log never blames a stop that did run. */
  logRefreshError(error: unknown): void;
}

export type TeamForceStopActionOutcome =
  | 'cancelled'
  | 'ran'
  | 'ran_refresh_failed'
  | 'incomplete'
  | 'failed';

export async function runTeamForceStopAction(
  ports: TeamForceStopActionPorts
): Promise<TeamForceStopActionOutcome> {
  const confirmed = await ports.confirm({
    title: ports.labels.confirmTitle,
    message: ports.labels.confirmMessage,
    confirmLabel: ports.labels.confirmLabel,
    cancelLabel: ports.labels.cancelLabel,
    variant: 'danger',
  });
  if (!confirmed) {
    return 'cancelled';
  }
  ports.setBusy(true);
  const reportFailure = (message: string): void => {
    void ports.confirm({
      title: ports.labels.failureTitle,
      message,
      confirmLabel: ports.labels.failureConfirmLabel,
      variant: 'danger',
    });
  };
  try {
    let result: TeamForceStopResult;
    try {
      result = await ports.forceStop(ports.teamName);
    } catch (error) {
      ports.logError(error);
      reportFailure(selectTeamForceStopFailureMessage(error, ports.labels.failureFallbackMessage));
      return 'failed';
    }
    const incomplete = result.cleanupOutcome !== 'completed';
    if (incomplete) {
      ports.logError(result);
      reportFailure(
        result.diagnostics.filter((message) => message.trim()).join('\n') ||
          ports.labels.failureFallbackMessage
      );
    }
    // Even an incomplete stop may change runtime state. A failed refresh must
    // never obscure its outcome or imply that completed cleanup failed.
    try {
      await ports.refreshTeamData(ports.teamName);
    } catch (refreshError) {
      ports.logRefreshError(refreshError);
      return incomplete ? 'incomplete' : 'ran_refresh_failed';
    }
    return incomplete ? 'incomplete' : 'ran';
  } finally {
    ports.setBusy(false);
  }
}

/** An error with nothing readable to say falls back to the localized sentence. */
export function selectTeamForceStopFailureMessage(error: unknown, fallbackMessage: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return fallbackMessage;
}
