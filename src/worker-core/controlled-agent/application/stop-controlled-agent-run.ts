import { randomUUID } from "node:crypto";

import {
  ControlledAgentEventType,
  ControlledAgentRunStatus,
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

export enum StopControlledAgentRunReason {
  SessionMissing = "session_missing",
  RunMissing = "run_missing",
  AlreadyStopped = "already_stopped",
  Stopped = "stopped",
}

export type StopControlledAgentRunResult =
  | {
      readonly ok: true;
      readonly reason:
        | StopControlledAgentRunReason.AlreadyStopped
        | StopControlledAgentRunReason.Stopped;
      readonly session: ControlledAgentSession;
      readonly run: ControlledAgentRun;
    }
  | {
      readonly ok: false;
      readonly reason:
        | StopControlledAgentRunReason.SessionMissing
        | StopControlledAgentRunReason.RunMissing;
      readonly session?: ControlledAgentSession;
    };

export type StopControlledAgentRunDeps = {
  readonly stateStore: ControllerStateStorePort;
  readonly provider: ControlledAgentProviderPort;
  readonly events?: ControlledAgentEventPort;
  readonly clock?: { now(): Date };
  readonly idGenerator?: { randomId(): string };
};

export class StopControlledAgentRunUseCase {
  constructor(private readonly deps: StopControlledAgentRunDeps) {}

  async stop(input: {
    readonly sessionId: string;
    readonly reason?: string;
  }): Promise<StopControlledAgentRunResult> {
    const session = await this.deps.stateStore.readSession(input.sessionId);
    if (!session) {
      return { ok: false, reason: StopControlledAgentRunReason.SessionMissing };
    }
    const run = session.activeRunId
      ? await this.deps.stateStore.readRun(session.activeRunId)
      : await this.deps.stateStore.readLatestRunForSession(session.sessionId);
    if (!run) {
      return {
        ok: false,
        reason: StopControlledAgentRunReason.RunMissing,
        session,
      };
    }
    if (run.status !== ControlledAgentRunStatus.Running) {
      return {
        ok: true,
        reason: StopControlledAgentRunReason.AlreadyStopped,
        session,
        run,
      };
    }

    const provider = await this.deps.provider.stop({
      session,
      run,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    const now = provider.stoppedAt ?? (this.deps.clock?.now() ?? new Date()).toISOString();
    const stoppedRun: ControlledAgentRun = {
      ...run,
      status: provider.status,
      ...(provider.safeMessage === undefined ? {} : {
        safeMessage: provider.safeMessage,
      }),
      stoppedAt: now,
      updatedAt: now,
    };
    const { activeRunId: _activeRunId, ...sessionWithoutActiveRun } = session;
    const stoppedSession: ControlledAgentSession = {
      ...sessionWithoutActiveRun,
      status: provider.status,
      updatedAt: now,
    };
    await this.deps.stateStore.saveRun(stoppedRun);
    await this.deps.stateStore.saveSession(stoppedSession);
    await this.deps.events?.append({
      schemaVersion: 1,
      eventId: this.deps.idGenerator?.randomId() ?? randomUUID(),
      sessionId: stoppedSession.sessionId,
      runId: stoppedRun.runId,
      controllerJobId: stoppedSession.identity.controllerJobId,
      type: ControlledAgentEventType.RunStopped,
      occurredAt: now,
      payload: {
        status: stoppedRun.status,
        reason: input.reason ?? null,
      },
    });
    return {
      ok: true,
      reason: StopControlledAgentRunReason.Stopped,
      session: stoppedSession,
      run: stoppedRun,
    };
  }
}

export async function stopControlledAgentRun(
  input: { readonly sessionId: string; readonly reason?: string },
  deps: StopControlledAgentRunDeps,
): Promise<StopControlledAgentRunResult> {
  return new StopControlledAgentRunUseCase(deps).stop(input);
}
