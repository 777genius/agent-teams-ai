import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseTeamId, type TeamId } from '@shared/contracts/hosted/identifiers';

import {
  assertAttemptNamespace,
  assertOperationId,
  ATTEMPT_OWNERSHIP_MAX_BYTES,
  type AttemptArtifactBinding,
  closeAttemptBinding,
  parseAttemptRelativePath,
  parseTeamAttemptArtifactOwnership,
  PROTECTED_TEAM_ARTIFACTS,
  revalidateAttemptOwnership,
  sameAttemptOwnership,
  serializeTeamAttemptArtifactOwnership,
  validateAttemptArtifactPath,
} from './teamAttemptArtifactOwnership';
import {
  assertCurrentDirectoryBinding,
  childPathForMutation,
  type DirectoryBinding,
  DirectoryBoundaryError,
  isCanonicalTimestamp,
  listNonQuarantineEntries,
  NO_FOLLOW,
  openAdmittedTeamsRoot,
  openChildDirectory,
  openTeamDirectory,
  quarantineLogicalDirectory,
  readBoundedFile,
} from './teamDirectoryBoundary';

import type {
  AbortPreparedTeamDirectoryRequest,
  CleanupProvisioningFailureOutcome,
  CleanupProvisioningFailureRequest,
  ExplicitTeamDeleteOutcome,
  ExplicitTeamDeleteRequest,
  PrepareTeamDirectoryOutcome,
  PrepareTeamDirectoryRequest,
  PublishAndCommitTeamIdentityOutcome,
  PublishAndCommitTeamIdentityRequest,
  RegisterAttemptArtifactOwnershipOutcome,
  RegisterAttemptArtifactOwnershipRequest,
} from './teamDirectoryLifecycleTypes';

export { serializeTeamAttemptArtifactOwnership } from './teamAttemptArtifactOwnership';
export type {
  AbortPreparedTeamDirectoryRequest,
  AttemptOwnedArtifact,
  CleanupProvisioningFailureOutcome,
  CleanupProvisioningFailureRequest,
  ExplicitTeamDeleteOutcome,
  ExplicitTeamDeleteRequest,
  PrepareTeamDirectoryOutcome,
  PrepareTeamDirectoryRequest,
  PublishAndCommitTeamIdentityOutcome,
  PublishAndCommitTeamIdentityRequest,
  RegisterAttemptArtifactOwnershipOutcome,
  RegisterAttemptArtifactOwnershipRequest,
} from './teamDirectoryLifecycleTypes';

import {
  type LegacyTeamKey,
  parseLegacyTeamKey,
  parseTeamIdentityChecksum,
  TEAM_ATTEMPT_OWNERSHIP_FILE_NAME,
  TEAM_IDENTITY_SCHEMA_VERSION,
  type TeamAttemptArtifactOwnership,
  type TeamAttemptArtifactOwnershipRegistry,
  type TeamDirectoryRootAdmission,
  type TeamIdentityAuthorityEvidence,
  type TeamIdentityAuthorityLookupOutcome,
  type TeamIdentityIntent,
  type TeamIdentityPersistence,
  type TeamIdentityPublicationEvidence,
  type TeamIdentityPublicationPort,
  type TeamIdentityTombstoneOutcome,
} from '../../core/application/ports/TeamIdentityPersistence';

function mapPrepareBlockReason(
  reason: string
): Extract<PrepareTeamDirectoryOutcome, { status: 'blocked' }>['reason'] {
  if (reason === 'legacy_key_tombstoned') return 'legacy_key_tombstoned';
  if (reason === 'legacy_key_conflict') return 'legacy_key_conflict';
  return 'persistence_mismatch';
}

function publicationMatchesAuthority(
  publication: TeamIdentityPublicationEvidence,
  authority: Extract<TeamIdentityAuthorityEvidence, { state: 'file_published' }>,
  intent: TeamIdentityIntent
): boolean {
  return (
    publication.teamId === intent.teamId &&
    publication.legacyTeamKey === intent.legacyTeamKey &&
    publication.checksum === intent.expectedChecksum &&
    publication.fileSchemaVersion === TEAM_IDENTITY_SCHEMA_VERSION &&
    isCanonicalTimestamp(publication.publishedAt) &&
    publication.fileFsync === 'synced' &&
    publication.parentDirectoryFsync === 'synced' &&
    authority.expectedChecksum === intent.expectedChecksum &&
    authority.publication.teamId === publication.teamId &&
    authority.publication.legacyTeamKey === publication.legacyTeamKey &&
    authority.publication.checksum === publication.checksum &&
    authority.publication.fileSchemaVersion === publication.fileSchemaVersion &&
    authority.publication.publishedAt === publication.publishedAt
  );
}

export class TeamDirectoryLifecycleAdapter {
  constructor(
    private readonly admission: TeamDirectoryRootAdmission,
    private readonly persistence: TeamIdentityPersistence,
    private readonly identityFiles: TeamIdentityPublicationPort,
    private readonly attemptOwnership: TeamAttemptArtifactOwnershipRegistry
  ) {}

  async prepareTeamDirectory(
    request: PrepareTeamDirectoryRequest
  ): Promise<PrepareTeamDirectoryOutcome> {
    let teamsRoot: DirectoryBinding | null = null;
    let existing: DirectoryBinding | null = null;
    try {
      assertOperationId(request.operationId);
      parseTeamId(request.intent.teamId);
      parseLegacyTeamKey(request.intent.legacyTeamKey);
      parseTeamIdentityChecksum(request.intent.expectedChecksum);
      teamsRoot = await openAdmittedTeamsRoot(this.admission);
      existing = await openTeamDirectory(teamsRoot, request.intent.legacyTeamKey, true);
      const prepared = await this.persistence.prepare(request.intent);
      if (prepared.status === 'blocked') {
        return { status: 'blocked', reason: mapPrepareBlockReason(prepared.reason) };
      }
      if (prepared.intent.expectedChecksum !== request.intent.expectedChecksum) {
        return { status: 'blocked', reason: 'persistence_mismatch' };
      }
      if (existing) {
        if (prepared.status === 'already_prepared') {
          await assertCurrentDirectoryBinding(existing, 'unsafe_team_directory');
          await teamsRoot.handle.sync();
          return { status: 'resumed', teamId: request.intent.teamId };
        }
        return { status: 'blocked', reason: 'legacy_key_conflict' };
      }
      await assertCurrentDirectoryBinding(teamsRoot, 'root_not_admitted');
      const targetPath = await childPathForMutation(
        teamsRoot,
        request.intent.legacyTeamKey,
        'unsafe_team_directory'
      );
      await fs.promises.mkdir(targetPath, { mode: 0o700 });
      const created = await openTeamDirectory(teamsRoot, request.intent.legacyTeamKey, false);
      if (!created) throw new DirectoryBoundaryError('unsafe_team_directory');
      try {
        await created.handle.sync();
        await teamsRoot.handle.sync();
        await assertCurrentDirectoryBinding(created, 'unsafe_team_directory');
      } finally {
        await created.handle.close();
      }
      return { status: 'created', teamId: request.intent.teamId };
    } catch (error) {
      return {
        status: 'blocked',
        reason:
          error instanceof DirectoryBoundaryError
            ? error.reason === 'root_not_admitted'
              ? 'root_not_admitted'
              : 'unsafe_team_directory'
            : 'unsafe_team_directory',
      };
    } finally {
      await existing?.handle.close().catch(() => undefined);
      await teamsRoot?.handle.close().catch(() => undefined);
    }
  }

  async publishAndCommitIdentity(
    request: PublishAndCommitTeamIdentityRequest
  ): Promise<PublishAndCommitTeamIdentityOutcome> {
    try {
      parseTeamId(request.teamId);
      parseLegacyTeamKey(request.legacyTeamKey);
    } catch {
      return { status: 'blocked', reason: 'intent_mismatch' };
    }
    if (request.identity.teamId !== request.teamId) {
      return { status: 'blocked', reason: 'intent_mismatch' };
    }

    const initial = await this.lookupAuthority(request.teamId, request.legacyTeamKey);
    if (initial.status === 'blocked') {
      return { status: 'blocked', reason: 'authority_not_durable' };
    }
    if (!this.intentMatchesRequest(initial.intent, request)) {
      return { status: 'blocked', reason: 'intent_mismatch' };
    }
    if (initial.authority.duplicateTeamIdCount > 0) {
      return { status: 'blocked', reason: 'intent_mismatch' };
    }

    if (initial.authority.state === 'tombstoned') {
      return { status: 'blocked', reason: 'identity_tombstoned' };
    }
    if (initial.authority.state === 'committed') {
      if (
        !Number.isSafeInteger(initial.authority.identityGeneration) ||
        initial.authority.identityGeneration < 1
      ) {
        return { status: 'blocked', reason: 'authority_not_durable' };
      }
      const inspected = await this.identityFiles.inspect(request.legacyTeamKey, initial.authority);
      if (inspected.status !== 'valid' || inspected.capability !== 'read_write') {
        return {
          status: 'blocked',
          reason: inspected.status === 'blocked' ? inspected.reason : 'identity_mismatch',
        };
      }
      return {
        status: 'already_committed',
        teamId: request.teamId,
        identityGeneration: initial.authority.identityGeneration,
        recovery: 'already_committed',
      };
    }

    let durable: TeamIdentityAuthorityLookupOutcome = initial;
    let recovery: 'published_and_committed' | 'resumed_file_published';
    if (initial.authority.state === 'prepared') {
      const published = await this.identityFiles.publish({
        legacyTeamKey: request.legacyTeamKey,
        identity: request.identity,
        authority: initial.authority,
      });
      if (published.status === 'blocked') {
        return { status: 'blocked', reason: published.reason };
      }
      const recorded = await this.persistence.recordPublication(published.evidence);
      if (recorded.status === 'blocked') {
        return { status: 'blocked', reason: 'publication_not_durable' };
      }
      durable = await this.lookupAuthority(request.teamId, request.legacyTeamKey);
      if (durable.status === 'blocked') {
        return { status: 'blocked', reason: 'publication_not_durable' };
      }
      recovery = 'published_and_committed';
    } else {
      recovery = 'resumed_file_published';
    }

    if (durable.authority.state === 'committed') {
      const inspected = await this.identityFiles.inspect(request.legacyTeamKey, durable.authority);
      if (inspected.status !== 'valid' || inspected.capability !== 'read_write') {
        return { status: 'blocked', reason: 'commit_blocked' };
      }
      return {
        status: 'already_committed',
        teamId: request.teamId,
        identityGeneration: durable.authority.identityGeneration,
        recovery: 'already_committed',
      };
    }
    if (
      durable.authority.state !== 'file_published' ||
      !this.intentMatchesRequest(durable.intent, request) ||
      !publicationMatchesAuthority(durable.authority.publication, durable.authority, durable.intent)
    ) {
      return { status: 'blocked', reason: 'publication_not_durable' };
    }
    const inspected = await this.identityFiles.inspect(request.legacyTeamKey, durable.authority);
    if (inspected.status !== 'valid' || inspected.capability !== 'read_only') {
      return {
        status: 'blocked',
        reason: inspected.status === 'blocked' ? inspected.reason : 'identity_mismatch',
      };
    }
    const committed = await this.persistence.commit({
      intent: durable.intent,
      publication: durable.authority.publication,
    });
    if (
      committed.status === 'blocked' ||
      committed.teamId !== request.teamId ||
      committed.checksum !== durable.intent.expectedChecksum ||
      !Number.isSafeInteger(committed.identityGeneration) ||
      committed.identityGeneration < 1
    ) {
      return { status: 'blocked', reason: 'commit_blocked' };
    }
    return {
      status: committed.status,
      teamId: committed.teamId,
      identityGeneration: committed.identityGeneration,
      recovery,
    };
  }

  async registerAttemptArtifactOwnership(
    request: RegisterAttemptArtifactOwnershipRequest
  ): Promise<RegisterAttemptArtifactOwnershipOutcome> {
    let teamsRoot: DirectoryBinding | null = null;
    let teamDirectory: DirectoryBinding | null = null;
    let namespace: DirectoryBinding | null = null;
    let artifactDirectory: DirectoryBinding | null = null;
    try {
      parseTeamId(request.teamId);
      parseLegacyTeamKey(request.legacyTeamKey);
      assertOperationId(request.runId);
      if (!isCanonicalTimestamp(request.createdAt)) {
        return { status: 'blocked', reason: 'artifact_ownership_unproven' };
      }
      const segments = parseAttemptRelativePath(request.artifactRelativePath);
      assertAttemptNamespace(segments, request.runId);

      const durable = await this.lookupAuthority(request.teamId, request.legacyTeamKey);
      if (durable.status === 'blocked' || durable.authority.state !== 'committed') {
        return { status: 'blocked', reason: 'identity_blocked' };
      }
      const identity = await this.identityFiles.inspect(request.legacyTeamKey, durable.authority);
      if (identity.status !== 'valid' || identity.capability !== 'read_write') {
        return { status: 'blocked', reason: 'identity_blocked' };
      }

      teamsRoot = await openAdmittedTeamsRoot(this.admission);
      teamDirectory = await openTeamDirectory(teamsRoot, request.legacyTeamKey, false);
      if (!teamDirectory) {
        return { status: 'blocked', reason: 'unsafe_team_directory' };
      }
      namespace = await openChildDirectory(
        teamDirectory,
        segments[0],
        path.join(teamDirectory.logicalPath, segments[0]),
        false,
        'unsafe_attempt_path'
      );
      if (!namespace) return { status: 'blocked', reason: 'unsafe_attempt_path' };
      artifactDirectory = await openChildDirectory(
        namespace,
        segments[1],
        path.join(namespace.logicalPath, segments[1]),
        false,
        'unsafe_attempt_path'
      );
      if (!artifactDirectory) return { status: 'blocked', reason: 'unsafe_attempt_path' };

      const expected: TeamAttemptArtifactOwnership = {
        schemaVersion: 1,
        scope: 'p2-d-provisioning-attempt',
        teamId: request.teamId,
        legacyTeamKey: request.legacyTeamKey,
        runId: request.runId,
        artifactRelativePath: request.artifactRelativePath,
        createdAt: request.createdAt,
      };
      let registered = await this.attemptOwnership.getAttemptArtifactOwnership({
        teamId: request.teamId,
        legacyTeamKey: request.legacyTeamKey,
        runId: request.runId,
        artifactRelativePath: request.artifactRelativePath,
      });
      if (registered.status === 'blocked') {
        return { status: 'blocked', reason: 'artifact_ownership_unproven' };
      }
      const existing = await readBoundedFile(
        artifactDirectory,
        TEAM_ATTEMPT_OWNERSHIP_FILE_NAME,
        ATTEMPT_OWNERSHIP_MAX_BYTES,
        'artifact_ownership_unproven'
      );
      if (existing) {
        if ((existing.stat.mode & 0o077) !== 0 || registered.status !== 'found') {
          return { status: 'blocked', reason: 'artifact_ownership_unproven' };
        }
        const parsed = parseTeamAttemptArtifactOwnership(existing.raw, {
          teamId: request.teamId,
          legacyTeamKey: request.legacyTeamKey,
          runId: request.runId,
          artifactRelativePath: request.artifactRelativePath,
        });
        if (
          parsed.createdAt !== request.createdAt ||
          !sameAttemptOwnership(parsed, registered.ownership)
        ) {
          return { status: 'blocked', reason: 'artifact_ownership_unproven' };
        }
        return { status: 'already_registered', durability: 'durable' };
      }

      await assertCurrentDirectoryBinding(artifactDirectory, 'unsafe_attempt_path');
      const entries = await listNonQuarantineEntries(artifactDirectory, 'unsafe_attempt_path');
      if (entries.length !== 0) {
        return { status: 'blocked', reason: 'artifact_not_pristine' };
      }
      const freshAuthority = await this.lookupAuthority(request.teamId, request.legacyTeamKey);
      if (
        freshAuthority.status === 'blocked' ||
        freshAuthority.authority.state !== 'committed' ||
        freshAuthority.authority.identityGeneration !== durable.authority.identityGeneration ||
        freshAuthority.authority.expectedChecksum !== durable.authority.expectedChecksum
      ) {
        return { status: 'blocked', reason: 'identity_blocked' };
      }
      if (registered.status === 'absent') {
        const recorded = await this.attemptOwnership.recordAttemptArtifactOwnership(expected);
        if (recorded.status === 'blocked' || recorded.durability !== 'durable') {
          return { status: 'blocked', reason: 'artifact_ownership_unproven' };
        }
        registered = await this.attemptOwnership.getAttemptArtifactOwnership({
          teamId: request.teamId,
          legacyTeamKey: request.legacyTeamKey,
          runId: request.runId,
          artifactRelativePath: request.artifactRelativePath,
        });
      }
      if (registered.status !== 'found' || !sameAttemptOwnership(registered.ownership, expected)) {
        return { status: 'blocked', reason: 'artifact_ownership_unproven' };
      }
      const ownershipPath = await childPathForMutation(
        artifactDirectory,
        TEAM_ATTEMPT_OWNERSHIP_FILE_NAME,
        'unsafe_attempt_path'
      );
      const handle = await fs.promises.open(
        ownershipPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
        0o600
      );
      try {
        await assertCurrentDirectoryBinding(artifactDirectory, 'unsafe_attempt_path');
        await handle.writeFile(serializeTeamAttemptArtifactOwnership(expected), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await artifactDirectory.handle.sync();
      await assertCurrentDirectoryBinding(artifactDirectory, 'unsafe_attempt_path');
      return { status: 'registered', durability: 'durable' };
    } catch (error) {
      return {
        status: 'blocked',
        reason:
          error instanceof DirectoryBoundaryError ? error.reason : 'artifact_ownership_unproven',
      };
    } finally {
      await artifactDirectory?.handle.close().catch(() => undefined);
      await namespace?.handle.close().catch(() => undefined);
      await teamDirectory?.handle.close().catch(() => undefined);
      await teamsRoot?.handle.close().catch(() => undefined);
    }
  }

  async cleanupProvisioningFailure(
    request: CleanupProvisioningFailureRequest
  ): Promise<CleanupProvisioningFailureOutcome> {
    let teamsRoot: DirectoryBinding | null = null;
    let teamDirectory: DirectoryBinding | null = null;
    const validated: AttemptArtifactBinding[] = [];
    try {
      parseTeamId(request.teamId);
      parseLegacyTeamKey(request.legacyTeamKey);
      assertOperationId(request.runId);
      const seenPaths = new Set<string>();
      for (const artifact of request.attemptOwnedArtifacts) {
        if (artifact.ownerRunId !== request.runId) {
          return { status: 'blocked', reason: 'artifact_ownership_mismatch' };
        }
        const firstSegment = artifact.relativePath.split('/')[0] ?? '';
        if (PROTECTED_TEAM_ARTIFACTS.has(firstSegment) || firstSegment.startsWith('.identity-')) {
          return { status: 'blocked', reason: 'protected_artifact' };
        }
        assertAttemptNamespace(parseAttemptRelativePath(artifact.relativePath), request.runId);
        if (seenPaths.has(artifact.relativePath)) {
          return { status: 'blocked', reason: 'artifact_ownership_mismatch' };
        }
        seenPaths.add(artifact.relativePath);
      }

      const durable = await this.lookupAuthority(request.teamId, request.legacyTeamKey);
      if (durable.status === 'blocked' || durable.authority.state !== 'committed') {
        return { status: 'blocked', reason: 'identity_blocked' };
      }
      const identity = await this.identityFiles.inspect(request.legacyTeamKey, durable.authority);
      if (identity.status !== 'valid' || identity.capability !== 'read_write') {
        return { status: 'blocked', reason: 'identity_blocked' };
      }
      teamsRoot = await openAdmittedTeamsRoot(this.admission);
      teamDirectory = await openTeamDirectory(teamsRoot, request.legacyTeamKey, false);
      if (!teamDirectory) {
        return { status: 'blocked', reason: 'unsafe_team_directory' };
      }

      for (const artifact of request.attemptOwnedArtifacts) {
        const registered = await this.attemptOwnership.getAttemptArtifactOwnership({
          teamId: request.teamId,
          legacyTeamKey: request.legacyTeamKey,
          runId: request.runId,
          artifactRelativePath: artifact.relativePath,
        });
        if (registered.status !== 'found') {
          return { status: 'blocked', reason: 'artifact_ownership_unproven' };
        }
        const artifactBinding = await validateAttemptArtifactPath(teamDirectory, request, artifact);
        if (artifactBinding) {
          if (!sameAttemptOwnership(artifactBinding.ownership, registered.ownership)) {
            await closeAttemptBinding(artifactBinding);
            return { status: 'blocked', reason: 'artifact_ownership_unproven' };
          }
          validated.push(artifactBinding);
        }
      }

      const removedArtifacts: string[] = [];
      for (const binding of validated) {
        const freshAuthority = await this.lookupAuthority(request.teamId, request.legacyTeamKey);
        if (
          freshAuthority.status === 'blocked' ||
          freshAuthority.authority.state !== 'committed' ||
          freshAuthority.authority.identityGeneration !== durable.authority.identityGeneration ||
          freshAuthority.authority.expectedChecksum !== durable.authority.expectedChecksum
        ) {
          throw new DirectoryBoundaryError('unsafe_team_directory');
        }
        const freshIdentity = await this.identityFiles.inspect(
          request.legacyTeamKey,
          freshAuthority.authority
        );
        if (freshIdentity.status !== 'valid' || freshIdentity.capability !== 'read_write') {
          throw new DirectoryBoundaryError('unsafe_team_directory');
        }
        await assertCurrentDirectoryBinding(teamDirectory, 'unsafe_team_directory');
        await revalidateAttemptOwnership(binding, request);
        const registered = await this.attemptOwnership.getAttemptArtifactOwnership({
          teamId: request.teamId,
          legacyTeamKey: request.legacyTeamKey,
          runId: request.runId,
          artifactRelativePath: binding.relativePath,
        });
        if (
          registered.status !== 'found' ||
          !sameAttemptOwnership(binding.ownership, registered.ownership)
        ) {
          throw new DirectoryBoundaryError('artifact_ownership_unproven');
        }
        await assertCurrentDirectoryBinding(teamDirectory, 'unsafe_team_directory');
        await assertCurrentDirectoryBinding(binding.artifact, 'unsafe_attempt_path');
        await quarantineLogicalDirectory(
          binding.namespace,
          request.runId,
          binding.artifact,
          'unsafe_attempt_path'
        );
        await teamDirectory.handle.sync();
        await assertCurrentDirectoryBinding(teamDirectory, 'unsafe_team_directory');
        removedArtifacts.push(binding.relativePath);
      }
      return { status: 'cleaned', removedArtifacts, anchorPreserved: true };
    } catch (error) {
      return {
        status: 'blocked',
        reason: error instanceof DirectoryBoundaryError ? error.reason : 'unsafe_team_directory',
      };
    } finally {
      await Promise.allSettled(validated.map(closeAttemptBinding));
      await teamDirectory?.handle.close().catch(() => undefined);
      await teamsRoot?.handle.close().catch(() => undefined);
    }
  }

  async deleteDraft(request: ExplicitTeamDeleteRequest): Promise<ExplicitTeamDeleteOutcome> {
    if (request.confirmation !== 'delete_draft') {
      return { status: 'blocked', reason: 'delete_not_explicit' };
    }
    return this.deleteExplicitly(request);
  }

  async permanentlyDelete(request: ExplicitTeamDeleteRequest): Promise<ExplicitTeamDeleteOutcome> {
    if (request.confirmation !== 'permanent_delete') {
      return { status: 'blocked', reason: 'delete_not_explicit' };
    }
    return this.deleteExplicitly(request);
  }

  async abortPreparedDirectory(
    request: AbortPreparedTeamDirectoryRequest
  ): Promise<ExplicitTeamDeleteOutcome> {
    if (request.confirmation !== 'prepared_abort') {
      return { status: 'blocked', reason: 'delete_not_explicit' };
    }
    const durable = await this.lookupAuthority(request.teamId, request.legacyTeamKey);
    if (durable.status === 'blocked' || durable.authority.state !== 'prepared') {
      return { status: 'blocked', reason: 'identity_blocked' };
    }
    const inspected = await this.identityFiles.inspect(request.legacyTeamKey, durable.authority);
    if (inspected.status !== 'absent') {
      return { status: 'blocked', reason: 'identity_blocked' };
    }
    return this.deleteAfterTombstone(request, durable, 'prepared_abort');
  }

  private async deleteExplicitly(
    request: ExplicitTeamDeleteRequest
  ): Promise<ExplicitTeamDeleteOutcome> {
    const durable = await this.lookupAuthority(request.teamId, request.legacyTeamKey);
    if (durable.status === 'blocked') {
      return { status: 'blocked', reason: 'identity_blocked' };
    }
    if (durable.authority.state === 'tombstoned') {
      const directoryState = await this.inspectTeamDirectoryPresence(request.legacyTeamKey);
      if (directoryState !== 'absent') {
        return {
          status: 'blocked',
          reason: directoryState === 'blocked' ? 'unsafe_team_directory' : 'identity_blocked',
        };
      }
      return {
        status: 'already_deleted',
        tombstoneGeneration: durable.authority.tombstoneGeneration,
      };
    }
    if (
      durable.authority.state !== 'committed' ||
      durable.authority.identityGeneration !== request.expectedIdentityGeneration
    ) {
      return { status: 'blocked', reason: 'identity_blocked' };
    }
    const inspected = await this.identityFiles.inspect(request.legacyTeamKey, durable.authority);
    if (inspected.status !== 'valid' || inspected.capability !== 'read_write') {
      return { status: 'blocked', reason: 'identity_blocked' };
    }
    return this.deleteAfterTombstone(request, durable, request.confirmation);
  }

  private async deleteAfterTombstone(
    request: ExplicitTeamDeleteRequest | AbortPreparedTeamDirectoryRequest,
    durable: Extract<TeamIdentityAuthorityLookupOutcome, { status: 'found' }>,
    reason: 'delete_draft' | 'permanent_delete' | 'prepared_abort'
  ): Promise<ExplicitTeamDeleteOutcome> {
    let teamsRoot: DirectoryBinding | null = null;
    let teamDirectory: DirectoryBinding | null = null;
    try {
      parseTeamId(request.teamId);
      parseLegacyTeamKey(request.legacyTeamKey);
      teamsRoot = await openAdmittedTeamsRoot(this.admission);
      teamDirectory = await openTeamDirectory(teamsRoot, request.legacyTeamKey, true);
    } catch (error) {
      await teamDirectory?.handle.close().catch(() => undefined);
      await teamsRoot?.handle.close().catch(() => undefined);
      return {
        status: 'blocked',
        reason:
          error instanceof DirectoryBoundaryError && error.reason === 'root_not_admitted'
            ? 'root_not_admitted'
            : 'unsafe_team_directory',
      };
    }

    const tombstone = await this.persistence
      .tombstone({
        teamId: request.teamId,
        legacyTeamKey: request.legacyTeamKey,
        expectedIdentityGeneration: request.expectedIdentityGeneration,
        reason,
        requestedAt: request.requestedAt,
      })
      .catch(() => null);
    if (!tombstone || !this.isDurableTombstone(tombstone)) {
      await teamDirectory?.handle.close().catch(() => undefined);
      await teamsRoot.handle.close().catch(() => undefined);
      return { status: 'blocked', reason: 'tombstone_not_durable' };
    }
    if (!teamDirectory) {
      await teamsRoot.handle.close().catch(() => undefined);
      return {
        status: 'already_deleted',
        tombstoneGeneration: tombstone.tombstoneGeneration,
      };
    }

    try {
      const identity = await this.identityFiles.inspect(request.legacyTeamKey, durable.authority);
      if (
        (durable.authority.state === 'committed' &&
          (identity.status !== 'valid' || identity.capability !== 'read_write')) ||
        (durable.authority.state === 'prepared' && identity.status !== 'absent')
      ) {
        return { status: 'blocked', reason: 'identity_blocked' };
      }
      await assertCurrentDirectoryBinding(teamDirectory, 'unsafe_team_directory');
      await assertCurrentDirectoryBinding(teamsRoot, 'root_not_admitted');
      await quarantineLogicalDirectory(
        teamsRoot,
        request.legacyTeamKey,
        teamDirectory,
        'unsafe_team_directory'
      );
      return { status: 'deleted', tombstoneGeneration: tombstone.tombstoneGeneration };
    } catch {
      return { status: 'blocked', reason: 'filesystem_delete_failed' };
    } finally {
      await teamDirectory.handle.close().catch(() => undefined);
      await teamsRoot.handle.close().catch(() => undefined);
    }
  }

  private async lookupAuthority(
    teamId: TeamId,
    legacyTeamKey: LegacyTeamKey
  ): Promise<TeamIdentityAuthorityLookupOutcome> {
    const outcome = await this.persistence.getAuthority({ teamId, legacyTeamKey }).catch(() => ({
      status: 'blocked' as const,
      reason: 'identity_mismatch' as const,
    }));
    if (
      outcome.status === 'found' &&
      (outcome.intent.teamId !== teamId ||
        outcome.intent.legacyTeamKey !== legacyTeamKey ||
        outcome.authority.teamId !== teamId ||
        !Number.isSafeInteger(outcome.authority.duplicateTeamIdCount) ||
        outcome.authority.duplicateTeamIdCount < 0 ||
        (outcome.authority.expectedChecksum !== undefined &&
          outcome.authority.expectedChecksum !== outcome.intent.expectedChecksum))
    ) {
      return { status: 'blocked', reason: 'identity_mismatch' };
    }
    return outcome;
  }

  private async inspectTeamDirectoryPresence(
    legacyTeamKey: LegacyTeamKey
  ): Promise<'absent' | 'present' | 'blocked'> {
    let teamsRoot: DirectoryBinding | null = null;
    let teamDirectory: DirectoryBinding | null = null;
    try {
      teamsRoot = await openAdmittedTeamsRoot(this.admission);
      teamDirectory = await openTeamDirectory(teamsRoot, legacyTeamKey, true);
      return teamDirectory ? 'present' : 'absent';
    } catch {
      return 'blocked';
    } finally {
      await teamDirectory?.handle.close().catch(() => undefined);
      await teamsRoot?.handle.close().catch(() => undefined);
    }
  }

  private intentMatchesRequest(
    intent: TeamIdentityIntent,
    request: PublishAndCommitTeamIdentityRequest
  ): boolean {
    return (
      intent.teamId === request.teamId &&
      intent.legacyTeamKey === request.legacyTeamKey &&
      intent.createdAt === request.identity.createdAt &&
      intent.originDeploymentId === request.identity.originDeploymentId
    );
  }

  private isDurableTombstone(
    outcome: TeamIdentityTombstoneOutcome
  ): outcome is Extract<TeamIdentityTombstoneOutcome, { durability: 'durable' }> {
    return (
      (outcome.status === 'tombstoned' || outcome.status === 'already_tombstoned') &&
      outcome.durability === 'durable'
    );
  }
}
