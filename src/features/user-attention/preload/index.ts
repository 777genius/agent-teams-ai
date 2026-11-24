import { USER_ATTENTION_CHANNEL, type UserAttentionApi } from '@features/user-attention/contracts';
import { ipcRenderer } from 'electron';

export function createUserAttentionBridge(): UserAttentionApi {
  return {
    getUserAttentionSnapshot: (teamName) => ipcRenderer.invoke(USER_ATTENTION_CHANNEL, teamName),
  };
}
