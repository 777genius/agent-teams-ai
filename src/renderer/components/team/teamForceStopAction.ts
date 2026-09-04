/**
 * The force stop control's whole sequence: confirm the destructive action, run
 * it, refresh the view, and tell the user when it did not run at all.
 *
 * It lives beside `TeamDetailView` rather than inside it because the failure
 * branch is the only place in that view where an action failure has to reach
 * the user, and a 3.7k-line component is not somewhere a test can reach a
 * three-line branch.
 *
 * Labels are resolved by the caller, so this module carries no i18n coupling
 * and the view keeps its typed `t` calls.
 */

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
  forceStop(teamName: string): Promise<unknown>;
  refreshTeamData(teamName: string): Promise<void>;
  /** Drives the control's pending state; never set while the user is deciding. */
  setBusy(busy: boolean): void;
  logError(error: unknown): void;
}

export type TeamForceStopActionOutcome = 'cancelled' | 'ran' | 'failed';

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
  try {
    await ports.forceStop(ports.teamName);
    await ports.refreshTeamData(ports.teamName);
    return 'ran';
  } catch (error) {
    ports.logError(error);
    /*
     * The flow behind force stop answers with diagnostics even when the regular
     * stop inside it failed, so a rejection here does not mean "the stop did
     * not work" - it means the escape hatch never ran. Nothing on screen says
     * so: the control simply stops pulsing and the team stays alive. It is
     * also the last thing the user can try from the app, which is why this one
     * failure gets a dialog while the regular stop beside it, whose answer to
     * failing is this very control, keeps reporting through the log.
     *
     * The dialog is the pattern the app already uses for a failed destructive
     * action; see the failed task delete in `GlobalTaskList`.
     */
    void ports.confirm({
      title: ports.labels.failureTitle,
      message: selectTeamForceStopFailureMessage(error, ports.labels.failureFallbackMessage),
      confirmLabel: ports.labels.failureConfirmLabel,
      variant: 'danger',
    });
    return 'failed';
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
