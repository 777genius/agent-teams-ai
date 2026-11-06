import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { TeamOwnerError } from '../../team/contracts.js';
import { digest } from '../../team/identity.js';
import { teamBackupResourceVersion } from '../../team/teamBackupResourceVersion.js';
import { atomicWriteSync } from './atomicWriteSync.js';
import { OwnerBackupResourceAccess } from './OwnerBackupResourceAccess.js';
import { collectOwnerTeamBackupFiles } from './ownerTeamBackupCensus.js';
import { getBackupManifestPath, readBackupManifestStrictSync } from './teamBackupManifest.js';
import type { BackupManifest } from './teamBackupManifest.js';
import type { OwnedBackupResourceProof } from './OwnerBackupResourceAccess.js';
import type { TeamBinding } from '../../team/contracts.js';
import type { TeamOwnerStore } from '../team/TeamOwnerStore.js';
import type { BackupRegistryEntryPort } from './permanentDeletionPorts.js';
import type { createImportPublication } from '../../stopped-team-import/importPublication.js';
import type { LifecycleDirectories } from './lifecycleRoots.js';

interface OwnerBackupManifest extends BackupManifest {
  hostOwner: { schemaVersion: 1; binding: TeamBinding; resources: Record<string, OwnedBackupResourceProof>; held: string[]; importArchive?: { path: 'import-publication.json'; sha256: string } };
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function ensureOwnerBackupDirectories(path: string, create: boolean): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new TeamOwnerError('hold');
  let current = parse(path).root;
  for (const segment of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, segment);
    try { const stat = lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TeamOwnerError('hold'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error; mkdirSync(current, { mode: 0o700 }); }
  }
}
function readPlain(path: string, limit = 20 * 1024 * 1024): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > limit) throw new TeamOwnerError('hold');
    const bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || after.dev !== current.dev || after.ino !== current.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new TeamOwnerError('hold');
    return bytes;
  } finally { closeSync(fd); }
}
/** Existing manifest/census/publication adapter; scheduling and retention remain with their existing owner. */
export class OwnerScopedTeamBackup {
  private readonly resources: OwnerBackupResourceAccess;
  constructor(private readonly options: {
    binding: TeamBinding; store: TeamOwnerStore; roots: LifecycleDirectories;
    /** Existing owner-qualified backup directory; never a human-name lookup across owners. */
    backupDirectory: string;
    assertWriter(): void;
    /** Existing permanent-deletion identity/publication fence. */
    withIdentityFence<T>(operation: () => Promise<T>): Promise<T>;
    assertPublicationCurrent(): void;
    /** Exact importer-owned immutable publication, never the whole private owner directory. */
    importPublication?: ReturnType<typeof createImportPublication>;
    publishRegistryEntry(entry: BackupRegistryEntryPort, assertCurrent: () => void): Promise<void>;

  }) { this.resources = new OwnerBackupResourceAccess(options.store, options.binding); }
  private resourcePath(relative: string): string | undefined {
    if (relative.startsWith('tasks/') && /^[A-Za-z0-9_-]+\.json$/.test(relative.slice(6))) return `tasks/${this.options.binding.teamName}/${relative.slice(6)}`;
    if (relative.includes('..') || relative.startsWith('/') || relative.includes('\\')) return undefined;
    const path = `teams/${this.options.binding.teamName}/${relative}`;
    return teamBackupResourceVersion(this.options.store, this.options.binding, path) ? path : undefined;
  }
  private manifest(): OwnerBackupManifest | null {
    try { ensureOwnerBackupDirectories(this.options.backupDirectory, false); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const value = readBackupManifestStrictSync(getBackupManifestPath(this.options.backupDirectory), this.options.binding.teamName) as OwnerBackupManifest | null;
    if (!value) return null;
    if (value.identityId !== this.options.binding.teamId || value.hostOwner?.schemaVersion !== 1 ||
      digest(value.hostOwner.binding) !== digest(this.options.binding) || !value.hostOwner.resources || typeof value.hostOwner.resources !== 'object' || Array.isArray(value.hostOwner.resources) || !Array.isArray(value.hostOwner.held) || value.hostOwner.held.some(path => typeof path !== 'string' || path.includes('..') || path.includes('\\') || path.startsWith('/'))) throw new TeamOwnerError('hold');
    for (const [relative, proof] of Object.entries(value.hostOwner.resources)) if (!relative || relative.includes('..') || relative.includes('\\') || relative.startsWith('/') ||
      !proof || !/^[a-f0-9]{64}$/.test(proof.sha256) || !/^[a-f0-9]{64}$/.test(proof.ownerVersion)) throw new TeamOwnerError('hold');
    return value;
  }
  async snapshot(): Promise<{ copied: number; held: string[] }> {
    return this.options.withIdentityFence(async () => {
      const result = this.options.store.fenced(() => {
      this.options.assertWriter(); this.options.assertPublicationCurrent();
      ensureOwnerBackupDirectories(this.options.backupDirectory, true);
      const previous = this.manifest();
      if (previous?.status === 'deleted_by_user') throw new TeamOwnerError('hold');
      this.resourcePath('config.json'); // Missing authoritative owner state can never be supplied by an archive.
      try { ensureOwnerBackupDirectories(this.options.roots.appData, false); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const captured = collectOwnerTeamBackupFiles(this.options.roots, this.options.binding.teamName);
      if (captured.hasErrors) throw new TeamOwnerError('hold');
      const resources: Record<string, OwnedBackupResourceProof> = {}, fileStats: BackupManifest['fileStats'] = {}, held: string[] = [];
      let copied = 0;
      for (const file of captured.files) {
        try {
          const resource = this.resourcePath(file.relPath);
          const bytes = resource ? this.resources.capture(resource) : { bytes: readPlain(file.sourcePath), proof: undefined };
          const destination = join(this.options.backupDirectory, file.relPath);
          ensureOwnerBackupDirectories(dirname(destination), true);
          this.options.assertWriter(); this.options.assertPublicationCurrent();
          atomicWriteSync(destination, bytes.bytes, { mode: 0o600 });
          const stat = lstatSync(file.sourcePath);
          fileStats[file.relPath] = { mtime: stat.mtimeMs, size: bytes.bytes.length };
          if (bytes.proof) resources[file.relPath] = bytes.proof;
          copied++;
        } catch { held.push(file.relPath); }
      }
      let importArchive: OwnerBackupManifest['hostOwner']['importArchive'];
      if (this.options.importPublication) {
        const archive = Buffer.from(JSON.stringify(this.options.importPublication.capture()));
        if (archive.length > 192 * 1024 * 1024) throw new TeamOwnerError('hold');
        this.options.assertPublicationCurrent();
        atomicWriteSync(join(this.options.backupDirectory, 'import-publication.json'), archive, { mode: 0o600 });
        importArchive = { path: 'import-publication.json', sha256: hash(archive) };
      }
      const timestamp = new Date().toISOString();
      const manifest: OwnerBackupManifest = { teamName: this.options.binding.teamName, identityId: this.options.binding.teamId,
        status: 'active', firstBackupAt: previous?.firstBackupAt ?? timestamp, lastBackupAt: timestamp, fileStats,
        hostOwner: { schemaVersion: 1, binding: structuredClone(this.options.binding), resources, held, ...(importArchive ? { importArchive } : {}) } };
      this.options.assertWriter(); this.options.assertPublicationCurrent();
      atomicWriteSync(getBackupManifestPath(this.options.backupDirectory), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      return { copied, held, entry: { teamName: manifest.teamName, identityId: manifest.identityId,
        status: manifest.status, lastBackupAt: manifest.lastBackupAt } };
      });
      await this.options.publishRegistryEntry(result.entry, () => this.options.store.fenced(() => {
        this.options.assertWriter(); this.options.assertPublicationCurrent();
      }));
      return { copied: result.copied, held: result.held };
    });
  }
  async restoreMissing(): Promise<{ restored: number; held: string[] }> {
    return this.options.withIdentityFence(async () => this.options.store.fenced(() => {
      this.options.assertWriter(); this.options.assertPublicationCurrent();
      const manifest = this.manifest();
      if (!manifest || manifest.status !== 'active') return { restored: 0, held: [] };
      let restored = 0;
      const held: string[] = [...manifest.hostOwner.held];
      const imported = manifest.hostOwner.importArchive;
      if (imported) {
        if (imported.path !== 'import-publication.json' || !/^[a-f0-9]{64}$/.test(imported.sha256) || !this.options.importPublication) throw new TeamOwnerError('hold');
        const bytes = readPlain(join(this.options.backupDirectory, imported.path), 192 * 1024 * 1024);
        if (hash(bytes) !== imported.sha256) throw new TeamOwnerError('hold');
        restored += this.options.importPublication.restoreMissing(JSON.parse(bytes.toString('utf8'))).restored;
      }
      // Only hash/owner-qualified product resources restore. Native/launch archives confer no execution rights.
      for (const [relative, proof] of Object.entries(manifest.hostOwner.resources)) {
        try {
          const resource = this.resourcePath(relative);
          if (!resource) { held.push(relative); continue; }
          ensureOwnerBackupDirectories(dirname(join(this.options.backupDirectory, relative)), false);
          const bytes = readPlain(join(this.options.backupDirectory, relative));
          if (hash(bytes) !== proof.sha256) { held.push(relative); continue; }
          this.options.assertWriter(); this.options.assertPublicationCurrent();
          const result = this.resources.restoreMissing(resource, bytes, proof);
          if (result === 'held') held.push(relative); else if (result === 'restored') restored++;
        } catch { held.push(relative); }
      }
      return { restored, held };
    }));
  }
}
