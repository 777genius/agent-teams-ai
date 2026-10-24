import { captureLegacyNativeStop } from './LegacyNativeStopRelease';

import type { TeamLaunchStopAuthority } from '../TeamLaunchStateStore';
import type {
  CapturedLegacyNativeStop,
  LegacyNativeStopRelease,
  LegacyNativeStopRun,
} from './LegacyNativeStopRelease';

const pendingCaptures = new WeakMap<LegacyNativeStopRun, CapturedLegacyNativeStop>();

export interface LegacyNativeStopPublication {
  /** Called only after every existing owned Stop/cancellation/helper branch succeeded. */
  complete(): Promise<boolean>;
}

/** One existing Stop owns the attempt; no background retry or durable side store. */
export function captureLegacyNativeStopPublication(options: {
  teamsBasePath: string;
  run: LegacyNativeStopRun;
  current(): boolean;
  beginStop(teamName: string): Promise<TeamLaunchStopAuthority>;
  publishStopped(
    teamName: string,
    authority: TeamLaunchStopAuthority,
    proof: LegacyNativeStopRelease
  ): Promise<boolean>;
  unavailable?(): void;
}): LegacyNativeStopPublication | null {
  const { teamsBasePath, run, current, beginStop, publishStopped, unavailable } = options;
  const teamName = run.teamName,
    runId = run.runId;
  const captured = pendingCaptures.get(run) ?? captureLegacyNativeStop(teamsBasePath, run, current);
  if (!captured) return null;
  pendingCaptures.set(run, captured);
  const report = () => {
    try {
      unavailable?.();
    } catch {
      /* Proof observation never replaces Stop outcome. */
    }
  };
  // beginStop advances the existing publication epoch synchronously, before its queue await.
  let admission: Promise<TeamLaunchStopAuthority | null>;
  try {
    admission = beginStop(teamName).catch(() => {
      report();
      return null;
    });
  } catch {
    report();
    return null;
  }
  let completion: Promise<boolean> | undefined;
  return Object.freeze({
    complete() {
      return (completion ??= (async () => {
        const authority = await admission;
        if (
          !authority ||
          !current() ||
          authority.teamName !== teamName ||
          (authority.freshness?.kind === 'launch'
            ? authority.freshness.runId !== runId
            : authority.freshness?.kind !== 'stop' || authority.freshness.stoppedRunId !== runId)
        )
          return false;
        const proof = captured.complete();
        if (!proof) return false;
        try {
          return await publishStopped(teamName, authority, proof);
        } catch {
          report();
          return false;
        }
      })().catch(() => {
        report();
        return false;
      }));
    },
  });
}

/** Existing owner maps supply authority; a same-name run or new child never inherits it. */
export function captureTrackedLegacyNativeStopPublication(
  teamName: string,
  owners: Pick<
    Parameters<typeof captureLegacyNativeStopPublication>[0],
    'beginStop' | 'publishStopped' | 'unavailable'
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
