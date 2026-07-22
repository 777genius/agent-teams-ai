import type { TeamProvisioningProgress } from '@shared/types';

export interface TeamProvisioningStreamSpawnRun {
  teamName: string;
  provisioningComplete: boolean;
  progress: TeamProvisioningProgress;
  memberSpawnStatuses: Map<
    string,
    {
      hardFailure?: boolean;
      bootstrapConfirmed?: boolean;
      runtimeAlive?: boolean;
      agentToolAccepted?: boolean;
    }
  >;
  memberSpawnToolUseIds: Map<string, string>;
  onProgress(progress: TeamProvisioningProgress): void;
}

export interface TeamProvisioningStreamSpawnEventsLogger {
  warn(message: string): void;
}

export interface TeamProvisioningStreamSpawnEventsPorts<
  TRun extends TeamProvisioningStreamSpawnRun,
> {
  logger: TeamProvisioningStreamSpawnEventsLogger;
  setMemberSpawnStatus(
    run: TRun,
    memberName: string,
    status: 'spawning' | 'error',
    error?: string
  ): void;
  appendMemberBootstrapDiagnostic(run: TRun, memberName: string, detail: string): void;
  updateProgress(run: TRun, state: 'assembling', message: string): TeamProvisioningProgress;
}

export function captureTeamSpawnEvents<TRun extends TeamProvisioningStreamSpawnRun>(
  run: TRun,
  content: Record<string, unknown>[],
  ports: TeamProvisioningStreamSpawnEventsPorts<TRun>
): void {
  for (const part of content) {
    if (part.type !== 'tool_use' || part.name !== 'Agent') continue;
    const input = part.input;
    if (!input || typeof input !== 'object') continue;
    const inp = input as Record<string, unknown>;
    const teamName = typeof inp.team_name === 'string' ? inp.team_name.trim() : '';
    const memberName = typeof inp.name === 'string' ? inp.name.trim() : '';
    if (teamName && !memberName) {
      ports.logger.warn(
        `[captureTeamSpawnEvents] Agent call for team "${run.teamName}" is missing name - ` +
          `runtime will spawn an ephemeral subagent instead of a persistent teammate`
      );
      continue;
    }
    if (!memberName) continue;
    if (!teamName) {
      ports.logger.warn(
        `[captureTeamSpawnEvents] Agent call for "${memberName}" is missing team_name - ` +
          `teammate will be an ephemeral subagent, not a persistent member of "${run.teamName}"`
      );
      ports.setMemberSpawnStatus(
        run,
        memberName,
        'error',
        `Agent spawn for "${memberName}" is missing team_name - spawned as ephemeral subagent instead of persistent teammate`
      );
      continue;
    }
    if (teamName !== run.teamName) continue;
    const existing = run.memberSpawnStatuses.get(memberName);
    if (
      existing &&
      !existing.hardFailure &&
      (existing.bootstrapConfirmed || existing.runtimeAlive || existing.agentToolAccepted)
    ) {
      ports.appendMemberBootstrapDiagnostic(
        run,
        memberName,
        'respawn blocked as duplicate - teammate already online'
      );
      continue;
    }
    ports.setMemberSpawnStatus(run, memberName, 'spawning');
    const toolUseId = typeof part.id === 'string' ? part.id.trim() : '';
    if (toolUseId) {
      run.memberSpawnToolUseIds.set(toolUseId, memberName);
    }

    if (
      !run.provisioningComplete &&
      (run.progress.state === 'configuring' || run.progress.state === 'spawning')
    ) {
      const progress = ports.updateProgress(run, 'assembling', `Spawning member ${memberName}...`);
      run.onProgress(progress);
    }
  }
}
