import type {
  ControlledAgentRun,
  ControlledAgentSession,
} from "../domain/controlled-agent";
import type {
  ControlledAgentProviderPort,
  ControlledAgentProviderStatusResult,
  ControllerStateStorePort,
} from "../ports";

export enum ControlledAgentStatusReason {
  SessionMissing = "session_missing",
  RunMissing = "run_missing",
  ProviderStatusUnavailable = "provider_status_unavailable",
  StatusObserved = "status_observed",
}

export type GetControlledAgentStatusResult =
  | {
      readonly ok: true;
      readonly reason: ControlledAgentStatusReason.StatusObserved;
      readonly session: ControlledAgentSession;
      readonly run: ControlledAgentRun;
      readonly provider: ControlledAgentProviderStatusResult;
    }
  | {
      readonly ok: true;
      readonly reason: ControlledAgentStatusReason.ProviderStatusUnavailable;
      readonly session: ControlledAgentSession;
      readonly run: ControlledAgentRun;
    }
  | {
      readonly ok: false;
      readonly reason:
        | ControlledAgentStatusReason.SessionMissing
        | ControlledAgentStatusReason.RunMissing;
      readonly session?: ControlledAgentSession;
    };

export type GetControlledAgentStatusDeps = {
  readonly stateStore: ControllerStateStorePort;
  readonly provider?: ControlledAgentProviderPort;
};

export class GetControlledAgentStatusUseCase {
  constructor(private readonly deps: GetControlledAgentStatusDeps) {}

  async get(sessionId: string): Promise<GetControlledAgentStatusResult> {
    const session = await this.deps.stateStore.readSession(sessionId);
    if (!session) {
      return {
        ok: false,
        reason: ControlledAgentStatusReason.SessionMissing,
      };
    }
    const run = session.activeRunId
      ? await this.deps.stateStore.readRun(session.activeRunId)
      : await this.deps.stateStore.readLatestRunForSession(session.sessionId);
    if (!run) {
      return {
        ok: false,
        reason: ControlledAgentStatusReason.RunMissing,
        session,
      };
    }
    if (!this.deps.provider) {
      return {
        ok: true,
        reason: ControlledAgentStatusReason.ProviderStatusUnavailable,
        session,
        run,
      };
    }
    return {
      ok: true,
      reason: ControlledAgentStatusReason.StatusObserved,
      session,
      run,
      provider: await this.deps.provider.status({ session, run }),
    };
  }
}

export async function getControlledAgentStatus(
  sessionId: string,
  deps: GetControlledAgentStatusDeps,
): Promise<GetControlledAgentStatusResult> {
  return new GetControlledAgentStatusUseCase(deps).get(sessionId);
}
