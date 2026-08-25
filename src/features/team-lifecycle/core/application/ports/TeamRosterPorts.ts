import type { LegacyTeamRosterEvidence, TeamRoster } from '../../domain';
import type { MemberId, TeamId } from '@shared/contracts/hosted';

export type LegacyTeamRosterEvidenceBlockReason =
  | 'legacy_evidence_invalid'
  | 'legacy_evidence_unavailable'
  | 'team_identity_unavailable'
  | 'unsafe_team_directory';

export type LegacyTeamRosterEvidenceReadResult =
  | { readonly status: 'available'; readonly evidence: LegacyTeamRosterEvidence }
  | {
      readonly status: 'blocked';
      readonly reason: LegacyTeamRosterEvidenceBlockReason;
    };

export interface LegacyTeamRosterEvidenceSource {
  readLegacyTeamRosterEvidence(teamId: TeamId): Promise<LegacyTeamRosterEvidenceReadResult>;
}

export type TeamRosterAdoptPersistenceResult =
  | { readonly status: 'created'; readonly roster: TeamRoster }
  | { readonly status: 'existing'; readonly roster: TeamRoster };

/**
 * The implementation must compare-and-insert the aggregate in one storage
 * transaction. An existing TeamId is returned verbatim and never overwritten.
 */
export interface TeamRosterRepository {
  getTeamRoster(teamId: TeamId): Promise<TeamRoster | null>;
  adoptTeamRosterIfAbsent(roster: TeamRoster): Promise<TeamRosterAdoptPersistenceResult>;
}

export interface TeamRosterMemberIdFactory {
  createMemberId(): MemberId;
}

export interface TeamRosterClock {
  now(): Date;
}

export interface TeamRosterFingerprintHasher {
  sha256Hex(value: string): string;
}
