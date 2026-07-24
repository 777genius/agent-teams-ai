import { createHash, randomBytes } from 'node:crypto';

import { parseMemberId } from '@shared/contracts/hosted';

import {
  AdoptTeamRoster,
  type AdoptTeamRosterRequest,
  type AdoptTeamRosterResult,
} from '../../core/application';
import { InternalStorageTeamRosterRepository } from '../infrastructure/InternalStorageTeamRosterRepository';
import { LegacyTeamRosterFileSource } from '../infrastructure/LegacyTeamRosterFileSource';

import type {
  TeamIdentityReadGateway,
  TeamRosterStorageGateway,
} from '@features/internal-storage/contracts';

export interface TeamRosterAdoptionFeature {
  adoptTeamRoster(request: AdoptTeamRosterRequest): Promise<AdoptTeamRosterResult>;
  rosterRepository: InternalStorageTeamRosterRepository;
}

export interface TeamRosterAdoptionFeatureDependencies {
  readonly teamsRootPath: string;
  readonly teamIdentityGateway: TeamIdentityReadGateway;
  readonly teamRosterGateway: TeamRosterStorageGateway;
  readonly now?: () => Date;
  readonly randomMemberIdBytes?: () => Uint8Array;
}

export function createTeamRosterAdoptionFeature(
  dependencies: TeamRosterAdoptionFeatureDependencies
): TeamRosterAdoptionFeature {
  const repository = new InternalStorageTeamRosterRepository(dependencies.teamRosterGateway);
  const useCase = new AdoptTeamRoster({
    evidenceSource: new LegacyTeamRosterFileSource({
      teamsRootPath: dependencies.teamsRootPath,
      teamIdentityGateway: dependencies.teamIdentityGateway,
    }),
    repository,
    memberIdFactory: {
      createMemberId: () => {
        const bytes = dependencies.randomMemberIdBytes?.() ?? randomBytes(16);
        if (bytes.byteLength !== 16) throw new TypeError('team-roster-member-id-entropy-invalid');
        return parseMemberId(`member_${Buffer.from(bytes).toString('hex')}`);
      },
    },
    clock: { now: dependencies.now ?? (() => new Date()) },
    fingerprintHasher: {
      sha256Hex: (value) => createHash('sha256').update(value, 'utf8').digest('hex'),
    },
  });
  return Object.freeze({
    adoptTeamRoster: (request: AdoptTeamRosterRequest) => useCase.execute(request),
    rosterRepository: repository,
  });
}
