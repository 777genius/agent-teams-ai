import {
  TEAM_GET_DATA,
  TEAM_GET_LOGS_FOR_TASK,
  TEAM_GET_MEMBER_ACTIVITY_META,
  TEAM_GET_MESSAGES_PAGE,
} from '@preload/constants/ipcChannels';

import type { TeamReadRecoveryApi } from '../contracts';

export function createTeamReadRecoveryBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
): TeamReadRecoveryApi {
  return {
    getData: (teamName, options) =>
      invoke(
        TEAM_GET_DATA,
        ...(options === undefined ? [teamName] : [teamName, options])
      ) as ReturnType<TeamReadRecoveryApi['getData']>,
    getMessagesPage: (teamName, options) =>
      invoke(TEAM_GET_MESSAGES_PAGE, teamName, options) as ReturnType<
        TeamReadRecoveryApi['getMessagesPage']
      >,
    getMemberActivityMeta: (teamName) =>
      invoke(TEAM_GET_MEMBER_ACTIVITY_META, teamName) as ReturnType<
        TeamReadRecoveryApi['getMemberActivityMeta']
      >,
    getLogsForTask: (teamName, taskId, options) =>
      invoke(TEAM_GET_LOGS_FOR_TASK, teamName, taskId, options) as ReturnType<
        TeamReadRecoveryApi['getLogsForTask']
      >,
  };
}
