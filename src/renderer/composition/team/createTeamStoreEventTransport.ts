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

const noOpCleanup = (): void => undefined;

export function createTeamStoreEventTransport(): TeamStoreEventTransport {
  return {
    trackChangePresence: (teamName, enabled) => {
      const teams = api.teams;
      return teams?.setChangePresenceTracking?.call(teams, teamName, enabled) ?? Promise.resolve();
    },
    trackTaskLogs: (teamName, enabled) => {
      const teams = api.teams;
      return teams?.setTaskLogStreamTracking?.call(teams, teamName, enabled) ?? Promise.resolve();
    },
    trackToolActivity: (teamName, enabled) => {
      const teams = api.teams;
      return teams?.setToolActivityTracking?.call(teams, teamName, enabled) ?? Promise.resolve();
    },
    subscribeToProjectBranchChanges: (listener) => {
      const teams = api.teams;
      return (
        teams?.onProjectBranchChange?.call(teams, (_event, event) => listener(event)) ?? noOpCleanup
      );
    },
    subscribeToTeamChanges: (listener) => {
      const teams = api.teams;
      return teams?.onTeamChange?.call(teams, (_event, event) => listener(event)) ?? noOpCleanup;
    },
    subscribeToToolApprovalEvents: (listener) => {
      const teams = api.teams;
      return (
        teams?.onToolApprovalEvent?.call(teams, (_event, event) => listener(event)) ?? noOpCleanup
      );
    },
  };
}
