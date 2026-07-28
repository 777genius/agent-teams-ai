import { RuntimeTurnSettledSpoolInitializer } from '../infrastructure/RuntimeTurnSettledSpoolInitializer';

import type {
  MemberWorkSyncMetricsRequest,
  MemberWorkSyncReportRequest,
  MemberWorkSyncReportResult,
  MemberWorkSyncStatus,
  MemberWorkSyncStatusRequest,
  MemberWorkSyncTeamMetrics,
} from '../../contracts';
import type {
  MemberWorkSyncNudgeDispatchSummary,
  MemberWorkSyncPendingReportReplaySummary,
  MemberWorkSyncQueueDiagnostics,
  RuntimeTurnSettledDrainSummary,
} from '../../core/application';
import type { RuntimeTurnSettledProvider } from '../../core/domain';
import type { TeamChangeEvent } from '@shared/types';

export function buildMemberWorkSyncRuntimeTurnSettledEnvironment(input: {
  teamsBasePath: string;
  provider: RuntimeTurnSettledProvider;
}): Promise<Record<string, string> | null> {
  return new RuntimeTurnSettledSpoolInitializer(input.teamsBasePath).buildEnvironment({
    provider: input.provider,
  });
}

export interface MemberWorkSyncFeatureFacade {
  getStatus(request: MemberWorkSyncStatusRequest): Promise<MemberWorkSyncStatus>;
  refreshStatus(request: MemberWorkSyncStatusRequest): Promise<MemberWorkSyncStatus>;
  getMetrics(request: MemberWorkSyncMetricsRequest): Promise<MemberWorkSyncTeamMetrics>;
  report(request: MemberWorkSyncReportRequest): Promise<MemberWorkSyncReportResult>;
  scheduleProofMissingRecovery(
    request: MemberWorkSyncProofMissingRecoveryScheduleRequest
  ): Promise<MemberWorkSyncProofMissingRecoveryScheduleResult>;
  prepareTeamDeletion(teamName: string, deletionIdentityId?: string): Promise<void>;
  completeTeamDeletion(teamName: string): void;
  resumeTeam(teamName: string): void;
  noteTeamChange(event: TeamChangeEvent): void;
  enqueueStartupScan(teamNames: string[]): Promise<void>;
  replayPendingReports(teamNames: string[]): Promise<MemberWorkSyncPendingReportReplaySummary>;
  dispatchDueNudges(teamNames: string[]): Promise<MemberWorkSyncNudgeDispatchSummary>;
  buildRuntimeTurnSettledHookSettings(input: {
    provider: RuntimeTurnSettledProvider;
  }): Promise<Record<string, unknown> | null>;
  buildRuntimeTurnSettledEnvironment(input: {
    provider: RuntimeTurnSettledProvider;
  }): Promise<Record<string, string> | null>;
  drainRuntimeTurnSettledEvents(): Promise<RuntimeTurnSettledDrainSummary>;
  getQueueDiagnostics(): MemberWorkSyncQueueDiagnostics;
  dispose(): Promise<void>;
}

export interface MemberWorkSyncProofMissingRecoveryScheduleRequest {
  teamName: string;
  memberName: string;
  originalMessageId: string;
  taskRefs?: { taskId: string; displayId?: string; teamName?: string }[];
  reason?: string;
}

export interface MemberWorkSyncProofMissingRecoveryScheduleResult {
  scheduled: boolean;
  reason: 'scheduled' | 'coalesced_recent' | 'invalid';
  intentKey?: string;
  existingOutboxId?: string;
}

export function buildProofMissingRecoveryIntentKey(originalMessageId: string): string {
  return `proof-missing:${originalMessageId}`;
}

export function normalizeRecoveryTaskRefs(
  taskRefs: MemberWorkSyncProofMissingRecoveryScheduleRequest['taskRefs']
): { taskId: string; displayId?: string; teamName?: string }[] {
  const seen = new Set<string>();
  const normalized: { taskId: string; displayId?: string; teamName?: string }[] = [];
  for (const taskRef of taskRefs ?? []) {
    const taskId = taskRef.taskId.trim();
    if (!taskId || seen.has(taskId)) {
      continue;
    }
    seen.add(taskId);
    normalized.push({
      taskId,
      ...(taskRef.displayId?.trim() ? { displayId: taskRef.displayId.trim() } : {}),
      ...(taskRef.teamName?.trim() ? { teamName: taskRef.teamName.trim() } : {}),
    });
  }
  return normalized.sort((left, right) => left.taskId.localeCompare(right.taskId));
}
