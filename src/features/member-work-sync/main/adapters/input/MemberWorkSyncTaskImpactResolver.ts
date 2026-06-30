import { isLeadMember } from '@shared/utils/leadDetection';
import {
  getTeamTaskWorkflowColumn,
  isTeamTaskTerminalForActionableWork,
} from '@shared/utils/teamTaskState';

import {
  normalizeMemberName,
  resolveCurrentReviewOwner,
  sameMemberName,
} from '../../../core/domain';

import type { TeamKanbanManager } from '@main/services/team/TeamKanbanManager';
import type { TeamTaskReader } from '@main/services/team/TeamTaskReader';
import type { TeamTask } from '@shared/types';

export interface MemberWorkSyncTaskImpactResolverDeps {
  taskReader: Pick<TeamTaskReader, 'getTasks'>;
  kanbanManager: Pick<TeamKanbanManager, 'getState'>;
  activeMemberSource: {
    loadActiveMemberNames(teamName: string): Promise<string[]>;
  };
}

export interface MemberWorkSyncTaskImpactResolverResult {
  memberNames: string[];
  fallbackTeamWide: boolean;
  diagnostics: string[];
}

interface TaskImpactSourceSnapshot {
  activeMembers: string[];
  tasks: Awaited<ReturnType<MemberWorkSyncTaskImpactResolverDeps['taskReader']['getTasks']>>;
  kanban: Awaited<ReturnType<MemberWorkSyncTaskImpactResolverDeps['kanbanManager']['getState']>>;
}

function isDeletedTask(task: Pick<TeamTask, 'status' | 'deletedAt'>): boolean {
  return task.status === 'deleted' || Boolean(task.deletedAt);
}

interface TaskReferenceIndex {
  canonical: Map<string, Set<TeamTask>>;
  display: Map<string, Set<TeamTask>>;
}

function addTaskReference(
  index: Map<string, Set<TeamTask>>,
  reference: string | undefined,
  task: TeamTask
): void {
  const normalized = reference?.trim().replace(/^#/, '');
  if (!normalized) return;
  const matches = index.get(normalized) ?? new Set<TeamTask>();
  matches.add(task);
  index.set(normalized, matches);
}

function buildTaskReferenceIndex(tasks: TeamTask[]): TaskReferenceIndex {
  const canonical = new Map<string, Set<TeamTask>>();
  const display = new Map<string, Set<TeamTask>>();
  for (const task of tasks) {
    addTaskReference(canonical, task.id, task);
    addTaskReference(display, task.displayId, task);
  }
  return { canonical, display };
}

function getTaskReferenceMatches(
  tasksByReference: TaskReferenceIndex,
  reference: string
): ReadonlySet<TeamTask> | null {
  const normalized = reference.trim().replace(/^#/, '');
  return (
    tasksByReference.canonical.get(normalized) ?? tasksByReference.display.get(normalized) ?? null
  );
}

function taskReferenceIncludesTask(
  tasksByReference: TaskReferenceIndex,
  reference: string,
  task: TeamTask
): boolean {
  return getTaskReferenceMatches(tasksByReference, reference)?.has(task) === true;
}

function taskReferenceIsMissingOrDeleted(
  tasksByReference: TaskReferenceIndex,
  reference: string
): boolean {
  const matches = getTaskReferenceMatches(tasksByReference, reference);
  if (!matches || matches.size === 0) {
    return true;
  }
  return [...matches].every(isDeletedTask);
}

function findTasksByReference(tasksByReference: TaskReferenceIndex, reference: string): TeamTask[] {
  const matches = getTaskReferenceMatches(tasksByReference, reference);
  return matches ? [...matches] : [];
}

function normalizedTaskReferences(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function findLeadMemberName(activeMembers: string[]): string | null {
  return activeMembers.find((memberName) => isLeadMember({ name: memberName })) ?? null;
}

export function extractMemberWorkSyncTaskId(input: {
  taskId?: string;
  detail?: string;
}): string | null {
  const explicit = input.taskId?.trim();
  if (explicit) {
    return explicit;
  }

  const detail = input.detail?.trim();
  if (!detail || detail.startsWith('.') || !detail.endsWith('.json')) {
    return null;
  }

  const fileName = detail.split(/[\\/]/).filter(Boolean).at(-1);
  const taskId = fileName?.replace(/\.json$/i, '').trim();
  return taskId && !taskId.startsWith('.') ? taskId : null;
}

export class MemberWorkSyncTaskImpactResolver {
  private readonly sourceInFlightByTeam = new Map<string, Promise<TaskImpactSourceSnapshot>>();

  constructor(private readonly deps: MemberWorkSyncTaskImpactResolverDeps) {}

  async resolve(input: {
    teamName: string;
    taskId: string;
  }): Promise<MemberWorkSyncTaskImpactResolverResult> {
    const taskId = input.taskId.trim();
    if (!taskId) {
      return {
        memberNames: [],
        fallbackTeamWide: true,
        diagnostics: ['task_id_missing'],
      };
    }

    const { activeMembers, tasks, kanban } = await this.loadSource(input.teamName);
    const activeByName = new Map(
      activeMembers.map((memberName) => [normalizeMemberName(memberName), memberName] as const)
    );
    const impacted = new Set<string>();
    const diagnostics: string[] = [];
    const addDiagnostic = (diagnostic: string): void => {
      if (!diagnostics.includes(diagnostic)) {
        diagnostics.push(diagnostic);
      }
    };
    const addMember = (value: unknown): void => {
      const normalized = normalizeMemberName(value);
      const activeName = activeByName.get(normalized);
      if (activeName) {
        impacted.add(activeName);
      }
    };
    const addLead = (): void => {
      const leadName = findLeadMemberName(activeMembers);
      if (leadName) {
        impacted.add(leadName);
      } else {
        addDiagnostic('lead_member_unavailable');
      }
    };

    const tasksByReference = buildTaskReferenceIndex(tasks);
    const matchingTasks = findTasksByReference(tasksByReference, taskId);
    if (matchingTasks.length === 0) {
      return {
        memberNames: [],
        fallbackTeamWide: true,
        diagnostics: ['task_not_found'],
      };
    }
    if (matchingTasks.length > 1) {
      return {
        memberNames: [],
        fallbackTeamWide: true,
        diagnostics: ['task_reference_ambiguous'],
      };
    }
    const task = matchingTasks[0];

    addMember(task.owner);

    if (!normalizeMemberName(task.owner)) {
      addLead();
      addDiagnostic('task_owner_missing');
    } else if (!activeByName.has(normalizeMemberName(task.owner))) {
      addLead();
      addDiagnostic('task_owner_inactive');
    }

    const taskKanbanColumn = kanban.tasks[task.id]?.column;
    const taskWorkflowColumn = getTeamTaskWorkflowColumn({
      ...task,
      ...(taskKanbanColumn ? { kanbanColumn: taskKanbanColumn } : {}),
    });

    const reviewOwner =
      taskWorkflowColumn === 'review'
        ? resolveCurrentReviewOwner({
            reviewState: taskWorkflowColumn,
            kanbanReviewer: kanban.tasks[task.id]?.reviewer ?? null,
            historyEvents: task.historyEvents,
          })
        : null;
    const selfReview =
      taskWorkflowColumn === 'review' &&
      Boolean(reviewOwner?.reviewer) &&
      Boolean(normalizeMemberName(task.owner)) &&
      sameMemberName(reviewOwner?.reviewer, task.owner);
    if (selfReview) {
      addLead();
      addDiagnostic('self_review_invalid');
    } else {
      addMember(reviewOwner?.reviewer);
    }

    if (taskWorkflowColumn === 'review' && !reviewOwner?.reviewer) {
      addLead();
      addDiagnostic('task_reviewer_missing');
    }

    if (task.needsClarification === 'lead') {
      addLead();
    }

    const brokenDependencies = normalizedTaskReferences(task.blockedBy).filter((dependencyId) => {
      return taskReferenceIsMissingOrDeleted(tasksByReference, dependencyId);
    });
    if (brokenDependencies.length > 0) {
      addLead();
      addDiagnostic('task_has_broken_dependencies');
    }

    for (const candidate of tasks) {
      const kanbanColumn = kanban.tasks[candidate.id]?.column;
      if (
        candidate.id === task.id ||
        isTeamTaskTerminalForActionableWork({
          ...candidate,
          ...(kanbanColumn ? { kanbanColumn } : {}),
        })
      ) {
        continue;
      }
      if (
        normalizedTaskReferences(candidate.blockedBy).some((dependencyId) =>
          taskReferenceIncludesTask(tasksByReference, dependencyId, task)
        )
      ) {
        addMember(candidate.owner);
        if (isDeletedTask(task)) {
          addLead();
          addDiagnostic('dependent_task_has_deleted_dependency');
        }
      }
    }

    const memberNames = [...impacted].sort((left, right) => left.localeCompare(right));
    if (memberNames.length === 0) {
      addDiagnostic('task_impact_empty');
    }

    return {
      memberNames,
      fallbackTeamWide: memberNames.length === 0,
      diagnostics,
    };
  }

  private loadSource(teamName: string): Promise<TaskImpactSourceSnapshot> {
    const existing = this.sourceInFlightByTeam.get(teamName);
    if (existing) {
      return existing;
    }

    const request = this.buildSource(teamName).finally(() => {
      if (this.sourceInFlightByTeam.get(teamName) === request) {
        this.sourceInFlightByTeam.delete(teamName);
      }
    });
    this.sourceInFlightByTeam.set(teamName, request);
    return request;
  }

  private async buildSource(teamName: string): Promise<TaskImpactSourceSnapshot> {
    const [activeMembers, tasks, kanban] = await Promise.all([
      this.deps.activeMemberSource.loadActiveMemberNames(teamName),
      this.deps.taskReader.getTasks(teamName),
      this.deps.kanbanManager.getState(teamName),
    ]);
    return { activeMembers, tasks, kanban };
  }
}
