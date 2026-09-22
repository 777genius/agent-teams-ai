import {
  type BuiltArtifactStateManifest,
  HOSTED_STATE_COMPATIBILITY_MANIFEST_FORMAT,
  HOSTED_STATE_COMPATIBILITY_MANIFEST_SCHEMA_VERSION,
  type HostedStateMigrationDescriptor,
} from '../../contracts';

import type { Sha256Digest } from '@features/coordination-backup/contracts';

export type BuiltArtifactManifestInvalidReason =
  | 'manifest_not_an_object'
  | 'manifest_fields_invalid'
  | 'manifest_format_unsupported'
  | 'manifest_schema_unsupported'
  | 'manifest_version_range_invalid'
  | 'migration_descriptor_invalid'
  | 'migration_order_invalid';

export type BuiltArtifactManifestInspection =
  | { readonly status: 'valid'; readonly manifest: BuiltArtifactStateManifest }
  | {
      readonly status: 'invalid';
      readonly reasons: readonly BuiltArtifactManifestInvalidReason[];
    };

const MANIFEST_KEYS = Object.freeze([
  'artifactVersion',
  'format',
  'hostedStateSchemaVersion',
  'manifestId',
  'minimumReadableHostedStateVersion',
  'orderedMigrations',
  'schemaVersion',
] as const);
const MIGRATION_KEYS = Object.freeze([
  'backupRequirement',
  'fromVersion',
  'migrationId',
  'sha256',
  'toVersion',
] as const);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const ARTIFACT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function inspectBuiltArtifactStateManifest(value: unknown): BuiltArtifactManifestInspection {
  if (!isDataRecord(value)) {
    return invalidManifest('manifest_not_an_object');
  }

  const reasons: BuiltArtifactManifestInvalidReason[] = [];
  if (!hasExactDataKeys(value, MANIFEST_KEYS)) reasons.push('manifest_fields_invalid');
  if (readData(value, 'format') !== HOSTED_STATE_COMPATIBILITY_MANIFEST_FORMAT) {
    reasons.push('manifest_format_unsupported');
  }
  if (readData(value, 'schemaVersion') !== HOSTED_STATE_COMPATIBILITY_MANIFEST_SCHEMA_VERSION) {
    reasons.push('manifest_schema_unsupported');
  }

  const manifestId = readData(value, 'manifestId');
  const artifactVersion = readData(value, 'artifactVersion');
  const currentVersion = readData(value, 'hostedStateSchemaVersion');
  const minimumVersion = readData(value, 'minimumReadableHostedStateVersion');
  if (
    !isIdentifier(manifestId) ||
    typeof artifactVersion !== 'string' ||
    !ARTIFACT_VERSION_PATTERN.test(artifactVersion)
  ) {
    reasons.push('manifest_fields_invalid');
  }
  if (
    !isPositiveVersion(currentVersion) ||
    !isPositiveVersion(minimumVersion) ||
    minimumVersion > currentVersion
  ) {
    reasons.push('manifest_version_range_invalid');
  }

  const rawMigrations = readData(value, 'orderedMigrations');
  const migrations: HostedStateMigrationDescriptor[] = [];
  if (!Array.isArray(rawMigrations)) {
    reasons.push('migration_descriptor_invalid');
  } else {
    for (const rawMigration of rawMigrations) {
      const migration = materializeMigration(rawMigration);
      if (!migration) reasons.push('migration_descriptor_invalid');
      else migrations.push(migration);
    }
  }

  if (
    isPositiveVersion(currentVersion) &&
    isPositiveVersion(minimumVersion) &&
    !isCompleteOrderedMigrationPath(migrations, minimumVersion, currentVersion)
  ) {
    reasons.push('migration_order_invalid');
  }

  const uniqueReasons = Object.freeze([...new Set(reasons)]);
  if (uniqueReasons.length > 0) return { status: 'invalid', reasons: uniqueReasons };

  return {
    status: 'valid',
    manifest: Object.freeze({
      format: HOSTED_STATE_COMPATIBILITY_MANIFEST_FORMAT,
      schemaVersion: HOSTED_STATE_COMPATIBILITY_MANIFEST_SCHEMA_VERSION,
      manifestId: manifestId as string,
      artifactVersion: artifactVersion as string,
      hostedStateSchemaVersion: currentVersion as number,
      minimumReadableHostedStateVersion: minimumVersion as number,
      orderedMigrations: Object.freeze(migrations),
    }),
  };
}

function materializeMigration(value: unknown): HostedStateMigrationDescriptor | null {
  if (!isDataRecord(value) || !hasExactDataKeys(value, MIGRATION_KEYS)) return null;
  const migrationId = readData(value, 'migrationId');
  const fromVersion = readData(value, 'fromVersion');
  const toVersion = readData(value, 'toVersion');
  const sha256 = readData(value, 'sha256');
  const backupRequirement = readData(value, 'backupRequirement');
  if (
    !isIdentifier(migrationId) ||
    !isPositiveVersion(fromVersion) ||
    !isPositiveVersion(toVersion) ||
    toVersion !== fromVersion + 1 ||
    typeof sha256 !== 'string' ||
    !SHA256_PATTERN.test(sha256) ||
    (backupRequirement !== 'none' && backupRequirement !== 'verified_offline_archive')
  ) {
    return null;
  }
  return Object.freeze({
    migrationId,
    fromVersion,
    toVersion,
    sha256: sha256 as Sha256Digest,
    backupRequirement,
  });
}

function isCompleteOrderedMigrationPath(
  migrations: readonly HostedStateMigrationDescriptor[],
  minimumVersion: number,
  currentVersion: number
): boolean {
  if (migrations.length !== currentVersion - minimumVersion) return false;
  const ids = new Set<string>();
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    const expectedFrom = minimumVersion + index;
    if (
      migration.fromVersion !== expectedFrom ||
      migration.toVersion !== expectedFrom + 1 ||
      ids.has(migration.migrationId)
    ) {
      return false;
    }
    ids.add(migration.migrationId);
  }
  return true;
}

function invalidManifest(
  reason: BuiltArtifactManifestInvalidReason
): BuiltArtifactManifestInspection {
  return { status: 'invalid', reasons: Object.freeze([reason]) };
}

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

export function isPositiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

export function isDataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readData(record: Readonly<Record<string, unknown>>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function hasExactDataKeys(
  record: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[]
): boolean {
  const keys = Object.keys(record).sort((left, right) => left.localeCompare(right));
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      return descriptor !== undefined && 'value' in descriptor;
    })
  );
}
