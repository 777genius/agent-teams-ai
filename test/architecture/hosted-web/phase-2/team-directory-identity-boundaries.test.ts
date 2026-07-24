import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const PORT_PATH = 'src/features/team-lifecycle/core/application/ports/TeamIdentityPersistence.ts';
const FILE_STORE_PATH = 'src/features/team-lifecycle/main/infrastructure/TeamIdentityFileStore.ts';
const DIRECTORY_ADAPTER_PATH =
  'src/features/team-lifecycle/main/infrastructure/TeamDirectoryLifecycleAdapter.ts';
const BACKUP_COMPATIBILITY_PATH =
  'src/features/team-lifecycle/main/infrastructure/TeamIdentityBackupCompatibility.ts';

const PRODUCTION_PATHS = [
  PORT_PATH,
  FILE_STORE_PATH,
  DIRECTORY_ADAPTER_PATH,
  BACKUP_COMPATIBILITY_PATH,
] as const;

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function containsBypassTeamRootDeletion(source: string): boolean {
  return /(?:rm|remove|delete)\s*\([^)]*(?:teamRoot|teamDirectory|teamsDir)[^)]*recursive\s*:\s*true/is.test(
    source
  );
}

describe('P2.D team-directory identity architecture', () => {
  it('keeps the application port value-only and infrastructure-free', () => {
    const source = read(PORT_PATH);
    expect(source).toContain('interface TeamIdentityPersistence');
    expect(source).toContain('prepare(intent: TeamIdentityIntent)');
    expect(source).toContain('getAuthority(');
    expect(source).toContain('recordPublication(');
    expect(source).toContain('commit(request: TeamIdentityCommitRequest)');
    expect(source).toContain('tombstone(request: TeamIdentityTombstoneRequest)');
    expect(source).toContain('recordAttemptArtifactOwnership(');
    expect(source).toContain('getAttemptArtifactOwnership(');
    expect(source).toContain('type TeamIdentityMismatchReason');

    for (const forbidden of [
      '@main',
      'electron',
      'fastify',
      'react',
      'zustand',
      'node:fs',
      'node:path',
      'child_process',
    ]) {
      expect(source, `core port imported forbidden boundary: ${forbidden}`).not.toContain(
        forbidden
      );
    }
  });

  it('depends only on the lane port, Node filesystem mechanics and canonical identifier kernel', () => {
    for (const relativePath of PRODUCTION_PATHS.slice(1)) {
      const source = read(relativePath);
      expect(source).not.toMatch(/@features\/(?:internal-storage|workspace-registry)/);
      expect(source).not.toContain('src/features/internal-storage');
      expect(source).not.toContain('src/features/workspace-registry');
      expect(source).not.toMatch(/electron|fastify|ipcMain|BrowserWindow|@renderer|@preload/);
      expect(source).not.toContain('@main/services/team');
    }
  });

  it('keeps the portable anchor immutable and free of mutable directory or provider projections', () => {
    const port = read(PORT_PATH);
    const store = read(FILE_STORE_PATH);
    expect(port).toContain("TEAM_IDENTITY_FILE_NAME = 'team.identity.json'");
    expect(port).toContain('readonly schemaVersion');
    expect(port).toContain('readonly teamId');
    expect(port).toContain('readonly createdAt');
    expect(port).toContain('readonly originDeploymentId?');
    for (const forbiddenField of [
      'displayName:',
      'legacyTeamKey: LegacyTeamKey;\n  readonly workspaceId',
      'projectPath:',
      'providerId:',
      'lifecycleState:',
    ]) {
      expect(store).not.toContain(forbiddenField);
    }
    expect(store).toContain('fs.constants.O_EXCL | NO_FOLLOW');
    expect(store).toContain("path.join('/proc/self/fd', String(handle.fd))");
    expect(store).toContain('assertCurrentDirectoryBinding');
    expect(store).not.toMatch(/rename\([^,]+,\s*identityPath/);
    expect(store).not.toMatch(/writeFile\(identityPath/);
  });

  it('uses durable quarantine-only logical deletion and rejects physical request-path deletion', () => {
    const unsafeExamples = [
      'await fs.promises.rm(teamRoot, { recursive: true, force: true });',
      'remove(teamsDir, { recursive: true });',
      'delete(teamDirectory, { recursive: true });',
    ];
    for (const unsafe of unsafeExamples) {
      expect(containsBypassTeamRootDeletion(unsafe)).toBe(true);
    }

    for (const relativePath of PRODUCTION_PATHS) {
      if (relativePath === DIRECTORY_ADAPTER_PATH) continue;
      expect(
        containsBypassTeamRootDeletion(read(relativePath)),
        `${relativePath} bypassed identity-aware deletion`
      ).toBe(false);
    }
    for (const relativePath of PRODUCTION_PATHS) {
      expect(read(relativePath)).not.toMatch(
        /(?:fs\.promises\.)?(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/
      );
    }

    const adapter = read(DIRECTORY_ADAPTER_PATH);
    expect(adapter).not.toMatch(/(?:public\s+)?(?:removeRoot|deleteDirectory|rmTeamRoot)\s*\(/);
    expect(adapter).toContain('deleteDraft(');
    expect(adapter).toContain('permanentlyDelete(');
    expect(adapter).toContain('abortPreparedDirectory(');
    const tombstoneIndex = adapter.indexOf('.tombstone({');
    const deleteMethodIndex = adapter.indexOf('private async deleteAfterTombstone');
    const rootQuarantineIndex = adapter.indexOf(
      'await quarantineLogicalDirectory(',
      tombstoneIndex
    );
    expect(tombstoneIndex).toBeGreaterThan(-1);
    expect(deleteMethodIndex).toBeGreaterThan(-1);
    expect(deleteMethodIndex).toBeLessThan(tombstoneIndex);
    expect(rootQuarantineIndex).toBeGreaterThan(tombstoneIndex);
    expect(adapter).toContain("REMOVAL_QUARANTINE_DIRECTORY_NAME = '.p2-d-removal-quarantine'");
    expect(adapter).toContain('openRemovalQuarantineContainer(parent, reason)');
    expect(adapter).toContain('const quarantineEntryName = randomUUID()');
    expect(adapter).toContain('await assertCurrentDirectoryBinding(quarantineContainer, reason)');
    expect(adapter).toContain('!sameEntry(moved, expected.identity)');
    expect(adapter).toContain('await listNonQuarantineEntries(');
    expect(adapter).toContain('if (!isRemovalQuarantineName(entry.name))');
    expect(adapter).toContain('await fs.promises.rename(originalPath, quarantinePath)');
    expect(adapter).toContain('await assertQuarantinedDirectoryBinding(');
    expect(adapter).toContain('await quarantineContainer.handle.sync()');
    expect(adapter).toContain('await parent.handle.sync()');
  });

  it('uses descriptor-bound capped reads instead of stat-gated whole-file reads', () => {
    const store = read(FILE_STORE_PATH);
    const adapter = read(DIRECTORY_ADAPTER_PATH);
    for (const source of [store, adapter]) {
      expect(source).toContain('const capacity = maxBytes + 1;');
      expect(source).toContain('await handle.read(buffer, offset, capacity - offset, null)');
      expect(source).toContain('bytes.byteLength > maxBytes');
      expect(source).toContain('after.size > maxBytes');
      expect(source).not.toContain("handle.readFile('utf8')");
      expect(source).not.toContain('before.size > maxBytes');
    }
  });

  it('makes canonical identity mandatory in both legacy backup inventories without a recovery claim', () => {
    const source = read(BACKUP_COMPATIBILITY_PATH);
    expect(source).toContain('buildAsyncInventory');
    expect(source).toContain('buildShutdownSyncInventory');
    expect(source).toContain("classification: 'legacy_unverified'");
    expect(source).toContain("recoveryCapability: 'not_verified'");
    expect(source).toContain('[TEAM_IDENTITY_FILE_NAME');
    expect(source).toContain('legacyIdentity: LegacyBackupIdentityEvidence | null');
    expect(source).not.toMatch(/recoveryCapability:\s*'verified'/);
  });

  it('revalidates marker-owned temporary roots and denies symlink traversal before effects', () => {
    const store = read(FILE_STORE_PATH);
    const adapter = read(DIRECTORY_ADAPTER_PATH);
    for (const source of [store, adapter]) {
      expect(source).toContain('os.tmpdir()');
      expect(source).toContain('TEAM_DIRECTORY_ROOT_MARKER_FILE');
      expect(source).toContain('.isSymbolicLink()');
      expect(source).toContain('root_not_admitted');
    }
    expect(adapter).toContain('validateAttemptArtifactPath');
    expect(adapter).toContain('artifact.ownerRunId !== request.runId');
    expect(adapter).toContain('TEAM_ATTEMPT_OWNERSHIP_FILE_NAME');
    expect(adapter).toContain('registerAttemptArtifactOwnership(');
    expect(adapter).toContain("durability: 'durable'");
    expect(adapter).toContain('revalidateAttemptOwnership(binding, request)');
    expect(adapter).toContain('persistence.getAuthority');
    expect(adapter).toContain('PROTECTED_TEAM_ARTIFACTS');
  });
});
