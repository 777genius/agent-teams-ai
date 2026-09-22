import type { ListDashboardRecentProjectsResponse } from '../models/ListDashboardRecentProjectsResponse';

export interface ListDashboardRecentProjectsOutputPort<TViewModel> {
  present(response: ListDashboardRecentProjectsResponse): TViewModel;
}
