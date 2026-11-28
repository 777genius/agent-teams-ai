import {
  monitorFailure,
  PR_MONITOR_CHANNEL,
  PR_MONITOR_CONSENT_CHANNEL,
  PR_MONITOR_LOGIN_CHANNEL,
} from '../../../contracts';

import type { PrMonitorFeature } from '../../composition/createPrMonitorFeature';
import type { IpcMain } from 'electron';

export function registerPrMonitorIpc(
  ipcMain: IpcMain,
  feature: PrMonitorFeature,
  senderId: () => number | undefined,
  trustedUrl: (url: string) => boolean
): () => void {
  ipcMain.handle(PR_MONITOR_CHANNEL, (event, request: unknown) => {
    if (
      event.sender.id !== senderId() ||
      event.senderFrame !== event.sender.mainFrame ||
      !trustedUrl(event.senderFrame?.url ?? '')
    )
      return monitorFailure('forbidden', 'Open Pull Requests in the desktop window.');
    return feature.read(request);
  });
  ipcMain.handle(PR_MONITOR_CONSENT_CHANNEL, (event, request: unknown, enabled: unknown) => {
    if (
      event.sender.id !== senderId() ||
      event.senderFrame !== event.sender.mainFrame ||
      !trustedUrl(event.senderFrame?.url ?? '') ||
      typeof enabled !== 'boolean'
    )
      return monitorFailure('forbidden', 'Open Pull Requests in the desktop window.');
    return feature.consent(request, enabled);
  });
  ipcMain.handle(PR_MONITOR_LOGIN_CHANNEL, (event, request: unknown) => {
    if (
      event.sender.id !== senderId() ||
      event.senderFrame !== event.sender.mainFrame ||
      !trustedUrl(event.senderFrame?.url ?? '')
    )
      return monitorFailure('forbidden', 'Open Pull Requests in the desktop window.');
    return feature.login(request);
  });
  return () => {
    ipcMain.removeHandler(PR_MONITOR_CHANNEL);
    ipcMain.removeHandler(PR_MONITOR_CONSENT_CHANNEL);
    ipcMain.removeHandler(PR_MONITOR_LOGIN_CHANNEL);
  };
}
