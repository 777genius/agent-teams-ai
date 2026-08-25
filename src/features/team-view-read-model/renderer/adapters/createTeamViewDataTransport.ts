import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import { getTeamDataRequestLabel } from '../utils/teamViewDataRequestKeys';

import type { TeamViewDataTransportPort } from '../ports/TeamViewDataRendererPorts';

const TEAM_GET_DATA_TIMEOUT_MS = 30_000;

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

export function createTeamViewDataTransport(): TeamViewDataTransportPort {
  return {
    getData: (teamName, options) =>
      withTimeout(
        unwrapIpc('team:getData', () =>
          options === undefined ? api.teams.getData(teamName) : api.teams.getData(teamName, options)
        ),
        TEAM_GET_DATA_TIMEOUT_MS,
        getTeamDataRequestLabel(teamName, options)
      ),
    invalidateTaskChangeSummaries: (teamName, taskIds) =>
      api.review.invalidateTaskChangeSummaries(teamName, taskIds),
  };
}
