import { captureLegacyNativeStop } from './LegacyNativeStopRelease';

import type { TeamLaunchStopAuthority } from '../TeamLaunchStateStore';
import type {
  CapturedLegacyNativeStop,
  LegacyNativeStopRelease,
  LegacyNativeStopRun,
} from './LegacyNativeStopRelease';

const pendingCaptures = new WeakMap<
  LegacyNativeStopRun,
  { captured: CapturedLegacyNativeStop; workSync: boolean }
>();

export interface LegacyNativeStopSourceFence {
  drain(): Promise<void>;
  assertDrained(): void;
  release(): void;
}
export type CaptureLegacyNativeStopSourceFence = (
  teamName: string
) => LegacyNativeStopSourceFence | null;

export interface LegacyNativeStopPublication {
  /** If present, the original Stop must release its team lock before draining. */
  drain?(): Promise<void>;
  release?(): void;
  /** Called only after every existing owned Stop/cancellation/helper branch succeeded. */
  complete(): Promise<boolean>;
}

/** One existing Stop owns the attempt; no background retry or durable side store. */
export function captureLegacyNativeStopPublication(options: {
  teamsBasePath: string;
  run: LegacyNativeStopRun;
  current(): boolean;
  isCurrentAttempt?(): boolean;
  captureSourceFence?: CaptureLegacyNativeStopSourceFence;
  beginStop(teamName: string): Promise<TeamLaunchStopAuthority>;
  publishStopped(
    teamName: string,
    authority: TeamLaunchStopAuthority,
    proof: LegacyNativeStopRelease
  ): Promise<boolean>;
  unavailable?(): void;
}): LegacyNativeStopPublication | null {
  const {
    teamsBasePath,
    run,
    current,
    beginStop,
    publishStopped,
    unavailable,
    captureSourceFence,
  } = options;
  const currentAttempt = () => current() && options.isCurrentAttempt?.() !== false;
  if (!currentAttempt()) return null;
  const teamName = run.teamName,
    runId = run.runId;
  const previous = pendingCaptures.get(run);
  const workSync = captureSourceFence !== undefined;
  if (previous && previous.workSync !== workSync) return null;
  const captured =
    previous?.captured ?? captureLegacyNativeStop(teamsBasePath, run, current, workSync);
  if (!captured) return null;
  let sourceFence: LegacyNativeStopSourceFence | null = null;
  try {
    sourceFence = captureSourceFence?.(teamName) ?? null;
  } catch {
    return null;
  }
  if (workSync && !sourceFence) return null;
  pendingCaptures.set(run, { captured, workSync });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    sourceFence?.release();
  };
  const assertSourceDrained = () => {
    if (released || !currentAttempt()) throw new Error('Original native Stop owner changed');
    sourceFence?.assertDrained();
  };
  const report = () => {
    try {
      unavailable?.();
    } catch {
      /* Proof observation never replaces Stop outcome. */
    }
  };
  // beginStop advances the existing publication epoch synchronously, before its queue await.
  // A synchronous admission call may throw before returning its promise. The
  // bundle keeps that capture distinct from the existing async rejection handler.
  const admit = (): { promise: Promise<TeamLaunchStopAuthority | null> } => ({
    promise: beginStop(teamName).catch(() => {
      report();
      return null;
    }),
  });
  let admission: Promise<TeamLaunchStopAuthority | null>;
  try {
    admission = admit().promise;
  } catch {
    report();
    release();
    return null;
  }
  let completion: Promise<boolean> | undefined;
  return Object.freeze({
    ...(sourceFence
      ? {
          async drain() {
            if (released || !currentAttempt())
              throw new Error('Original native Stop owner changed');
            await sourceFence.drain();
            assertSourceDrained();
          },
          release,
        }
      : {}),
    complete() {
      if (completion === undefined) {
        completion = (async () => {
          const authority = await admission;
          if (
            !authority ||
            !currentAttempt() ||
            released ||
            authority.teamName !== teamName ||
            (authority.freshness?.kind === 'launch'
              ? authority.freshness.runId !== runId
              : authority.freshness?.kind !== 'stop' || authority.freshness.stoppedRunId !== runId)
          )
            return false;
          if (sourceFence) assertSourceDrained();
          const proof = captured.complete(sourceFence ? assertSourceDrained : undefined);
          if (!proof) return false;
          try {
            const published = await publishStopped(teamName, authority, proof);
            if (sourceFence) assertSourceDrained();
            return published && currentAttempt() && !released;
          } catch {
            report();
            return false;
          }
        })().catch(() => {
          report();
          return false;
        });
      }
      return completion;
    },
  });
}

/** Existing owner maps supply authority; a same-name run or new child never inherits it. */
export function captureTrackedLegacyNativeStopPublication(
  teamName: string,
  owners: Pick<
    Parameters<typeof captureLegacyNativeStopPublication>[0],
    'beginStop' | 'publishStopped' | 'unavailable' | 'captureSourceFence' | 'isCurrentAttempt'
  > & {
    getTeamsBasePath(): string;
    getTrackedRunId(teamName: string): string | null;
    runs: ReadonlyMap<string, LegacyNativeStopRun>;
    hasOtherRuntimeOwner(teamName: string): boolean;
  }
): LegacyNativeStopPublication | null {
  try {
    const teamsBasePath = owners.getTeamsBasePath(),
      runId = owners.getTrackedRunId(teamName);
    const run = runId && owners.runs.get(runId);
    if (!run || run.teamName !== teamName) return null;
    const child = run.child,
      sessionId = run.detectedSessionId;
    const current = () => {
      const tracked = owners.getTrackedRunId(teamName),
        retained = owners.runs.get(run.runId);
      return (
        owners.getTeamsBasePath() === teamsBasePath &&
        run.runId === runId &&
        run.teamName === teamName &&
        run.child === child &&
        run.detectedSessionId === sessionId &&
        (!tracked || tracked === runId) &&
        (!retained || retained === run) &&
        !owners.hasOtherRuntimeOwner(teamName) &&
        ![...owners.runs.values()].some((other) => other !== run && other.teamName === teamName) &&
        !run.expectedMembers.length &&
        !run.allEffectiveMembers.length &&
        !run.mixedSecondaryLanes.length
      );
    };
    return captureLegacyNativeStopPublication({ ...owners, teamsBasePath, run, current });
  } catch {
    return null;
  }
}
