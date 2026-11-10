import {
  hashRuntimeDeliveryEnvelope,
  normalizeRuntimeDeliveryEnvelope,
  type RuntimeDeliveryCanonicalRecoveryMigration,
  type RuntimeDeliveryDestinationRef,
  type RuntimeDeliveryEnvelope,
  type RuntimeDeliveryJournalRecord,
  type RuntimeDeliveryLocation,
} from './RuntimeDeliveryJournal';

export interface RuntimeDeliveryRecoveryEvidence {
  fromMemberName: string;
  runtimeSessionId: string;
  text: string;
  createdAt: string;
  summary: string | null;
  taskRefs?: RuntimeDeliveryEnvelope['taskRefs'];
}

export function deriveCanonicalRecoveryMigration(
  record: RuntimeDeliveryJournalRecord,
  canonicalRecord: RuntimeDeliveryJournalRecord,
  evidence: RuntimeDeliveryRecoveryEvidence | undefined
): RuntimeDeliveryCanonicalRecoveryMigration | null {
  if (
    !evidence ||
    record.logicalPayloadHash === null ||
    evidence.fromMemberName.trim().toLowerCase() !== record.fromMemberName.trim().toLowerCase() ||
    evidence.runtimeSessionId !== record.runtimeSessionId
  ) {
    return null;
  }

  try {
    const persistedEnvelope = normalizeRuntimeDeliveryEnvelope({
      idempotencyKey: record.idempotencyKey,
      runId: record.runId,
      teamName: record.teamName,
      fromMemberName: record.fromMemberName,
      providerId: record.providerId,
      runtimeSessionId: record.runtimeSessionId,
      to: getRuntimeDeliveryTarget(record.destination),
      text: evidence.text,
      createdAt: evidence.createdAt,
      summary: evidence.summary,
      ...(evidence.taskRefs ? { taskRefs: evidence.taskRefs } : {}),
    });
    if (hashRuntimeDeliveryEnvelope(persistedEnvelope) !== record.logicalPayloadHash) {
      return null;
    }
    const canonicalEnvelope = normalizeRuntimeDeliveryEnvelope({
      ...persistedEnvelope,
      fromMemberName: canonicalRecord.fromMemberName,
      to: getRuntimeDeliveryTarget(canonicalRecord.destination),
    });
    return {
      recoveryRecords: [record],
      fromMemberName: canonicalEnvelope.fromMemberName,
      payloadHash: hashRuntimeDeliveryEnvelope(canonicalEnvelope),
      destination: canonicalRecord.destination,
      destinationMessageId: canonicalRecord.destinationMessageId,
    };
  } catch {
    return null;
  }
}

export function hasSameCanonicalRecoveryMigration(
  left: RuntimeDeliveryCanonicalRecoveryMigration,
  right: RuntimeDeliveryCanonicalRecoveryMigration
): boolean {
  return (
    left.payloadHash === right.payloadHash &&
    left.fromMemberName === right.fromMemberName &&
    hasSameRuntimeDeliveryDestinationIdentity(left.destination, right.destination) &&
    left.destinationMessageId === right.destinationMessageId
  );
}

// eslint-disable-next-line sonarjs/function-return-type -- destination kinds map to the target union by design
export function getRuntimeDeliveryTarget(
  destination: RuntimeDeliveryDestinationRef
): RuntimeDeliveryEnvelope['to'] {
  switch (destination.kind) {
    case 'user_sent_messages':
      return 'user';
    case 'member_inbox':
      return { memberName: destination.memberName };
    case 'cross_team_outbox':
      return { teamName: destination.toTeamName, memberName: destination.toMemberName };
  }
}

export function hasCanonicalRuntimeDeliveryIdentityChange(
  record: RuntimeDeliveryJournalRecord,
  canonicalRecord: RuntimeDeliveryJournalRecord
): boolean {
  return (
    record.fromMemberName !== canonicalRecord.fromMemberName ||
    !hasSameRuntimeDeliveryDestinationIdentity(record.destination, canonicalRecord.destination)
  );
}

export function hasSameRuntimeDeliveryLocationIdentity(
  left: RuntimeDeliveryLocation,
  right: RuntimeDeliveryLocation
): boolean {
  if (left.kind !== right.kind || left.messageId !== right.messageId) {
    return false;
  }
  if (left.kind === 'user_sent_messages' && right.kind === 'user_sent_messages') {
    return left.teamName === right.teamName;
  }
  if (left.kind === 'member_inbox' && right.kind === 'member_inbox') {
    return left.teamName === right.teamName && left.memberName === right.memberName;
  }
  return (
    left.kind === 'cross_team_outbox' &&
    right.kind === 'cross_team_outbox' &&
    left.fromTeamName === right.fromTeamName &&
    left.toTeamName === right.toTeamName &&
    left.toMemberName === right.toMemberName
  );
}

export function hasSameRuntimeDeliveryDestinationIdentity(
  left: RuntimeDeliveryDestinationRef,
  right: RuntimeDeliveryDestinationRef
): boolean {
  if (left.kind === 'user_sent_messages' && right.kind === 'user_sent_messages') {
    return left.teamName === right.teamName;
  }
  if (left.kind === 'member_inbox' && right.kind === 'member_inbox') {
    return left.teamName === right.teamName && left.memberName === right.memberName;
  }
  return (
    left.kind === 'cross_team_outbox' &&
    right.kind === 'cross_team_outbox' &&
    left.fromTeamName === right.fromTeamName &&
    left.toTeamName === right.toTeamName &&
    left.toMemberName === right.toMemberName
  );
}

export function assertSameRuntimeDeliveryJournalIdentity(
  record: RuntimeDeliveryJournalRecord,
  canonicalRecord: RuntimeDeliveryJournalRecord
): void {
  if (
    canonicalRecord.idempotencyKey !== record.idempotencyKey ||
    canonicalRecord.runId !== record.runId ||
    canonicalRecord.teamName !== record.teamName ||
    canonicalRecord.providerId !== record.providerId ||
    canonicalRecord.runtimeSessionId !== record.runtimeSessionId ||
    canonicalRecord.payloadHash !== record.payloadHash ||
    canonicalRecord.logicalPayloadHash !== record.logicalPayloadHash ||
    canonicalRecord.destinationMessageId !== record.destinationMessageId ||
    canonicalRecord.status !== record.status ||
    !hasSameRuntimeDeliveryDestinationScope(record.destination, canonicalRecord.destination) ||
    !hasSameRuntimeDeliveryLocationScope(
      record.committedLocation,
      canonicalRecord.committedLocation
    )
  ) {
    throw new Error('Runtime delivery journal canonicalizer changed immutable record identity');
  }
}

export function hasSameRuntimeDeliveryDestinationScope(
  left: RuntimeDeliveryDestinationRef,
  right: RuntimeDeliveryDestinationRef
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'user_sent_messages' && right.kind === 'user_sent_messages') {
    return left.teamName === right.teamName;
  }
  if (left.kind === 'member_inbox' && right.kind === 'member_inbox') {
    return left.teamName === right.teamName;
  }
  return (
    left.kind === 'cross_team_outbox' &&
    right.kind === 'cross_team_outbox' &&
    left.fromTeamName === right.fromTeamName &&
    left.toTeamName === right.toTeamName
  );
}

export function hasSameRuntimeDeliveryLocationScope(
  left: RuntimeDeliveryLocation | null,
  right: RuntimeDeliveryLocation | null
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  if (left.kind !== right.kind || left.messageId !== right.messageId) {
    return false;
  }
  if (left.kind === 'user_sent_messages' && right.kind === 'user_sent_messages') {
    return left.teamName === right.teamName;
  }
  if (left.kind === 'member_inbox' && right.kind === 'member_inbox') {
    return left.teamName === right.teamName;
  }
  return (
    left.kind === 'cross_team_outbox' &&
    right.kind === 'cross_team_outbox' &&
    left.fromTeamName === right.fromTeamName &&
    left.toTeamName === right.toTeamName
  );
}
