import {
  GET_DASHBOARD_RECENT_PROJECTS,
  type RecentProjectsElectronApi,
} from '@features/recent-projects/contracts';
import { ipcRenderer } from 'electron';

export function createRecentProjectsBridge(): RecentProjectsElectronApi {
  return {
    getDashboardRecentProjects: () => ipcRenderer.invoke(GET_DASHBOARD_RECENT_PROJECTS),
  };
}
