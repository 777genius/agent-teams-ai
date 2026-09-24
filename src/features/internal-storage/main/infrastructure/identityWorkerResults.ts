import { parseTeamId } from '@shared/contracts/hosted';

import {
  type ExternalWriterIdentityInventoryCapture,
  MAX_TEAM_IDENTITY_READ_RECORDS,
  parseIdentityTimestamp,
  parseTeamIdentityChecksum,
  parseTeamIdentityRecord,
  type TeamIdentityRecord,
} from '../../contracts/teamIdentityStorageContracts';

export function parseExternalWriterIdentityInventoryCapture(
  value: unknown
): ExternalWriterIdentityInventoryCapture {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('external-writer-inventory-capture-invalid');
  }
  const record = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).length !== 2 ||
    !Object.hasOwn(record, 'active') ||
    !Object.hasOwn(record, 'retiredCandidates') ||
    !Array.isArray(record.retiredCandidates) ||
    record.retiredCandidates.length > 1_024
  ) {
    throw new TypeError('external-writer-inventory-capture-invalid');
  }
  const active = parseTeamIdentityList(record.active);
  const retiredCandidates = record.retiredCandidates.map((proof) => {
    if (typeof proof !== 'object' || proof === null || Array.isArray(proof)) {
      throw new TypeError('external-writer-inventory-capture-invalid');
    }
    const candidate = proof as Record<string, unknown>;
    if (
      Reflect.ownKeys(candidate).length !== 3 ||
      !Object.hasOwn(candidate, 'teamId') ||
      !Object.hasOwn(candidate, 'identityChecksum') ||
      !Object.hasOwn(candidate, 'tombstonedAt')
    ) {
      throw new TypeError('external-writer-inventory-capture-invalid');
    }
    const identity = active.find((entry) => entry.teamId === candidate.teamId);
    if (identity) throw new TypeError('external-writer-inventory-capture-invalid');
    return Object.freeze({
      teamId: parseTeamId(candidate.teamId),
      identityChecksum: parseTeamIdentityChecksum(candidate.identityChecksum),
      tombstonedAt: parseIdentityTimestamp(candidate.tombstonedAt),
    });
  });
  return Object.freeze({ active, retiredCandidates: Object.freeze(retiredCandidates) });
}

export function parseTeamIdentityList(value: unknown): readonly TeamIdentityRecord[] {
  if (!Array.isArray(value) || value.length > MAX_TEAM_IDENTITY_READ_RECORDS) {
    throw new TypeError('team-identity-list-invalid');
  }
  const identities: TeamIdentityRecord[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError('team-identity-list-invalid');
    identities.push(parseTeamIdentityRecord(value[index]));
  }
  return Object.freeze(identities);
}
