import { isLeadMember } from '@shared/utils/leadDetection';
import { calculateTaskImplementationDuration } from '@shared/utils/taskWorkDuration';

import type {
  TeamTaskBoardClockPort,
  TeamTaskLifecyclePort,
} from './ports/TeamTaskBoardInteractionPorts';
import type { CreateTaskRequest, TaskComment, TeamTask, TeamViewSnapshot } from '@shared/types';

export interface TaskLifecycleAnalyticsReporter {
  recordTaskCreate(input: {
    source: 'dialog';
    targetType: 'member' | 'team';
    hasAttachments: false;
    hasTaskRefs: boolean;
    promptLength: number;
    teamSize: number | null;
  }): void;
  recordTaskEnd(input: {
    result: 'completed';
    durationMs: number | null;
    provider: string | null;
    changedFilesCount: number | null;
    reviewRequired: boolean;
    errorClass: 'none';
  }): void;
  recordTaskFirstOutput(input: {
    targetType: 'member' | 'team';
    durationMs: number | null;
    provider: string | null;
    teamSize: number | null;
    hasAttachments: boolean;
    hasTaskRefs: boolean;
  }): void;
}

interface TaskFirstOutputContext {
  startedAtMs: number;
  targetType: 'member' | 'team';
  provider: string | null;
  teamSize: number | null;
  hasAttachments: boolean;
  hasTaskRefs: boolean;
}

function taskKey(teamName: string, taskId: string): string {
  return `${teamName}:${taskId}`;
}

function hasCreateTaskRefs(request: CreateTaskRequest): boolean {
  return (
    (request.descriptionTaskRefs?.length ?? 0) > 0 ||
    (request.promptTaskRefs?.length ?? 0) > 0 ||
    (request.blockedBy?.length ?? 0) > 0 ||
    (request.related?.length ?? 0) > 0
  );
}

function getTaskProviderId(data: TeamViewSnapshot, task: TeamTask): string | null {
  if (!task.owner) return null;
  return data.members.find((member) => member.name === task.owner)?.providerId ?? null;
}

function getProviderIdForMember(data: TeamViewSnapshot | null, memberName?: string): string | null {
  if (!data || !memberName) return null;
  return data.members.find((member) => member.name === memberName)?.providerId ?? null;
}

function getKnownChangedFilesCount(task: TeamTask): number | null {
  return 'changePresence' in task && task.changePresence === 'no_changes' ? 0 : null;
}

function isTaskReviewRequired(task: TeamTask): boolean {
  return (
    task.reviewState === 'review' ||
    task.reviewState === 'needsFix' ||
    ('changePresence' in task &&
      (task.changePresence === 'has_changes' || task.changePresence === 'needs_attention'))
  );
}

function isTeammateTaskComment(comment: TaskComment): boolean {
  const author = comment.author.trim();
  if (!author || author.toLowerCase() === 'user') return false;
  return !isLeadMember({ name: author });
}

export class TaskLifecycleAnalyticsTracker implements TeamTaskLifecyclePort {
  private readonly reportedEndKeys = new Set<string>();
  private readonly reportedFirstOutputKeys = new Set<string>();
  private readonly firstOutputContextByTask = new Map<string, TaskFirstOutputContext>();

  constructor(
    private readonly reporter: TaskLifecycleAnalyticsReporter,
    private readonly clock: TeamTaskBoardClockPort
  ) {}

  recordCreatedTask(
    teamName: string,
    task: TeamTask,
    request: CreateTaskRequest,
    teamData: TeamViewSnapshot | null,
    startedAtMs: number
  ): void {
    const hasTaskRefs = hasCreateTaskRefs(request);
    const targetType = request.owner ? 'member' : 'team';
    const teamSize = teamData?.members.length ?? null;
    this.reporter.recordTaskCreate({
      source: 'dialog',
      targetType,
      hasAttachments: false,
      hasTaskRefs,
      promptLength: request.prompt?.length ?? 0,
      teamSize,
    });
    this.firstOutputContextByTask.set(taskKey(teamName, task.id), {
      startedAtMs,
      targetType,
      provider: getProviderIdForMember(teamData, request.owner),
      teamSize,
      hasAttachments: false,
      hasTaskRefs,
    });
  }

  recordSnapshotTransitions(
    teamName: string,
    previousData: TeamViewSnapshot | null,
    nextData: TeamViewSnapshot
  ): void {
    this.recordTaskEndTransitions(teamName, previousData, nextData);
    this.recordTaskFirstOutputTransitions(teamName, nextData);
  }

  clearTeam(teamName: string): void {
    for (const key of this.firstOutputContextByTask.keys()) {
      if (key.startsWith(`${teamName}:`)) {
        this.firstOutputContextByTask.delete(key);
      }
    }
  }

  reset(): void {
    this.reportedEndKeys.clear();
    this.reportedFirstOutputKeys.clear();
    this.firstOutputContextByTask.clear();
  }

  private recordTaskFirstOutputTransitions(teamName: string, nextData: TeamViewSnapshot): void {
    for (const task of nextData.tasks) {
      const eventKey = taskKey(teamName, task.id);
      const context = this.firstOutputContextByTask.get(eventKey);
      if (!context || this.reportedFirstOutputKeys.has(eventKey)) continue;
      if (!task.comments?.some(isTeammateTaskComment)) continue;

      this.reportedFirstOutputKeys.add(eventKey);
      this.firstOutputContextByTask.delete(eventKey);
      this.reporter.recordTaskFirstOutput({
        targetType: context.targetType,
        durationMs: Math.max(0, this.clock.now() - context.startedAtMs),
        provider: context.provider ?? getTaskProviderId(nextData, task),
        teamSize: context.teamSize,
        hasAttachments: context.hasAttachments,
        hasTaskRefs: context.hasTaskRefs,
      });
    }
  }

  private recordTaskEndTransitions(
    teamName: string,
    previousData: TeamViewSnapshot | null,
    nextData: TeamViewSnapshot
  ): void {
    if (!previousData) return;
    const previousTaskById = new Map(previousData.tasks.map((task) => [task.id, task]));
    for (const task of nextData.tasks) {
      if (task.status !== 'completed') continue;
      const previousTask = previousTaskById.get(task.id);
      if (!previousTask || previousTask.status === 'completed') continue;
      const eventKey = `${teamName}:${task.id}:completed`;
      if (this.reportedEndKeys.has(eventKey)) continue;
      this.reportedEndKeys.add(eventKey);

      const duration = calculateTaskImplementationDuration(task);
      this.reporter.recordTaskEnd({
        result: 'completed',
        durationMs: duration.elapsedMs > 0 ? duration.elapsedMs : null,
        provider: getTaskProviderId(nextData, task),
        changedFilesCount: getKnownChangedFilesCount(task),
        reviewRequired: isTaskReviewRequired(task),
        errorClass: 'none',
      });
    }
  }
}
