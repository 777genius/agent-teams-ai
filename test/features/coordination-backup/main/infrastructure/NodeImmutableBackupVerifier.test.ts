import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  type BackupCommitMarker,
  type BackupManifest,
  type BackupManifestBody,
  type BackupManifestEntry,
  type BackupVerificationPlan,
  COORDINATION_BACKUP_COMMIT_MARKER_FORMAT,
  COORDINATION_BACKUP_FORMAT,
  parseBackupRunId,
} from '@features/coordination-backup/contracts';
import {
  canonicalBackupJson,
  createBackupPathLayout,
  NodeBackupManifestHasher,
  NodeBackupPublication,
  NodeImmutableBackupVerifier,
  stagePaths,
} from '@features/coordination-backup/main/infrastructure';
import { parseDeploymentId } from '@shared/contracts/hosted/identifiers';
import { afterEach, describe, expect, it } from 'vitest';

const RUN_ID = parseBackupRunId('backup_node-verifier-001');
const DEPLOYMENT_ID = parseDeploymentId('deployment_test');

describe('NodeImmutableBackupVerifier', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true })));
  });

  it('returns the exact ImmutableBackupInspection for staging and committed generations', async () => {
    const fixture = await makeSealedFixture(roots);
    const verifier = new NodeImmutableBackupVerifier(fixture.root);

    const staging = await verifier.verify({
      backupRunId: RUN_ID,
      location: 'staging',
      expectedPlan: fixture.plan,
    });
    expect(staging).toMatchObject({
      status: 'verified',
      inspection: {
        manifest: fixture.plan.manifest,
        marker: fixture.plan.marker,
        computedManifestHash: fixture.plan.manifest.manifestHash,
        copiedSourceRun: {
          backupRunId: RUN_ID,
          state: 'sqlite_snapshot',
        },
      },
    });
    if (staging.status === 'verified') {
      expect(staging.inspection.measuredEntries.map((entry) => entry.entryId)).toEqual(
        fixture.plan.manifest.entries.map((entry) => entry.entryId)
      );
      expect(staging.inspection.observedIdentityInventory).toEqual(
        fixture.plan.manifest.identityInventory
      );
    }

    await fixture.publication.commitSealedStage({
      backupRunId: RUN_ID,
      manifestHash: fixture.plan.manifest.manifestHash,
    });
    await expect(
      verifier.verify({
        backupRunId: RUN_ID,
        location: 'committed',
        expectedPlan: fixture.plan,
      })
    ).resolves.toMatchObject({ status: 'verified' });
  });

  it.each([
    [
      'digest or size drift',
      async (fixture: SealedFixture) => {
        await fs.promises.writeFile(fixture.identityPath, 'changed');
      },
    ],
    [
      'mode drift',
      async (fixture: SealedFixture) => {
        // The sandbox fixture deliberately creates an unsafe mode to verify fail-closed handling.
        // eslint-disable-next-line sonarjs/file-permissions
        await fs.promises.chmod(fixture.identityPath, 0o644);
      },
    ],
    [
      'missing entry',
      async (fixture: SealedFixture) => {
        await fs.promises.rm(fixture.identityPath);
      },
    ],
    [
      'extra entry',
      async (fixture: SealedFixture) => {
        await fs.promises.writeFile(path.join(fixture.stageDirectory, 'extra'), 'extra', {
          mode: 0o600,
        });
      },
    ],
    [
      'symlink entry',
      async (fixture: SealedFixture) => {
        await fs.promises.rm(fixture.identityPath);
        await fs.promises.symlink(fixture.root, fixture.identityPath);
      },
    ],
  ] as const)('fails closed on %s', async (_name, mutate) => {
    const fixture = await makeSealedFixture(roots);
    await mutate(fixture);
    const verifier = new NodeImmutableBackupVerifier(fixture.root);

    await expect(
      verifier.verify({
        backupRunId: RUN_ID,
        location: 'staging',
        expectedPlan: fixture.plan,
      })
    ).resolves.toMatchObject({ status: 'invalid' });
  });

  it('rejects canonical manifest and marker disagreement with the durable plan', async () => {
    const fixture = await makeSealedFixture(roots);
    const changedManifest = {
      ...fixture.plan.manifest,
      purpose: 'app_migration' as const,
    };
    await fs.promises.writeFile(
      path.join(fixture.stageDirectory, 'manifest.json'),
      canonicalBackupJson(changedManifest),
      { mode: 0o600 }
    );
    const verifier = new NodeImmutableBackupVerifier(fixture.root);

    await expect(
      verifier.verify({
        backupRunId: RUN_ID,
        location: 'staging',
        expectedPlan: fixture.plan,
      })
    ).resolves.toEqual({ status: 'invalid', reasons: ['manifest-mismatch'] });

    await fs.promises.writeFile(
      path.join(fixture.stageDirectory, 'manifest.json'),
      canonicalBackupJson(fixture.plan.manifest),
      { mode: 0o600 }
    );
    await fs.promises.writeFile(
      path.join(fixture.stageDirectory, 'commit-marker.json'),
      canonicalBackupJson({ ...fixture.plan.marker, sealedAt: '2026-07-20T00:02:00.000Z' }),
      { mode: 0o600 }
    );
    await expect(
      verifier.verify({
        backupRunId: RUN_ID,
        location: 'staging',
        expectedPlan: fixture.plan,
      })
    ).resolves.toEqual({ status: 'invalid', reasons: ['commit-marker-mismatch'] });
  });

  it('rejects stage/generation ambiguity without choosing either artifact', async () => {
    const fixture = await makeSealedFixture(roots);
    const publication = await fixture.publication.commitSealedStage({
      backupRunId: RUN_ID,
      manifestHash: fixture.plan.manifest.manifestHash,
    });
    const layout = createBackupPathLayout(await fs.promises.realpath(fixture.root));
    await fs.promises.mkdir(stagePaths(layout, RUN_ID).directory, { mode: 0o700 });
    const verifier = new NodeImmutableBackupVerifier(fixture.root);

    expect(publication.immutableGeneration).toContain(fixture.plan.manifest.manifestHash);
    await expect(
      verifier.verify({
        backupRunId: RUN_ID,
        location: 'committed',
        expectedPlan: fixture.plan,
      })
    ).resolves.toEqual({ status: 'invalid', reasons: ['publication-ambiguous'] });
  });
});

interface SealedFixture {
  readonly root: string;
  readonly publication: NodeBackupPublication;
  readonly plan: BackupVerificationPlan;
  readonly stageDirectory: string;
  readonly identityPath: string;
}

async function makeSealedFixture(roots: string[]): Promise<SealedFixture> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coordination-verifier-'));
  roots.push(root);
  const publication = new NodeBackupPublication(root);
  await publication.preparePrivateStage(RUN_ID);
  const sqlite = await publication.writeArtifact({
    backupRunId: RUN_ID,
    entryId: 'sqlite/app.db',
    participantId: 'internal-storage',
    kind: 'sqlite_snapshot',
    logicalOwner: 'internal-storage',
    logicalType: 'application/sqlite3',
    schemaVersion: 3,
    sourceGeneration: 'sqlite-generation-1',
    bytes: Buffer.from('sqlite-online-backup-api-output'),
    mode: 0o600,
  });
  const identity = await publication.writeArtifact({
    backupRunId: RUN_ID,
    entryId: 'identity/deployment.json',
    participantId: 'identity',
    kind: 'identity_anchor',
    logicalOwner: 'deployment-identity',
    logicalType: 'application/json',
    schemaVersion: 1,
    sourceGeneration: 'identity-generation-1',
    bytes: Buffer.from('{"deploymentId":"deployment_test"}'),
    mode: 0o600,
  });
  const plan = await buildPlan(sqlite, identity);
  await publication.writeRootManifest({ backupRunId: RUN_ID, manifest: plan.manifest });
  await publication.writeCommitMarkerLast({ backupRunId: RUN_ID, marker: plan.marker });
  const layout = createBackupPathLayout(await fs.promises.realpath(root));
  const stage = stagePaths(layout, RUN_ID);
  return {
    root,
    publication,
    plan,
    stageDirectory: stage.directory,
    identityPath: path.join(stage.directory, identity.entryId),
  };
}

async function buildPlan(
  sqlite: BackupManifestEntry,
  identity: BackupManifestEntry
): Promise<BackupVerificationPlan> {
  const entries = [identity, sqlite].sort((left, right) =>
    left.entryId.localeCompare(right.entryId)
  );
  const body: BackupManifestBody = {
    format: COORDINATION_BACKUP_FORMAT,
    backupRunId: RUN_ID,
    sourceBackupRunId: RUN_ID,
    productKind: 'coordination_backup',
    purpose: 'coordination_repair',
    deploymentId: DEPLOYMENT_ID,
    requestedAt: '2026-07-20T00:00:00.000Z',
    sealedAt: '2026-07-20T00:01:00.000Z',
    fenceGeneration: 7,
    coordinationBarrier: {
      stateCompatibilityManifest: {
        manifestId: 'state-v3',
        schemaVersion: 3,
        sha256: sqlite.sha256,
      },
      acceptedCommandDrain: {
        admittedRunId: RUN_ID,
        fenceGeneration: 7,
        throughCommandCursor: 'command-10',
        durableBarrier: 'command-drain-10',
      },
      participantRecoveryPoints: [
        {
          participantId: 'identity',
          sourceGeneration: identity.sourceGeneration,
          durableBarrier: 'identity-barrier-1',
        },
      ],
      eventCursor: 'event-20',
      eventEpoch: 'epoch-1',
      journalCursors: { outbox: 'outbox-12' },
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
          checksum: identity.sha256,
          fileEntryId: identity.entryId,
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
        sourceGeneration: identity.sourceGeneration,
        durableBarrier: 'identity-barrier-1',
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
      requiredInvariants: { backup_run_present: true, identity_unique: true },
    },
    entries,
    exclusions: [],
  };
  const manifestHash = await new NodeBackupManifestHasher().hashCanonicalManifest(body);
  const manifest: BackupManifest = { ...body, manifestHash };
  const marker: BackupCommitMarker = {
    format: COORDINATION_BACKUP_COMMIT_MARKER_FORMAT,
    backupRunId: RUN_ID,
    deploymentId: DEPLOYMENT_ID,
    manifestHash,
    sealedAt: body.sealedAt,
  };
  return { manifest, marker };
}
