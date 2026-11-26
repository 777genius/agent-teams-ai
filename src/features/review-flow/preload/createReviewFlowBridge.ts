import { ipcRenderer } from 'electron';

import {
  REVIEW_FLOW_GET_OVERVIEW,
  REVIEW_FLOW_SET_DEFAULTS,
  REVIEW_FLOW_SET_TEAM_OVERRIDE,
  type ReviewFlowElectronApi,
  type ReviewFlowIpcResult,
} from '../contracts';

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as ReviewFlowIpcResult<T>;
  // Only the message crosses the context bridge: a known error travels as its code.
  if (!result.ok) throw new Error(result.code ?? result.error);
  return result.value;
}

export function createReviewFlowBridge(): ReviewFlowElectronApi {
  return {
    getOverview: () => invoke(REVIEW_FLOW_GET_OVERVIEW),
    setDefaults: (settings) => invoke(REVIEW_FLOW_SET_DEFAULTS, settings),
    setTeamOverride: (teamName, settings) =>
      invoke(REVIEW_FLOW_SET_TEAM_OVERRIDE, teamName, settings),
  };
}
