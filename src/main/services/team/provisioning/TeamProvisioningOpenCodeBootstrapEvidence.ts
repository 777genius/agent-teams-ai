import { mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { getErrorMessage } from '@shared/utils/errorHandling';

import {
  type AgentTeamsMcpHttpTransportEvidence,
  getCurrentAgentTeamsMcpHttpTransportEvidence,
} from '../AgentTeamsMcpHttpServer';
import {
  getOpenCodeRuntimeManifestPath,
  type OpenCodeCommittedBootstrapSessionEvidence,
  type OpenCodeCommittedBootstrapSessionRecord,
  readCommittedOpenCodeBootstrapSessionEvidence,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import {
  createRuntimeStoreManifestStore,
  createRuntimeStoreReceiptStore,
  OPENCODE_RUNTIME_STORE_DESCRIPTORS,
  RuntimeStoreBatchWriter,
} from '../opencode/store/RuntimeStoreManifest';

import { namesMatchCaseInsensitive } from './TeamProvisioningMemberIdentity';
import { isFileLockTimeoutError } from './TeamProvisioningOpenCodeDiagnosticsPolicy';

import type { PersistedTeamLaunchMemberState } from '@shared/types';
import type {
  OpenCodeAppManagedBootstrapCandidate,
  OpenCodeBootstrapEvidenceSource,
} from '@shared/types/team';

export const OPENCODE_BOOTSTRAP_EVIDENCE_LOCK_OPTIONS = {
  acquireTimeoutMs: 45_000,
  staleTimeoutMs: 60_000,
  retryIntervalMs: 50,
} as const;

export type OpenCodeRuntimeSessionStoreRecord = Record<string, unknown>;

export interface OpenCodeRuntimeBootstrapEvidencePorts {
  teamsBasePath: string;
  readFileUtf8(filePath: string): Promise<string>;
  mkdirRecursive(directoryPath: string): Promise<void>;
  readCommittedBootstrapSessionEvidence(params: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
  }): Promise<OpenCodeCommittedBootstrapSessionEvidence>;
  getCurrentAgentTeamsMcpHttpTransportEvidence(): AgentTeamsMcpHttpTransportEvidence | null;
  isFileLockTimeoutError(error: unknown): boolean;
  warn(message: string): void;
}

export function createDefaultOpenCodeRuntimeBootstrapEvidencePorts(input: {
  teamsBasePath: string;
  warn?: (message: string) => void;
}): OpenCodeRuntimeBootstrapEvidencePorts {
  return {
    teamsBasePath: input.teamsBasePath,
    readFileUtf8: (filePath) => readFile(filePath, 'utf8'),
    mkdirRecursive: async (directoryPath) => {
      await mkdir(directoryPath, { recursive: true });
    },
    readCommittedBootstrapSessionEvidence: readCommittedOpenCodeBootstrapSessionEvidence,
    getCurrentAgentTeamsMcpHttpTransportEvidence,
    isFileLockTimeoutError,
    warn: input.warn ?? (() => undefined),
  };
}

export interface CommitOpenCodeRuntimeBootstrapSessionEvidenceInput {
  teamName: string;
  runId: string;
  laneId: string;
  memberName: string;
  runtimeSessionId: string;
  observedAt: string;
  source?: OpenCodeBootstrapEvidenceSource;
  appManagedBootstrapCandidate?: OpenCodeAppManagedBootstrapCandidate;
}

export type HasCommittedOpenCodeRuntimeBootstrapSessionEvidenceInput = Omit<
  CommitOpenCodeRuntimeBootstrapSessionEvidenceInput,
  'observedAt'
>;

export interface FindDeliverableOpenCodeRuntimeBootstrapSessionEvidenceInput {
  teamName: string;
  runId: string | null;
  laneId: string;
  memberName: string;
}

export type OpenCodeRuntimeBootstrapCheckinIdempotencyResult =
  | {
      state: 'new';
      previousMember?: PersistedTeamLaunchMemberState;
    }
  | {
      state: 'duplicate';
      previousMember: PersistedTeamLaunchMemberState;
    }
  | {
      state: 'conflict';
      previousMember: PersistedTeamLaunchMemberState;
      existingRuntimeSessionId: string;
    };

function getOpenCodeRuntimeSessionStoreDescriptor() {
  return (
    OPENCODE_RUNTIME_STORE_DESCRIPTORS.find(
      (candidate) => candidate.schemaName === 'opencode.sessionStore'
    ) ?? null
  );
}

function getOpenCodeRuntimeSessionStorePaths(input: {
  teamsBasePath: string;
  teamName: string;
  laneId: string;
}) {
  const descriptor = getOpenCodeRuntimeSessionStoreDescriptor();
  if (!descriptor) {
    return null;
  }
  const manifestPath = getOpenCodeRuntimeManifestPath(
    input.teamsBasePath,
    input.teamName,
    input.laneId
  );
  const runtimeDirectory = path.dirname(manifestPath);
  return {
    descriptor,
    manifestPath,
    runtimeDirectory,
    sessionStorePath: path.join(runtimeDirectory, descriptor.relativePath),
    receiptStorePath: path.join(runtimeDirectory, 'opencode-runtime-receipts.json'),
  };
}

export function parseOpenCodeRuntimeSessionStoreRecords(
  raw: string
): OpenCodeRuntimeSessionStoreRecord[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const record =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    const data =
      record && Object.prototype.hasOwnProperty.call(record, 'data') ? record.data : record;
    const sessions =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>).sessions
        : null;
    return Array.isArray(sessions)
      ? sessions.filter(
          (session): session is OpenCodeRuntimeSessionStoreRecord =>
            Boolean(session) && typeof session === 'object' && !Array.isArray(session)
        )
      : [];
  } catch {
    return [];
  }
}

export async function readOpenCodeRuntimeSessionStore(
  filePath: string,
  ports: Pick<OpenCodeRuntimeBootstrapEvidencePorts, 'readFileUtf8'>
): Promise<OpenCodeRuntimeSessionStoreRecord[]> {
  let raw: string;
  try {
    raw = await ports.readFileUtf8(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return parseOpenCodeRuntimeSessionStoreRecords(raw);
}

export function mergeOpenCodeRuntimeSessionRecords(
  existingSessions: OpenCodeRuntimeSessionStoreRecord[],
  session: OpenCodeRuntimeSessionStoreRecord
): OpenCodeRuntimeSessionStoreRecord[] {
  const sessionId = typeof session.id === 'string' ? session.id.trim() : '';
  const memberName = typeof session.memberName === 'string' ? session.memberName.trim() : '';
  const runId = typeof session.runId === 'string' ? session.runId.trim() : '';
  const laneId = typeof session.laneId === 'string' ? session.laneId.trim() : '';
  const filtered = existingSessions.filter((candidate) => {
    const candidateId = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    if (sessionId && candidateId === sessionId) {
      return false;
    }
    const sameMember =
      memberName &&
      runId &&
      laneId &&
      candidate.memberName === memberName &&
      candidate.runId === runId &&
      candidate.laneId === laneId;
    return !sameMember;
  });
  return [...filtered, session];
}

export function hasMatchingCommittedOpenCodeRuntimeBootstrapSessionEvidence(
  evidence: OpenCodeCommittedBootstrapSessionEvidence | null | undefined,
  input: HasCommittedOpenCodeRuntimeBootstrapSessionEvidenceInput
): boolean {
  if (!evidence?.committed) {
    return false;
  }
  if (evidence.activeRunId && evidence.activeRunId.trim() !== input.runId) {
    return false;
  }
  return evidence.sessions.some((session) => {
    if (
      session.id !== input.runtimeSessionId ||
      session.runId !== input.runId ||
      !namesMatchCaseInsensitive(session.memberName, input.memberName)
    ) {
      return false;
    }
    if (input.source && session.source !== input.source) {
      return false;
    }
    if (input.source === 'app_managed_bootstrap' && input.appManagedBootstrapCandidate) {
      const candidate = session.appManagedBootstrapCandidate;
      return (
        candidate?.runtimeSessionId === input.appManagedBootstrapCandidate.runtimeSessionId &&
        candidate.messageID === input.appManagedBootstrapCandidate.messageID &&
        candidate.contextHash === input.appManagedBootstrapCandidate.contextHash &&
        candidate.briefingHash === input.appManagedBootstrapCandidate.briefingHash
      );
    }
    return true;
  });
}

export async function hasCommittedOpenCodeRuntimeBootstrapSessionEvidence(
  input: HasCommittedOpenCodeRuntimeBootstrapSessionEvidenceInput,
  ports: OpenCodeRuntimeBootstrapEvidencePorts
): Promise<boolean> {
  const evidence = await ports
    .readCommittedBootstrapSessionEvidence({
      teamsBasePath: ports.teamsBasePath,
      teamName: input.teamName,
      laneId: input.laneId,
    })
    .catch(() => null);

  return hasMatchingCommittedOpenCodeRuntimeBootstrapSessionEvidence(evidence, input);
}

export function getOpenCodeAppMcpTransportMismatchDiagnostic(
  session: OpenCodeCommittedBootstrapSessionRecord,
  currentTransportEvidence: Pick<
    AgentTeamsMcpHttpTransportEvidence,
    'urlHash'
  > | null = getCurrentAgentTeamsMcpHttpTransportEvidence()
): string | null {
  const committedHash = session.appMcpTransportHash?.trim();
  const currentHash = currentTransportEvidence?.urlHash?.trim();
  if (!committedHash || !currentHash || committedHash === currentHash) {
    return null;
  }
  return `opencode_app_mcp_transport_changed:${committedHash}->${currentHash}`;
}

export async function commitOpenCodeRuntimeBootstrapSessionEvidence(
  input: CommitOpenCodeRuntimeBootstrapSessionEvidenceInput,
  ports: OpenCodeRuntimeBootstrapEvidencePorts
): Promise<void> {
  const paths = getOpenCodeRuntimeSessionStorePaths({
    teamsBasePath: ports.teamsBasePath,
    teamName: input.teamName,
    laneId: input.laneId,
  });
  if (!paths) {
    throw new Error('OpenCode runtime session store descriptor is not registered');
  }

  await ports.mkdirRecursive(paths.runtimeDirectory);
  const existingSessions = await readOpenCodeRuntimeSessionStore(paths.sessionStorePath, ports);
  const source = input.source ?? 'runtime_bootstrap_checkin';
  const appMcpTransportEvidence =
    source === 'app_managed_bootstrap'
      ? ports.getCurrentAgentTeamsMcpHttpTransportEvidence()
      : null;
  const session: OpenCodeRuntimeSessionStoreRecord = {
    id: input.runtimeSessionId,
    teamName: input.teamName,
    memberName: input.memberName,
    runId: input.runId,
    laneId: input.laneId,
    providerId: 'opencode',
    observedAt: input.observedAt,
    source,
    ...(source === 'app_managed_bootstrap' && input.appManagedBootstrapCandidate
      ? { appManagedBootstrapCandidate: input.appManagedBootstrapCandidate }
      : {}),
    ...(appMcpTransportEvidence
      ? {
          appMcpTransportHash: appMcpTransportEvidence.urlHash,
          appMcpTransportEvidence,
        }
      : {}),
  };
  const sessions = mergeOpenCodeRuntimeSessionRecords(existingSessions, session);
  const manifestStore = createRuntimeStoreManifestStore({
    filePath: paths.manifestPath,
    teamName: input.teamName,
    lockOptions: OPENCODE_BOOTSTRAP_EVIDENCE_LOCK_OPTIONS,
  });
  const receiptStore = createRuntimeStoreReceiptStore({
    filePath: paths.receiptStorePath,
    lockOptions: OPENCODE_BOOTSTRAP_EVIDENCE_LOCK_OPTIONS,
  });
  const writer = new RuntimeStoreBatchWriter(paths.runtimeDirectory, manifestStore, receiptStore);

  try {
    await writer.writeBatch({
      teamName: input.teamName,
      runId: input.runId,
      capabilitySnapshotId: null,
      behaviorFingerprint: null,
      reason: 'launch_checkpoint',
      writes: [
        {
          descriptor: paths.descriptor,
          data: { sessions },
        },
      ],
    });
  } catch (error) {
    if (
      ports.isFileLockTimeoutError(error) &&
      (await hasCommittedOpenCodeRuntimeBootstrapSessionEvidence(input, ports))
    ) {
      return;
    }
    throw error;
  }
  if (!(await hasCommittedOpenCodeRuntimeBootstrapSessionEvidence(input, ports))) {
    throw new Error(
      `OpenCode bootstrap session evidence write did not verify for ${input.memberName}`
    );
  }
}

export async function stampOpenCodeAppMcpTransportEvidenceIfMissing(
  session: OpenCodeCommittedBootstrapSessionRecord,
  ports: OpenCodeRuntimeBootstrapEvidencePorts,
  options: {
    overwriteExistingHash?: boolean;
    runtimeSessionId?: string | null;
  } = {}
): Promise<void> {
  const overwriteExistingHash = options.overwriteExistingHash === true;
  const runtimeSessionId = options.runtimeSessionId?.trim() || null;
  if (session.appMcpTransportHash?.trim() && !overwriteExistingHash) {
    return;
  }
  const appMcpTransportEvidence = ports.getCurrentAgentTeamsMcpHttpTransportEvidence();
  if (!appMcpTransportEvidence) {
    return;
  }
  const paths = getOpenCodeRuntimeSessionStorePaths({
    teamsBasePath: ports.teamsBasePath,
    teamName: session.teamName,
    laneId: session.laneId,
  });
  if (!paths) {
    return;
  }

  try {
    const existingSessions = await readOpenCodeRuntimeSessionStore(paths.sessionStorePath, ports);
    let changed = false;
    const sessions = existingSessions
      .filter((record) => {
        if (!runtimeSessionId || runtimeSessionId === session.id) {
          return true;
        }
        const recordId = typeof record.id === 'string' ? record.id : '';
        const recordRunId = typeof record.runId === 'string' ? record.runId : null;
        const recordLaneId = typeof record.laneId === 'string' ? record.laneId : '';
        const recordMemberName = typeof record.memberName === 'string' ? record.memberName : '';
        return !(
          recordId === runtimeSessionId &&
          recordRunId === session.runId &&
          recordLaneId === session.laneId &&
          namesMatchCaseInsensitive(recordMemberName, session.memberName)
        );
      })
      .map((record) => {
        const recordId = typeof record.id === 'string' ? record.id : '';
        const recordRunId = typeof record.runId === 'string' ? record.runId : null;
        const recordLaneId = typeof record.laneId === 'string' ? record.laneId : '';
        const recordMemberName = typeof record.memberName === 'string' ? record.memberName : '';
        const hasTransportHash =
          typeof record.appMcpTransportHash === 'string' &&
          record.appMcpTransportHash.trim().length > 0;
        if (
          recordId !== session.id ||
          recordRunId !== session.runId ||
          recordLaneId !== session.laneId ||
          !namesMatchCaseInsensitive(recordMemberName, session.memberName) ||
          (hasTransportHash && !overwriteExistingHash)
        ) {
          return record;
        }
        changed = true;
        return {
          ...record,
          ...(runtimeSessionId ? { id: runtimeSessionId } : {}),
          appMcpTransportHash: appMcpTransportEvidence.urlHash,
          appMcpTransportEvidence,
        };
      });
    if (!changed) {
      return;
    }

    const manifestStore = createRuntimeStoreManifestStore({
      filePath: paths.manifestPath,
      teamName: session.teamName,
      lockOptions: OPENCODE_BOOTSTRAP_EVIDENCE_LOCK_OPTIONS,
    });
    const receiptStore = createRuntimeStoreReceiptStore({
      filePath: paths.receiptStorePath,
      lockOptions: OPENCODE_BOOTSTRAP_EVIDENCE_LOCK_OPTIONS,
    });
    const writer = new RuntimeStoreBatchWriter(paths.runtimeDirectory, manifestStore, receiptStore);
    await writer.writeBatch({
      teamName: session.teamName,
      runId: session.runId,
      capabilitySnapshotId: null,
      behaviorFingerprint: null,
      reason: 'delivery_commit',
      writes: [
        {
          descriptor: paths.descriptor,
          data: { sessions },
        },
      ],
    });
  } catch (error) {
    ports.warn(
      `[${session.teamName}] Failed to stamp OpenCode app MCP transport evidence for ${
        session.memberName
      }: ${getErrorMessage(error)}`
    );
  }
}

export function findDeliverableOpenCodeRuntimeBootstrapSessionEvidenceInCommittedEvidence(
  evidence: OpenCodeCommittedBootstrapSessionEvidence | null | undefined,
  input: FindDeliverableOpenCodeRuntimeBootstrapSessionEvidenceInput
): OpenCodeCommittedBootstrapSessionRecord | null {
  if (!evidence?.committed) {
    return null;
  }
  const activeRunId = evidence.activeRunId?.trim() || null;
  if (activeRunId !== input.runId) {
    return null;
  }
  return (
    evidence.sessions.find(
      (session) =>
        session.runId === input.runId &&
        namesMatchCaseInsensitive(session.memberName, input.memberName)
    ) ?? null
  );
}

export async function findDeliverableOpenCodeRuntimeBootstrapSessionEvidence(
  input: FindDeliverableOpenCodeRuntimeBootstrapSessionEvidenceInput,
  ports: OpenCodeRuntimeBootstrapEvidencePorts
): Promise<OpenCodeCommittedBootstrapSessionRecord | null> {
  const evidence = await ports
    .readCommittedBootstrapSessionEvidence({
      teamsBasePath: ports.teamsBasePath,
      teamName: input.teamName,
      laneId: input.laneId,
    })
    .catch(() => null);

  return findDeliverableOpenCodeRuntimeBootstrapSessionEvidenceInCommittedEvidence(evidence, input);
}

export async function hasDeliverableOpenCodeRuntimeBootstrapSessionEvidence(
  input: FindDeliverableOpenCodeRuntimeBootstrapSessionEvidenceInput,
  ports: OpenCodeRuntimeBootstrapEvidencePorts
): Promise<boolean> {
  return (await findDeliverableOpenCodeRuntimeBootstrapSessionEvidence(input, ports)) != null;
}

export function resolveOpenCodeRuntimeBootstrapCheckinIdempotencyFromMember(input: {
  previousMember?: PersistedTeamLaunchMemberState;
  runId: string;
  runtimeSessionId: string;
}): OpenCodeRuntimeBootstrapCheckinIdempotencyResult {
  const previousMember = input.previousMember;
  if (!previousMember) {
    return { state: 'new' };
  }

  const existingRuntimeSessionId = previousMember.runtimeSessionId?.trim();
  const existingRuntimeRunId =
    typeof previousMember.runtimeRunId === 'string' ? previousMember.runtimeRunId.trim() : '';
  const hasAcceptedBootstrap =
    previousMember.bootstrapConfirmed === true ||
    previousMember.livenessKind === 'confirmed_bootstrap' ||
    previousMember.launchState === 'confirmed_alive';

  if (!hasAcceptedBootstrap || !existingRuntimeSessionId) {
    return { state: 'new', previousMember };
  }

  if (existingRuntimeRunId && existingRuntimeRunId !== input.runId) {
    return { state: 'new', previousMember };
  }

  if (existingRuntimeSessionId === input.runtimeSessionId) {
    return { state: 'duplicate', previousMember };
  }

  if (!existingRuntimeRunId) {
    return { state: 'new', previousMember };
  }

  return {
    state: 'conflict',
    previousMember,
    existingRuntimeSessionId,
  };
}
