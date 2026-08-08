import {
  type ArchiveEntryChecksum,
  HOSTED_STATE_RESTORE_SET_FORMAT,
  HOSTED_STATE_RESTORE_SET_SCHEMA_VERSION,
  type OfflineArchiveReadModel,
  type OfflineRestoreAdmission,
  type OfflineRestoreRequest,
  type RestoreArchiveEvidence,
  type RestoreSetIdentity,
} from '../../contracts';
import { evaluateHostedStateAdmission, evaluateOfflineRestoreAdmission } from '../domain';

import type {
  BuiltArtifactStateManifestIntegrityProbePort,
  BuiltArtifactStateManifestReaderPort,
  OfflineArchiveIntegrityProbePort,
  OfflineArchiveReaderPort,
  OfflineControllerStateProbePort,
  OfflineRestoreTargetProbePort,
} from './ports';
import type {
  BackupManifest,
  ImmutableBackupVerification,
  MeasuredBackupEntry,
} from '@features/coordination-backup/contracts';
import type { CoordinationSnapshotMetadata } from '@features/coordination-events/contracts';

export interface AdmitOfflineRestoreDependencies {
  readonly artifactManifestReader: BuiltArtifactStateManifestReaderPort;
  readonly artifactIntegrityProbe: BuiltArtifactStateManifestIntegrityProbePort;
  readonly archiveReader: OfflineArchiveReaderPort;
  readonly archiveIntegrityProbe: OfflineArchiveIntegrityProbePort;
  readonly controllerStateProbe: OfflineControllerStateProbePort;
  readonly targetProbe: OfflineRestoreTargetProbePort;
}

export class AdmitOfflineRestore {
  constructor(private readonly dependencies: AdmitOfflineRestoreDependencies) {}

  async execute(request: OfflineRestoreRequest): Promise<OfflineRestoreAdmission> {
    const [artifact, archive, controllerState, targetState] = await Promise.all([
      this.dependencies.artifactManifestReader.readBuiltArtifactManifest(),
      this.dependencies.archiveReader.readArchive(request.archiveRef),
      this.dependencies.controllerStateProbe.inspectControllerState(),
      this.dependencies.targetProbe.inspectTarget(),
    ]);
    if (!archive) {
      return refuseMissingArchive(controllerState, targetState, request);
    }

    const [artifactIntegrity, immutableVerification] = await Promise.all([
      this.dependencies.artifactIntegrityProbe.verify(artifact),
      this.dependencies.archiveIntegrityProbe.verify(archive),
    ]);
    const stateAdmission = evaluateHostedStateAdmission({
      artifactManifest: artifact.manifest,
      artifactIntegrity: artifactIntegrity.status === 'verified' ? 'verified' : 'failed',
      stateHeader: archive.stateHeader,
      migrationJournal: archive.migrationJournal,
    });
    return evaluateOfflineRestoreAdmission({
      mode: request.mode,
      controllerState,
      sourceOfflineAttested: request.sourceOfflineAttested,
      targetState,
      archive: createRestoreArchiveEvidence(
        archive,
        immutableVerification,
        request.expectedRestoreSet
      ),
      stateAdmission,
    });
  }
}

export function createRestoreSetIdentity(
  manifest: BackupManifest,
  snapshotMetadata: CoordinationSnapshotMetadata
): RestoreSetIdentity {
  return Object.freeze({
    format: HOSTED_STATE_RESTORE_SET_FORMAT,
    schemaVersion: HOSTED_STATE_RESTORE_SET_SCHEMA_VERSION,
    deploymentId: manifest.deploymentId,
    backupRunId: manifest.backupRunId,
    manifestHash: manifest.manifestHash,
    fenceGeneration: manifest.fenceGeneration,
    stateCompatibilityManifest: Object.freeze({
      ...manifest.coordinationBarrier.stateCompatibilityManifest,
    }),
    snapshot: Object.freeze({
      deploymentId: snapshotMetadata.deploymentId,
      eventEpoch: snapshotMetadata.eventEpoch,
      replayCursor: snapshotMetadata.replayCursor,
    }),
  });
}

function createManifestSnapshotIdentity(manifest: BackupManifest): RestoreSetIdentity['snapshot'] {
  return Object.freeze({
    deploymentId: manifest.deploymentId,
    eventEpoch: manifest.coordinationBarrier.eventEpoch,
    replayCursor: manifest.coordinationBarrier.eventCursor,
  });
}

function createRestoreArchiveEvidence(
  archive: OfflineArchiveReadModel,
  immutableVerification: ImmutableBackupVerification,
  expectedRestoreSet: RestoreSetIdentity
): RestoreArchiveEvidence {
  if (immutableVerification.status === 'invalid') {
    return {
      publication: 'committed',
      immutableVerification,
      expectedRestoreSet,
      observedRestoreSet: expectedRestoreSet,
      manifestSnapshot: expectedRestoreSet.snapshot,
      expectedChecksums: checksumsFromManifest(archive.verificationPlan.manifest),
      observedChecksums: checksumsFromManifest(archive.verificationPlan.manifest),
      sqliteIntegrity: 'ok',
    };
  }
  const observedManifest = immutableVerification.inspection.manifest;
  return {
    publication: 'committed',
    immutableVerification,
    expectedRestoreSet,
    observedRestoreSet: createRestoreSetIdentity(observedManifest, archive.snapshotMetadata),
    manifestSnapshot: createManifestSnapshotIdentity(observedManifest),
    expectedChecksums: checksumsFromManifest(archive.verificationPlan.manifest),
    observedChecksums: checksumsFromMeasurements(immutableVerification.inspection.measuredEntries),
    sqliteIntegrity: observedManifest.sqliteIntegrity.integrityCheck === 'ok' ? 'ok' : 'failed',
  };
}

function checksumsFromManifest(manifest: BackupManifest): readonly ArchiveEntryChecksum[] {
  return Object.freeze(
    manifest.entries.map((entry) =>
      Object.freeze({
        entryId: entry.entryId,
        byteLength: entry.byteLength,
        mode: entry.mode,
        sha256: entry.sha256,
      })
    )
  );
}

function checksumsFromMeasurements(
  entries: readonly MeasuredBackupEntry[]
): readonly ArchiveEntryChecksum[] {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

function refuseMissingArchive(
  controllerState: 'stopped' | 'running' | 'unknown',
  targetState: 'empty' | 'non_empty' | 'unavailable',
  request: OfflineRestoreRequest
): OfflineRestoreAdmission {
  const reasons: Extract<OfflineRestoreAdmission, { status: 'refused' }>['reasons'][number][] = [
    'archive_incomplete',
  ];
  if (request.mode !== 'replace_deployment') reasons.push('restore_mode_unsupported');
  if (controllerState !== 'stopped') reasons.push('controller_not_stopped');
  if (!request.sourceOfflineAttested) reasons.push('source_offline_not_attested');
  if (targetState === 'non_empty') reasons.push('target_not_empty');
  if (targetState === 'unavailable') reasons.push('target_unavailable');
  return { status: 'refused', reasons: Object.freeze(reasons) };
}
