import {
  type BuiltArtifactStateManifest,
  type BuiltArtifactStateManifestEnvelope,
  HOSTED_STATE_HEADER_FORMAT,
  HOSTED_STATE_HEADER_SCHEMA_VERSION,
  type HostedStateHeader,
  type HostedStateMigrationJournal,
} from '../../contracts';

import type {
  BuiltArtifactStateManifestIntegrityProbePort,
  BuiltArtifactStateManifestReaderPort,
  HostedStateHeaderReaderPort,
  HostedStateMigrationJournalReaderPort,
} from '../../core/application';
import type {
  HostedOfflineRestoreRotationProof,
  HostedOfflineRestoreRotationProofVerifier,
  HostedOfflineRestoreRotationRequest,
  HostedStateCompatibilityRuntime,
} from '../application';
import type { Sha256Digest } from '@features/coordination-backup/contracts';

const MANIFEST_FILE = 'manifest.json';
const STATE_HEADER_FILE = 'hosted-state-header.v1.json';
const FIRST_BOOT_MARKER_FILE = 'hosted-canonical-first-boot.v1.json';
const MIGRATION_JOURNAL_FILE = 'hosted-state-migration-journal.v1.json';
const RESTORE_ROTATION_FILE = 'hosted-restore-rotation.v1.json';
const RESTORE_JOURNAL_FILE = 'hosted-restore-journal.v1.json';
const COMPLETED_RESTORE_ROTATION_FILE = 'hosted-restore-rotation.completed.v1.json';
// The storage worker pins this directory at spawn, and first boot spawns it before the
// marker can be cleared. Mirrors LOCK_DIRECTORY_NAME in productTaskWriteAuthorityLock.
const PRODUCT_TASK_WRITE_LOCK_DIRECTORY = '.product-task-write-locks';
const FIRST_BOOT_ENTRIES = [
  STATE_HEADER_FILE,
  FIRST_BOOT_MARKER_FILE,
  'storage',
  PRODUCT_TASK_WRITE_LOCK_DIRECTORY,
];
const MAX_METADATA_BYTES = 256 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class NodeBuiltArtifactStateManifestAdapter
  implements BuiltArtifactStateManifestReaderPort, BuiltArtifactStateManifestIntegrityProbePort
{
  constructor(
    private readonly artifactDirectory: string,
    private readonly runtime: HostedStateCompatibilityRuntime
  ) {}

  async readBuiltArtifactManifest(): Promise<BuiltArtifactStateManifestEnvelope> {
    const path = metadataPath(this.artifactDirectory, MANIFEST_FILE);
    const [body, digestBody] = await Promise.all([
      readRegularBoundedFile(this.runtime, path),
      readRegularBoundedFile(this.runtime, `${path}.sha256`),
    ]);
    const digest = digestBody.trim();
    if (!SHA256_PATTERN.test(digest)) throw new Error('artifact_manifest_digest_invalid');
    if (this.runtime.sha256(body) !== digest) {
      throw new Error('artifact_manifest_integrity_failed');
    }
    return Object.freeze({
      manifest: JSON.parse(body) as BuiltArtifactStateManifest,
      ref: Object.freeze({
        manifestId: readManifestId(body),
        schemaVersion: 3,
        sha256: digest as Sha256Digest,
      }),
    });
  }

  async verify(
    input: BuiltArtifactStateManifestEnvelope
  ): Promise<
    { readonly status: 'verified' } | { readonly status: 'invalid'; readonly reason: string }
  > {
    try {
      const path = metadataPath(this.artifactDirectory, MANIFEST_FILE);
      const body = await readRegularBoundedFile(this.runtime, path);
      const digest = this.runtime.sha256(body);
      return digest === input.ref.sha256 && readManifestId(body) === input.manifest.manifestId
        ? ({ status: 'verified' } as const)
        : ({ status: 'invalid', reason: 'manifest-hash-mismatch' } as const);
    } catch {
      return { status: 'invalid', reason: 'manifest-unreadable' } as const;
    }
  }
}

export class NodeHostedStateMetadataAdapter
  implements HostedStateHeaderReaderPort, HostedStateMigrationJournalReaderPort
{
  constructor(
    private readonly stateDirectory: string,
    private readonly runtime: HostedStateCompatibilityRuntime,
    private readonly rotationProofVerifier?: HostedOfflineRestoreRotationProofVerifier,
    private readonly prepareCanonicalFirstBoot = false
  ) {}

  async initializeEmptyState(
    deploymentId: string,
    hostedStateSchemaVersion: number,
    expectedRestoreGeneration?: number
  ): Promise<void> {
    await this.runtime.ensureDirectory(this.stateDirectory, 0o700);
    const entries = await this.runtime.readDirectory(this.stateDirectory);
    if (entries.includes(STATE_HEADER_FILE)) return;
    if (this.prepareCanonicalFirstBoot && entries.length === 0) {
      await this.runtime.createExclusiveDurable(
        metadataPath(this.stateDirectory, FIRST_BOOT_MARKER_FILE),
        `${JSON.stringify({
          format: 'hosted-canonical-first-boot/v1',
          deploymentId,
          restoreGeneration: expectedRestoreGeneration ?? null,
          hostedStateSchemaVersion,
          stateDirectory: this.stateDirectory,
        })}\n`,
        0o600
      );
    } else if (
      this.prepareCanonicalFirstBoot &&
      entries.length === 1 &&
      entries[0] === FIRST_BOOT_MARKER_FILE
    ) {
      await this.hasPendingCanonicalFirstBoot(
        deploymentId,
        expectedRestoreGeneration,
        hostedStateSchemaVersion
      );
    } else if (entries.includes(FIRST_BOOT_MARKER_FILE)) {
      throw new Error('hosted_canonical_first_boot_contents_invalid');
    } else if (entries.length > 0) {
      // Only v1 predates this header. Later artifacts must never infer a disk version from themselves.
      if (hostedStateSchemaVersion !== 1) {
        throw new Error('hosted_state_header_missing_from_unproven_state');
      }
      const binding = await this.runtime.inspectExistingStateBinding(this.stateDirectory);
      if (
        binding === null ||
        binding.deploymentId !== deploymentId ||
        (expectedRestoreGeneration !== undefined &&
          binding.restoreGeneration !== expectedRestoreGeneration)
      ) {
        throw new Error('hosted_state_header_missing_from_unproven_state');
      }
    }
    const header: HostedStateHeader = Object.freeze({
      format: HOSTED_STATE_HEADER_FORMAT,
      schemaVersion: HOSTED_STATE_HEADER_SCHEMA_VERSION,
      deploymentId,
      hostedStateSchemaVersion,
    });
    await this.runtime.writeExclusiveDurable(
      metadataPath(this.stateDirectory, STATE_HEADER_FILE),
      `${JSON.stringify(header)}\n`,
      0o600
    );
  }

  async hasPendingCanonicalFirstBoot(
    deploymentId: string,
    expectedRestoreGeneration?: number,
    expectedSchemaVersion?: number
  ): Promise<boolean> {
    let value: unknown;
    try {
      value = JSON.parse(
        await readRegularBoundedFile(
          this.runtime,
          metadataPath(this.stateDirectory, FIRST_BOOT_MARKER_FILE)
        )
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const schemaVersion =
      expectedSchemaVersion ?? (await this.readStateHeader()).hostedStateSchemaVersion;
    const entries = await this.runtime.readDirectory(this.stateDirectory);
    if (
      entries.some((entry) => !FIRST_BOOT_ENTRIES.includes(entry)) ||
      (entries.includes(PRODUCT_TASK_WRITE_LOCK_DIRECTORY) &&
        !(await this.runtime.isEmptyPrivateDirectory(
          metadataPath(this.stateDirectory, PRODUCT_TASK_WRITE_LOCK_DIRECTORY)
        ))) ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 5 ||
      (value as Record<string, unknown>).format !== 'hosted-canonical-first-boot/v1' ||
      (value as Record<string, unknown>).deploymentId !== deploymentId ||
      (value as Record<string, unknown>).restoreGeneration !==
        (expectedRestoreGeneration ?? null) ||
      (value as Record<string, unknown>).hostedStateSchemaVersion !== schemaVersion ||
      (value as Record<string, unknown>).stateDirectory !== this.stateDirectory
    ) {
      throw new Error('hosted_canonical_first_boot_marker_invalid');
    }
    return true;
  }

  async completeCanonicalFirstBoot(
    deploymentId: string,
    restoreGeneration?: number
  ): Promise<void> {
    if (!(await this.hasPendingCanonicalFirstBoot(deploymentId, restoreGeneration))) {
      throw new Error('hosted_canonical_first_boot_marker_missing');
    }
    await this.runtime.removeFile(metadataPath(this.stateDirectory, FIRST_BOOT_MARKER_FILE));
  }

  async readStateHeader(): Promise<HostedStateHeader> {
    return JSON.parse(
      await readRegularBoundedFile(
        this.runtime,
        metadataPath(this.stateDirectory, STATE_HEADER_FILE)
      )
    ) as HostedStateHeader;
  }

  async readMigrationJournal(): Promise<HostedStateMigrationJournal | null> {
    const path = metadataPath(this.stateDirectory, MIGRATION_JOURNAL_FILE);
    try {
      return JSON.parse(
        await readRegularBoundedFile(this.runtime, path)
      ) as HostedStateMigrationJournal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async readPendingRestoreRotation(): Promise<HostedOfflineRestoreRotationRequest | null> {
    try {
      const value = JSON.parse(
        await readRegularBoundedFile(
          this.runtime,
          metadataPath(this.stateDirectory, RESTORE_ROTATION_FILE)
        )
      ) as HostedOfflineRestoreRotationRequest;
      validateRotationRequest(value);
      return Object.freeze({ ...value });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const entries = await this.runtime.readDirectory(this.stateDirectory);
        if (entries.includes(RESTORE_JOURNAL_FILE)) {
          const completed = await readOptionalRotationRequest(
            this.runtime,
            metadataPath(this.stateDirectory, COMPLETED_RESTORE_ROTATION_FILE)
          );
          if (completed) return completed;
          throw new Error('hosted_restore_journal_without_rotation_marker');
        }
        return null;
      }
      throw error;
    }
  }

  async completePendingRestoreRotation(proof: HostedOfflineRestoreRotationProof): Promise<void> {
    const request = await this.readPendingRestoreRotation();
    if (!request || !rotationProofMatches(request, proof)) {
      throw new Error('hosted_restore_rotation_proof_invalid');
    }
    await assertCompletedRestoreJournal(this.runtime, this.stateDirectory, request);
    if (!this.rotationProofVerifier || !(await this.rotationProofVerifier.verify(request, proof))) {
      throw new Error('hosted_restore_rotation_proof_unavailable');
    }
    const completedPath = metadataPath(this.stateDirectory, COMPLETED_RESTORE_ROTATION_FILE);
    const completed = await readOptionalRotationRequest(this.runtime, completedPath);
    if (completed && !rotationRequestsMatch(request, completed)) {
      throw new Error('hosted_restore_rotation_completion_mismatch');
    }
    if (!completed) {
      await this.runtime.writeExclusiveDurable(
        completedPath,
        `${JSON.stringify(request)}\n`,
        0o600
      );
    }
    try {
      await this.runtime.removeFile(metadataPath(this.stateDirectory, RESTORE_ROTATION_FILE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await this.runtime.removeFile(metadataPath(this.stateDirectory, RESTORE_JOURNAL_FILE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function assertCompletedRestoreJournal(
  runtime: HostedStateCompatibilityRuntime,
  directory: string,
  request: HostedOfflineRestoreRotationRequest
): Promise<void> {
  let journal: unknown;
  try {
    journal = JSON.parse(
      await readRegularBoundedFile(runtime, metadataPath(directory, RESTORE_JOURNAL_FILE))
    );
  } catch {
    throw new Error('hosted_restore_journal_not_completed');
  }
  if (
    !journal ||
    typeof journal !== 'object' ||
    Array.isArray(journal) ||
    Object.keys(journal).length !== 6
  ) {
    throw new Error('hosted_restore_journal_not_completed');
  }
  const value = journal as Record<string, unknown>;
  if (
    value.format !== 'hosted-stopped-stack-restore-journal/v1' ||
    value.schemaVersion !== 1 ||
    value.phase !== 'completed' ||
    typeof value.manifestHash !== 'string' ||
    !SHA256_PATTERN.test(value.manifestHash) ||
    typeof value.keyringId !== 'string' ||
    !/^akr_[A-Za-z0-9._-]{8,127}$/.test(value.keyringId) ||
    !value.rotation ||
    typeof value.rotation !== 'object' ||
    Array.isArray(value.rotation) ||
    !rotationRequestsMatch(request, value.rotation as HostedOfflineRestoreRotationRequest)
  ) {
    throw new Error('hosted_restore_journal_not_completed');
  }
}

async function readOptionalRotationRequest(
  runtime: HostedStateCompatibilityRuntime,
  path: string
): Promise<HostedOfflineRestoreRotationRequest | null> {
  try {
    const value = JSON.parse(
      await readRegularBoundedFile(runtime, path)
    ) as HostedOfflineRestoreRotationRequest;
    validateRotationRequest(value);
    return value;
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === 'ENOENT') return null;
    throw error;
  }
}

async function readRegularBoundedFile(
  runtime: HostedStateCompatibilityRuntime,
  path: string
): Promise<string> {
  return runtime.readRegularBoundedUtf8(path, MAX_METADATA_BYTES);
}

function readManifestId(body: string): string {
  const value = JSON.parse(body) as { readonly manifestId?: unknown };
  if (typeof value.manifestId !== 'string') throw new Error('artifact_manifest_id_invalid');
  return value.manifestId;
}

function metadataPath(directory: string, fileName: string): string {
  let end = directory.length;
  while (end > 0 && directory.charCodeAt(end - 1) === 47) end -= 1;
  return `${directory.slice(0, end)}/${fileName}`;
}

export const HOSTED_STATE_METADATA_FILES = Object.freeze({
  header: STATE_HEADER_FILE,
  migrationJournal: MIGRATION_JOURNAL_FILE,
  restoreRotation: RESTORE_ROTATION_FILE,
});

function validateRotationRequest(value: HostedOfflineRestoreRotationRequest): void {
  if (
    value?.format !== 'hosted-restored-authority-rotation/v1' ||
    value.schemaVersion !== 1 ||
    typeof value.deploymentId !== 'string' ||
    !Number.isSafeInteger(value.restoreGeneration) ||
    value.restoreGeneration <= 0 ||
    typeof value.bootId !== 'string' ||
    typeof value.eventEpoch !== 'string' ||
    value.browserAuthorityRotated !== true ||
    value.runtimeAuthorityRotationRequired !== true ||
    value.freshMountBindingsRequired !== true
  ) {
    throw new Error('hosted_restore_rotation_request_invalid');
  }
}

function rotationProofMatches(
  request: HostedOfflineRestoreRotationRequest,
  proof: HostedOfflineRestoreRotationProof
): boolean {
  return (
    proof.deploymentId === request.deploymentId &&
    proof.restoreGeneration === request.restoreGeneration &&
    proof.bootId === request.bootId &&
    proof.eventEpoch === request.eventEpoch &&
    proof.browserSessionsRevoked === true &&
    proof.runtimeAuthorityRotated === true &&
    proof.mountBindingsRotated === true
  );
}

function rotationRequestsMatch(
  left: HostedOfflineRestoreRotationRequest,
  right: HostedOfflineRestoreRotationRequest
): boolean {
  return (
    left.format === right.format &&
    left.schemaVersion === right.schemaVersion &&
    left.deploymentId === right.deploymentId &&
    left.restoreGeneration === right.restoreGeneration &&
    left.bootId === right.bootId &&
    left.eventEpoch === right.eventEpoch &&
    left.browserAuthorityRotated === right.browserAuthorityRotated &&
    left.runtimeAuthorityRotationRequired === right.runtimeAuthorityRotationRequired &&
    left.freshMountBindingsRequired === right.freshMountBindingsRequired
  );
}
