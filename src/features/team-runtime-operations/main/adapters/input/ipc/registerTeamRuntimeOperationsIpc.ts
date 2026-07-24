import {
  TEAM_ALIVE_LIST,
  TEAM_GET_AGENT_RUNTIME,
  TEAM_GET_CLAUDE_LOGS,
  TEAM_GET_LOGS_FOR_TASK,
  TEAM_GET_MEMBER_LOGS,
  TEAM_GET_MEMBER_STATS,
  TEAM_KILL_PROCESS,
  TEAM_LEAD_ACTIVITY,
  TEAM_LEAD_CONTEXT,
  TEAM_MEMBER_SPAWN_STATUSES,
  TEAM_RESTART_MEMBER,
  TEAM_RETRY_FAILED_OPENCODE_SECONDARY_LANES,
  TEAM_SKIP_MEMBER_FOR_LAUNCH,
  TEAM_STOP,
} from '../../../../contracts';

import { createTeamRuntimeCommandIpcHandlers } from './createTeamRuntimeCommandIpcHandlers';
import { createTeamRuntimeLogIpcHandlers } from './createTeamRuntimeLogIpcHandlers';
import { createTeamRuntimeReadIpcHandlers } from './createTeamRuntimeReadIpcHandlers';

import type { TeamRuntimeOperationsFeature } from '../../../composition/createTeamRuntimeOperationsFeature';
import type { IpcMain } from 'electron';

const TEAM_RUNTIME_OPERATION_CHANNELS = [
  TEAM_ALIVE_LIST,
  TEAM_GET_AGENT_RUNTIME,
  TEAM_GET_CLAUDE_LOGS,
  TEAM_GET_LOGS_FOR_TASK,
  TEAM_GET_MEMBER_LOGS,
  TEAM_GET_MEMBER_STATS,
  TEAM_KILL_PROCESS,
  TEAM_LEAD_ACTIVITY,
  TEAM_LEAD_CONTEXT,
  TEAM_MEMBER_SPAWN_STATUSES,
  TEAM_RESTART_MEMBER,
  TEAM_RETRY_FAILED_OPENCODE_SECONDARY_LANES,
  TEAM_SKIP_MEMBER_FOR_LAUNCH,
  TEAM_STOP,
] as const;

export function registerTeamRuntimeOperationsIpc(
  ipcMain: IpcMain,
  feature: TeamRuntimeOperationsFeature
): void {
  const logs = createTeamRuntimeLogIpcHandlers(feature);
  const reads = createTeamRuntimeReadIpcHandlers(feature);
  const commands = createTeamRuntimeCommandIpcHandlers(feature);
  ipcMain.handle(TEAM_GET_CLAUDE_LOGS, logs.getClaudeLogs.bind(logs));
  ipcMain.handle(TEAM_GET_MEMBER_LOGS, logs.getMemberLogs.bind(logs));
  ipcMain.handle(TEAM_GET_LOGS_FOR_TASK, logs.getLogsForTask.bind(logs));
  ipcMain.handle(TEAM_GET_MEMBER_STATS, logs.getMemberStats.bind(logs));
  ipcMain.handle(TEAM_ALIVE_LIST, reads.aliveList.bind(reads));
  ipcMain.handle(TEAM_LEAD_ACTIVITY, reads.leadActivity.bind(reads));
  ipcMain.handle(TEAM_LEAD_CONTEXT, reads.leadContext.bind(reads));
  ipcMain.handle(TEAM_MEMBER_SPAWN_STATUSES, reads.memberSpawnStatuses.bind(reads));
  ipcMain.handle(TEAM_GET_AGENT_RUNTIME, reads.getAgentRuntime.bind(reads));
  ipcMain.handle(TEAM_RESTART_MEMBER, commands.restartMember.bind(commands));
  ipcMain.handle(
    TEAM_RETRY_FAILED_OPENCODE_SECONDARY_LANES,
    commands.retryFailedOpenCodeSecondaryLanes.bind(commands)
  );
  ipcMain.handle(TEAM_SKIP_MEMBER_FOR_LAUNCH, commands.skipMemberForLaunch.bind(commands));
  ipcMain.handle(TEAM_STOP, commands.stopTeam.bind(commands));
  ipcMain.handle(TEAM_KILL_PROCESS, commands.killProcess.bind(commands));
}

export function removeTeamRuntimeOperationsIpc(ipcMain: IpcMain): void {
  for (const channel of TEAM_RUNTIME_OPERATION_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}
