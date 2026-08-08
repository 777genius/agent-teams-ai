import { api } from '@renderer/api';

import type { ProjectBranchChangeEvent, TeamChangeEvent, ToolApprovalEvent } from '@shared/types';

type TrackingCapability = (teamName: string, enabled: boolean) => Promise<void>;
type Subscription<TEvent> = (listener: (event: TEvent) => void) => () => void;

export interface TeamStoreEventTransport {
  trackChangePresence?: TrackingCapability;
  trackTaskLogs?: TrackingCapability;
  trackToolActivity?: TrackingCapability;
  subscribeToProjectBranchChanges?: Subscription<ProjectBranchChangeEvent>;
  subscribeToTeamChanges?: Subscription<TeamChangeEvent>;
  subscribeToToolApprovalEvents?: Subscription<ToolApprovalEvent>;
}

export function createTeamStoreEventTransport(): TeamStoreEventTransport {
  const teams = api.teams;
  const setChangePresenceTracking = teams?.setChangePresenceTracking?.bind(teams);
  const setTaskLogStreamTracking = teams?.setTaskLogStreamTracking?.bind(teams);
  const setToolActivityTracking = teams?.setToolActivityTracking?.bind(teams);
  const onProjectBranchChange = teams?.onProjectBranchChange?.bind(teams);
  const onTeamChange = teams?.onTeamChange?.bind(teams);
  const onToolApprovalEvent = teams?.onToolApprovalEvent?.bind(teams);

  return {
    ...(setChangePresenceTracking ? { trackChangePresence: setChangePresenceTracking } : undefined),
    ...(setTaskLogStreamTracking ? { trackTaskLogs: setTaskLogStreamTracking } : undefined),
    ...(setToolActivityTracking ? { trackToolActivity: setToolActivityTracking } : undefined),
    ...(onProjectBranchChange
      ? {
          subscribeToProjectBranchChanges: (listener: (event: ProjectBranchChangeEvent) => void) =>
            onProjectBranchChange((_event, event) => listener(event)),
        }
      : undefined),
    ...(onTeamChange
      ? {
          subscribeToTeamChanges: (listener: (event: TeamChangeEvent) => void) =>
            onTeamChange((_event, event) => listener(event)),
        }
      : undefined),
    ...(onToolApprovalEvent
      ? {
          subscribeToToolApprovalEvents: (listener: (event: ToolApprovalEvent) => void) =>
            onToolApprovalEvent((_event, event) => listener(event)),
        }
      : undefined),
  };
}
