import { assessMemberWorkSyncPhase2Readiness } from '../domain';

import type { MemberWorkSyncMetricsRequest, MemberWorkSyncTeamMetrics } from '../../contracts';
import type { MemberWorkSyncUseCaseDeps } from './ports';

function emptyMetrics(teamName: string, generatedAt: string): MemberWorkSyncTeamMetrics {
  return {
    teamName,
    generatedAt,
    memberCount: 0,
    stateCounts: {
      caught_up: 0,
      needs_sync: 0,
      still_working: 0,
      blocked: 0,
      inactive: 0,
      unknown: 0,
    },
    actionableItemCount: 0,
    wouldNudgeCount: 0,
    fingerprintChangeCount: 0,
    reportAcceptedCount: 0,
    reportRejectedCount: 0,
    recentEvents: [],
    phase2Readiness: assessMemberWorkSyncPhase2Readiness({
      memberCount: 0,
      recentEvents: [],
    }),
  };
}

export class MemberWorkSyncMetricsReader {
  constructor(private readonly deps: MemberWorkSyncUseCaseDeps) {}

  async execute(request: MemberWorkSyncMetricsRequest): Promise<MemberWorkSyncTeamMetrics> {
    if (!this.deps.statusStore.readTeamMetrics) {
      return emptyMetrics(request.teamName, this.deps.clock.now().toISOString());
    }
    const metrics = await this.deps.statusStore.readTeamMetrics(request.teamName);
    return {
      ...metrics,
      phase2Readiness:
        metrics.phase2Readiness ??
        assessMemberWorkSyncPhase2Readiness({
          memberCount: metrics.memberCount,
          recentEvents: metrics.recentEvents,
        }),
    };
  }
}
