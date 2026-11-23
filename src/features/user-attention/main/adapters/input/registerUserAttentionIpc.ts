import { USER_ATTENTION_CHANNEL } from '@features/user-attention/contracts';

import type { UserAttentionFeatureFacade } from '../../composition/createUserAttentionFeature';
import type { IpcMain } from 'electron';

export function registerUserAttentionIpc(
  ipcMain: IpcMain,
  feature: UserAttentionFeatureFacade
): void {
  ipcMain.handle(USER_ATTENTION_CHANNEL, (_event, teamName?: unknown) => {
    if (teamName !== undefined &&
        (typeof teamName !== 'string' || !/^[\w.-]{1,128}$/.test(teamName))) {
      throw new Error('Invalid attention team name');
    }
    return feature.getUserAttentionSnapshot(teamName as string | undefined);
  });
}

export function removeUserAttentionIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(USER_ATTENTION_CHANNEL);
}
