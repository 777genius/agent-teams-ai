import { sliceClaudeLogs } from './TeamProvisioningLogSlice';

import type { RetainedClaudeLogsSnapshot } from './TeamProvisioningRetainedLogs';

export interface TeamProvisioningClaudeLogsRunLike {
  claudeLogLines: string[];
  claudeLogsUpdatedAt?: string;
}

export interface TeamProvisioningClaudeLogsPorts {
  runTracking: {
    getTrackedRunId(teamName: string): string | null;
  };
  runs: {
    get(runId: string): TeamProvisioningClaudeLogsRunLike | undefined;
  };
  retainedClaudeLogsByTeam: {
    get(teamName: string): RetainedClaudeLogsSnapshot | undefined;
  };
  readPersistedTranscriptClaudeLogs(teamName: string): Promise<RetainedClaudeLogsSnapshot | null>;
}

export interface TeamProvisioningClaudeLogsQuery {
  offset?: number;
  limit?: number;
}

export type TeamProvisioningClaudeLogsResult = ReturnType<typeof sliceClaudeLogs>;

export async function readTeamProvisioningClaudeLogs(
  teamName: string,
  query: TeamProvisioningClaudeLogsQuery | undefined,
  ports: TeamProvisioningClaudeLogsPorts
): Promise<TeamProvisioningClaudeLogsResult> {
  const runId = ports.runTracking.getTrackedRunId(teamName);
  if (runId) {
    const run = ports.runs.get(runId);
    if (run) {
      return sliceClaudeLogs(run.claudeLogLines, run.claudeLogsUpdatedAt, query);
    }
  }

  const retained = ports.retainedClaudeLogsByTeam.get(teamName);
  if (retained) {
    return sliceClaudeLogs(retained.lines, retained.updatedAt, query);
  }

  const transcriptSnapshot = await ports.readPersistedTranscriptClaudeLogs(teamName);
  if (!transcriptSnapshot) {
    return { lines: [], total: 0, hasMore: false };
  }

  return sliceClaudeLogs(transcriptSnapshot.lines, transcriptSnapshot.updatedAt, query);
}
