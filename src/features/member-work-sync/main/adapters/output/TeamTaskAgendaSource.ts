import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';

import {
  buildActionableWorkAgenda,
  isReservedMemberName,
  type MemberWorkSyncMemberLike,
  normalizeMemberName,
} from '../../../core/domain';

import { mergeTeamMembers } from './mergeTeamMembers';

import type {
  MemberWorkSyncAgendaSourcePort,
  MemberWorkSyncAgendaSourceResult,
  MemberWorkSyncHashPort,
} from '../../../core/application';
import type { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import type { TeamKanbanManager } from '@main/services/team/TeamKanbanManager';
import type { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import type { TeamTaskReader } from '@main/services/team/TeamTaskReader';
import type { TeamMember, TeamProviderId } from '@shared/types';

export interface TeamTaskAgendaSourceDeps {
  configReader: Pick<TeamConfigReader, 'getConfig'>;
  taskReader: TeamTaskReader;
  kanbanManager: TeamKanbanManager;
  membersMetaStore: TeamMembersMetaStore;
  hash: MemberWorkSyncHashPort;
  clock: { now(): Date };
}

function memberKey(member: Pick<TeamMember, 'name'>): string {
  return normalizeMemberName(member.name);
}

function providerIdFromBackend(providerBackendId: unknown): TeamProviderId | undefined {
  const normalized = typeof providerBackendId === 'string' ? providerBackendId.trim() : '';
  if (normalized === 'codex-native') {
    return 'codex';
  }
  if (normalized === 'opencode-cli') {
    return 'opencode';
  }
  return undefined;
}

function toMemberLike(member: TeamMember): MemberWorkSyncMemberLike {
  const providerId =
    normalizeOptionalTeamProviderId(member.providerId) ??
    providerIdFromBackend(member.providerBackendId) ??
    inferTeamProviderIdFromModel(member.model);
  return {
    name: member.name,
    ...(providerId ? { providerId } : {}),
    ...(member.model ? { model: member.model } : {}),
    ...(member.agentType ? { agentType: member.agentType } : {}),
    ...(member.removedAt ? { removedAt: String(member.removedAt) } : {}),
  };
}

export class TeamTaskAgendaSource implements MemberWorkSyncAgendaSourcePort {
  constructor(private readonly deps: TeamTaskAgendaSourceDeps) {}

  async loadActiveMemberNames(teamName: string): Promise<string[]> {
    const config = await this.deps.configReader.getConfig(teamName);
    if (!config || config.deletedAt) {
      return [];
    }

    const metaMembers = await this.deps.membersMetaStore.getMembers(teamName);
    return mergeTeamMembers(config.members ?? [], metaMembers)
      .filter((member) => !member.removedAt)
      .map((member) => normalizeMemberName(member.name))
      .filter((memberName) => memberName.length > 0 && !isReservedMemberName(memberName))
      .sort((left, right) => left.localeCompare(right));
  }

  async loadAgenda(input: {
    teamName: string;
    memberName: string;
  }): Promise<MemberWorkSyncAgendaSourceResult> {
    const config = await this.deps.configReader.getConfig(input.teamName);
    if (!config || config.deletedAt) {
      const nowIso = this.deps.clock.now().toISOString();
      return {
        agenda: {
          teamName: input.teamName,
          memberName: normalizeMemberName(input.memberName),
          generatedAt: nowIso,
          items: [],
          diagnostics: config?.deletedAt ? ['team_deleted'] : ['team_config_missing'],
        },
        activeMemberNames: [],
        inactive: true,
        diagnostics: [],
      };
    }

    const [tasks, kanban, metaMembers] = await Promise.all([
      this.deps.taskReader.getTasks(input.teamName),
      this.deps.kanbanManager.getState(input.teamName),
      this.deps.membersMetaStore.getMembers(input.teamName),
    ]);
    const members = mergeTeamMembers(config.members ?? [], metaMembers);
    const activeMemberNames = members
      .filter((member) => !member.removedAt)
      .map((member) => normalizeMemberName(member.name))
      .filter(Boolean);
    const normalizedMemberName = normalizeMemberName(input.memberName);
    const member = members.find((candidate) => memberKey(candidate) === normalizedMemberName);
    const providerId =
      normalizeOptionalTeamProviderId(member?.providerId) ??
      providerIdFromBackend(member?.providerBackendId) ??
      inferTeamProviderIdFromModel(member?.model);

    const agenda = buildActionableWorkAgenda({
      teamName: input.teamName,
      memberName: input.memberName,
      generatedAt: this.deps.clock.now().toISOString(),
      tasks: tasks.map((task) => {
        const kanbanColumn = kanban.tasks[task.id]?.column;
        return {
          ...task,
          ...(kanbanColumn ? { kanbanColumn } : {}),
        };
      }),
      members: members.map(toMemberLike),
      kanbanReviewersByTaskId: Object.fromEntries(
        Object.entries(kanban.tasks).map(([taskId, value]) => [taskId, value.reviewer ?? null])
      ),
      hash: this.deps.hash.sha256Hex.bind(this.deps.hash),
    });

    return {
      agenda,
      activeMemberNames,
      inactive: !activeMemberNames.includes(normalizedMemberName),
      ...(providerId ? { providerId } : {}),
      diagnostics: [],
    };
  }
}
