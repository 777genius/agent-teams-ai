import {
  parseTeamRosterSnapshotRecord,
  type TeamRosterSnapshotRecord,
  type TeamRosterStorageGateway,
} from '@features/internal-storage/contracts';

import {
  type TeamRosterAdoptPersistenceResult,
  type TeamRosterRepository,
} from '../../core/application';
import { parseTeamRoster, type TeamRoster } from '../../core/domain';

import type { TeamId } from '@shared/contracts/hosted';

export class InternalStorageTeamRosterRepository implements TeamRosterRepository {
  constructor(private readonly gateway: TeamRosterStorageGateway) {}

  async getTeamRoster(teamId: TeamId): Promise<TeamRoster | null> {
    const record = await this.gateway.getTeamRoster(teamId);
    return record ? fromStorageRecord(record) : null;
  }

  async getPersistedTeamRoster(teamId: TeamId): Promise<TeamRoster | null> {
    return this.getTeamRoster(teamId);
  }

  async adoptTeamRosterIfAbsent(roster: TeamRoster): Promise<TeamRosterAdoptPersistenceResult> {
    const result = await this.gateway.adoptTeamRoster(toStorageRecord(roster));
    return Object.freeze({
      status: result.outcome,
      roster: fromStorageRecord(result.roster),
    });
  }
}

function toStorageRecord(rosterValue: TeamRoster): TeamRosterSnapshotRecord {
  const roster = parseTeamRoster(rosterValue);
  return parseTeamRosterSnapshotRecord({
    schemaVersion: roster.schemaVersion,
    teamId: roster.teamId,
    rosterGeneration: roster.rosterGeneration,
    adoptionFingerprint: roster.adoptionFingerprint,
    adoptedAt: roster.adoptedAt,
    members: roster.members.map((member, ordinal) => ({
      ordinal,
      memberId: member.memberId,
      legacyMemberKey: member.legacyMemberKey,
      memberRevision: member.memberRevision,
      state: member.state,
      providerId: member.providerId,
      model: member.model,
      role: member.role,
      workflow: member.workflow,
      isolation: member.isolation,
    })),
  });
}

function fromStorageRecord(record: TeamRosterSnapshotRecord): TeamRoster {
  const parsed = parseTeamRosterSnapshotRecord(record);
  return parseTeamRoster({
    schemaVersion: parsed.schemaVersion,
    teamId: parsed.teamId,
    rosterGeneration: parsed.rosterGeneration,
    adoptionFingerprint: parsed.adoptionFingerprint,
    adoptedAt: parsed.adoptedAt,
    members: parsed.members.map((member) => ({
      memberId: member.memberId,
      legacyMemberKey: member.legacyMemberKey,
      memberRevision: member.memberRevision,
      state: member.state,
      providerId: member.providerId,
      model: member.model,
      role: member.role,
      workflow: member.workflow,
      isolation: member.isolation,
    })),
  });
}
