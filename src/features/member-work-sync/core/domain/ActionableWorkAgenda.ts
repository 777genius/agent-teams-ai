import {
  getTeamTaskWorkflowColumn,
  isTeamTaskFinishedForDependency,
  isTeamTaskNeedsFixActionable,
  isTeamTaskTerminalForActionableWork,
} from '@shared/utils/teamTaskState';

import {
  buildAgendaFingerprintPayload,
  canonicalizeAgendaFingerprintPayload,
  formatAgendaFingerprint,
} from './AgendaFingerprint';
import { resolveCurrentReviewCycle, type ReviewHistoryEventLike } from './currentReviewCycle';
import { isReservedMemberName, normalizeMemberName, sameMemberName } from './memberName';

import type {
  MemberWorkSyncActionableWorkItem,
  MemberWorkSyncAgenda,
  MemberWorkSyncProviderId,
} from '../../contracts';

export interface MemberWorkSyncTaskLike {
  id: string;
  displayId?: string;
  subject?: string;
  status: string;
  owner?: string | null;
  reviewState?: string | null;
  kanbanColumn?: string | null;
  needsClarification?: 'lead' | 'user' | null;
  blockedBy?: string[];
  blocks?: string[];
  deletedAt?: string | null;
  historyEvents?: ReviewHistoryEventLike[];
}

export interface MemberWorkSyncMemberLike {
  name: string;
  providerId?: MemberWorkSyncProviderId | string;
  model?: string;
  agentType?: string;
  removedAt?: string | null;
}

export interface BuildActionableWorkAgendaInput {
  teamName: string;
  memberName: string;
  generatedAt: string;
  tasks: MemberWorkSyncTaskLike[];
  members: MemberWorkSyncMemberLike[];
  kanbanReviewersByTaskId?: Record<string, string | null | undefined>;
  sourceRevision?: string;
  hash: (canonicalPayload: string) => string;
}

function getActiveMemberNames(members: MemberWorkSyncMemberLike[]): Set<string> {
  return new Set(
    members
      .filter((member) => !member.removedAt)
      .map((member) => normalizeMemberName(member.name))
      .filter((name) => name.length > 0 && !isReservedMemberName(name))
  );
}

function isLeadLike(member: MemberWorkSyncMemberLike): boolean {
  const name = normalizeMemberName(member.name);
  const agentType = typeof member.agentType === 'string' ? member.agentType : '';
  return (
    name === 'team-lead' ||
    agentType === 'team-lead' ||
    agentType === 'lead' ||
    agentType === 'orchestrator'
  );
}

function getActiveLeadName(members: MemberWorkSyncMemberLike[]): string | null {
  const lead = members.find((member) => !member.removedAt && isLeadLike(member));
  return lead ? normalizeMemberName(lead.name) : null;
}

function buildBaseItem(
  task: MemberWorkSyncTaskLike,
  memberName: string
): Omit<MemberWorkSyncActionableWorkItem, 'kind' | 'priority' | 'reason' | 'evidence'> {
  return {
    taskId: task.id,
    ...(task.displayId ? { displayId: task.displayId } : {}),
    subject: task.subject?.trim() || 'Untitled task',
    assignee: memberName,
  };
}

interface TaskReferenceIndex {
  canonical: Map<string, Set<MemberWorkSyncTaskLike>>;
  display: Map<string, Set<MemberWorkSyncTaskLike>>;
}

function addTaskReference(
  index: Map<string, Set<MemberWorkSyncTaskLike>>,
  reference: string | undefined,
  task: MemberWorkSyncTaskLike
): void {
  const normalized = reference?.trim().replace(/^#/, '');
  if (!normalized) return;
  const matches = index.get(normalized) ?? new Set<MemberWorkSyncTaskLike>();
  matches.add(task);
  index.set(normalized, matches);
}

function buildTaskReferenceIndex(tasks: MemberWorkSyncTaskLike[]): TaskReferenceIndex {
  const index = new Map<string, Set<MemberWorkSyncTaskLike>>();
  const display = new Map<string, Set<MemberWorkSyncTaskLike>>();
  for (const task of tasks) {
    addTaskReference(index, task.id, task);
    addTaskReference(display, task.displayId, task);
  }
  return { canonical: index, display };
}

function findUniqueReferencedTask(
  tasksByReference: TaskReferenceIndex,
  reference: string
): MemberWorkSyncTaskLike | null {
  const normalized = reference.trim().replace(/^#/, '');
  const canonicalMatches = tasksByReference.canonical.get(normalized);
  if (canonicalMatches?.size === 1) {
    return [...canonicalMatches][0];
  }
  if (canonicalMatches && canonicalMatches.size > 1) {
    return null;
  }
  const matches = tasksByReference.display.get(normalized);
  return matches?.size === 1 ? [...matches][0] : null;
}

export function buildActionableWorkAgenda(
  input: BuildActionableWorkAgendaInput
): MemberWorkSyncAgenda {
  const memberName = normalizeMemberName(input.memberName);
  const diagnostics: string[] = [];
  const activeMemberNames = getActiveMemberNames(input.members);
  const activeLeadName = getActiveLeadName(input.members);
  const tasksByReference = buildTaskReferenceIndex(input.tasks);

  if (!memberName || isReservedMemberName(memberName)) {
    diagnostics.push('member_invalid_or_reserved');
  } else if (!activeMemberNames.has(memberName)) {
    diagnostics.push('member_not_active');
  }

  const items: MemberWorkSyncActionableWorkItem[] = [];

  if (activeMemberNames.has(memberName)) {
    for (const task of input.tasks) {
      const workflowColumn = getTeamTaskWorkflowColumn(task);
      const isReviewWorkflow = workflowColumn === 'review';
      if (!task.id || (isTeamTaskTerminalForActionableWork(task) && !isReviewWorkflow)) {
        continue;
      }

      const owner = normalizeMemberName(task.owner);
      const base = buildBaseItem(task, memberName);
      const blockedBy = [
        ...new Set((task.blockedBy ?? []).map((id) => id.trim()).filter(Boolean)),
      ].sort();
      const blocks = [
        ...new Set((task.blocks ?? []).map((id) => id.trim()).filter(Boolean)),
      ].sort();
      const brokenDependencyIds: string[] = [];
      const waitingDependencyIds: string[] = [];
      for (const dependencyId of blockedBy) {
        const dependency = findUniqueReferencedTask(tasksByReference, dependencyId);
        if (!dependency || dependency.status === 'deleted' || dependency.deletedAt) {
          brokenDependencyIds.push(dependencyId);
        } else if (!isTeamTaskFinishedForDependency(dependency)) {
          waitingDependencyIds.push(dependencyId);
        }
      }

      if (
        activeLeadName &&
        sameMemberName(activeLeadName, memberName) &&
        task.needsClarification === 'lead'
      ) {
        items.push({
          ...base,
          kind: 'clarification',
          priority: 'needs_clarification',
          reason: 'task_needs_lead_clarification',
          evidence: {
            status: task.status,
            ...(owner ? { owner } : {}),
            ...(task.reviewState ? { reviewState: task.reviewState } : {}),
            needsClarification: 'lead',
          },
        });
        continue;
      }

      if (
        activeLeadName &&
        sameMemberName(activeLeadName, memberName) &&
        brokenDependencyIds.length > 0
      ) {
        items.push({
          ...base,
          kind: 'blocked_dependency',
          priority: 'blocked',
          reason: 'task_has_broken_dependency',
          evidence: {
            status: task.status,
            ...(owner ? { owner } : {}),
            ...(task.reviewState ? { reviewState: task.reviewState } : {}),
            blockedByTaskIds: brokenDependencyIds,
            ...(blocks.length > 0 ? { blockerTaskIds: blocks } : {}),
          },
        });
        continue;
      }

      const reviewCycle = isReviewWorkflow
        ? resolveCurrentReviewCycle({
            reviewState: workflowColumn,
            kanbanReviewer: input.kanbanReviewersByTaskId?.[task.id] ?? null,
            historyEvents: task.historyEvents,
          })
        : null;
      const isSelfReview =
        Boolean(owner) &&
        Boolean(reviewCycle?.reviewer) &&
        sameMemberName(owner, reviewCycle?.reviewer);

      if (isSelfReview && activeLeadName && sameMemberName(activeLeadName, memberName)) {
        items.push({
          ...base,
          kind: 'clarification',
          priority: 'needs_clarification',
          reason: 'self_review_invalid',
          evidence: {
            status: task.status,
            owner,
            reviewer: reviewCycle?.reviewer,
            reviewState: workflowColumn,
            ...(reviewCycle?.reviewRequestEventId
              ? { reviewRequestEventId: reviewCycle.reviewRequestEventId }
              : {}),
            ...(reviewCycle?.historyEventIds.length
              ? { historyEventIds: reviewCycle.historyEventIds }
              : {}),
            reviewDiagnostics: [
              ...new Set([...(reviewCycle?.diagnostics ?? []), 'self_review_invalid']),
            ].sort(),
          },
        });
        continue;
      }

      if (reviewCycle && !isSelfReview && sameMemberName(reviewCycle.reviewer, memberName)) {
        items.push({
          ...base,
          kind: 'review',
          priority: 'review_requested',
          reason: 'current_cycle_review_assigned',
          evidence: {
            status: task.status,
            ...(owner ? { owner } : {}),
            reviewer: memberName,
            reviewState: workflowColumn,
            reviewCycleId: reviewCycle.reviewCycleId,
            reviewObligation: reviewCycle.obligation,
            canBypassDeliveryReadiness: reviewCycle.canBypassDeliveryReadiness,
            ...(reviewCycle.reviewRequestEventId
              ? { reviewRequestEventId: reviewCycle.reviewRequestEventId }
              : {}),
            ...(reviewCycle.reviewRequestedAt
              ? { reviewRequestedAt: reviewCycle.reviewRequestedAt }
              : {}),
            ...(reviewCycle.reviewStartedEventId
              ? { reviewStartedEventId: reviewCycle.reviewStartedEventId }
              : {}),
            ...(reviewCycle.reviewStartedAt
              ? { reviewStartedAt: reviewCycle.reviewStartedAt }
              : {}),
            ...(reviewCycle.reviewStartedBy
              ? { reviewStartedBy: reviewCycle.reviewStartedBy }
              : {}),
            ...(reviewCycle.historyEventIds.length > 0
              ? { historyEventIds: reviewCycle.historyEventIds }
              : {}),
            ...(reviewCycle.diagnostics.length > 0
              ? { reviewDiagnostics: [...reviewCycle.diagnostics].sort() }
              : {}),
          },
        });
        continue;
      }

      if (isReviewWorkflow) {
        continue;
      }

      if (!sameMemberName(owner, memberName)) {
        continue;
      }

      if (task.needsClarification === 'lead' || task.needsClarification === 'user') {
        continue;
      }

      if (waitingDependencyIds.length > 0 || brokenDependencyIds.length > 0) {
        continue;
      }

      if (
        task.status === 'pending' ||
        task.status === 'in_progress' ||
        isTeamTaskNeedsFixActionable(task)
      ) {
        items.push({
          ...base,
          kind: 'work',
          priority: 'normal',
          reason: isTeamTaskNeedsFixActionable(task)
            ? 'review_changes_requested'
            : task.status === 'pending'
              ? 'owned_pending_task'
              : 'owned_in_progress_task',
          evidence: {
            status: task.status,
            owner: memberName,
            ...(task.reviewState ? { reviewState: task.reviewState } : {}),
          },
        });
      }
    }
  }

  const payload = buildAgendaFingerprintPayload({
    teamName: input.teamName,
    memberName,
    items,
    sourceRevision: input.sourceRevision,
  });
  const canonicalPayload = canonicalizeAgendaFingerprintPayload(payload);

  return {
    teamName: input.teamName,
    memberName,
    generatedAt: input.generatedAt,
    fingerprint: formatAgendaFingerprint(input.hash(canonicalPayload)),
    items,
    diagnostics,
    ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}),
  };
}
