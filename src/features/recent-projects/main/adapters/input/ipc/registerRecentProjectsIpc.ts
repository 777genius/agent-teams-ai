import {
  GET_DASHBOARD_RECENT_PROJECTS,
  normalizeDashboardRecentProjectsPayload,
} from '@features/recent-projects/contracts';
import { createLogger } from '@shared/utils/logger';

import type { RecentProjectsFeatureFacade } from '@features/recent-projects/main/composition/createRecentProjectsFeature';
import type { IpcMain } from 'electron';

const logger = createLogger('Feature:RecentProjects:IPC');

export function registerRecentProjectsIpc(
  ipcMain: IpcMain,
  feature: RecentProjectsFeatureFacade
): void {
  ipcMain.handle(GET_DASHBOARD_RECENT_PROJECTS, async () => {
    try {
      return (
        normalizeDashboardRecentProjectsPayload(await feature.listDashboardRecentProjects()) ?? {
          projects: [],
          degraded: true,
        }
      );
    } catch (error) {
      logger.error('Failed to load dashboard recent projects via IPC', error);
      return { projects: [], degraded: true };
    }
  });
}

export function removeRecentProjectsIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(GET_DASHBOARD_RECENT_PROJECTS);
}
