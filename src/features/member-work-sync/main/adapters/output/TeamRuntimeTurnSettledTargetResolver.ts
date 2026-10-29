import { TeamMemberLogsFinder } from '@main/services/team/TeamMemberLogsFinder';
import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';
import path from 'path';

import { isReservedMemberName, normalizeMemberName } from '../../../core/domain';

import { mergeTeamMembers } from './mergeTeamMembers';

import type {
  RuntimeTurnSettledSourceExecution,
  RuntimeTurnSettledTargetResolution,
  RuntimeTurnSettledTargetResolverPort,
} from '../../../core/application';
import type { RuntimeTurnSettledEvent } from '../../../core/domain';
import type { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import type { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import type { TeamMember, TeamProviderId, TeamSummary } from '@shared/types';

export interface RuntimeTurnSettledTeamSource {
  listTeams(): Promise<TeamSummary[]>;
  getConfig(teamName: string): ReturnType<TeamConfigReader['getConfig']>;
}

export interface AttributedMemberFileSource {
  listAttributedMemberFiles(
    teamName: string
  ): Promise<{ memberName: string; sessionId: string; filePath: string; mtimeMs: number }[]>;
}

export interface TeamRuntimeTurnSettledTargetResolverDeps {
  teamSource: RuntimeTurnSettledTeamSource;
  membersMetaStore: TeamMembersMetaStore;
  memberLogsFinder?: AttributedMemberFileSource;
  maxTeamsToScan?: number;
  captureSourceExecution?(teamName: string): RuntimeTurnSettledSourceExecution | null | undefined;
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

function providerForMember(member: TeamMember | undefined): TeamProviderId | undefined {
  return (
    normalizeOptionalTeamProviderId(member?.providerId) ??
    providerIdFromBackend(member?.providerBackendId) ??
    inferTeamProviderIdFromModel(member?.model)
  );
}

function normalizePath(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }
  return path.resolve(value.trim());
}

export class TeamRuntimeTurnSettledTargetResolver implements RuntimeTurnSettledTargetResolverPort {
  private readonly memberLogsFinder: AttributedMemberFileSource;
  private readonly maxTeamsToScan: number;

  constructor(private readonly deps: TeamRuntimeTurnSettledTargetResolverDeps) {
    this.memberLogsFinder = deps.memberLogsFinder ?? new TeamMemberLogsFinder();
    this.maxTeamsToScan = Math.max(1, deps.maxTeamsToScan ?? 200);
  }

  async resolve(event: RuntimeTurnSettledEvent): Promise<RuntimeTurnSettledTargetResolution> {
    if (event.provider === 'codex') {
      return this.resolveProviderOwnedEvent(event, 'codex');
    }

    if (event.provider === 'opencode') {
      return this.resolveProviderOwnedEvent(event, 'opencode');
    }

    if (event.provider !== 'claude') {
      return { ok: false, reason: 'unsupported_provider' };
    }

    const transcriptPath = normalizePath(event.transcriptPath);
    const sessionId = event.sessionId?.trim() || null;
    if (!transcriptPath && !sessionId) {
      return { ok: false, reason: 'missing_session_identity' };
    }

    const teams = (await this.deps.teamSource.listTeams())
      .filter((team) => !team.deletedAt)
      .slice(0, this.maxTeamsToScan);

    const candidates: {
      teamName: string;
      memberName: string;
      exactPath: boolean;
      mtimeMs: number;
      sourceExecution?: RuntimeTurnSettledSourceExecution;
    }[] = [];

    for (const team of teams) {
      const sourceExecution = this.deps.captureSourceExecution?.(team.teamName);
      if (sourceExecution === null) continue;
      const read = () =>
        this.memberLogsFinder.listAttributedMemberFiles(team.teamName).catch(() => []);
      const attributedFiles = await (sourceExecution ? sourceExecution.run(read) : read());
      sourceExecution?.assertCurrent();
      for (const file of attributedFiles) {
        const exactPath = transcriptPath ? normalizePath(file.filePath) === transcriptPath : false;
        const sessionMatch = sessionId ? file.sessionId === sessionId : false;
        if (!exactPath && !sessionMatch) {
          continue;
        }
        candidates.push({
          teamName: team.teamName,
          memberName: file.memberName,
          exactPath,
          mtimeMs: file.mtimeMs,
          ...(sourceExecution ? { sourceExecution } : {}),
        });
      }
    }

    const candidate = candidates.sort((left, right) => {
      if (left.exactPath !== right.exactPath) {
        return left.exactPath ? -1 : 1;
      }
      return right.mtimeMs - left.mtimeMs;
    })[0];

    if (!candidate) {
      return { ok: false, reason: 'no_matching_member_session' };
    }

    const member = await this.resolveActiveMember(
      candidate.teamName,
      candidate.memberName,
      candidate.sourceExecution
    );
    if (!member) {
      return { ok: false, reason: 'member_not_active' };
    }
    if (isReservedMemberName(member.name)) {
      return { ok: false, reason: 'reserved_member' };
    }

    const providerId = providerForMember(member);
    if (providerId && providerId !== 'anthropic') {
      return { ok: false, reason: 'provider_mismatch' };
    }

    return {
      ok: true,
      teamName: candidate.teamName,
      memberName: normalizeMemberName(member.name),
      ...(candidate.sourceExecution ? { sourceExecution: candidate.sourceExecution } : {}),
    };
  }

  private async resolveProviderOwnedEvent(
    event: RuntimeTurnSettledEvent,
    expectedProviderId: 'codex' | 'opencode'
  ): Promise<RuntimeTurnSettledTargetResolution> {
    const teamName = event.teamName?.trim();
    const memberName = event.memberName?.trim();
    if (!teamName || !memberName) {
      return { ok: false, reason: 'missing_team_member_identity' };
    }

    const sourceExecution = this.deps.captureSourceExecution?.(teamName);
    if (sourceExecution === null) return { ok: false, reason: 'source_read_only' };
    const member = await this.resolveActiveMember(teamName, memberName, sourceExecution);
    if (!member) {
      return { ok: false, reason: 'member_not_active' };
    }
    if (isReservedMemberName(member.name)) {
      return { ok: false, reason: 'reserved_member' };
    }

    const providerId = providerForMember(member);
    if (providerId && providerId !== expectedProviderId) {
      return { ok: false, reason: 'provider_mismatch' };
    }

    return {
      ok: true,
      teamName,
      memberName: normalizeMemberName(member.name),
      ...(sourceExecution ? { sourceExecution } : {}),
    };
  }

  private async resolveActiveMember(
    teamName: string,
    memberName: string,
    sourceExecution?: RuntimeTurnSettledSourceExecution
  ): Promise<TeamMember | null> {
    sourceExecution?.assertCurrent();
    const read = () =>
      Promise.all([
        this.deps.teamSource.getConfig(teamName),
        this.deps.membersMetaStore.getMembers(teamName).catch(() => []),
      ]);
    const [config, metaMembers] = await (sourceExecution ? sourceExecution.run(read) : read());
    sourceExecution?.assertCurrent();
    if (!config || config.deletedAt) {
      return null;
    }

    const normalizedTarget = normalizeMemberName(memberName);
    return (
      mergeTeamMembers(config.members ?? [], metaMembers).find(
        (member) => !member.removedAt && memberKey(member) === normalizedTarget
      ) ?? null
    );
  }
}
