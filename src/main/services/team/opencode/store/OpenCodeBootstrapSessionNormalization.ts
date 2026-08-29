import type { RuntimeStoreManifestEntryState } from './RuntimeStoreManifest';
import type {
  OpenCodeAppManagedBootstrapCandidate,
  OpenCodeBootstrapEvidenceSource,
} from '@shared/types/team';

export interface OpenCodeCommittedBootstrapSessionRecord {
  id: string;
  teamName: string;
  memberName: string;
  laneId: string;
  runId: string | null;
  observedAt: string | null;
  source: OpenCodeBootstrapEvidenceSource;
  appManagedBootstrapCandidate?: OpenCodeAppManagedBootstrapCandidate;
  appMcpTransportHash?: string;
  appMcpTransportEvidence?: Record<string, unknown>;
}

export interface OpenCodeCommittedBootstrapSessionEvidence {
  state: RuntimeStoreManifestEntryState | 'invalid_store' | 'descriptor_missing';
  committed: boolean;
  activeRunId: string | null;
  sessions: OpenCodeCommittedBootstrapSessionRecord[];
  diagnostics: string[];
}

export function normalizeOpenCodeRuntimeBootstrapCandidate(
  value: OpenCodeAppManagedBootstrapCandidate | undefined,
  expected: {
    teamName: string;
    memberName: string;
    runId: string;
    laneId: string;
    runtimeSessionId?: string;
  }
): OpenCodeAppManagedBootstrapCandidate | undefined {
  if (value?.schemaVersion !== 1 || value.source !== 'app_managed_bootstrap') {
    return undefined;
  }
  if (
    value.teamName !== expected.teamName ||
    value.memberName !== expected.memberName ||
    value.runId !== expected.runId ||
    value.laneId !== expected.laneId ||
    (expected.runtimeSessionId && value.runtimeSessionId !== expected.runtimeSessionId)
  ) {
    return undefined;
  }
  if (
    !isNonEmptyString(value.runtimeSessionId) ||
    !isNonEmptyString(value.messageID) ||
    !value.messageID.startsWith('msg') ||
    !isNonEmptyString(value.contextHash) ||
    !isNonEmptyString(value.briefingHash) ||
    !isNonEmptyString(value.injectionVerifiedAt) ||
    !isNonEmptyString(value.candidateAt)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    source: 'app_managed_bootstrap',
    teamName: value.teamName,
    memberName: value.memberName,
    runId: value.runId,
    laneId: value.laneId,
    runtimeSessionId: value.runtimeSessionId,
    messageID: value.messageID,
    contextHash: value.contextHash,
    briefingHash: value.briefingHash,
    injectionVerifiedAt: value.injectionVerifiedAt,
    candidateAt: value.candidateAt,
    ...(isNonEmptyString(value.model) ? { model: value.model } : {}),
    ...(isNonEmptyString(value.agent) ? { agent: value.agent } : {}),
  };
}

export function normalizeOpenCodeBootstrapSessionRecord(
  value: unknown
): OpenCodeCommittedBootstrapSessionRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeNonEmptyStoreString(record.id);
  const teamName = normalizeNonEmptyStoreString(record.teamName);
  const memberName = normalizeNonEmptyStoreString(record.memberName);
  const laneId = normalizeNonEmptyStoreString(record.laneId);
  const source = normalizeNonEmptyStoreString(record.source);
  if (
    !id ||
    !teamName ||
    !memberName ||
    !laneId ||
    (source !== 'runtime_bootstrap_checkin' && source !== 'app_managed_bootstrap')
  ) {
    return null;
  }
  const observedAt = normalizeOptionalStoreIso(record.observedAt);
  const appManagedBootstrapCandidate =
    source === 'app_managed_bootstrap'
      ? normalizeAppManagedBootstrapCandidate(record.appManagedBootstrapCandidate, {
          id,
          teamName,
          memberName,
          laneId,
          runId: normalizeNonEmptyStoreString(record.runId),
        })
      : undefined;
  const appMcpTransportHash = normalizeNonEmptyStoreString(record.appMcpTransportHash);
  const appMcpTransportEvidence =
    record.appMcpTransportEvidence &&
    typeof record.appMcpTransportEvidence === 'object' &&
    !Array.isArray(record.appMcpTransportEvidence)
      ? (record.appMcpTransportEvidence as Record<string, unknown>)
      : undefined;
  return {
    id,
    teamName,
    memberName,
    laneId,
    runId: normalizeNonEmptyStoreString(record.runId),
    observedAt,
    source,
    ...(appManagedBootstrapCandidate ? { appManagedBootstrapCandidate } : {}),
    ...(appMcpTransportHash ? { appMcpTransportHash } : {}),
    ...(appMcpTransportEvidence ? { appMcpTransportEvidence } : {}),
  };
}

function normalizeAppManagedBootstrapCandidate(
  value: unknown,
  session: {
    id: string;
    teamName: string;
    memberName: string;
    laneId: string;
    runId: string | null;
  }
): OpenCodeAppManagedBootstrapCandidate | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.source !== 'app_managed_bootstrap') {
    return undefined;
  }
  const teamName = normalizeNonEmptyStoreString(record.teamName);
  const memberName = normalizeNonEmptyStoreString(record.memberName);
  const runId = normalizeNonEmptyStoreString(record.runId);
  const laneId = normalizeNonEmptyStoreString(record.laneId);
  const runtimeSessionId = normalizeNonEmptyStoreString(record.runtimeSessionId);
  const messageID = normalizeNonEmptyStoreString(record.messageID);
  const contextHash = normalizeNonEmptyStoreString(record.contextHash);
  const briefingHash = normalizeNonEmptyStoreString(record.briefingHash);
  const injectionVerifiedAt = normalizeNonEmptyStoreString(record.injectionVerifiedAt);
  const candidateAt = normalizeNonEmptyStoreString(record.candidateAt);
  if (
    !teamName ||
    !memberName ||
    !runId ||
    !laneId ||
    !runtimeSessionId ||
    !messageID ||
    !contextHash ||
    !briefingHash ||
    !injectionVerifiedAt ||
    !candidateAt
  ) {
    return undefined;
  }
  if (
    runtimeSessionId !== session.id ||
    teamName !== session.teamName ||
    memberName !== session.memberName ||
    runId !== session.runId ||
    laneId !== session.laneId
  ) {
    return undefined;
  }
  const model = normalizeNonEmptyStoreString(record.model);
  const agent = normalizeNonEmptyStoreString(record.agent);
  return {
    schemaVersion: 1,
    source: 'app_managed_bootstrap',
    teamName,
    memberName,
    runId,
    laneId,
    runtimeSessionId,
    messageID,
    contextHash,
    briefingHash,
    injectionVerifiedAt,
    candidateAt,
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
  };
}

function normalizeNonEmptyStoreString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeOptionalStoreIso(value: unknown): string | null {
  const text = normalizeNonEmptyStoreString(value);
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}
