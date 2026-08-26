export type OpenCodeStrictLaunchAttemptDisposition =
  | 'continuation_eligible'
  | 'reconciliation_required';

export interface PersistedOpenCodeStrictLaunchAttempt {
  contractVersion: 1;
  disposition: OpenCodeStrictLaunchAttemptDisposition;
  attemptId: string;
  payloadHash: string;
  generation: number;
  runId: string;
  laneId: string;
  parent: {
    sessionIdentity: `sha256:${string}`;
    messageIdentity: `sha256:${string}`;
  };
  continuationToken?: string;
  inputDigest: string | null;
  immutableDigest: string | null;
  providerId: string;
  modelId: string;
  roster: Array<{ name: string; memberIdentity: `sha256:${string}` }>;
  partitions: {
    committed: `sha256:${string}`[];
    failed: `sha256:${string}`[];
    pending: `sha256:${string}`[];
    cleanupPending: `sha256:${string}`[];
  };
}

const SHA256 = /^[0-9a-f]{64}$/;
const OPAQUE_IDENTITY = /^sha256:[0-9a-f]{64}$/;
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function normalizePersistedOpenCodeStrictLaunchAttempt(
  value: unknown
): PersistedOpenCodeStrictLaunchAttempt | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.contractVersion !== 1 ||
    (record.disposition !== 'continuation_eligible' &&
      record.disposition !== 'reconciliation_required') ||
    typeof record.attemptId !== 'string' ||
    !ATTEMPT_ID.test(record.attemptId) ||
    typeof record.payloadHash !== 'string' ||
    !SHA256.test(record.payloadHash) ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) <= 0 ||
    typeof record.runId !== 'string' ||
    !record.runId.trim() ||
    typeof record.laneId !== 'string' ||
    !record.laneId.trim() ||
    !isDigest(record.inputDigest, record.disposition) ||
    !isDigest(record.immutableDigest, record.disposition) ||
    typeof record.providerId !== 'string' ||
    !record.providerId ||
    typeof record.modelId !== 'string' ||
    !record.modelId ||
    !record.parent ||
    typeof record.parent !== 'object' ||
    Array.isArray(record.parent) ||
    !Array.isArray(record.roster) ||
    !record.partitions ||
    typeof record.partitions !== 'object' ||
    Array.isArray(record.partitions)
  ) {
    return undefined;
  }
  const parent = record.parent as Record<string, unknown>;
  if (!isIdentity(parent.sessionIdentity) || !isIdentity(parent.messageIdentity)) {
    return undefined;
  }
  const roster: PersistedOpenCodeStrictLaunchAttempt['roster'] = [];
  for (const value of record.roster) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const member = value as Record<string, unknown>;
    if (
      typeof member.name === 'string' &&
      member.name.trim() &&
      isIdentity(member.memberIdentity)
    ) {
      roster.push({ name: member.name.trim(), memberIdentity: member.memberIdentity });
    }
  }
  if (
    roster.length !== record.roster.length ||
    new Set(roster.map((member) => member.name)).size !== roster.length ||
    new Set(roster.map((member) => member.memberIdentity)).size !== roster.length
  ) {
    return undefined;
  }
  const partitionsRecord = record.partitions as Record<string, unknown>;
  const committed = readIdentities(partitionsRecord.committed);
  const failed = readIdentities(partitionsRecord.failed);
  const pending = readIdentities(partitionsRecord.pending);
  const cleanupPending = readIdentities(partitionsRecord.cleanupPending);
  if (!committed || !failed || !pending || !cleanupPending) return undefined;
  const partition = [...committed, ...failed, ...pending];
  const rosterIdentities = roster.map((member) => member.memberIdentity);
  if (
    partition.length !== rosterIdentities.length ||
    new Set(partition).size !== partition.length ||
    rosterIdentities.some((identity) => !partition.includes(identity)) ||
    cleanupPending.some((identity) => !rosterIdentities.includes(identity))
  ) {
    return undefined;
  }
  const continuationToken = optionalString(record.continuationToken);
  if (
    (record.disposition === 'continuation_eligible' && !continuationToken) ||
    (record.disposition === 'reconciliation_required' && record.continuationToken !== undefined)
  ) {
    return undefined;
  }
  return {
    contractVersion: 1,
    disposition: record.disposition,
    attemptId: record.attemptId,
    payloadHash: record.payloadHash,
    generation: record.generation as number,
    runId: record.runId.trim(),
    laneId: record.laneId.trim(),
    parent: { sessionIdentity: parent.sessionIdentity, messageIdentity: parent.messageIdentity },
    ...(continuationToken ? { continuationToken } : {}),
    inputDigest: record.inputDigest as string | null,
    immutableDigest: record.immutableDigest as string | null,
    providerId: record.providerId,
    modelId: record.modelId,
    roster,
    partitions: { committed, failed, pending, cleanupPending },
  };
}

function isDigest(value: unknown, disposition: unknown): boolean {
  return (
    (typeof value === 'string' && SHA256.test(value)) ||
    (disposition === 'reconciliation_required' && value === null)
  );
}

function isIdentity(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && OPAQUE_IDENTITY.test(value);
}

function readIdentities(value: unknown): `sha256:${string}`[] | undefined {
  if (!Array.isArray(value) || !value.every(isIdentity) || new Set(value).size !== value.length) {
    return undefined;
  }
  return [...value];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
