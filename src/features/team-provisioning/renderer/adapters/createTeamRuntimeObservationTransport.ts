import { api } from '@renderer/api';

import type { TeamRuntimeObservationTransportPort } from '../ports/TeamRuntimeObservationPorts';

export function createTeamRuntimeObservationTransport(): TeamRuntimeObservationTransportPort {
  return {
    getMemberSpawnStatuses: (teamName) =>
      api.teams?.getMemberSpawnStatuses?.(teamName) ?? Promise.resolve(null),
    getTeamAgentRuntime: (teamName) =>
      api.teams?.getTeamAgentRuntime?.(teamName) ?? Promise.resolve(null),
  };
}
