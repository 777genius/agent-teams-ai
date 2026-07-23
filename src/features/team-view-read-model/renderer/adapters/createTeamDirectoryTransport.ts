import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import type { TeamDirectoryTransportPort } from '../ports/TeamDirectoryRendererPorts';

const TEAM_FETCH_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout after ${ms}ms: ${label}`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function createTeamDirectoryTransport(): TeamDirectoryTransportPort {
  return {
    getAllTasks: () =>
      withTimeout(
        unwrapIpc('team:getAllTasks', () => api.teams.getAllTasks()),
        TEAM_FETCH_TIMEOUT_MS,
        'fetchAllTasks'
      ),
    getProjectBranch: (path) => api.teams.getProjectBranch(path),
    listTeams: () =>
      withTimeout(
        unwrapIpc('team:list', () => api.teams.list()),
        TEAM_FETCH_TIMEOUT_MS,
        'fetchTeams'
      ),
  };
}
