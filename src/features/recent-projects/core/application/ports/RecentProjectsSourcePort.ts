import type { RecentProjectCandidate } from '../../domain/models/RecentProjectCandidate';

export interface RecentProjectsSourceResult {
  candidates: RecentProjectCandidate[];
  degraded: boolean;
}

export type RecentProjectsSourcePayload = RecentProjectsSourceResult | RecentProjectCandidate[];

export interface RecentProjectsSourcePort {
  readonly sourceId?: string;
  readonly timeoutMs?: number;
  list(): Promise<RecentProjectsSourcePayload>;
}
