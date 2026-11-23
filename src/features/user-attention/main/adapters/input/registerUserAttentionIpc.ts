import { USER_ATTENTION_CHANNEL } from '@features/user-attention/contracts';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';

import type { UserAttentionFeatureFacade } from '../../composition/createUserAttentionFeature';
import type { IpcMain } from 'electron';

export function registerUserAttentionIpc(
  ipcMain: IpcMain,
  feature: UserAttentionFeatureFacade
): void {
  ipcMain.handle(USER_ATTENTION_CHANNEL, (_event, teamName?: unknown) => {
    if (teamName === undefined) return feature.getUserAttentionSnapshot();
    const validated = validateTeamName(teamName);
    if (!validated.valid) throw new Error('Invalid attention team name');
    return feature.getUserAttentionSnapshot(validated.value);
  });
}

export function removeUserAttentionIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(USER_ATTENTION_CHANNEL);
}
