import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { digest } from '../team/identity.js';
import { TeamOwnerError } from '../team/contracts.js';
import { plainImportAncestors, readImportBytes, safeImportPath } from './snapshot.js';
import type { TeamBinding } from '../team/contracts.js';
import type { TeamPermanentDeletionIntent } from '../adapters/lifecycle/TeamPermanentDeletionTypes.js';

interface PublicationFile { path: string; base64: string; sha256: string }
export interface ImportedPublicationArchive {
  schemaVersion: 1; binding: TeamBinding; commandId: string; sourceId: string; snapshotDigest: string;
  files: PublicationFile[];
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const hold = (): never => { throw new TeamOwnerError('hold'); };
/** Only original immutable import files; product/control state is owned and backed up elsewhere. */
export function createImportPublication(options: {
  root: string; binding: TeamBinding; commandId: string; sourceId: string; snapshotDigest: string;
  files: readonly PublicationFile[]; assertCurrent(): void;
  withTeamFence<T>(operation: () => T): T;
}) {
  const teamPath = join(options.root, 'teams', options.binding.teamName);
  const namespace = lstatSync(teamPath);
  if (!namespace.isDirectory() || namespace.isSymbolicLink()) hold();
  const prefix = `teams/${options.binding.teamName}/.host-owner/import/`;
  const files = options.files.filter(file => file.path.startsWith(prefix)).map(file => ({ ...file, path: safeImportPath(file.path) }));
  if (!files.length || files.length > 4096 || new Set(files.map(file => file.path)).size !== files.length) hold();
  const expected: ImportedPublicationArchive = { schemaVersion: 1, binding: structuredClone(options.binding),
    commandId: options.commandId, sourceId: options.sourceId, snapshotDigest: options.snapshotDigest, files };
  function current(): void {
    options.assertCurrent(); plainImportAncestors(teamPath);
    const value = lstatSync(teamPath);
    if (value.dev !== namespace.dev || value.ino !== namespace.ino || value.birthtimeMs !== namespace.birthtimeMs) hold();
  }
  function census(): void {
    const seen = new Set<string>();
    const walk = (directory: string) => {
      plainImportAncestors(directory);
      for (const name of readdirSync(directory)) {
        const path = join(directory, name), info = lstatSync(path);
        if (info.isSymbolicLink()) hold();
        if (info.isDirectory()) walk(path);
        else if (info.isFile()) seen.add(path.slice(options.root.length + 1));
        else hold();
      }
    };
    walk(join(options.root, prefix.slice(0, -1)));
    if (seen.size !== files.length || files.some(file => !seen.has(file.path))) hold();
  }
  function capture(): ImportedPublicationArchive {
    return options.withTeamFence(() => {
      current(); census();
      for (const file of files) if (hash(readImportBytes(join(options.root, file.path), 20 * 1024 * 1024)) !== file.sha256) hold();
      current(); return structuredClone(expected);
    });
  }
  function ensure(directory: string): void {
    if (directory === teamPath) { plainImportAncestors(directory); return; }
    ensure(dirname(directory));
    try { const info = lstatSync(directory); if (!info.isDirectory() || info.isSymbolicLink()) hold(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; current(); mkdirSync(directory, { mode: 0o700 }); }
  }
  return {
    capture,
    restoreMissing(raw: unknown): { restored: number } {
      return options.withTeamFence(() => {
        current();
        if (digest(raw) !== digest(expected)) hold();
        let restored = 0;
        for (const file of files) {
          const path = join(options.root, file.path), bytes = Buffer.from(file.base64, 'base64');
          if (hash(bytes) !== file.sha256) hold();
          ensure(dirname(path));
          try { if (hash(readImportBytes(path, 20 * 1024 * 1024)) !== file.sha256) hold(); continue; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const candidate = join(dirname(path), `.import-restore-${randomUUID()}`), fd = openSync(candidate, 'wx', 0o600);
          try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
          try { current(); linkSync(candidate, path); restored++; }
          finally { unlinkSync(candidate); }
          const directory = openSync(dirname(path), 'r');
          try { fsyncSync(directory); } finally { closeSync(directory); }
        }
        census(); current(); return { restored };
      });
    },
    /** Original team-data detach/removal proof owns physical deletion; no separate unlink of private control trees. */
    assertRemovalCovered(intent: TeamPermanentDeletionIntent): void {
      options.withTeamFence(() => {
        current();
        const target = intent.targets['team-data'];
        if (intent.teamName !== options.binding.teamName || intent.identityId !== options.binding.teamId ||
          target.status !== 'present' || target.identity.dev !== namespace.dev || target.identity.ino !== namespace.ino ||
          target.identity.birthtimeMs !== namespace.birthtimeMs) hold();
        capture();
      });
    },
  };
}
