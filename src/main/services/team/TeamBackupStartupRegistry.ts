import * as fs from 'node:fs';
import * as path from 'node:path';

import { readBackupManifestStrict } from './teamBackupManifest';

export interface BackupRegistry {
  version: 1;
  teams: Record<string, BackupRegistryEntry>;
}

export interface BackupRegistryEntry {
  teamName: string;
  identityId: string;
  status: 'active' | 'deleted_by_user';
  deletedByUserAt?: string;
  lastBackupAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validTeamName(name: string): boolean {
  return !!name && name.trim() === name && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
}

/** Strict read for registry publication; discovery is reserved for startup. */
export async function readTeamBackupRegistry(registryPath: string): Promise<BackupRegistry> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(registryPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, teams: {} };
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.teams)) {
    throw new Error('Invalid backup registry shape or version');
  }
  for (const [name, entry] of Object.entries(parsed.teams)) {
    if (
      !validTeamName(name) ||
      !isRecord(entry) ||
      entry.teamName !== name ||
      typeof entry.identityId !== 'string' ||
      !entry.identityId.trim() ||
      entry.identityId !== entry.identityId.trim() ||
      (entry.status !== 'active' && entry.status !== 'deleted_by_user') ||
      typeof entry.lastBackupAt !== 'string' ||
      (entry.deletedByUserAt !== undefined && typeof entry.deletedByUserAt !== 'string')
    ) {
      throw new Error('Invalid backup registry team ownership');
    }
  }
  return parsed as unknown as BackupRegistry;
}

async function quarantineUnownedIncompleteBackupDir(
  backupsBasePath: string,
  teamsDir: string,
  teamName: string
): Promise<void> {
  const source = path.join(teamsDir, teamName);
  const quarantineRoot = path.join(backupsBasePath, 'incomplete-teams');
  try {
    await fs.promises.mkdir(quarantineRoot, { recursive: true });
    await fs.promises.rename(source, path.join(quarantineRoot, `${teamName}-${Date.now()}`));
  } catch {
    // Leave the crash artifact in place. Startup still continues without it.
  }
}

/** An incomplete inventory cannot establish startup readiness. */
export async function loadTeamBackupStartupRegistry(
  backupsBasePath: string
): Promise<BackupRegistry> {
  const registry = await readTeamBackupRegistry(path.join(backupsBasePath, 'registry.json'));
  const teamsDir = path.join(backupsBasePath, 'teams');
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(teamsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return registry;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      if (entry.isSymbolicLink()) throw new Error('Ambiguous backup team directory ownership');
      continue;
    }
    if (!validTeamName(entry.name)) throw new Error('Invalid backup team directory name');
    // Existing registry ownership wins. Its malformed manifest fails locally at restore.
    if (Object.hasOwn(registry.teams, entry.name)) continue;
    const manifest = await readBackupManifestStrict(
      path.join(teamsDir, entry.name, 'manifest.json'),
      entry.name
    );
    if (!manifest) {
      await quarantineUnownedIncompleteBackupDir(backupsBasePath, teamsDir, entry.name);
      continue;
    }
    if (manifest.identityId !== manifest.identityId.trim()) {
      throw new Error('Invalid backup manifest canonical identity');
    }
    Object.defineProperty(registry.teams, entry.name, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: {
        teamName: manifest.teamName,
        identityId: manifest.identityId,
        status: manifest.status,
        ...(manifest.deletedByUserAt ? { deletedByUserAt: manifest.deletedByUserAt } : {}),
        lastBackupAt: manifest.lastBackupAt,
      },
    });
  }
  return registry;
}
