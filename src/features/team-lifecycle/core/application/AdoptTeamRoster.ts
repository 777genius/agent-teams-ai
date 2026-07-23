import { parseMemberId, parseTeamId, type TeamId } from '@shared/contracts/hosted';

import {
  parseTeamRoster,
  reconcileLegacyTeamRosterEvidence,
  TEAM_ROSTER_SCHEMA_VERSION,
  type TeamRoster,
  TeamRosterIdentityAmbiguityError,
} from '../domain';

import type {
  LegacyTeamRosterEvidenceBlockReason,
  LegacyTeamRosterEvidenceSource,
  TeamRosterClock,
  TeamRosterFingerprintHasher,
  TeamRosterMemberIdFactory,
  TeamRosterRepository,
} from './ports/TeamRosterPorts';

export type AdoptTeamRosterBlockReason =
  | LegacyTeamRosterEvidenceBlockReason
  | 'member_id_collision'
  | 'persisted_roster_conflict'
  | 'roster_identity_ambiguous';

export type AdoptTeamRosterResult =
  | {
      readonly status: 'adopted' | 'already_adopted';
      readonly roster: TeamRoster;
    }
  | {
      readonly status: 'blocked';
      readonly reason: AdoptTeamRosterBlockReason;
    };

export interface AdoptTeamRosterRequest {
  readonly teamId: TeamId;
}

export interface AdoptTeamRosterDependencies {
  readonly evidenceSource: LegacyTeamRosterEvidenceSource;
  readonly repository: TeamRosterRepository;
  readonly memberIdFactory: TeamRosterMemberIdFactory;
  readonly clock: TeamRosterClock;
  readonly fingerprintHasher: TeamRosterFingerprintHasher;
}

export class AdoptTeamRoster {
  constructor(private readonly dependencies: AdoptTeamRosterDependencies) {}

  async execute(request: AdoptTeamRosterRequest): Promise<AdoptTeamRosterResult> {
    const teamId = parseTeamId(request.teamId);
    const evidenceResult =
      await this.dependencies.evidenceSource.readLegacyTeamRosterEvidence(teamId);
    if (evidenceResult.status === 'blocked') {
      return Object.freeze({ status: 'blocked', reason: evidenceResult.reason });
    }

    let reconciled;
    try {
      reconciled = reconcileLegacyTeamRosterEvidence({
        evidence: evidenceResult.evidence,
        sha256Hex: (value) => this.dependencies.fingerprintHasher.sha256Hex(value),
      });
    } catch (error) {
      if (error instanceof TeamRosterIdentityAmbiguityError) {
        return Object.freeze({ status: 'blocked', reason: error.code });
      }
      throw error;
    }
    if (reconciled.teamId !== teamId) {
      return Object.freeze({ status: 'blocked', reason: 'persisted_roster_conflict' });
    }

    const existing = await this.dependencies.repository.getTeamRoster(teamId);
    if (existing) {
      return compareExistingRoster(existing, reconciled.adoptionFingerprint);
    }

    const memberIds = new Set<string>();
    const members = [];
    for (const member of reconciled.members) {
      const memberId = parseMemberId(this.dependencies.memberIdFactory.createMemberId());
      if (memberIds.has(memberId)) {
        return Object.freeze({ status: 'blocked', reason: 'member_id_collision' });
      }
      memberIds.add(memberId);
      members.push({
        ...member,
        memberId,
        memberRevision: 1,
      });
    }
    const roster = parseTeamRoster({
      schemaVersion: TEAM_ROSTER_SCHEMA_VERSION,
      teamId,
      rosterGeneration: 1,
      adoptionFingerprint: reconciled.adoptionFingerprint,
      adoptedAt: this.dependencies.clock.now().toISOString(),
      members,
    });
    const persisted = await this.dependencies.repository.adoptTeamRosterIfAbsent(roster);
    if (persisted.status === 'existing') {
      return compareExistingRoster(persisted.roster, reconciled.adoptionFingerprint);
    }
    if (
      persisted.roster.teamId !== teamId ||
      persisted.roster.adoptionFingerprint !== reconciled.adoptionFingerprint
    ) {
      return Object.freeze({ status: 'blocked', reason: 'persisted_roster_conflict' });
    }
    return Object.freeze({ status: 'adopted', roster: persisted.roster });
  }
}

function compareExistingRoster(
  roster: TeamRoster,
  expectedFingerprint: TeamRoster['adoptionFingerprint']
): AdoptTeamRosterResult {
  const parsed = parseTeamRoster(roster);
  if (parsed.adoptionFingerprint !== expectedFingerprint) {
    return Object.freeze({ status: 'blocked', reason: 'persisted_roster_conflict' });
  }
  return Object.freeze({ status: 'already_adopted', roster: parsed });
}
