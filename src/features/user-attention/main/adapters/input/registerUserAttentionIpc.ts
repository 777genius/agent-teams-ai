import { USER_ATTENTION_CHANNEL } from '@features/user-attention/contracts';

import { validateAttentionTeamSelection } from './validateAttentionTeamSelection';

import type { UserAttentionFeatureFacade } from '../../composition/createUserAttentionFeature';
import type { IpcMain } from 'electron';

export function registerUserAttentionIpc(
  ipcMain: IpcMain,
  feature: UserAttentionFeatureFacade
): void {
  ipcMain.handle(USER_ATTENTION_CHANNEL, (_event, teamName?: unknown) => {
    if (teamName === undefined) return feature.getUserAttentionSnapshot();
    return feature.getUserAttentionSnapshot(validateAttentionTeamSelection(teamName));
  });
}

export function removeUserAttentionIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(USER_ATTENTION_CHANNEL);
}
