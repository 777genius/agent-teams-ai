import type { DashboardRecentProjectsPayload } from './dto';

export interface RecentProjectsElectronApi {
  getDashboardRecentProjects(): Promise<DashboardRecentProjectsPayload>;
}
