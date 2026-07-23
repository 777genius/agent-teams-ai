import {
  TEAM_ADD_MEMBER,
  TEAM_REMOVE_MEMBER,
  TEAM_REPLACE_MEMBERS,
  TEAM_RESTORE_MEMBER,
  TEAM_UPDATE_MEMBER_ROLE,
} from '../../../../contracts';

import { createTeamRosterMutationIpcHandlers } from './createTeamRosterMutationIpcHandlers';

import type { TeamRosterMutationFeature } from '../../../composition/createTeamRosterMutationFeature';
import type { IpcMain } from 'electron';

export function registerTeamRosterMutationIpc(
  ipcMain: IpcMain,
  feature: TeamRosterMutationFeature
): void {
  const handlers = createTeamRosterMutationIpcHandlers(feature);
  ipcMain.handle(TEAM_ADD_MEMBER, handlers.addMember);
  ipcMain.handle(TEAM_REPLACE_MEMBERS, handlers.replaceMembers);
  ipcMain.handle(TEAM_REMOVE_MEMBER, handlers.removeMember);
  ipcMain.handle(TEAM_RESTORE_MEMBER, handlers.restoreMember);
  ipcMain.handle(TEAM_UPDATE_MEMBER_ROLE, handlers.updateMemberRole);
}

export function removeTeamRosterMutationIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_ADD_MEMBER);
  ipcMain.removeHandler(TEAM_REPLACE_MEMBERS);
  ipcMain.removeHandler(TEAM_REMOVE_MEMBER);
  ipcMain.removeHandler(TEAM_RESTORE_MEMBER);
  ipcMain.removeHandler(TEAM_UPDATE_MEMBER_ROLE);
}
