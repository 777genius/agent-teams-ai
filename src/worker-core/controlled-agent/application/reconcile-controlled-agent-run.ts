import { randomUUID } from "node:crypto";

import {
  ControlledAgentEventType,
  ControlledAgentRunStatus,
  controlledAgentStatusAllowsLiveController,
  isControlledAgentTerminalStatus,
} from "../domain/controlled-agent";
import type {
  ControlledAgentRun,
  ControlledAgentSession,
} from "../domain/controlled-agent";
import type {
  ControlledAgentEventPort,
  ControlledAgentProviderPort,
  ControllerStateStorePort,
} from "../ports";

export enum ReconcileControlledAgentRunReason {
  SessionMissing = "session_missing",
  RunMissing = "run_missing",
  ProviderStillRunning = "provider_still_running",
  ProviderTerminalStatus = "provider_terminal_status",
  ProviderStatusFailed = "provider_status_failed",
  ProviderCleanupFailed = "provider_cleanup_failed",
}

export type ReconcileControlledAgentRunResult =
  | {
      readonly ok: true;
      readonly reason:
        | ReconcileControlledAgentRunReason.ProviderStillRunning
        | ReconcileControlledAgentRunReason.ProviderTerminalStatus;
      readonly session: ControlledAgentSession;
      readonly run: ControlledAgentRun;
    }
  | {
      readonly ok: false;
      readonly reason:
        | ReconcileControlledAgentRunReason.SessionMissing
        | ReconcileControlledAgentRunReason.RunMissing
        | ReconcileControlledAgentRunReason.ProviderStatusFailed
        | ReconcileControlledAgentRunReason.ProviderCleanupFailed;
      readonly session?: ControlledAgentSession;
      readonly run?: ControlledAgentRun;
      readonly safeMessage?: string;
    };

export type ReconcileControlledAgentRunDeps = {
  readonly stateStore: ControllerStateStorePort;
  readonly provider: ControlledAgentProviderPort;
  readonly events?: ControlledAgentEventPort;
  readonly clock?: { now(): Date };
  readonly idGenerator?: { randomId(): string };
};

export class ReconcileControlledAgentRunUseCase {
  constructor(private readonly deps: ReconcileControlledAgentRunDeps) {}

  async reconcile(sessionId: string): Promise<ReconcileControlledAgentRunResult> {
    const session = await this.deps.stateStore.readSession(sessionId);
    if (!session) {
      return {
        ok: false,
        reason: ReconcileControlledAgentRunReason.SessionMissing,
      };
    }
    const run = session.activeRunId
      ? await this.deps.stateStore.readRun(session.activeRunId)
      : await this.deps.stateStore.readLatestRunForSession(session.sessionId);
    if (!run) {
      return {
        ok: false,
        reason: ReconcileControlledAgentRunReason.RunMissing,
        session,
      };
    }

    let observed;
    try {
      observed = await this.deps.provider.status({ session, run });
    } catch (error) {
      return {
        ok: false,
        reason: ReconcileControlledAgentRunReason.ProviderStatusFailed,
        session,
        run,
        safeMessage: error instanceof Error ? error.message : String(error),
      };
    }

    const persistedStateAllowsLive =
      controlledAgentStatusAllowsLiveController(session.status) &&
      controlledAgentStatusAllowsLiveController(run.status);

    if (observed.status === ControlledAgentRunStatus.Running && persistedStateAllowsLive) {
      await this.appendEvent(session, run, ControlledAgentEventType.RunStatusObserved, {
        status: observed.status,
        providerRunId: observed.providerRunId ?? null,
      });
      return {
        ok: true,
        reason: ReconcileControlledAgentRunReason.ProviderStillRunning,
        session,
        run,
      };
    }

    const now = observed.observedAt ?? (this.deps.clock?.now() ?? new Date()).toISOString();
    const reconcileStatus = observed.status === ControlledAgentRunStatus.Running
      ? terminalPersistedStatus(session, run) ?? ControlledAgentRunStatus.Failed
      : observed.status;
    if (
      isControlledAgentTerminalStatus(observed.status) ||
      observed.status === ControlledAgentRunStatus.Running
    ) {
      try {
        const cleanup = await this.deps.provider.stop({
          session,
          run,
          reason: observed.status === ControlledAgentRunStatus.Running
            ? `controlled_agent_reconcile_persisted_terminal:${reconcileStatus}`
            : `controlled_agent_reconcile_terminal:${observed.status}`,
        });
        if (
          observed.providerAttached === true &&
          cleanup.status === ControlledAgentRunStatus.Failed
        ) {
          return {
            ok: false,
            reason: ReconcileControlledAgentRunReason.ProviderCleanupFailed,
            session,
            run,
            safeMessage: cleanup.safeMessage ??
              "Provider reported failed cleanup for an attached controlled-agent run.",
          };
        }
      } catch (error) {
        return {
          ok: false,
          reason: ReconcileControlledAgentRunReason.ProviderCleanupFailed,
          session,
          run,
          safeMessage: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const safeMessage = safeMessageForReconciledRun({
      observedSafeMessage: observed.safeMessage,
      existingSafeMessage: run.safeMessage,
      observedStatus: observed.status,
      reconcileStatus,
    });
    const reconciledRun: ControlledAgentRun = {
      ...run,
      status: reconcileStatus,
      ...(safeMessage === undefined ? {} : { safeMessage }),
      ...(isControlledAgentTerminalStatus(reconcileStatus) ? { stoppedAt: now } : {}),
      updatedAt: now,
    };
    const { activeRunId: _activeRunId, ...sessionWithoutActiveRun } = session;
    const reconciledSession: ControlledAgentSession = {
      ...sessionWithoutActiveRun,
      status: reconcileStatus,
      updatedAt: now,
    };
    await this.deps.stateStore.saveRun(reconciledRun);
    await this.deps.stateStore.saveSession(reconciledSession);
    await this.appendEvent(
      reconciledSession,
      reconciledRun,
      ControlledAgentEventType.RunReconciled,
      {
        status: reconcileStatus,
        providerRunId: observed.providerRunId ?? null,
      },
    );
    return {
      ok: true,
      reason: ReconcileControlledAgentRunReason.ProviderTerminalStatus,
      session: reconciledSession,
      run: reconciledRun,
    };
  }

  private async appendEvent(
    session: ControlledAgentSession,
    run: ControlledAgentRun,
    type: ControlledAgentEventType,
    payload: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    await this.deps.events?.append({
      schemaVersion: 1,
      eventId: this.deps.idGenerator?.randomId() ?? randomUUID(),
      sessionId: session.sessionId,
      runId: run.runId,
      controllerJobId: session.identity.controllerJobId,
      type,
      occurredAt: (this.deps.clock?.now() ?? new Date()).toISOString(),
      payload,
    });
  }
}

export async function reconcileControlledAgentRun(
  sessionId: string,
  deps: ReconcileControlledAgentRunDeps,
): Promise<ReconcileControlledAgentRunResult> {
  return new ReconcileControlledAgentRunUseCase(deps).reconcile(sessionId);
}

function terminalPersistedStatus(
  session: ControlledAgentSession,
  run: ControlledAgentRun,
): ControlledAgentRunStatus | undefined {
  if (isControlledAgentTerminalStatus(run.status)) return run.status;
  if (isControlledAgentTerminalStatus(session.status)) return session.status;
  return undefined;
}

function safeMessageForReconciledRun(input: {
  readonly observedSafeMessage?: string | undefined;
  readonly existingSafeMessage?: string | undefined;
  readonly observedStatus: ControlledAgentRunStatus;
  readonly reconcileStatus: ControlledAgentRunStatus;
}): string | undefined {
  if (input.observedSafeMessage !== undefined) return input.observedSafeMessage;
  if (input.existingSafeMessage !== undefined) return input.existingSafeMessage;
  if (input.observedStatus === ControlledAgentRunStatus.Running) {
    return `Controlled-agent persisted state is ${input.reconcileStatus}; attached provider run was stopped during reconcile.`;
  }
  return undefined;
}
