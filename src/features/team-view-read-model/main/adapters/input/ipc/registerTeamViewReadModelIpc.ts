import {
  TEAM_GET_DATA,
  TEAM_GET_MEMBER_ACTIVITY_META,
  TEAM_GET_MESSAGES_PAGE,
} from '@features/team-view-read-model/contracts';

import { createTeamViewReadModelIpcHandlers } from './createTeamViewReadModelIpcHandlers';

import type {
  TeamViewReadModelFeature,
  TeamViewReadModelIpcRegistrar,
} from '../../../composition/TeamViewReadModelIpcBoundary';

export function registerTeamViewReadModelIpc(
  ipcMain: TeamViewReadModelIpcRegistrar,
  dependencies: TeamViewReadModelFeature
): void {
  const handlers = createTeamViewReadModelIpcHandlers(dependencies);
  ipcMain.handle(TEAM_GET_DATA, handlers.getData.bind(handlers));
  ipcMain.handle(TEAM_GET_MESSAGES_PAGE, handlers.getMessagesPage.bind(handlers));
  ipcMain.handle(TEAM_GET_MEMBER_ACTIVITY_META, handlers.getMemberActivityMeta.bind(handlers));
}

export function removeTeamViewReadModelIpc(ipcMain: TeamViewReadModelIpcRegistrar): void {
  ipcMain.removeHandler(TEAM_GET_DATA);
  ipcMain.removeHandler(TEAM_GET_MESSAGES_PAGE);
  ipcMain.removeHandler(TEAM_GET_MEMBER_ACTIVITY_META);
}
