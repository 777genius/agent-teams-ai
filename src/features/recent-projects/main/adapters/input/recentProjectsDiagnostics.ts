import type {
  DashboardRecentProject,
  DashboardRecentProjectsPayload,
} from '@features/recent-projects/contracts';

function stringBytes(value: string | undefined): number {
  return value ? Buffer.byteLength(value, 'utf8') : 0;
}

function estimateOpenTargetBytes(openTarget: DashboardRecentProject['openTarget']): number {
  if (openTarget.type === 'existing-worktree') {
    return stringBytes(openTarget.repositoryId) + stringBytes(openTarget.worktreeId) + 48;
  }

  return stringBytes(openTarget.path) + 32;
}

export function estimateDashboardRecentProjectsPayloadBytes(
  payload: DashboardRecentProjectsPayload
): number {
  let bytes = 32;
  for (const project of payload.projects) {
    bytes +=
      160 +
      stringBytes(project.id) +
      stringBytes(project.name) +
      stringBytes(project.primaryPath) +
      stringBytes(project.primaryBranch) +
      estimateOpenTargetBytes(project.openTarget);
    for (const associatedPath of project.associatedPaths) {
      bytes += stringBytes(associatedPath) + 8;
    }
    for (const providerId of project.providerIds) {
      bytes += stringBytes(providerId) + 8;
    }
  }
  return bytes;
}

export function getRecentProjectsMemoryDiagnostics(): {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
} {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
  };
}
