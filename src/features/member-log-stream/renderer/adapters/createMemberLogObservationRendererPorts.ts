import { api } from '@renderer/api';

import type { MemberLogObservationRendererPorts } from '../ports/MemberLogObservationRendererPorts';

export function createMemberLogObservationRendererPorts(): MemberLogObservationRendererPorts {
  return {
    readTaskLogs: (teamName, taskId, query) => api.teams.getLogsForTask(teamName, taskId, query),
    readMemberLogs: (teamName, memberName) => api.teams.getMemberLogs(teamName, memberName),
    readMemberLogStream: ({ teamName, memberName, options }) =>
      api.memberLogStream.getMemberLogStream(teamName, memberName, options),
    setStreamTracking: (teamName, enabled) =>
      api.memberLogStream.setMemberLogStreamTracking(teamName, enabled),
    subscribeToChanges: (listener) => {
      const unsubscribe = api.teams.onTeamChange?.((_event, event) => {
        listener({ teamName: event.teamName, type: event.type });
      });
      return typeof unsubscribe === 'function' ? unsubscribe : () => undefined;
    },
  };
}

export const productionMemberLogObservationRendererPorts =
  createMemberLogObservationRendererPorts();
