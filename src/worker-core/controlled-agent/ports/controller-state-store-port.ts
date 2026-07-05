import type {
  ControlledAgentEvent,
  ControlledAgentRun,
  ControlledAgentSession,
} from "../domain/controlled-agent";

export interface ControllerStateStorePort {
  readSession(sessionId: string): Promise<ControlledAgentSession | null> | ControlledAgentSession | null;
  saveSession(session: ControlledAgentSession): Promise<void> | void;
  readRun(runId: string): Promise<ControlledAgentRun | null> | ControlledAgentRun | null;
  readLatestRunForSession(
    sessionId: string,
  ): Promise<ControlledAgentRun | null> | ControlledAgentRun | null;
  saveRun(run: ControlledAgentRun): Promise<void> | void;
}

export interface ControlledAgentEventPort {
  append(event: ControlledAgentEvent): Promise<void> | void;
}
