import * as path from 'node:path';

import { parseTeamId } from '@shared/contracts/hosted/identifiers';

import {
  parseLegacyTeamKey,
  TEAM_ATTEMPT_OWNERSHIP_FILE_NAME,
  TEAM_IDENTITY_FILE_NAME,
  type TeamAttemptArtifactOwnership,
} from '../../core/application/ports/TeamIdentityPersistence';

import {
  assertCurrentDirectoryBinding,
  type DirectoryBinding,
  DirectoryBoundaryError,
  isCanonicalTimestamp,
  openChildDirectory,
  readBoundedFile,
} from './teamDirectoryBoundary';

import type {
  AttemptOwnedArtifact,
  CleanupProvisioningFailureRequest,
} from './teamDirectoryLifecycleTypes';

export const ATTEMPT_OWNERSHIP_MAX_BYTES = 4 * 1024;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const PROTECTED_TEAM_ARTIFACTS = new Set([
  TEAM_IDENTITY_FILE_NAME,
  TEAM_ATTEMPT_OWNERSHIP_FILE_NAME,
  'config.json',
  'team.meta.json',
  'members.meta.json',
]);

export interface AttemptArtifactBinding {
  readonly relativePath: string;
  readonly namespace: DirectoryBinding;
  readonly artifact: DirectoryBinding;
  readonly ownership: TeamAttemptArtifactOwnership;
}

export function serializeTeamAttemptArtifactOwnership(
  ownership: TeamAttemptArtifactOwnership
): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      scope: 'p2-d-provisioning-attempt',
      teamId: ownership.teamId,
      legacyTeamKey: ownership.legacyTeamKey,
      runId: ownership.runId,
      artifactRelativePath: ownership.artifactRelativePath,
      createdAt: ownership.createdAt,
    } satisfies TeamAttemptArtifactOwnership,
    null,
    2
  )}\n`;
}

export function parseTeamAttemptArtifactOwnership(
  raw: string,
  expected: Omit<TeamAttemptArtifactOwnership, 'schemaVersion' | 'scope' | 'createdAt'>
): TeamAttemptArtifactOwnership {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DirectoryBoundaryError('artifact_ownership_unproven');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DirectoryBoundaryError('artifact_ownership_unproven');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    'artifactRelativePath',
    'createdAt',
    'legacyTeamKey',
    'runId',
    'schemaVersion',
    'scope',
    'teamId',
  ];
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key, index) => key === expectedKeys[index]) ||
    record.schemaVersion !== 1 ||
    record.scope !== 'p2-d-provisioning-attempt' ||
    record.teamId !== expected.teamId ||
    record.legacyTeamKey !== expected.legacyTeamKey ||
    record.runId !== expected.runId ||
    record.artifactRelativePath !== expected.artifactRelativePath ||
    !isCanonicalTimestamp(record.createdAt)
  ) {
    throw new DirectoryBoundaryError('artifact_ownership_unproven');
  }
  try {
    const ownership: TeamAttemptArtifactOwnership = {
      schemaVersion: 1,
      scope: 'p2-d-provisioning-attempt',
      teamId: parseTeamId(record.teamId),
      legacyTeamKey: parseLegacyTeamKey(record.legacyTeamKey),
      runId: String(record.runId),
      artifactRelativePath: String(record.artifactRelativePath),
      createdAt: record.createdAt,
    };
    if (raw !== serializeTeamAttemptArtifactOwnership(ownership)) {
      throw new DirectoryBoundaryError('artifact_ownership_unproven');
    }
    return ownership;
  } catch (error) {
    if (error instanceof DirectoryBoundaryError) throw error;
    throw new DirectoryBoundaryError('artifact_ownership_unproven');
  }
}

export function assertOperationId(value: string): void {
  if (!OPERATION_ID_PATTERN.test(value)) {
    throw new DirectoryBoundaryError('unsafe_attempt_path');
  }
}

export function parseAttemptRelativePath(relativePath: string): readonly [string, string] {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.includes('\0') ||
    path.isAbsolute(relativePath) ||
    relativePath.includes('\\')
  ) {
    throw new DirectoryBoundaryError('unsafe_attempt_path');
  }
  const segments = relativePath.split('/');
  if (
    segments.length !== 2 ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
    PROTECTED_TEAM_ARTIFACTS.has(segments[0] ?? '') ||
    segments[0]?.startsWith('.identity-')
  ) {
    throw new DirectoryBoundaryError('unsafe_attempt_path');
  }
  return [segments[0] ?? '', segments[1] ?? ''];
}

export function assertAttemptNamespace(segments: readonly [string, string], runId: string): void {
  const [namespace, namespaceRunId] = segments;
  if (
    (namespace !== 'attempts' && namespace !== '.provisioning-attempts') ||
    namespaceRunId !== runId
  ) {
    throw new DirectoryBoundaryError('unsafe_attempt_path');
  }
}

export async function validateAttemptArtifactPath(
  teamDirectory: DirectoryBinding,
  request: CleanupProvisioningFailureRequest,
  artifact: AttemptOwnedArtifact
): Promise<AttemptArtifactBinding | null> {
  const segments = parseAttemptRelativePath(artifact.relativePath);
  assertAttemptNamespace(segments, request.runId);
  const namespace = await openChildDirectory(
    teamDirectory,
    segments[0],
    path.join(teamDirectory.logicalPath, segments[0]),
    true,
    'unsafe_attempt_path'
  );
  if (!namespace) return null;
  try {
    const artifactDirectory = await openChildDirectory(
      namespace,
      segments[1],
      path.join(namespace.logicalPath, segments[1]),
      true,
      'unsafe_attempt_path'
    );
    if (!artifactDirectory) {
      await namespace.handle.close();
      return null;
    }
    try {
      const provenance = await readBoundedFile(
        artifactDirectory,
        TEAM_ATTEMPT_OWNERSHIP_FILE_NAME,
        ATTEMPT_OWNERSHIP_MAX_BYTES,
        'artifact_ownership_unproven'
      );
      if (!provenance || (provenance.stat.mode & 0o077) !== 0) {
        throw new DirectoryBoundaryError('artifact_ownership_unproven');
      }
      const ownership = parseTeamAttemptArtifactOwnership(provenance.raw, {
        teamId: request.teamId,
        legacyTeamKey: request.legacyTeamKey,
        runId: request.runId,
        artifactRelativePath: artifact.relativePath,
      });
      return {
        relativePath: artifact.relativePath,
        namespace,
        artifact: artifactDirectory,
        ownership,
      };
    } catch (error) {
      await artifactDirectory.handle.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    await namespace.handle.close().catch(() => undefined);
    throw error;
  }
}

export async function revalidateAttemptOwnership(
  binding: AttemptArtifactBinding,
  request: CleanupProvisioningFailureRequest
): Promise<void> {
  await assertCurrentDirectoryBinding(binding.namespace, 'unsafe_attempt_path');
  await assertCurrentDirectoryBinding(binding.artifact, 'unsafe_attempt_path');
  const provenance = await readBoundedFile(
    binding.artifact,
    TEAM_ATTEMPT_OWNERSHIP_FILE_NAME,
    ATTEMPT_OWNERSHIP_MAX_BYTES,
    'artifact_ownership_unproven'
  );
  if (!provenance || (provenance.stat.mode & 0o077) !== 0) {
    throw new DirectoryBoundaryError('artifact_ownership_unproven');
  }
  const ownership = parseTeamAttemptArtifactOwnership(provenance.raw, {
    teamId: request.teamId,
    legacyTeamKey: request.legacyTeamKey,
    runId: request.runId,
    artifactRelativePath: binding.relativePath,
  });
  if (
    serializeTeamAttemptArtifactOwnership(ownership) !==
    serializeTeamAttemptArtifactOwnership(binding.ownership)
  ) {
    throw new DirectoryBoundaryError('artifact_ownership_unproven');
  }
}

export async function closeAttemptBinding(binding: AttemptArtifactBinding): Promise<void> {
  await Promise.allSettled([binding.artifact.handle.close(), binding.namespace.handle.close()]);
}

export function sameAttemptOwnership(
  left: TeamAttemptArtifactOwnership,
  right: TeamAttemptArtifactOwnership
): boolean {
  return (
    serializeTeamAttemptArtifactOwnership(left) === serializeTeamAttemptArtifactOwnership(right)
  );
}
