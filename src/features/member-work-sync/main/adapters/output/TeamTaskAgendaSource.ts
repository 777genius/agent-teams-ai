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
import { MemberWorkSyncReadSingleFlight } from '../../infrastructure/MemberWorkSyncReadSingleFlight';

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

const ROSTER_CACHE_MAX_AGE_MS = 5_000;

export interface TeamTaskAgendaSourceDeps {
  configReader: Pick<TeamConfigReader, 'getConfig'>;
  taskReader: TeamTaskReader;
  kanbanManager: TeamKanbanManager;
  membersMetaStore: TeamMembersMetaStore;
  hash: MemberWorkSyncHashPort;
  clock: { now(): Date };
  readTimeoutMs?: number;
}

interface TeamRosterSnapshot {
  config: Awaited<ReturnType<TeamTaskAgendaSourceDeps['configReader']['getConfig']>>;
  members: TeamMember[];
  activeMemberNames: string[];
}

interface TeamRosterCacheEntry {
  snapshot: TeamRosterSnapshot;
  cachedAtMs: number;
}

interface TeamWorkSnapshot {
  tasks: Awaited<ReturnType<TeamTaskAgendaSourceDeps['taskReader']['getTasks']>>;
  kanban: Awaited<ReturnType<TeamTaskAgendaSourceDeps['kanbanManager']['getState']>>;
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
  private readonly rosterReads: MemberWorkSyncReadSingleFlight<TeamRosterSnapshot>;
  private readonly rosterCacheByTeam = new Map<string, TeamRosterCacheEntry>();
  private readonly workReads: MemberWorkSyncReadSingleFlight<TeamWorkSnapshot>;

  constructor(private readonly deps: TeamTaskAgendaSourceDeps) {
    const timeout = deps.readTimeoutMs ?? 120_000;
    if (!Number.isFinite(timeout) || timeout < 1) throw new Error('invalid agenda read timeout');
    this.rosterReads = new MemberWorkSyncReadSingleFlight(timeout);
    this.workReads = new MemberWorkSyncReadSingleFlight(timeout);
  }

  async loadActiveMemberNames(teamName: string): Promise<string[]> {
    const roster = await this.loadRoster(teamName, { allowRecentCache: true });
    return roster.activeMemberNames
      .filter((memberName) => !isReservedMemberName(memberName))
      .sort((left, right) => left.localeCompare(right));
  }

  async loadAgenda(input: {
    teamName: string;
    memberName: string;
  }): Promise<MemberWorkSyncAgendaSourceResult> {
    const roster = await this.loadRoster(input.teamName, { allowRecentCache: false });
    const config = roster.config;
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

    const { tasks, kanban } = await this.loadWork(input.teamName);
    const members = roster.members;
    const activeMemberNames = roster.activeMemberNames;
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

  private loadRoster(
    teamName: string,
    options: { allowRecentCache: boolean }
  ): Promise<TeamRosterSnapshot> {
    const nowMs = this.deps.clock.now().getTime();
    const cached = this.rosterCacheByTeam.get(teamName);
    if (
      options.allowRecentCache &&
      cached &&
      nowMs >= cached.cachedAtMs &&
      nowMs - cached.cachedAtMs < ROSTER_CACHE_MAX_AGE_MS
    ) {
      return Promise.resolve(cached.snapshot);
    }

    return this.rosterReads
      .run(teamName, () => this.buildRoster(teamName))
      .then((snapshot) => {
        this.rosterCacheByTeam.set(teamName, {
          snapshot,
          cachedAtMs: this.deps.clock.now().getTime(),
        });
        if (this.rosterCacheByTeam.size > 128) {
          const oldest = this.rosterCacheByTeam.keys().next().value;
          if (oldest !== undefined) this.rosterCacheByTeam.delete(oldest);
        }
        return snapshot;
      });
  }

  private async buildRoster(teamName: string): Promise<TeamRosterSnapshot> {
    const config = await this.deps.configReader.getConfig(teamName);
    if (!config || config.deletedAt) {
      const snapshot = { config, members: [], activeMemberNames: [] };
      return snapshot;
    }

    const metaMembers = await this.deps.membersMetaStore.getMembers(teamName);
    const members = mergeTeamMembers(config.members ?? [], metaMembers);
    const activeMemberNames = members
      .filter((member) => !member.removedAt)
      .map((member) => normalizeMemberName(member.name))
      .filter(Boolean);
    const snapshot = { config, members, activeMemberNames };
    return snapshot;
  }

  private loadWork(teamName: string): Promise<TeamWorkSnapshot> {
    return this.workReads.run(teamName, () => this.buildWork(teamName));
  }

  private async buildWork(teamName: string): Promise<TeamWorkSnapshot> {
    const [tasks, kanban] = await Promise.allSettled([
      this.deps.taskReader.getTasks(teamName),
      this.deps.kanbanManager.getState(teamName, { strict: true }),
    ]);
    // A failed sibling cannot hide still-running I/O from the replacement budget.
    if (tasks.status === 'rejected') throw tasks.reason;
    if (kanban.status === 'rejected') throw kanban.reason;
    return { tasks: tasks.value, kanban: kanban.value };
  }
}
