import { assessMemberWorkSyncPhase2Readiness } from '../../core/domain';

import type { MemberWorkSyncStatusState, MemberWorkSyncTeamMetrics } from '../../contracts';
import type { MetricsIndexFile } from './JsonMemberWorkSyncStore';

function emptyStateCounts(): Record<MemberWorkSyncStatusState, number> {
  return {
    caught_up: 0,
    needs_sync: 0,
    still_working: 0,
    blocked: 0,
    inactive: 0,
    unknown: 0,
  };
}

export function toMetrics(teamName: string, file: MetricsIndexFile): MemberWorkSyncTeamMetrics {
  const stateCounts = emptyStateCounts();
  const members = Object.values(file.members);
  let actionableItemCount = 0;
  for (const member of members) {
    stateCounts[member.state] += 1;
    actionableItemCount += member.actionableCount;
  }
  const recentEvents = [...file.recentEvents].sort((left, right) =>
    left.recordedAt.localeCompare(right.recordedAt)
  );
  const metrics = {
    teamName,
    generatedAt: new Date().toISOString(),
    memberCount: members.length,
    stateCounts,
    actionableItemCount,
    wouldNudgeCount: recentEvents.filter((event) => event.kind === 'would_nudge').length,
    fingerprintChangeCount: recentEvents.filter((event) => event.kind === 'fingerprint_changed')
      .length,
    reportAcceptedCount: recentEvents.filter((event) => event.kind === 'report_accepted').length,
    reportRejectedCount: recentEvents.filter((event) => event.kind === 'report_rejected').length,
    recentEvents,
  };
  return {
    ...metrics,
    phase2Readiness: assessMemberWorkSyncPhase2Readiness({
      memberCount: metrics.memberCount,
      recentEvents: metrics.recentEvents,
    }),
  };
}
