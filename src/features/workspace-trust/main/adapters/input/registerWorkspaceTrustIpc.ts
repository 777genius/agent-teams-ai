import {
  WORKSPACE_TRUST_GET_LAUNCH_STATUS,
  WORKSPACE_TRUST_GET_PROJECT_STATUS,
} from '../../../contracts';

import type { WorkspaceTrustStatusFeatureFacade } from '../../composition/createWorkspaceTrustStatusFeature';
import type { IpcMain } from 'electron';

export function registerWorkspaceTrustIpc(
  ipcMain: IpcMain,
  feature: WorkspaceTrustStatusFeatureFacade
): void {
  ipcMain.handle(WORKSPACE_TRUST_GET_PROJECT_STATUS, async (_event, input: unknown) => {
    try {
      return await feature.getProjectStatus(input);
    } catch {
      return { status: 'unknown' };
    }
  });
  ipcMain.handle(WORKSPACE_TRUST_GET_LAUNCH_STATUS, async (_event, input: unknown) => {
    try {
      return await feature.getLaunchStatus(input);
    } catch {
      // Never forward filesystem/configuration errors across the process boundary.
      throw new Error('Workspace trust status unavailable');
    }
  });
}

export function removeWorkspaceTrustIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(WORKSPACE_TRUST_GET_PROJECT_STATUS);
  ipcMain.removeHandler(WORKSPACE_TRUST_GET_LAUNCH_STATUS);
}
