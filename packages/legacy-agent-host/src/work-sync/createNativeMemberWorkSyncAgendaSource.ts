import { TeamOwnerError } from '../team/contracts.js';
import { buildActionableWorkAgenda } from './policy/core/domain/ActionableWorkAgenda.js';
import { normalizeMemberName } from './policy/core/domain/memberName.js';

import type { TeamOwner } from '../team/TeamOwner.js';
import type { TeamTask } from '../team/ports.js';
import type { captureNativeInputAuthority } from '../composition/captureNativeInputAuthority.js';
import type { MemberWorkSyncTaskLike } from './policy/core/domain/ActionableWorkAgenda.js';
import type { ReviewHistoryEventLike } from './policy/core/domain/currentReviewCycle.js';
import type { MemberWorkSyncProviderId } from './policy/contracts/index.js';
import type { MemberWorkSyncAgendaSourcePort } from './policy/core/application/ports.js';

/** Actual current Team board and roster, bound to the original native actor rather than an assignee. */
export function createNativeMemberWorkSyncAgendaSource(options: {
  owner: Pick<TeamOwner, 'connect' | 'withLaunchAuthority'>;
  authority: Pick<
    ReturnType<typeof captureNativeInputAuthority>,
    'team' | 'fingerprint' | 'assertCurrent' | 'assertTeamCurrent'
  >;
  teamName: string;
  /** Captured Runtime configuration/source generation, deliberately independent of input ID. */
  sourceRevision: string;
  providerId: MemberWorkSyncProviderId;
  now(): Date;
  hash(value: string): string;
}): MemberWorkSyncAgendaSourcePort {
  const principalId = options.authority.team.principalId;
  const memberName = options.authority.team.memberName;
  const connection = options.owner.connect(principalId);
  return {
    async loadAgenda(input) {
      options.authority.assertCurrent();
      if (input.teamName !== options.teamName || input.memberName !== memberName)
        throw new TeamOwnerError('forbidden');
      const source = options.owner.withLaunchAuthority(principalId, 'read', () => {
        options.authority.assertTeamCurrent();
        if (!connection.readQueries) throw new TeamOwnerError('hold');
        const roster = connection.readRoster();
        const member = roster.members.find(
          (candidate) => candidate.memberId === options.authority.team.actorId
        );
        if (!member || member.name !== memberName) throw new TeamOwnerError('forbidden');
        const tasks = connection.listTasks();
        const kanban = readKanbanProjection(
          connection.readQueries.getKanbanState({ strict: true })
        );
        return {
          members: roster.members.map((current) => ({
            name: current.name,
            agentType: current.role === 'lead' ? 'team-lead' : 'general-purpose',
            ...(current.settings.providerId ? { providerId: current.settings.providerId } : {}),
          })),
          tasks: tasks.map((task) => projectTask(task, kanban.columns[task.id])),
          reviewers: kanban.reviewers,
        };
      });
      options.authority.assertCurrent();
      const activeMemberNames = source.members.map((member) => normalizeMemberName(member.name));
      return {
        agenda: buildActionableWorkAgenda({
          teamName: options.teamName,
          memberName,
          generatedAt: options.now().toISOString(),
          tasks: source.tasks,
          members: source.members,
          kanbanReviewersByTaskId: source.reviewers,
          sourceRevision: options.sourceRevision,
          hash: options.hash,
        }),
        activeMemberNames,
        inactive: !activeMemberNames.includes(normalizeMemberName(memberName)),
        providerId: options.providerId,
        diagnostics: [],
      };
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The controller's strict canonical read has already validated the schema; this selects only agenda fields. */
function readKanbanProjection(value: unknown) {
  if (!record(value) || !record(value.tasks)) throw new TeamOwnerError('hold');
  const columns: Record<string, string> = {};
  const reviewers: Record<string, string | null> = {};
  for (const [taskId, entry] of Object.entries(value.tasks)) {
    if (!record(entry) || (entry.column !== 'review' && entry.column !== 'approved'))
      throw new TeamOwnerError('hold');
    columns[taskId] = entry.column;
    reviewers[taskId] = typeof entry.reviewer === 'string' ? entry.reviewer : null;
  }
  return { columns, reviewers };
}

/** Typed projection of canonical board JSON; invalid optional safety facts are held rather than discarded. */
function projectTask(task: TeamTask, column: string | undefined): MemberWorkSyncTaskLike {
  const projected: MemberWorkSyncTaskLike = { id: task.id, status: task.status };
  for (const key of ['displayId', 'subject', 'owner', 'reviewState', 'deletedAt'] as const) {
    const value = task[key];
    if (value === undefined) continue;
    if (typeof value === 'string') projected[key] = value;
    else if (value !== null || key === 'displayId' || key === 'subject')
      throw new TeamOwnerError('hold');
    else projected[key] = null;
  }
  if (task.needsClarification !== undefined) {
    if (
      task.needsClarification !== null &&
      task.needsClarification !== 'lead' &&
      task.needsClarification !== 'user'
    )
      throw new TeamOwnerError('hold');
    projected.needsClarification = task.needsClarification;
  }
  for (const key of ['blockedBy', 'blocks'] as const) {
    const value = task[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string'))
      throw new TeamOwnerError('hold');
    projected[key] = value;
  }
  if (task.historyEvents !== undefined) {
    if (!Array.isArray(task.historyEvents)) throw new TeamOwnerError('hold');
    projected.historyEvents = task.historyEvents.map((event): ReviewHistoryEventLike => {
      if (!record(event) || typeof event.type !== 'string') throw new TeamOwnerError('hold');
      const row: ReviewHistoryEventLike = { type: event.type };
      for (const key of ['id', 'timestamp', 'actor', 'reviewer', 'from', 'to'] as const) {
        const value = event[key];
        if (value === undefined) continue;
        if (typeof value !== 'string') throw new TeamOwnerError('hold');
        row[key] = value;
      }
      return row;
    });
  }
  if (column !== undefined) projected.kanbanColumn = column;
  return projected;
}
