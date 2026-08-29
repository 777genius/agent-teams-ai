import { parseCanonicalRosterMembers } from './buildCanonicalRosterAuthorizationRaw';
import { fingerprintDurableTeamMembersMetaRaw } from './TeamMembersMetaStore';

import type { RosterAuthorizationTransactionRecord } from './TeamRosterAuthorizationLedger';
import type { RosterAuthorizedLaunchResult } from '@shared/types/rosterAuthorizationTransaction';
import type { TeamMember } from '@shared/types/team';

export function validateRosterAuthorizedLaunchResult(
  record: Readonly<RosterAuthorizationTransactionRecord>,
  result: RosterAuthorizedLaunchResult
): string | null {
  if (!result || typeof result !== 'object') return 'Launch result proof is missing';
  if (record.executionProof === undefined || record.launchRequestFingerprint === undefined) {
    return 'Launch result proof omits the current exact request binding';
  }
  if (
    result.transactionId !== record.transactionId ||
    result.teamName !== record.teamName ||
    result.rosterFingerprint !== record.targetFingerprint ||
    result.rosterRevision !== record.requestFingerprint ||
    result.launchCommandId !== record.launchCommandId ||
    result.executionProof?.authorityId !== record.executionProof.authorityId ||
    result.executionProof?.generation !== record.executionProof.generation ||
    result.executionProof?.completedAt !== record.executionProof.completedAt ||
    result.executionProof?.expiresAt !== record.executionProof.expiresAt ||
    result.executionProof?.requestDigest !== record.executionProof.requestDigest ||
    result.launchRequestFingerprint !== record.launchRequestFingerprint
  ) {
    return 'Launch result proof does not match the roster transaction binding';
  }
  if (!result.runId?.trim() || !result.attemptId?.trim()) {
    return 'Launch result proof does not contain a real run and attempt identity';
  }
  return ['started', 'not_started', 'already_launching', 'already_running'].includes(
    result.launchStatus
  )
    ? null
    : 'Launch result proof status is invalid';
}

export function decodeAuthorizedRoster(record: RosterAuthorizationTransactionRecord): TeamMember[] {
  if (typeof record.targetRawBase64 !== 'string') {
    throw new Error('Canonical authorized roster is unavailable');
  }
  const raw = Buffer.from(record.targetRawBase64, 'base64').toString('utf8');
  if (fingerprintDurableTeamMembersMetaRaw(raw) !== record.targetFingerprint) {
    throw new Error('Canonical authorized roster fingerprint does not match');
  }
  const parsed = JSON.parse(raw) as { members?: unknown };
  const members = parseCanonicalRosterMembers(parsed.members);
  if (!members) throw new Error('Canonical authorized roster is invalid');
  return members;
}

export function decodePriorRosterSnapshot(
  record: RosterAuthorizationTransactionRecord
): string | null {
  if (record.priorRawBase64 === null) {
    if (fingerprintDurableTeamMembersMetaRaw(null) !== record.priorSnapshotFingerprint) {
      throw new Error('Roster authorization transaction snapshot identity does not match');
    }
    return null;
  }
  if (typeof record.priorRawBase64 !== 'string') {
    throw new Error('Roster authorization transaction snapshot is unavailable');
  }
  const bytes = Buffer.from(record.priorRawBase64, 'base64');
  if (bytes.toString('base64') !== record.priorRawBase64) {
    throw new Error('Roster authorization transaction snapshot is corrupt');
  }
  const raw = bytes.toString('utf8');
  if (fingerprintDurableTeamMembersMetaRaw(raw) !== record.priorSnapshotFingerprint) {
    throw new Error('Roster authorization transaction snapshot identity does not match');
  }
  return raw;
}
