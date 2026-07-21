import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  type BackupCommitMarker,
  type BackupManifest,
  type BackupManifestBody,
  type BackupManifestEntry,
  COORDINATION_BACKUP_COMMIT_MARKER_FORMAT,
  COORDINATION_BACKUP_FORMAT,
  parseBackupRunId,
  parseSha256Digest,
} from '@features/coordination-backup/contracts';
import {
  BACKUP_COMMIT_MARKER_FILE,
  BACKUP_DIRECTORY_MODE,
  BACKUP_STAGE_OWNER_FILE,
  canonicalBackupJson,
  createBackupPathLayout,
  generationPaths,
  NodeBackupManifestHasher,
  NodeBackupPublication,
  stagePaths,
} from '@features/coordination-backup/main/infrastructure';
import { parseDeploymentId } from '@shared/contracts/hosted/identifiers';
import { afterEach, describe, expect, it, vi } from 'vitest';

const RUN_ID = parseBackupRunId('backup_node-publication-001');
const DEPLOYMENT_ID = parseDeploymentId('deployment_test');

describe('NodeBackupPublication', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true })));
  });

  it('idempotently prepares, seals marker-last, atomically commits, and re-inspects', async () => {
    const { root, publication } = await makePublication(roots);
    await expect(publication.inspect(RUN_ID)).resolves.toEqual({ status: 'absent' });
    await expect(fs.promises.readdir(root)).resolves.toEqual([]);
    await publication.preparePrivateStage(RUN_ID);
    await publication.preparePrivateStage(RUN_ID);
    await expect(publication.inspect(RUN_ID)).resolves.toEqual({ status: 'staging_unsealed' });

    const sqlite = await publication.writeArtifact(makeSqliteRequest());
    const entry = await publication.writeArtifact(makeArtifactRequest(Buffer.from('typed-state')));
    await expect(
      publication.writeArtifact(makeArtifactRequest(Buffer.from('typed-state')))
    ).resolves.toEqual(entry);
    const { manifest, marker } = await makePlan(sqlite, entry);

    await publication.writeRootManifest({ backupRunId: RUN_ID, manifest });
    await publication.writeRootManifest({ backupRunId: RUN_ID, manifest });
    await publication.writeCommitMarkerLast({ backupRunId: RUN_ID, marker });
    await publication.writeCommitMarkerLast({ backupRunId: RUN_ID, marker });
    await expect(publication.inspect(RUN_ID)).resolves.toEqual({ status: 'staging_sealed' });

    const committed = await publication.commitSealedStage({
      backupRunId: RUN_ID,
      manifestHash: manifest.manifestHash,
    });
    await expect(
      publication.commitSealedStage({
        backupRunId: RUN_ID,
        manifestHash: manifest.manifestHash,
      })
    ).resolves.toEqual(committed);
    await expect(publication.inspect(RUN_ID)).resolves.toEqual({
      status: 'committed',
      publication: committed,
    });

    const layout = createBackupPathLayout(await fs.promises.realpath(root));
    await expect(fs.promises.lstat(stagePaths(layout, RUN_ID).directory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const generation = generationPaths(layout, RUN_ID, manifest.manifestHash);
    expect((await fs.promises.lstat(generation.directory)).mode & 0o777).toBe(
      BACKUP_DIRECTORY_MODE
    );
    await expect(fs.promises.readFile(generation.marker, 'utf8')).resolves.toBe(
      canonicalBackupJson(marker)
    );
  });

  it('publishes a worker-owned SQLite snapshot by bound chunks without exposing a destination path', async () => {
    const { publication } = await makePublication(roots);
    await publication.preparePrivateStage(RUN_ID);
    const bytes = Buffer.from('sqlite-online-backup-bytes');
    const sha256 = parseSha256Digest(createHash('sha256').update(bytes).digest('hex'));
    const request = {
      backupRunId: RUN_ID,
      entryId: 'sqlite/internal-storage.sqlite',
      byteLength: bytes.byteLength,
      sha256,
      readChunk: (offset: number) => {
        const chunk = bytes.subarray(offset, Math.min(offset + 5, bytes.byteLength));
        return Promise.resolve({
          offset,
          totalByteLength: bytes.byteLength,
          bytes: Uint8Array.from(chunk),
          eof: offset + chunk.byteLength === bytes.byteLength,
        });
      },
    };

    await expect(publication.publishSqliteSnapshot(request)).resolves.toMatchObject({
      entryId: request.entryId,
      byteLength: bytes.byteLength,
      mode: 0o600,
      sha256,
    });
    await expect(publication.publishSqliteSnapshot(request)).resolves.toMatchObject({ sha256 });
  });

  it('refuses a symlinked SQLite artifact ancestor and writes nothing outside the owned stage', async () => {
    const { root, publication } = await makePublication(roots);
    await publication.preparePrivateStage(RUN_ID);
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sqlite-stage-outside-'));
    roots.push(outside);
    const layout = createBackupPathLayout(await fs.promises.realpath(root));
    const stage = stagePaths(layout, RUN_ID);
    await fs.promises.symlink(outside, path.join(stage.directory, 'sqlite'));
    const bytes = Buffer.from('must-not-escape');

    await expect(
      publication.publishSqliteSnapshot({
        backupRunId: RUN_ID,
        entryId: 'sqlite/internal-storage.sqlite',
        byteLength: bytes.byteLength,
        sha256: parseSha256Digest(createHash('sha256').update(bytes).digest('hex')),
        readChunk: (offset) =>
          Promise.resolve({
            offset,
            totalByteLength: bytes.byteLength,
            bytes: Uint8Array.from(bytes.subarray(offset)),
            eof: true,
          }),
      })
    ).rejects.toThrow('coordination-backup-publication-directory-invalid');
    await expect(fs.promises.readdir(outside)).resolves.toEqual([]);
  });

  it('fails closed when the owned stage is swapped during SQLite chunk publication', async () => {
    const { root, publication } = await makePublication(roots);
    await publication.preparePrivateStage(RUN_ID);
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sqlite-stage-swap-'));
    roots.push(outside);
    const layout = createBackupPathLayout(await fs.promises.realpath(root));
    const stage = stagePaths(layout, RUN_ID);
    const movedStage = `${stage.directory}.moved`;
    const bytes = Buffer.from('stage-swap-must-fail-closed');

    await expect(
      publication.publishSqliteSnapshot({
        backupRunId: RUN_ID,
        entryId: 'sqlite/internal-storage.sqlite',
        byteLength: bytes.byteLength,
        sha256: parseSha256Digest(createHash('sha256').update(bytes).digest('hex')),
        readChunk: async (offset) => {
          if (offset === 0) {
            await fs.promises.rename(stage.directory, movedStage);
            await fs.promises.symlink(outside, stage.directory);
          }
          return {
            offset,
            totalByteLength: bytes.byteLength,
            bytes: Uint8Array.from(bytes.subarray(offset)),
            eof: true,
          };
        },
      })
    ).rejects.toThrow('coordination-backup-publication-directory-invalid');
    await expect(fs.promises.readdir(outside)).resolves.toEqual([]);
  });

  it('makes destination publication durable before attempting durable source removal', async () => {
    const { root, publication } = await makePublication(roots);
    const { manifest } = await makeSealedStage(publication);
    const layout = createBackupPathLayout(await fs.promises.realpath(root));
    const actualOpen = fs.promises.open.bind(fs.promises);
    const syncOrder: string[] = [];
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      const openedPath = String(args[0]);
      if (openedPath === layout.generationsRoot || openedPath === layout.stagingRoot) {
        const actualSync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          syncOrder.push(openedPath);
          if (openedPath === layout.generationsRoot) {
            throw new Error('simulated-crash-before-destination-directory-sync');
          }
          await actualSync();
        });
      }
      return handle;
    });

    await expect(
      publication.commitSealedStage({
        backupRunId: RUN_ID,
        manifestHash: manifest.manifestHash,
      })
    ).rejects.toThrow('simulated-crash-before-destination-directory-sync');

    expect(syncOrder).toEqual([layout.generationsRoot]);
    await expect(fs.promises.lstat(stagePaths(layout, RUN_ID).directory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fs.promises.lstat(generationPaths(layout, RUN_ID, manifest.manifestHash).directory)
    ).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it('fully syncs a private marker file before atomically publishing its authoritative name', async () => {
    const { root, publication } = await makePublication(roots);
    const { manifest, marker } = await makeManifestStage(publication);
    const layout = createBackupPathLayout(await fs.promises.realpath(root));
    const stage = stagePaths(layout, RUN_ID);
    const actualOpen = fs.promises.open.bind(fs.promises);
    const actualRename = fs.promises.rename.bind(fs.promises);
    let temporaryMarkerSynced = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      const openedPath = String(args[0]);
      if (
        path.dirname(openedPath) === stage.directory &&
        path.basename(openedPath).startsWith(`.${BACKUP_COMMIT_MARKER_FILE}.prepare-`)
      ) {
        const actualSync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          await actualSync();
          temporaryMarkerSynced = true;
        });
      }
      return handle;
    });
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination) === stage.marker) {
        expect(String(source)).not.toBe(stage.marker);
        expect(path.dirname(String(source))).toBe(stage.directory);
        expect(temporaryMarkerSynced).toBe(true);
        expect((await fs.promises.lstat(source)).mode & 0o777).toBe(0o600);
        await expect(fs.promises.lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.promises.readFile(source, 'utf8')).resolves.toBe(
          canonicalBackupJson(marker)
        );
      }
      await actualRename(source, destination);
    });

    await publication.writeCommitMarkerLast({ backupRunId: RUN_ID, marker });

    await expect(fs.promises.readFile(stage.marker, 'utf8')).resolves.toBe(
      canonicalBackupJson(marker)
    );
    expect(manifest.manifestHash).toBe(marker.manifestHash);
  });

  it('keeps a crash-torn private marker non-authoritative and reaps it on retry', async () => {
    const { root, publication } = await makePublication(roots);
    const { marker } = await makeManifestStage(publication);
    const layout = createBackupPathLayout(await fs.promises.realpath(root));
    const stage = stagePaths(layout, RUN_ID);
    const tornTemporaryMarker = path.join(
      stage.directory,
      `.${BACKUP_COMMIT_MARKER_FILE}.prepare-00000000-0000-4000-8000-000000000000`
    );
    await fs.promises.writeFile(tornTemporaryMarker, '{"format":', {
      flag: 'wx',
      mode: 0o600,
    });

    await expect(publication.inspect(RUN_ID)).resolves.toEqual({ status: 'staging_unsealed' });
    await expect(fs.promises.lstat(stage.marker)).rejects.toMatchObject({ code: 'ENOENT' });

    await publication.writeCommitMarkerLast({ backupRunId: RUN_ID, marker });

    await expect(fs.promises.lstat(tornTemporaryMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.readFile(stage.marker, 'utf8')).resolves.toBe(
      canonicalBackupJson(marker)
    );
  });

  it('reaps only exact owned crash-left preparation directories', async () => {
    const { root, publication } = await makePublication(roots);
    await publication.preparePrivateStage(RUN_ID);
    await publication.abortUncommittedStage(RUN_ID);
    const layout = createBackupPathLayout(await fs.promises.realpath(root));
    const owned = path.join(layout.stagingRoot, `.prepare-${RUN_ID}-ABC123`);
    const foreign = path.join(layout.stagingRoot, `.prepare-${RUN_ID}-DEF456`);
    const ambiguous = path.join(layout.stagingRoot, `.prepare-${RUN_ID}-GHI789`);
    for (const directory of [owned, foreign, ambiguous]) {
      await fs.promises.mkdir(directory, { mode: BACKUP_DIRECTORY_MODE });
    }
    await writeStageOwner(owned, RUN_ID);
    await writeStageOwner(foreign, 'backup_foreign-001');
    await writeStageOwner(ambiguous, RUN_ID);
    await fs.promises.writeFile(path.join(ambiguous, 'foreign-entry'), 'leave-me', { mode: 0o600 });

    await publication.preparePrivateStage(RUN_ID);

    await expect(fs.promises.lstat(owned)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.lstat(foreign)).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(fs.promises.lstat(ambiguous)).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(publication.inspect(RUN_ID)).resolves.toEqual({ status: 'staging_unsealed' });
  });

  it('aborts only an owned unsealed stage and refuses a sealed stage', async () => {
    const { publication } = await makePublication(roots);
    await publication.preparePrivateStage(RUN_ID);
    await publication.abortUncommittedStage(RUN_ID);
    await expect(publication.inspect(RUN_ID)).resolves.toEqual({ status: 'absent' });

    await publication.preparePrivateStage(RUN_ID);
    const sqlite = await publication.writeArtifact(makeSqliteRequest());
    const entry = await publication.writeArtifact(makeArtifactRequest(Buffer.from('typed-state')));
    const { manifest, marker } = await makePlan(sqlite, entry);
    await publication.writeRootManifest({ backupRunId: RUN_ID, manifest });
    await publication.writeCommitMarkerLast({ backupRunId: RUN_ID, marker });

    await expect(publication.abortUncommittedStage(RUN_ID)).rejects.toThrow(
      'coordination-backup-publication-abort-refused'
    );
    await expect(publication.inspect(RUN_ID)).resolves.toEqual({ status: 'staging_sealed' });
  });

  it('fails closed on artifact path escape and a symlink in an owned stage', async () => {
    const { root, publication } = await makePublication(roots);
    await publication.preparePrivateStage(RUN_ID);
    await expect(
      publication.writeArtifact({ ...makeArtifactRequest(Buffer.from('x')), entryId: '../escape' })
    ).rejects.toThrow('coordination-backup-artifact-entry-id-invalid');

    const layout = createBackupPathLayout(await fs.promises.realpath(root));
    const stage = stagePaths(layout, RUN_ID);
    await fs.promises.symlink(root, path.join(stage.directory, 'link'));
    await expect(publication.abortUncommittedStage(RUN_ID)).rejects.toThrow(
      'coordination-backup-publication-symlink-refused'
    );
  });

  it('reports ambiguity instead of selecting between stage and committed-looking generations', async () => {
    const { root, publication } = await makePublication(roots);
    await publication.preparePrivateStage(RUN_ID);
    const layout = createBackupPathLayout(await fs.promises.realpath(root));
    await fs.promises.mkdir(path.join(layout.generationsRoot, `${RUN_ID}.${'a'.repeat(64)}`), {
      mode: BACKUP_DIRECTORY_MODE,
    });

    await expect(publication.inspect(RUN_ID)).resolves.toEqual({ status: 'ambiguous' });
    await expect(publication.preparePrivateStage(RUN_ID)).rejects.toThrow(
      'coordination-backup-publication-prepare-state-ambiguous'
    );
  });
});

async function makePublication(roots: string[]): Promise<{
  readonly root: string;
  readonly publication: NodeBackupPublication;
}> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coordination-publication-'));
  roots.push(root);
  return { root, publication: new NodeBackupPublication({ backupRoot: root }) };
}

async function makeManifestStage(publication: NodeBackupPublication) {
  await publication.preparePrivateStage(RUN_ID);
  const sqlite = await publication.writeArtifact(makeSqliteRequest());
  const entry = await publication.writeArtifact(makeArtifactRequest(Buffer.from('typed-state')));
  const plan = await makePlan(sqlite, entry);
  await publication.writeRootManifest({ backupRunId: RUN_ID, manifest: plan.manifest });
  return plan;
}

async function makeSealedStage(publication: NodeBackupPublication) {
  const plan = await makeManifestStage(publication);
  await publication.writeCommitMarkerLast({ backupRunId: RUN_ID, marker: plan.marker });
  return plan;
}

async function writeStageOwner(directory: string, backupRunId: string): Promise<void> {
  await fs.promises.writeFile(
    path.join(directory, BACKUP_STAGE_OWNER_FILE),
    canonicalBackupJson({ format: 'coordination-backup-private-stage/v1', backupRunId }),
    { mode: 0o600 }
  );
}

function makeArtifactRequest(bytes: Uint8Array) {
  return {
    backupRunId: RUN_ID,
    entryId: 'identity/deployment.json',
    participantId: 'identity',
    kind: 'identity_anchor' as const,
    logicalOwner: 'deployment-identity',
    logicalType: 'application/json',
    schemaVersion: 1,
    sourceGeneration: 'identity-generation-1',
    bytes,
    mode: 0o600,
  };
}

function makeSqliteRequest() {
  return {
    backupRunId: RUN_ID,
    entryId: 'sqlite/app.db',
    participantId: 'internal-storage',
    kind: 'sqlite_snapshot' as const,
    logicalOwner: 'internal-storage',
    logicalType: 'application/sqlite3',
    schemaVersion: 3,
    sourceGeneration: 'sqlite-generation-1',
    bytes: Buffer.from('sqlite-online-backup-api-output'),
    mode: 0o600,
  };
}

async function makePlan(
  sqlite: BackupManifestEntry,
  entry: BackupManifestEntry
): Promise<{
  readonly manifest: BackupManifest;
  readonly marker: BackupCommitMarker;
}> {
  const body: BackupManifestBody = {
    format: COORDINATION_BACKUP_FORMAT,
    backupRunId: RUN_ID,
    sourceBackupRunId: RUN_ID,
    productKind: 'coordination_backup',
    purpose: 'coordination_repair',
    deploymentId: DEPLOYMENT_ID,
    requestedAt: '2026-07-20T00:00:00.000Z',
    sealedAt: '2026-07-20T00:01:00.000Z',
    fenceGeneration: 1,
    coordinationBarrier: {
      stateCompatibilityManifest: {
        manifestId: 'compatibility-1',
        schemaVersion: 3,
        sha256: sqlite.sha256,
      },
      acceptedCommandDrain: {
        admittedRunId: RUN_ID,
        fenceGeneration: 1,
        throughCommandCursor: 'command-1',
        durableBarrier: 'commands-durable-1',
      },
      participantRecoveryPoints: [
        {
          participantId: 'identity',
          sourceGeneration: entry.sourceGeneration,
          durableBarrier: 'identity-durable-1',
        },
      ],
      eventCursor: 'event-1',
      eventEpoch: 'epoch-1',
      journalCursors: { outbox: 'outbox-1' },
    },
    identityInventory: {
      schemaVersion: 1,
      deploymentId: DEPLOYMENT_ID,
      identities: [
        {
          kind: 'deployment',
          identityId: DEPLOYMENT_ID,
          parentIdentityId: null,
          state: 'active',
          checksum: entry.sha256,
          fileEntryId: entry.entryId,
        },
      ],
      workspaceRegistrations: [],
    },
    participants: [
      {
        descriptor: {
          participantId: 'identity',
          kind: 'identity_anchor',
          contractVersion: 1,
          schemaVersion: 1,
          required: true,
        },
        sourceGeneration: entry.sourceGeneration,
        durableBarrier: 'identity-durable-1',
      },
    ],
    sqliteSnapshot: {
      method: 'sqlite_online_backup_api',
      entry: { ...sqlite, kind: 'sqlite_snapshot' },
      applicationId: 42,
      userVersion: 3,
      sourceRunId: RUN_ID,
    },
    sqliteIntegrity: {
      integrityCheck: 'ok',
      applicationId: 42,
      userVersion: 3,
      requiredInvariants: { source_run_present: true },
    },
    entries: [entry, sqlite].sort((left, right) => left.entryId.localeCompare(right.entryId)),
    exclusions: [],
  };
  const manifestHash = await new NodeBackupManifestHasher().hashCanonicalManifest(body);
  const manifest: BackupManifest = { ...body, manifestHash };
  return {
    manifest,
    marker: {
      format: COORDINATION_BACKUP_COMMIT_MARKER_FORMAT,
      backupRunId: RUN_ID,
      deploymentId: DEPLOYMENT_ID,
      manifestHash,
      sealedAt: body.sealedAt,
    },
  };
}
