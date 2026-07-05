import type {
  ControlledAgentRun,
  ControlledAgentRunStatus,
  ControlledAgentSession,
} from "../domain/controlled-agent";

export type ControlledAgentProviderStartInput = {
  readonly session: ControlledAgentSession;
  readonly systemPrompt: string;
};

export type ControlledAgentProviderStartResult = {
  readonly providerRunId?: string;
  readonly safeMessage?: string;
};

export type ControlledAgentProviderStatusInput = {
  readonly session: ControlledAgentSession;
  readonly run: ControlledAgentRun;
};

export type ControlledAgentProviderStatusResult = {
  readonly status: ControlledAgentRunStatus;
  readonly providerRunId?: string;
  readonly safeMessage?: string;
  readonly observedAt?: string;
};

export type ControlledAgentProviderStopInput = {
  readonly session: ControlledAgentSession;
  readonly run: ControlledAgentRun;
  readonly reason?: string;
};

export type ControlledAgentProviderStopResult = {
  readonly status: ControlledAgentRunStatus.Stopped | ControlledAgentRunStatus.Failed;
  readonly safeMessage?: string;
  readonly stoppedAt?: string;
};

export interface ControlledAgentProviderPort {
  start(
    input: ControlledAgentProviderStartInput,
  ): Promise<ControlledAgentProviderStartResult> | ControlledAgentProviderStartResult;

  status(
    input: ControlledAgentProviderStatusInput,
  ): Promise<ControlledAgentProviderStatusResult> | ControlledAgentProviderStatusResult;

  stop(
    input: ControlledAgentProviderStopInput,
  ): Promise<ControlledAgentProviderStopResult> | ControlledAgentProviderStopResult;
}
