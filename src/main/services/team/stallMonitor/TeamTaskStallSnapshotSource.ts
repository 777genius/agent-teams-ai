import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';

import {
  type OpenCodeLaneTurnActivityRegistry,
  openCodeLaneTurnActivityRegistry,
} from '../opencode/delivery/OpenCodeLaneTurnActivityRegistry';
import { BoardTaskActivityTranscriptReader } from '../taskLogs/activity/BoardTaskActivityTranscriptReader';
import { isBoardTaskActivityReadEnabled } from '../taskLogs/activity/featureGates';
import { TeamTranscriptSourceLocator } from '../taskLogs/discovery/TeamTranscriptSourceLocator';
import { isBoardTaskExactLogsReadEnabled } from '../taskLogs/exact/featureGates';
import { TeamKanbanManager } from '../TeamKanbanManager';
import { TeamMembersMetaStore } from '../TeamMembersMetaStore';
import { getTeamTaskWorkflowColumn, isTeamTaskActivelyWorked } from '../teamTaskActiveState';
import { TeamTaskReader } from '../TeamTaskReader';

import { BoardTaskActivityBatchIndexer } from './BoardTaskActivityBatchIndexer';
import { OpenCodeTaskStallEvidenceSource } from './OpenCodeTaskStallEvidenceSource';
import { buildResolvedReviewerIndex } from './reviewerResolution';
import { TeamTaskLogFreshnessReader } from './TeamTaskLogFreshnessReader';
import { TeamTaskStallExactRowReader } from './TeamTaskStallExactRowReader';

import type { BoardTaskActivityRecord } from '../taskLogs/activity/BoardTaskActivityRecord';
import type { TeamTaskStallExactRow, TeamTaskStallSnapshot } from './TeamTaskStallTypes';
import type { TeamConfig, TeamMember, TeamProviderId, TeamTask } from '@shared/types';

function resolveLeadNameFromConfig(config: TeamConfig): string {
  const lead = config.members?.find((member) => member.role?.toLowerCase().includes('lead'));
  return lead?.name ?? config.members?.[0]?.name ?? 'team-lead';
}

function normalizeMemberNameKey(name: string | undefined): string | null {
  const normalized = name?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function resolveMemberProvider(member: TeamMember): TeamProviderId | undefined {
  const legacyProvider = (member as { provider?: unknown }).provider;
  return (
    normalizeOptionalTeamProviderId(member.providerId) ??
    normalizeOptionalTeamProviderId(legacyProvider) ??
    inferTeamProviderIdFromModel(member.model)
  );
}

function buildProviderByMemberName(args: {
  configMembers: TeamMember[];
  metaMembers: TeamMember[];
}): Map<string, TeamProviderId> {
  const providerByMemberName = new Map<string, TeamProviderId>();
  for (const member of args.configMembers) {
    const memberName = normalizeMemberNameKey(member.name);
    const providerId = resolveMemberProvider(member);
    if (memberName && providerId) {
      providerByMemberName.set(memberName, providerId);
    }
  }
  for (const member of args.metaMembers) {
    const memberName = normalizeMemberNameKey(member.name);
    const providerId = resolveMemberProvider(member);
    if (memberName && providerId) {
      providerByMemberName.set(memberName, providerId);
    }
  }
  return providerByMemberName;
}

export class TeamTaskStallSnapshotSource {
  constructor(
    private readonly transcriptSourceLocator: TeamTranscriptSourceLocator = new TeamTranscriptSourceLocator(),
    private readonly taskReader: TeamTaskReader = new TeamTaskReader(),
    private readonly kanbanManager: TeamKanbanManager = new TeamKanbanManager(),
    private readonly transcriptReader: BoardTaskActivityTranscriptReader = new BoardTaskActivityTranscriptReader(),
    private readonly activityBatchIndexer: BoardTaskActivityBatchIndexer = new BoardTaskActivityBatchIndexer(),
    private readonly freshnessReader: TeamTaskLogFreshnessReader = new TeamTaskLogFreshnessReader(),
    private readonly exactRowReader: TeamTaskStallExactRowReader = new TeamTaskStallExactRowReader(),
    private readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore(),
    private readonly openCodeEvidenceSource: OpenCodeTaskStallEvidenceSource = new OpenCodeTaskStallEvidenceSource(),
    private readonly laneTurnActivity: OpenCodeLaneTurnActivityRegistry = openCodeLaneTurnActivityRegistry
  ) {}

  async getSnapshot(teamName: string): Promise<TeamTaskStallSnapshot | null> {
    const transcriptContext = await this.transcriptSourceLocator.getContext(teamName);
    if (!transcriptContext) {
      return null;
    }

    const [activeTasks, deletedTasks, kanbanState, metaMembers] = await Promise.all([
      this.taskReader.getTasks(teamName),
      this.taskReader.getDeletedTasks(teamName),
      this.kanbanManager.getState(teamName),
      this.membersMetaStore.getMembers(teamName).catch(() => []),
    ]);
    const withWorkflowOverlay = (task: TeamTask): TeamTask => {
      const kanbanColumn = kanbanState.tasks[task.id]?.column;
      const workflowColumn = getTeamTaskWorkflowColumn({
        ...task,
        ...(kanbanColumn ? { kanbanColumn } : {}),
      });
      if (workflowColumn) {
        return task.reviewState !== workflowColumn
          ? { ...task, reviewState: workflowColumn }
          : task;
      }
      return task.reviewState === 'review' || task.reviewState === 'approved'
        ? { ...task, reviewState: 'none' }
        : task;
    };
    const workflowActiveTasks = activeTasks.map(withWorkflowOverlay);
    const allTasks = [...workflowActiveTasks, ...deletedTasks];
    const allTasksById = new Map(allTasks.map((task) => [task.id, task] as const));
    const inProgressTasks = workflowActiveTasks.filter((task) => {
      const kanbanColumn = kanbanState.tasks[task.id]?.column;
      const workflowColumn = getTeamTaskWorkflowColumn({
        ...task,
        ...(kanbanColumn ? { kanbanColumn } : {}),
      });
      return (
        workflowColumn !== 'review' &&
        isTeamTaskActivelyWorked({
          ...task,
          ...(kanbanColumn ? { kanbanColumn } : {}),
        })
      );
    });
    const reviewOpenTasks = workflowActiveTasks.filter((task) => {
      const kanbanColumn = kanbanState.tasks[task.id]?.column;
      return (
        getTeamTaskWorkflowColumn({
          ...task,
          ...(kanbanColumn ? { kanbanColumn } : {}),
        }) === 'review'
      );
    });
    const resolvedReviewersByTaskId = buildResolvedReviewerIndex(activeTasks, kanbanState);
    const activityReadsEnabled = isBoardTaskActivityReadEnabled();
    const exactReadsEnabled = isBoardTaskExactLogsReadEnabled();
    const providerByMemberName = buildProviderByMemberName({
      configMembers: transcriptContext.config.members ?? [],
      metaMembers,
    });

    let recordsByTaskId = new Map<string, BoardTaskActivityRecord[]>();
    if (
      activityReadsEnabled &&
      allTasks.length > 0 &&
      transcriptContext.transcriptFiles.length > 0
    ) {
      const messages = await this.transcriptReader.readFiles(transcriptContext.transcriptFiles);
      recordsByTaskId = this.activityBatchIndexer.buildIndex({
        teamName,
        tasks: allTasks,
        messages,
      });
    }

    const relevantMonitorTasks = [...inProgressTasks, ...reviewOpenTasks];
    const relevantExactFiles = this.collectRelevantExactFiles(
      relevantMonitorTasks,
      recordsByTaskId
    );
    const [freshnessByTaskId, exactRowsByFilePath, openCodeEvidence] = await Promise.all([
      this.freshnessReader.readSignals(
        transcriptContext.projectDir,
        relevantMonitorTasks.map((task) => task.id),
        { teamName }
      ),
      exactReadsEnabled
        ? this.exactRowReader.parseFiles(relevantExactFiles)
        : Promise.resolve(new Map()),
      activityReadsEnabled && exactReadsEnabled
        ? this.openCodeEvidenceSource.readEvidence({
            teamName,
            tasks: relevantMonitorTasks,
            providerByMemberName,
          })
        : Promise.resolve({
            recordsByTaskId: new Map(),
            exactRowsByFilePath: new Map(),
          }),
    ]);
    const mergedRecordsByTaskId = this.mergeActivityRecords(
      recordsByTaskId,
      openCodeEvidence.recordsByTaskId
    );
    const mergedExactRowsByFilePath = this.mergeExactRows(
      exactRowsByFilePath,
      openCodeEvidence.exactRowsByFilePath
    );

    return {
      teamName,
      scannedAt: new Date().toISOString(),
      projectDir: transcriptContext.projectDir,
      projectId: transcriptContext.projectId,
      leadName: resolveLeadNameFromConfig(transcriptContext.config),
      transcriptFiles: transcriptContext.transcriptFiles,
      activityReadsEnabled,
      exactReadsEnabled,
      activeTasks: workflowActiveTasks,
      deletedTasks,
      allTasksById,
      inProgressTasks,
      reviewOpenTasks,
      resolvedReviewersByTaskId,
      recordsByTaskId: mergedRecordsByTaskId,
      freshnessByTaskId,
      exactRowsByFilePath: mergedExactRowsByFilePath,
      providerByMemberName,
      ...this.collectOpenCodeLaneTurnActivity(teamName),
    };
  }

  private collectOpenCodeLaneTurnActivity(teamName: string): {
    openCodeLaneIdleSinceByMemberName: Map<string, string>;
    openCodeLaneActiveMemberNames: Set<string>;
  } {
    const openCodeLaneIdleSinceByMemberName = new Map<string, string>();
    const openCodeLaneActiveMemberNames = new Set<string>();
    for (const [memberName, sample] of this.laneTurnActivity.listTeam(teamName)) {
      if (sample.state === 'idle') {
        openCodeLaneIdleSinceByMemberName.set(memberName, sample.observedAt);
      } else {
        openCodeLaneActiveMemberNames.add(memberName);
      }
    }
    return { openCodeLaneIdleSinceByMemberName, openCodeLaneActiveMemberNames };
  }

  private mergeActivityRecords(
    base: Map<string, BoardTaskActivityRecord[]>,
    extra: Map<string, BoardTaskActivityRecord[]>
  ): Map<string, BoardTaskActivityRecord[]> {
    if (extra.size === 0) {
      return base;
    }

    const merged = new Map(base);
    for (const [taskId, records] of extra.entries()) {
      const existing = merged.get(taskId) ?? [];
      const seen = new Set(existing.map((record) => record.id));
      const next = [...existing];
      for (const record of records) {
        if (!seen.has(record.id)) {
          next.push(record);
          seen.add(record.id);
        }
      }
      next.sort((left, right) => {
        const timeDiff = Date.parse(left.timestamp) - Date.parse(right.timestamp);
        return timeDiff !== 0 ? timeDiff : left.source.sourceOrder - right.source.sourceOrder;
      });
      merged.set(taskId, next);
    }
    return merged;
  }

  private mergeExactRows(
    base: Map<string, TeamTaskStallExactRow[]>,
    extra: Map<string, TeamTaskStallExactRow[]>
  ): Map<string, TeamTaskStallExactRow[]> {
    if (extra.size === 0) {
      return base;
    }

    const merged = new Map(base);
    for (const [filePath, rows] of extra.entries()) {
      const existing = merged.get(filePath) ?? [];
      const seen = new Set(existing.map((row) => `${row.messageUuid}:${row.sourceOrder}`));
      const next = [...existing];
      for (const row of rows) {
        const key = `${row.messageUuid}:${row.sourceOrder}`;
        if (!seen.has(key)) {
          next.push(row);
          seen.add(key);
        }
      }
      next.sort((left, right) => {
        const orderDiff = left.sourceOrder - right.sourceOrder;
        return orderDiff !== 0
          ? orderDiff
          : Date.parse(left.timestamp) - Date.parse(right.timestamp);
      });
      merged.set(filePath, next);
    }
    return merged;
  }

  private collectRelevantExactFiles(
    inProgressTasks: TeamTask[],
    recordsByTaskId: Map<string, BoardTaskActivityRecord[]>
  ): string[] {
    const filePaths = new Set<string>();

    for (const task of inProgressTasks) {
      const records = recordsByTaskId.get(task.id) ?? [];
      for (const record of records) {
        filePaths.add(record.source.filePath);
      }
    }

    return [...filePaths].sort((left, right) => left.localeCompare(right));
  }
}
