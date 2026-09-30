import {
  HOSTED_STATE_HEADER_FORMAT,
  HOSTED_STATE_HEADER_SCHEMA_VERSION,
  HOSTED_STATE_MIGRATION_JOURNAL_FORMAT,
  HOSTED_STATE_MIGRATION_JOURNAL_SCHEMA_VERSION,
  HOSTED_STATE_MIGRATION_PHASES,
  type HostedStateAdmission,
  type HostedStateHeader,
  type HostedStateMigrationDescriptor,
  type HostedStateMigrationJournal,
} from '../../contracts';

import {
  inspectBuiltArtifactStateManifest,
  isDataRecord,
  isIdentifier,
  isPositiveVersion,
  isSha256Digest,
  readData,
} from './manifestPolicy';

export interface EvaluateHostedStateAdmissionInput {
  readonly artifactManifest: unknown;
  readonly artifactIntegrity: 'verified' | 'failed';
  readonly stateHeader: unknown;
  readonly migrationJournal: unknown | null;
}

export function evaluateHostedStateAdmission(
  input: EvaluateHostedStateAdmissionInput
): HostedStateAdmission {
  const manifestInspection = inspectBuiltArtifactStateManifest(input.artifactManifest);
  if (manifestInspection.status === 'invalid') return refused('artifact_manifest_invalid');
  if (input.artifactIntegrity !== 'verified') {
    return refused('artifact_manifest_integrity_failed');
  }
  const stateHeader = materializeStateHeader(input.stateHeader);
  if (!stateHeader) return refused('state_header_invalid');

  const manifest = manifestInspection.manifest;
  if (input.migrationJournal !== null) {
    const journal = materializeMigrationJournal(input.migrationJournal);
    if (!journal) return refused('migration_journal_invalid');
    return evaluateInterruptedMigration(manifest.orderedMigrations, stateHeader, journal);
  }

  const observedVersion = stateHeader.hostedStateSchemaVersion;
  if (observedVersion > manifest.hostedStateSchemaVersion) return refused('future_state_version');
  if (observedVersion < manifest.minimumReadableHostedStateVersion) {
    return refused('state_version_too_old');
  }
  if (observedVersion === manifest.hostedStateSchemaVersion) {
    return { status: 'read_write', hostedStateSchemaVersion: observedVersion };
  }

  const migrations = manifest.orderedMigrations.filter(
    (migration) => migration.fromVersion >= observedVersion
  );
  if (
    migrations.length === 0 ||
    migrations[0].fromVersion !== observedVersion ||
    migrations[migrations.length - 1].toVersion !== manifest.hostedStateSchemaVersion
  ) {
    return refused('migration_path_unavailable');
  }
  return {
    status: 'migration_required',
    fromVersion: observedVersion,
    toVersion: manifest.hostedStateSchemaVersion,
    orderedMigrations: Object.freeze(migrations),
    backupRequired: migrations.some(
      (migration) => migration.backupRequirement === 'verified_offline_archive'
    ),
  };
}

function evaluateInterruptedMigration(
  migrations: readonly HostedStateMigrationDescriptor[],
  stateHeader: HostedStateHeader,
  journal: HostedStateMigrationJournal
): HostedStateAdmission {
  if (journal.deploymentId !== stateHeader.deploymentId) {
    return refused('migration_journal_mismatch');
  }
  const migration = migrations.find((candidate) => candidate.migrationId === journal.migrationId);
  if (
    !migration ||
    migration.fromVersion !== journal.fromVersion ||
    migration.toVersion !== journal.toVersion ||
    migration.sha256 !== journal.migrationSha256
  ) {
    return refused('migration_journal_mismatch');
  }
  if (stateHeader.hostedStateSchemaVersion === migration.fromVersion) {
    return {
      status: 'migration_recovery_required',
      recovery: 'resume_idempotently',
      migration,
      journalPhase: journal.phase,
    };
  }
  if (stateHeader.hostedStateSchemaVersion === migration.toVersion) {
    return {
      status: 'migration_recovery_required',
      recovery: 'verify_before_commit',
      migration,
      journalPhase: journal.phase,
    };
  }
  return refused('migration_journal_mismatch');
}

function materializeStateHeader(value: unknown): HostedStateHeader | null {
  if (!isDataRecord(value) || Object.keys(value).length !== 4) return null;
  const format = readData(value, 'format');
  const schemaVersion = readData(value, 'schemaVersion');
  const deploymentId = readData(value, 'deploymentId');
  const hostedStateSchemaVersion = readData(value, 'hostedStateSchemaVersion');
  if (
    format !== HOSTED_STATE_HEADER_FORMAT ||
    schemaVersion !== HOSTED_STATE_HEADER_SCHEMA_VERSION ||
    !isIdentifier(deploymentId) ||
    !isPositiveVersion(hostedStateSchemaVersion)
  ) {
    return null;
  }
  return Object.freeze({ format, schemaVersion, deploymentId, hostedStateSchemaVersion });
}

function materializeMigrationJournal(value: unknown): HostedStateMigrationJournal | null {
  if (!isDataRecord(value) || Object.keys(value).length !== 8) return null;
  const format = readData(value, 'format');
  const schemaVersion = readData(value, 'schemaVersion');
  const deploymentId = readData(value, 'deploymentId');
  const migrationId = readData(value, 'migrationId');
  const fromVersion = readData(value, 'fromVersion');
  const toVersion = readData(value, 'toVersion');
  const migrationSha256 = readData(value, 'migrationSha256');
  const phase = readData(value, 'phase');
  if (
    format !== HOSTED_STATE_MIGRATION_JOURNAL_FORMAT ||
    schemaVersion !== HOSTED_STATE_MIGRATION_JOURNAL_SCHEMA_VERSION ||
    !isIdentifier(deploymentId) ||
    !isIdentifier(migrationId) ||
    !isPositiveVersion(fromVersion) ||
    !isPositiveVersion(toVersion) ||
    toVersion !== fromVersion + 1 ||
    !isSha256Digest(migrationSha256) ||
    !HOSTED_STATE_MIGRATION_PHASES.includes(phase as (typeof HOSTED_STATE_MIGRATION_PHASES)[number])
  ) {
    return null;
  }
  return Object.freeze({
    format,
    schemaVersion,
    deploymentId,
    migrationId,
    fromVersion,
    toVersion,
    migrationSha256,
    phase: phase as HostedStateMigrationJournal['phase'],
  });
}

function refused(reason: Extract<HostedStateAdmission, { status: 'refused' }>['reason']) {
  return { status: 'refused' as const, reason };
}
