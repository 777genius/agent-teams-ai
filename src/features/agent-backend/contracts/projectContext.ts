import type { BackendHandle } from './index';
import type { BackendRosterReplacement } from './roster';
import type { ProjectLaunchSettings } from '@agent-teams/legacy-agent-host/team-project-context/contracts';
import type { TeamProjectContextView } from '@features/team-project-context/contracts';
import type { TeamLaunchRequest } from '@shared/types/team';

export interface BackendProjectContextPrepare {
  projectPath: string;
  expectedRevision?: string;
  rosterCommandId?: string;
  launchSettings?: ProjectLaunchSettings;
}
export interface BackendProjectReadinessLocator {
  logicalHandleId: string;
  commandId: string;
}
export interface BackendProjectContextSnapshot {
  kind: 'team-project-context';
  view: TeamProjectContextView;
  histories: { executionTeamName: string; workContextId: string; projectPath: string }[];
  prepared?: { executionHandle: BackendHandle; rosterCommandId: string; sourceRevision: string };
}
export interface BackendProjectLaunchSource {
  kind: 'team-project-launch-source';
  logicalHandleId: string;
  sourceRevision: string;
  probeRevision: string;
  roster: { commandId: string; expected: BackendRosterReplacement };
}
export interface BackendProjectContextOperations {
  'team.project-context.read': { projectPath?: string; scheduleAdmission?: true };
  'team.project-context.prepare': BackendProjectContextPrepare;
  'team.project-context.launch-source.read': BackendProjectReadinessLocator;
}

/** JSON-safe explicit clears; one-run prompt stays in the original launch command. */
export function captureHostProjectLaunchSettings(
  request: Partial<TeamLaunchRequest>
): ProjectLaunchSettings {
  const result: Record<string, unknown> = {};
  for (const key of [
    'providerId',
    'providerBackendId',
    'model',
    'effort',
    'fastMode',
    'syncModelsWithLead',
    'limitContext',
    'skipPermissions',
    'worktree',
    'extraCliArgs',
  ] as const) {
    if (!Object.hasOwn(request, key)) continue;
    const value = request[key];
    if (value === undefined && ['providerId', 'syncModelsWithLead', 'limitContext'].includes(key))
      continue;
    result[key] = value ?? null;
  }
  return result as ProjectLaunchSettings;
}
