export function shouldCacheMemberSpawnStatusesSnapshot(run: {
  isLaunch: boolean;
  provisioningComplete: boolean;
}): boolean {
  return run.isLaunch === true && run.provisioningComplete !== true;
}

export function isMemberSpawnStatusesSnapshotReadCurrent(params: {
  teamName: string;
  runIdAtStart: string | null;
  generationAtStart: number;
  ports: {
    getRun(runId: string): { runId: string } | undefined | null;
    cache: {
      getCacheGeneration(teamName: string): number;
      getTrackedRunId(teamName: string): string | null;
    };
  };
}): boolean {
  const trackedRunId = params.ports.cache.getTrackedRunId(params.teamName);
  return (
    params.ports.cache.getCacheGeneration(params.teamName) === params.generationAtStart &&
    (trackedRunId ? (params.ports.getRun(trackedRunId)?.runId ?? null) : null) ===
      params.runIdAtStart
  );
}
