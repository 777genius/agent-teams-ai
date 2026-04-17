import type { DashboardRecentProject, DashboardRecentProjectsPayload } from './dto';

export type DashboardRecentProjectsPayloadLike =
  | DashboardRecentProjectsPayload
  | DashboardRecentProject[]
  | { degraded?: unknown; projects?: unknown }
  | null
  | undefined;

export function normalizeDashboardRecentProjectsPayload(
  value: DashboardRecentProjectsPayloadLike
): DashboardRecentProjectsPayload | null {
  if (!value) {
    return null;
  }

  if (Array.isArray(value)) {
    return {
      projects: value,
      degraded: false,
    };
  }

  if (!Array.isArray(value.projects)) {
    return null;
  }

  return {
    projects: value.projects,
    degraded: value.degraded === true,
  };
}
