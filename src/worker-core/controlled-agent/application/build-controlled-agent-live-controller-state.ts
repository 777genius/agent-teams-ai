import {
  ControlledAgentRunStatus,
  controlledAgentStatusAllowsLiveController,
  type ControlledAgentProcessOwner,
  type ControlledAgentSession,
} from "../domain/controlled-agent";

export type ControlledAgentLiveControllerState = {
  readonly providerRunnerAttached: boolean;
  readonly providerStatusFailed: boolean;
  readonly live: boolean;
  readonly currentOwner: ControlledAgentProcessOwner;
  readonly persistedOwner?: ControlledAgentProcessOwner;
  readonly persistedStatus?: ControlledAgentRunStatus;
  readonly persistedRunStatus?: ControlledAgentRunStatus;
  readonly providerObservedStatus?: ControlledAgentRunStatus;
  readonly ownerMatches: boolean;
  readonly safeMessage: string;
};

export type BuildControlledAgentLiveControllerStateInput = {
  readonly session?: ControlledAgentSession | undefined;
  readonly providerAttached: boolean;
  readonly currentOwner: ControlledAgentProcessOwner;
  readonly persistedRunStatus?: ControlledAgentRunStatus | undefined;
  readonly providerObservedStatus?: ControlledAgentRunStatus | undefined;
  readonly providerStatusFailed?: boolean | undefined;
};

export function buildControlledAgentLiveControllerState(
  input: BuildControlledAgentLiveControllerStateInput,
): ControlledAgentLiveControllerState {
  const persistedOwner = input.session?.owner;
  const persistedStatus = input.session?.status;
  const ownerMatches = persistedOwner?.ownerId === input.currentOwner.ownerId;
  const providerStatusFailed = input.providerStatusFailed === true;
  const observedStatusAllowsLive = controlledAgentStatusAllowsLiveController(
    input.providerObservedStatus,
  );
  const sessionStatusAllowsLive = controlledAgentStatusAllowsLiveController(
    persistedStatus,
  );
  const runStatusAllowsLive = input.persistedRunStatus === undefined ||
    controlledAgentStatusAllowsLiveController(input.persistedRunStatus);
  const live = input.providerAttached &&
    !providerStatusFailed &&
    ownerMatches &&
    sessionStatusAllowsLive &&
    runStatusAllowsLive &&
    observedStatusAllowsLive;

  return {
    providerRunnerAttached: input.providerAttached,
    providerStatusFailed,
    live,
    currentOwner: input.currentOwner,
    ...(persistedOwner === undefined ? {} : { persistedOwner }),
    ...(persistedStatus === undefined ? {} : { persistedStatus }),
    ...(input.persistedRunStatus === undefined ? {} : {
      persistedRunStatus: input.persistedRunStatus,
    }),
    ...(input.providerObservedStatus === undefined ? {} : {
      providerObservedStatus: input.providerObservedStatus,
    }),
    ownerMatches,
    safeMessage: controlledAgentLiveControllerSafeMessage({
      providerAttached: input.providerAttached,
      providerStatusFailed,
      live,
      persistedOwner,
      persistedStatus,
      persistedRunStatus: input.persistedRunStatus,
      ownerMatches,
      providerObservedStatus: input.providerObservedStatus,
    }),
  };
}

function controlledAgentLiveControllerSafeMessage(input: {
  readonly providerAttached: boolean;
  readonly providerStatusFailed: boolean;
  readonly live: boolean;
  readonly persistedOwner?: ControlledAgentProcessOwner | undefined;
  readonly persistedStatus?: ControlledAgentRunStatus | undefined;
  readonly persistedRunStatus?: ControlledAgentRunStatus | undefined;
  readonly ownerMatches: boolean;
  readonly providerObservedStatus?: ControlledAgentRunStatus | undefined;
}): string {
  if (!input.providerAttached) {
    return input.persistedOwner
      ? "Persisted controller state exists, but this process does not own the provider runner."
      : "No persisted live controller owner is recorded.";
  }
  if (input.live) {
    return "Provider runner is attached to this durable MCP process.";
  }
  if (input.providerStatusFailed) {
    return "Provider runner is attached, but provider status probe failed.";
  }
  if (!input.ownerMatches) {
    return "Provider runner is attached, but persisted owner metadata does not match this process.";
  }
  if (input.persistedStatus !== ControlledAgentRunStatus.Running) {
    return "Provider runner is attached, but persisted controller status is not running.";
  }
  if (
    input.persistedRunStatus !== undefined &&
    input.persistedRunStatus !== ControlledAgentRunStatus.Running
  ) {
    return "Provider runner is attached, but persisted controller run status is not running.";
  }
  if (
    input.providerObservedStatus !== ControlledAgentRunStatus.Running
  ) {
    return input.providerObservedStatus === undefined
      ? "Provider runner is attached, but provider status has not confirmed running."
      : "Provider runner is attached, but observed provider status is not running.";
  }
  return "Provider runner is attached, but live controller ownership is not proven.";
}
