import type { MemberFullStats } from '@shared/types';

export interface TeamOperationalLogQuery {
  offset?: number;
  limit?: number;
}

export interface TeamOperationalLogPage {
  lines: string[];
  total: number;
  hasMore: boolean;
  updatedAt?: string;
}

/** Read-only operational projections consumed by team presentation surfaces. */
export interface TeamOperationalReadRendererPorts {
  readLeadLogs(teamName: string, query?: TeamOperationalLogQuery): Promise<TeamOperationalLogPage>;
  readMemberStats(teamName: string, memberName: string): Promise<MemberFullStats>;
}
