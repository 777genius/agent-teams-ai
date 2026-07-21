import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  BACKUP_RUN_STATES,
  COORDINATION_BACKUP_COMMIT_MARKER_FORMAT,
  COORDINATION_BACKUP_FORMAT,
  CoordinationBackupService,
  SQLITE_ONLINE_BACKUP_METHOD,
  transitionBackupRunState,
} from '@features/coordination-backup';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const CORE_PATHS = [
  'src/features/coordination-backup/contracts/coordinationBackupContracts.ts',
  'src/features/coordination-backup/core/domain/backupRunState.ts',
  'src/features/coordination-backup/core/application/ports.ts',
  'src/features/coordination-backup/core/application/CoordinationBackupService.ts',
] as const;
const FORBIDDEN_IMPORTS = [
  'electron',
  'fastify',
  'node:fs',
  'node:path',
  'node:crypto',
  'node:child_process',
  '@main/',
  '@renderer/',
  '@preload/',
] as const;
const NODE_ADAPTER_PATHS = [
  'src/features/coordination-backup/main/adapters/output/DurableBackupIdentityInventory.ts',
  'src/features/coordination-backup/main/adapters/output/SqliteBackupCoordinationFlush.ts',
  'src/features/coordination-backup/main/adapters/output/SqliteBackupRunRepository.ts',
  'src/features/coordination-backup/main/adapters/output/SqliteBackupWriterFence.ts',
  'src/features/coordination-backup/main/adapters/output/SqliteOnlineBackupAdapter.ts',
  'src/features/coordination-backup/main/composition/createCoordinationBackupFeature.ts',
  'src/features/coordination-backup/main/infrastructure/backupPathLayout.ts',
  'src/features/coordination-backup/main/infrastructure/canonicalBackupJson.ts',
  'src/features/coordination-backup/main/infrastructure/NodeBackupManifestHasher.ts',
  'src/features/coordination-backup/main/infrastructure/NodeBackupPublication.ts',
  'src/features/coordination-backup/main/infrastructure/NodeImmutableBackupVerifier.ts',
  'src/features/coordination-backup/main/infrastructure/index.ts',
  'src/features/coordination-backup/main/participants/TypedFileBackupParticipant.ts',
  'src/features/coordination-backup/main/participants/CoordinationEventBackupParticipant.ts',
  'src/features/coordination-backup/main/participants/index.ts',
] as const;

describe('Phase 3D coordination backup architecture boundary', () => {
  it('keeps contracts and core process-agnostic and free of direct storage operations', () => {
    for (const relativePath of CORE_PATHS) {
      // Paths come only from the fixed repository-owned allowlist above.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(
          imports.some((specifier) => specifier === forbidden || specifier.startsWith(forbidden)),
          `${relativePath} imports ${forbidden}`
        ).toBe(false);
      }
      expect(source).not.toMatch(
        /\b(copyFile|createReadStream|writeFile|rename|openSync|spawn)\s*\(/
      );
    }
  });

  it('owns bounded main composition and adapters without raw copy or public primitive leakage', () => {
    // These resolve fixed repository-owned feature paths.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(existsSync(resolve(ROOT, 'src/features/coordination-backup/main/composition'))).toBe(
      true
    );
    for (const relativePath of NODE_ADAPTER_PATHS) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      expect(existsSync(resolve(ROOT, relativePath)), relativePath).toBe(true);
    }
    // This resolves fixed repository-owned source paths.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const ports = readFileSync(
      resolve(ROOT, 'src/features/coordination-backup/core/application/ports.ts'),
      'utf8'
    );
    expect(ports).toContain('SqliteOnlineBackupPort');
    expect(ports).toContain('createOnlineSnapshot');
    expect(ports).not.toMatch(/\b(copyDatabase|copyWal|copyShm|rawCopy|fallbackCopy)\b/);
    for (const relativePath of NODE_ADAPTER_PATHS) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(source).not.toMatch(/\b(copyFile|copyFileSync|cpSync|copyDatabase|copyWal|copyShm)\b/);
      expect(source).not.toMatch(/better-sqlite3|(?:^|[^A-Za-z])(?:-wal|-shm)(?:[^A-Za-z]|$)/);
    }
    // This resolves one fixed repository-owned public entrypoint.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const mainEntrypoint = readFileSync(
      resolve(ROOT, 'src/features/coordination-backup/main/index.ts'),
      'utf8'
    );
    expect(mainEntrypoint).toContain(
      "export * from './composition/createCoordinationBackupFeature'"
    );
    expect(mainEntrypoint).not.toMatch(/adapters|infrastructure|participants/);
    // This resolves one fixed repository-owned composition root.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const composition = readFileSync(
      resolve(
        ROOT,
        'src/features/coordination-backup/main/composition/createCoordinationBackupFeature.ts'
      ),
      'utf8'
    );
    expect(composition).toContain('return Object.freeze({ service });');
  });

  it('keeps the generic typed-file source pathless and stages only through the artifact writer', () => {
    // This resolves one fixed repository-owned source path.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = readFileSync(
      resolve(
        ROOT,
        'src/features/coordination-backup/main/participants/TypedFileBackupParticipant.ts'
      ),
      'utf8'
    );
    const sourceContract = source.slice(
      source.indexOf('export interface TypedFileBackupSourceSnapshot<'),
      source.indexOf('export interface TypedFileBackupParticipantOptions<')
    );
    expect(sourceContract).toContain('bytes: Uint8Array');
    expect(sourceContract).toContain('generation: TGeneration');
    expect(sourceContract).toContain('durableBarrier: string');
    expect(sourceContract).toContain('exclusions: readonly TypedFileSourceExclusion[]');
    expect(sourceContract).not.toMatch(/\b(?:root|path|directory|filename)s?\b/i);
    expect(source).toContain('this.options.artifactWriter.writeArtifact({');
    expect(source).not.toMatch(/from ['"]node:(?:fs|path)['"]/);
  });

  it('keeps canonical hashing and exact verifier inspection at the Node boundary', () => {
    // These resolve fixed repository-owned source paths.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const canonical = readFileSync(
      resolve(ROOT, 'src/features/coordination-backup/main/infrastructure/canonicalBackupJson.ts'),
      'utf8'
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const hasher = readFileSync(
      resolve(
        ROOT,
        'src/features/coordination-backup/main/infrastructure/NodeBackupManifestHasher.ts'
      ),
      'utf8'
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const verifier = readFileSync(
      resolve(
        ROOT,
        'src/features/coordination-backup/main/infrastructure/NodeImmutableBackupVerifier.ts'
      ),
      'utf8'
    );
    expect(canonical).toContain('Object.keys(record).sort()');
    expect(hasher).toContain("createHash('sha256')");
    expect(verifier).toContain('validateImmutableBackupInspection(inspection)');
    expect(verifier).toContain("status: 'verified', inspection");
  });

  it('makes root manifest, hash-bound marker-last, immutable rename, and commit ordering explicit', () => {
    // This resolves one fixed repository-owned source path.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const service = readFileSync(
      resolve(
        ROOT,
        'src/features/coordination-backup/core/application/CoordinationBackupService.ts'
      ),
      'utf8'
    );
    const integrity = service.indexOf('checkSqliteIntegrity(run)');
    const participantVerification = service.indexOf('verifyParticipants(run)');
    const writeManifest = service.indexOf('writeRootManifest({');
    const writeMarker = service.indexOf('writeCommitMarkerLast({');
    const commitStage = service.indexOf('commitSealedStage({');
    const durableCommit = service.indexOf("to: 'committed'");
    expect(integrity).toBeGreaterThan(-1);
    expect(participantVerification).toBeGreaterThan(integrity);
    expect(writeManifest).toBeGreaterThan(participantVerification);
    expect(writeMarker).toBeGreaterThan(writeManifest);
    expect(commitStage).toBeGreaterThan(writeMarker);
    expect(durableCommit).toBeGreaterThan(commitStage);
  });

  it('publishes the v2 contract, state machine, and service only through public entrypoints', () => {
    expect(COORDINATION_BACKUP_FORMAT).toBe('coordination-backup/v2');
    expect(COORDINATION_BACKUP_COMMIT_MARKER_FORMAT).toBe('coordination-backup-commit-marker/v1');
    expect(SQLITE_ONLINE_BACKUP_METHOD).toBe('sqlite_online_backup_api');
    expect(BACKUP_RUN_STATES).toContain('artifact_source');
    expect(transitionBackupRunState('requested', 'fencing')).toBe('fencing');
    expect(typeof CoordinationBackupService).toBe('function');
  });

  it('requires every feature participant to prepare, flush, stage, and verify typed evidence', () => {
    // This resolves one fixed repository-owned source path.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const ports = readFileSync(
      resolve(ROOT, 'src/features/coordination-backup/core/application/ports.ts'),
      'utf8'
    );
    const participantContract = ports.slice(
      ports.indexOf('export interface CoordinationBackupParticipant'),
      ports.indexOf('export interface DrainAcceptedBackupCommandsRequest')
    );
    expect(participantContract).toMatch(/\bprepare\s*\(/);
    expect(participantContract).toMatch(/\bflush\s*\(/);
    expect(participantContract).toMatch(/\bstage\s*\(/);
    expect(participantContract).toMatch(/\bverify\s*\(/);
    expect(participantContract).not.toMatch(/\b(rootPath|sourcePath|destinationPath)\b/);
  });

  it('drains accepted commands before participant flush and persists fence completion', () => {
    // This resolves fixed repository-owned source paths.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const ports = readFileSync(
      resolve(ROOT, 'src/features/coordination-backup/core/application/ports.ts'),
      'utf8'
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const service = readFileSync(
      resolve(
        ROOT,
        'src/features/coordination-backup/core/application/CoordinationBackupService.ts'
      ),
      'utf8'
    );
    const drain = service.indexOf('drainAcceptedCommands({');
    const flush = service.indexOf('participant.flush({');
    expect(drain).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(drain);
    expect(ports).toContain('markFenceCompleted(request: MarkBackupFenceCompletedRequest)');
    expect(ports).toContain('Idempotent for the durable lease identity');
  });
});
