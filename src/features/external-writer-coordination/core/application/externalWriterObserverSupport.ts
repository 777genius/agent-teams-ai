import {
  type ExternalContentChecksum,
  type ExternalFileActor,
  type ExternalFileReconciliationResult,
  type ExternalFileRegistration,
  type ExternalFileSourceFingerprint,
  type ExternalFileStat,
  type ExternalFileStatIdentity,
  type ExternalWriterDirtyReason,
  type ExternalWriterObserverOptions,
  type ExternalWriterScope,
  type FileWriterEpoch,
  type ObservationSequence,
  type VerifiedRunActor,
} from '../../contracts';

import type {
  ExternalContentChecksumPort,
  ExternalFileObservationCatalog,
  ExternalFileObservationSource,
  ExternalFileReconciliationPort,
  ExternalWriterObservationStateStore,
  ExternalWriterObserverClock,
  ExternalWriterWatchPort,
  VerifiedRunEvidencePort,
} from './ports';

export const DEFAULT_OPTIONS: ExternalWriterObserverOptions = {
  maxPendingObservations: 1_024,
  maxSelfWriteIntents: 1_024,
  maxScopes: 1_024,
  maxObservedFiles: 100_000,
  maxFilesPerScope: 10_000,
  maxReadBytes: 4 * 1_024 * 1_024,
  maxStableReadAttempts: 4,
  maxObservationAttempts: 3,
  maxDrainPassObservations: 20_000,
  maxQuiescenceAttempts: 4,
  stableReadDeadlineMs: 2_000,
  retryDelayMs: 10,
  atomicReplaceDebounceMs: 25,
  shutdownDrainDeadlineMs: 5_000,
};

export type StableReadOutcome =
  | {
      outcome: 'stable';
      content: Uint8Array | null;
      fingerprint: ExternalFileSourceFingerprint;
    }
  | {
      outcome: 'invalid';
      reason: Extract<
        ExternalWriterDirtyReason,
        'outside_containment' | 'oversized' | 'unsupported_file_type'
      >;
    }
  | { outcome: 'unstable' };

export interface TeamQuiescenceFence {
  fileWriterEpoch: FileWriterEpoch;
  lastObservationSequence: ObservationSequence;
  observationWatermark: ObservationSequence;
  clean: boolean;
}

export interface ExternalWriterObserverDependencies {
  watch: ExternalWriterWatchPort;
  catalog: ExternalFileObservationCatalog;
  source: ExternalFileObservationSource;
  checksums: ExternalContentChecksumPort;
  reconciliation: ExternalFileReconciliationPort;
  stateStore: ExternalWriterObservationStateStore;
  clock: ExternalWriterObserverClock;
  verifiedRunEvidence?: VerifiedRunEvidencePort;
}

export class ExternalWriterObserverError extends Error {
  constructor(
    readonly code: 'already_started' | 'catalog_invalid' | 'not_running' | 'options_invalid'
  ) {
    super(`external-writer-observer:${code}`);
    this.name = 'ExternalWriterObserverError';
  }
}

export const scopesEqual = (left: ExternalWriterScope, right: ExternalWriterScope): boolean =>
  left.teamId === right.teamId && left.featureKey === right.featureKey;

export const fingerprintsEqual = (
  left: ExternalFileSourceFingerprint,
  right: ExternalFileSourceFingerprint
): boolean => left.exists === right.exists && left.checksum === right.checksum;

export const isSafeNonNegativeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

export const isSafePositiveInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

export const isClosedReconciliationResult = (
  value: unknown
): value is ExternalFileReconciliationResult => {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.outcome) {
    case 'accepted_change':
      return (
        typeof value.sourceGeneration === 'number' &&
        isSafeNonNegativeInteger(value.sourceGeneration) &&
        typeof value.featureRevision === 'number' &&
        isSafeNonNegativeInteger(value.featureRevision)
      );
    case 'semantic_noop':
      return (
        typeof value.sourceGeneration === 'number' &&
        isSafeNonNegativeInteger(value.sourceGeneration)
      );
    case 'invalid':
      return (
        isNonEmptyString(value.diagnosticCode) &&
        typeof value.blocksDependentMutations === 'boolean'
      );
    case 'conflict':
      return isNonEmptyString(value.diagnosticCode);
    default:
      return false;
  }
};

const statIdentity = (stat: ExternalFileStat): ExternalFileStatIdentity | null => {
  if (
    stat.kind !== 'file' ||
    stat.device === null ||
    stat.inode === null ||
    stat.modifiedTimeNs === null ||
    stat.changedTimeNs === null
  ) {
    return null;
  }
  return {
    byteLength: stat.byteLength,
    device: stat.device,
    inode: stat.inode,
    modifiedTimeNs: stat.modifiedTimeNs,
    changedTimeNs: stat.changedTimeNs,
  };
};

const statIdentitiesEqual = (
  left: ExternalFileStatIdentity,
  right: ExternalFileStatIdentity
): boolean =>
  left.byteLength === right.byteLength &&
  left.device === right.device &&
  left.inode === right.inode &&
  left.modifiedTimeNs === right.modifiedTimeNs &&
  left.changedTimeNs === right.changedTimeNs;

export async function classifyExternalWriterActor(
  dependencies: ExternalWriterObserverDependencies,
  input: {
    readonly registration: ExternalFileRegistration;
    readonly content: Uint8Array | null;
    readonly checksum: ExternalContentChecksum | null;
    readonly observationSequence: ObservationSequence;
    readonly fileWriterEpoch: FileWriterEpoch;
  }
): Promise<ExternalFileActor | VerifiedRunActor> {
  const externalActor: ExternalFileActor = {
    kind: 'external_file',
    teamId: input.registration.scope.teamId,
    featureKey: input.registration.scope.featureKey,
    fileKey: input.registration.fileKey,
    checksum: input.checksum,
    observationSequence: input.observationSequence,
  };
  if (
    input.registration.attributionPolicy !== 'verified_run_evidence' ||
    !dependencies.verifiedRunEvidence
  ) {
    return externalActor;
  }
  let verified: VerifiedRunActor | null;
  try {
    verified = await dependencies.verifiedRunEvidence.verify(input);
  } catch {
    return externalActor;
  }
  if (!verified) {
    return externalActor;
  }
  if (
    verified.kind !== 'verified_run' ||
    verified.teamId !== input.registration.scope.teamId ||
    typeof verified.runId !== 'string' ||
    verified.runId.length === 0 ||
    (verified.memberId !== null && typeof verified.memberId !== 'string') ||
    typeof verified.evidenceRef !== 'string' ||
    verified.evidenceRef.length === 0 ||
    !isSafePositiveInteger(verified.runGeneration)
  ) {
    return externalActor;
  }
  return verified;
}

export async function readStableExternalFile(
  dependencies: ExternalWriterObserverDependencies,
  options: ExternalWriterObserverOptions,
  registration: ExternalFileRegistration
): Promise<StableReadOutcome> {
  const startedAt = dependencies.clock.nowMs();
  for (let attempt = 0; attempt < options.maxStableReadAttempts; attempt += 1) {
    try {
      const before = await dependencies.source.stat(registration);
      if (!before.contained) {
        return { outcome: 'invalid', reason: 'outside_containment' };
      }
      if (before.kind === 'missing') {
        await dependencies.clock.sleep(options.atomicReplaceDebounceMs);
        const confirmed = await dependencies.source.confirmAbsentByParentRescan(registration);
        const afterConfirmation = await dependencies.source.stat(registration);
        if (confirmed && afterConfirmation.kind === 'missing' && afterConfirmation.contained) {
          return {
            outcome: 'stable',
            content: null,
            fingerprint: { exists: false, checksum: null, statIdentity: null },
          };
        }
        await retryStableRead(dependencies.clock, options, startedAt, attempt);
        continue;
      }
      if (before.kind !== 'file') {
        return { outcome: 'invalid', reason: 'unsupported_file_type' };
      }
      const maximumBytes = Math.min(registration.maxBytes, options.maxReadBytes);
      if (!isSafeNonNegativeInteger(before.byteLength) || before.byteLength > maximumBytes) {
        return { outcome: 'invalid', reason: 'oversized' };
      }
      const beforeIdentity = statIdentity(before);
      if (!beforeIdentity) {
        await retryStableRead(dependencies.clock, options, startedAt, attempt);
        continue;
      }
      const content = await dependencies.source.read(registration, maximumBytes);
      const after = await dependencies.source.stat(registration);
      const afterIdentity = statIdentity(after);
      if (
        !after.contained ||
        !afterIdentity ||
        content.byteLength !== before.byteLength ||
        !statIdentitiesEqual(beforeIdentity, afterIdentity)
      ) {
        await retryStableRead(dependencies.clock, options, startedAt, attempt);
        continue;
      }
      const checksum = await dependencies.checksums.checksum(content);
      if (checksum.length === 0) {
        await retryStableRead(dependencies.clock, options, startedAt, attempt);
        continue;
      }
      return {
        outcome: 'stable',
        content,
        fingerprint: { exists: true, checksum, statIdentity: afterIdentity },
      };
    } catch {
      await retryStableRead(dependencies.clock, options, startedAt, attempt);
    }
  }
  return { outcome: 'unstable' };
}

async function retryStableRead(
  clock: ExternalWriterObserverClock,
  options: ExternalWriterObserverOptions,
  startedAt: number,
  attempt: number
): Promise<void> {
  if (
    attempt + 1 < options.maxStableReadAttempts &&
    clock.nowMs() - startedAt < options.stableReadDeadlineMs
  ) {
    await clock.sleep(options.retryDelayMs * (attempt + 1));
  }
}

export function externalWriterStateLimits(options: ExternalWriterObserverOptions): {
  maxPendingObservations: number;
  maxSelfWriteIntents: number;
  maxObservationAttempts: number;
  maxScopes: number;
  maxObservedFiles: number;
} {
  return {
    maxPendingObservations: options.maxPendingObservations,
    maxSelfWriteIntents: options.maxSelfWriteIntents,
    maxObservationAttempts: options.maxObservationAttempts,
    maxScopes: options.maxScopes,
    maxObservedFiles: options.maxObservedFiles,
  };
}

export function assertExternalWriterObserverOptions(options: ExternalWriterObserverOptions): void {
  const positiveIntegerOptions = [
    options.maxPendingObservations,
    options.maxSelfWriteIntents,
    options.maxScopes,
    options.maxObservedFiles,
    options.maxFilesPerScope,
    options.maxReadBytes,
    options.maxStableReadAttempts,
    options.maxObservationAttempts,
    options.maxDrainPassObservations,
    options.maxQuiescenceAttempts,
  ];
  if (
    positiveIntegerOptions.some((value) => !isSafePositiveInteger(value)) ||
    !isSafeNonNegativeInteger(options.stableReadDeadlineMs) ||
    !isSafeNonNegativeInteger(options.retryDelayMs) ||
    !isSafeNonNegativeInteger(options.atomicReplaceDebounceMs) ||
    !isSafeNonNegativeInteger(options.shutdownDrainDeadlineMs)
  ) {
    throw new ExternalWriterObserverError('options_invalid');
  }
}

export async function listScopes(
  dependencies: ExternalWriterObserverDependencies,
  options: ExternalWriterObserverOptions
): Promise<readonly ExternalWriterScope[]> {
  const scopes = await dependencies.catalog.listScopes();
  if (scopes.length > options.maxScopes) {
    throw new ExternalWriterObserverError('catalog_invalid');
  }
  const seen = new Set<string>();
  for (const scope of scopes) {
    const key = `${scope.teamId.length}:${scope.teamId}${scope.featureKey.length}:${scope.featureKey}`;
    if (scope.teamId.length === 0 || scope.featureKey.length === 0 || seen.has(key)) {
      throw new ExternalWriterObserverError('catalog_invalid');
    }
    seen.add(key);
  }
  return scopes;
}

export async function listRegistrations(
  dependencies: ExternalWriterObserverDependencies,
  options: ExternalWriterObserverOptions,
  scope: ExternalWriterScope
): Promise<readonly ExternalFileRegistration[]> {
  const registrations = await dependencies.catalog.listRegistrations(scope);
  if (registrations.length > options.maxFilesPerScope) {
    throw new ExternalWriterObserverError('catalog_invalid');
  }
  const seen = new Set<string>();
  for (const registration of registrations) {
    if (
      !scopesEqual(registration.scope, scope) ||
      registration.fileKey.length === 0 ||
      !isSafePositiveInteger(registration.maxBytes) ||
      registration.maxBytes > options.maxReadBytes ||
      (registration.attributionPolicy !== 'external_file_only' &&
        registration.attributionPolicy !== 'verified_run_evidence') ||
      seen.has(registration.fileKey)
    ) {
      throw new ExternalWriterObserverError('catalog_invalid');
    }
    seen.add(registration.fileKey);
  }
  return registrations;
}
