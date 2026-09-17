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
    cache: {
      getCacheGeneration(teamName: string): number;
      getTrackedRunId(teamName: string): string | null;
    };
  };
}): boolean {
  return (
    params.ports.cache.getCacheGeneration(params.teamName) === params.generationAtStart &&
    params.ports.cache.getTrackedRunId(params.teamName) === params.runIdAtStart
  );
}
