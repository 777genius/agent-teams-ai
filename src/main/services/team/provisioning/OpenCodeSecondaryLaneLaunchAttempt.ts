import type { TeamRuntimeLaunchResult } from '../runtime/TeamRuntimeAdapter';

/** In-memory ownership of one exact lane attempt, never reconstructed from a manifest. */
export interface OpenCodeSecondaryLaneLaunchAttempt {
  readonly runId: string;
  readonly stopRequested: boolean;
  mayDispatch(): boolean;
  launch(operation: () => Promise<TeamRuntimeLaunchResult>): Promise<TeamRuntimeLaunchResult>;
  wasBlockedBeforeLaunch(): boolean;
  finish(): void;
  cancelAndJoin(): Promise<boolean>;
}

export function createOpenCodeSecondaryLaneLaunchAttempt(
  runId: string,
  isCurrent: () => boolean
): OpenCodeSecondaryLaneLaunchAttempt {
  let stopRequested = false;
  let adapterEntered = false;
  let dispatchEntered = false;
  let result: TeamRuntimeLaunchResult | undefined;
  let resolve!: (neverDispatched: boolean) => void;
  const settled = new Promise<boolean>((done) => {
    resolve = done;
  });
  const wasBlockedBeforeLaunch = (): boolean =>
    !adapterEntered ||
    (!dispatchEntered && result?.runId === runId && result.preLaunchGate?.blocked === true);
  return {
    runId,
    get stopRequested() {
      return stopRequested;
    },
    mayDispatch() {
      if (stopRequested || !isCurrent()) return false;
      // The adapter calls this synchronously at every native bridge handoff.
      dispatchEntered = true;
      return true;
    },
    async launch(operation) {
      adapterEntered = true;
      result = undefined;
      result = await operation();
      return result;
    },
    wasBlockedBeforeLaunch,
    finish() {
      resolve(wasBlockedBeforeLaunch());
    },
    cancelAndJoin() {
      stopRequested = true;
      return dispatchEntered ? Promise.resolve(false) : settled;
    },
  };
}
