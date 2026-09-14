import { readFile } from 'node:fs/promises';

import {
  createDefaultRuntimeStoreManifest,
  type RuntimeStoreManifest,
  type RuntimeStoreManifestEntryState,
  validateRuntimeStoreManifest,
} from './RuntimeStoreManifest';

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

export interface ClearOpenCodeRuntimeLaneStorageParams {
  teamsBasePath: string;
  teamName: string;
  laneId: string;
}

export type ClearOpenCodeRuntimeLaneStorageResult = 'cleared' | 'owner_changed';

export async function resolveOpenCodeRuntimeLaneClearOwnership(input: {
  expectedRunId: string | undefined;
  laneEntryExists: boolean;
  laneEntryRunId: string | undefined;
  manifestExists: boolean;
  laneDirectoryExists(): Promise<boolean>;
  readManifestActiveRunId(): Promise<string | null | undefined>;
}): Promise<ClearOpenCodeRuntimeLaneStorageResult | null> {
  if (input.expectedRunId === undefined) return null;
  if (!input.laneEntryExists && !input.manifestExists) {
    return (await input.laneDirectoryExists()) ? 'owner_changed' : 'cleared';
  }
  if (input.laneEntryRunId !== undefined && input.laneEntryRunId !== input.expectedRunId) {
    return 'owner_changed';
  }
  if (input.manifestExists) {
    return (await input.readManifestActiveRunId()) === input.expectedRunId ? null : 'owner_changed';
  }
  return input.laneEntryRunId === undefined ? 'owner_changed' : null;
}

export async function readRuntimeStoreManifestEvidenceData(
  manifestPath: string,
  teamName: string,
  clock: () => Date
): Promise<RuntimeStoreManifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createDefaultRuntimeStoreManifest(teamName, clock().toISOString());
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  const maybeRecord =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  const manifestData =
    maybeRecord && Object.prototype.hasOwnProperty.call(maybeRecord, 'data')
      ? maybeRecord.data
      : parsed;
  return validateRuntimeStoreManifest(manifestData);
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
      ? normalizeAppManagedBootstrapCandidate(record.appManagedBootstrapCandidate)
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
  value: unknown
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

function normalizeOptionalStoreIso(value: unknown): string | null {
  const text = normalizeNonEmptyStoreString(value);
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}
