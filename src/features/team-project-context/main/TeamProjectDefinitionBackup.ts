import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  readTeamOwnerProfileScope,
  resolveThisAppProfileScope,
  TEAM_PROFILE_OWNER_MARKER_FILE,
} from '@main/services/team/provisioning/TeamProvisioningProfileOwnership';
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import {
  getBackupsBasePath,
  getTasksBasePath,
  getTeamsBasePath,
} from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('TeamProjectDefinitionBackup');
const FILES = ['team.meta.json', 'members.meta.json', TEAM_PROFILE_OWNER_MARKER_FILE] as const;
const CONTEXT_INDEX = 'project-contexts.json';
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const SAFE_ALIAS_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

interface DefinitionSnapshot {
  version: 1;
  teamName: string;
  profileScope: string;
  files: Record<string, { sha256: string; content: string }>;
}

function checkedName(value: string): string {
  const validation = validateTeamName(value);
  if (!validation.valid || validation.value !== value) {
    throw new Error('Unsafe logical team backup identifier');
  }
  return value;
}

function backupFilePath(teamName: string): string {
  return path.join(getBackupsBasePath(), 'project-team-definitions', checkedName(teamName) + '.json');
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readRegularJson(target: string): Promise<string> {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_BYTES) {
    throw new Error('Unsafe project team backup source');
  }
  const value = await fs.readFile(target, 'utf8');
  if (Buffer.byteLength(value, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('Project team backup source too large');
  }
  JSON.parse(value);
  return value;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function verifiedSnapshot(value: unknown, teamName: string): DefinitionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid project team definition backup');
  }
  const parsed = value as DefinitionSnapshot;
  if (parsed.version !== 1 || parsed.teamName !== teamName ||
      parsed.profileScope !== resolveThisAppProfileScope() ||
      !parsed.files || typeof parsed.files !== 'object') {
    throw new Error('Project team backup is not owned by this profile');
  }
  for (const fileName of FILES) {
    const item = parsed.files[fileName];
    if (!item || typeof item.content !== 'string' || digest(item.content) !== item.sha256 ||
        Buffer.byteLength(item.content, 'utf8') > MAX_FILE_BYTES) {
      throw new Error('Invalid project team backup integrity');
    }
    JSON.parse(item.content);
  }
  const index = parsed.files[CONTEXT_INDEX];
  if (index) {
    if (typeof index.content !== 'string' || digest(index.content) !== index.sha256 ||
        Buffer.byteLength(index.content, 'utf8') > MAX_FILE_BYTES) {
      throw new Error('Invalid project-context backup index integrity');
    }
    const parsedIndex = JSON.parse(index.content) as {
      version?: unknown; logicalTeamName?: unknown; contexts?: unknown;
    };
    if (parsedIndex.version !== 1 || parsedIndex.logicalTeamName !== teamName ||
        !Array.isArray(parsedIndex.contexts)) {
      throw new Error('Project-context backup identity mismatch');
    }
  }
  const owner = JSON.parse(parsed.files[TEAM_PROFILE_OWNER_MARKER_FILE].content) as {
    schemaVersion?: unknown; profileScope?: unknown;
  };
  if (owner.schemaVersion !== 1 || owner.profileScope !== parsed.profileScope) {
    throw new Error('Project team backup owner marker mismatch');
  }
  return parsed;
}

/**
 * Config-less logical teams are skipped by the native TeamBackupService.
 * Capture their small, app-owned definition only; each physical context uses
 * the existing native backup pipeline for its task/chat artifacts.
 */
export async function backupProjectTeamDefinition(teamName: string): Promise<boolean> {
  checkedName(teamName);
  const dir = path.join(getTeamsBasePath(), teamName);
  if (await readTeamOwnerProfileScope(dir) !== resolveThisAppProfileScope()) return false;
  if (await exists(path.join(dir, 'config.json'))) return false;

  const fileNames: string[] = [...FILES];
  const indexPath = path.join(dir, CONTEXT_INDEX);
  const hasIndex = await exists(indexPath);
  if (hasIndex) fileNames.push(CONTEXT_INDEX);
  const rawFiles = await Promise.all(fileNames.map(async (name) => [
    name, await readRegularJson(path.join(dir, name)),
  ] as const));
  const meta = JSON.parse(rawFiles.find(([n]) => n === 'team.meta.json')![1]) as {
    version?: unknown; projectContextMode?: unknown;
  };
  if (meta.version !== 1 || (meta.projectContextMode !== 'per_project' && !hasIndex)) {
    return false;
  }
  const files = Object.fromEntries(rawFiles.map(([name, content]) => [
    name, { sha256: digest(content), content },
  ]));
  const snapshot: DefinitionSnapshot = {
    version: 1, teamName, profileScope: resolveThisAppProfileScope(), files,
  };
  const contents = JSON.stringify(snapshot);
  if (Buffer.byteLength(contents, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new Error('Project team definition backup too large');
  }
  await atomicWriteAsync(backupFilePath(teamName), contents + '\n', {
    mode: 0o600, directoryMode: 0o700,
  });
  return true;
}

/** A broken logical draft must not stop backups of unrelated teams. */
export async function backupProjectTeamDefinitionSafely(teamName: string): Promise<void> {
  try {
    await backupProjectTeamDefinition(teamName);
  } catch (error) {
    logger.warn(`[Backup] definition backup skipped for ${teamName}: ${String(error)}`);
  }
}

async function readSnapshot(teamName: string): Promise<DefinitionSnapshot | null> {
  const file = backupFilePath(teamName);
  if (!(await exists(file))) return null;
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) {
    throw new Error('Unsafe project team definition backup');
  }
  const contents = await fs.readFile(file, 'utf8');
  return verifiedSnapshot(JSON.parse(contents) as unknown, teamName);
}

/** Explicitly recover only an absent logical directory with verified owned aliases. */
export async function recoverMissingProjectTeamDefinition(teamName: string): Promise<boolean> {
  checkedName(teamName);
  const snapshot = await readSnapshot(teamName);
  if (!snapshot) return false;
  const targetDir = path.join(getTeamsBasePath(), teamName);
  if (await exists(targetDir) || await exists(path.join(getTasksBasePath(), teamName))) return false;
  const index = snapshot.files[CONTEXT_INDEX];
  // Never resurrect an intentionally deleted empty team from a stale backup.
  if (!index) return false;
  const parsed = JSON.parse(index.content) as {
    deleting?: boolean; softDeleting?: boolean;
    contexts: { executionTeamName?: unknown; state?: unknown }[];
  };
  if (parsed.deleting || parsed.softDeleting) return false;
  if (parsed.contexts.length === 0) return false;
  for (const row of parsed.contexts) {
    const alias = row.executionTeamName;
    if (typeof alias !== 'string' || !SAFE_ALIAS_NAME.test(alias) || alias === teamName ||
        row.state !== 'ready') return false;
    const aliasDir = path.join(getTeamsBasePath(), alias);
    if (await readTeamOwnerProfileScope(aliasDir) !== snapshot.profileScope) return false;
    if (!(await exists(path.join(aliasDir, 'config.json')))) return false;
  }
  const teamsRoot = getTeamsBasePath();
  await fs.mkdir(teamsRoot, { recursive: true, mode: 0o700 });
  const staged = path.join(teamsRoot, '.project-restore-' + randomUUID());
  const tasksDir = path.join(getTasksBasePath(), teamName);
  const installed: string[] = [];
  let claimedTarget = false;
  let claimedTasks = false;
  await fs.mkdir(staged, { mode: 0o700 });
  try {
    for (const [name, record] of Object.entries(snapshot.files)) {
      if (![...FILES, CONTEXT_INDEX].includes(name as typeof CONTEXT_INDEX)) {
        throw new Error('Unexpected project team backup file');
      }
      await fs.writeFile(path.join(staged, name), record.content, {
        mode: 0o600, flag: 'wx',
      });
    }
    // An existence check followed by rename could REPLACE another process's
    // newly created empty directory on Linux. Claim the name exclusively.
    try {
      await fs.mkdir(targetDir, { mode: 0o700 });
      claimedTarget = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    await fs.mkdir(getTasksBasePath(), { recursive: true, mode: 0o700 });
    await fs.mkdir(tasksDir, { mode: 0o700 });
    claimedTasks = true;
    // Publish ownership last. Until then an incomplete restored definition is
    // not recognized as profile-owned by background file watchers.
    const ownerName = TEAM_PROFILE_OWNER_MARKER_FILE;
    for (const name of Object.keys(snapshot.files).filter((value) => value !== ownerName)) {
      await fs.rename(path.join(staged, name), path.join(targetDir, name));
      installed.push(name);
    }
    await fs.rename(path.join(staged, ownerName), path.join(targetDir, ownerName));
    return true;
  } catch (error) {
    // Roll back only files this recovery wrote. Never recursively delete a
    // directory another process might have started to use.
    if (claimedTarget) {
      for (const name of installed) {
        const dest = path.join(targetDir, name);
        if ((await fs.readFile(dest, 'utf8').catch(() => null)) === snapshot.files[name]?.content) {
          await fs.unlink(dest).catch(() => undefined);
        }
      }
      await fs.rmdir(targetDir).catch(() => undefined);
    }
    if (claimedTasks) await fs.rmdir(tasksDir).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(staged, { recursive: true, force: true });
  }
}

/** Recovery is restricted to backups of this same profile and with live aliases. */
export async function recoverMissingProjectTeamDefinitions(): Promise<number> {
  const root = path.join(getBackupsBasePath(), 'project-team-definitions');
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let recovered = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const teamName = name.slice(0, -5);
    if (!validateTeamName(teamName).valid) continue;
    try {
      if (await recoverMissingProjectTeamDefinition(teamName)) recovered++;
    } catch {
      // An invalid or foreign backup is never an authority to touch live data.
    }
  }
  if (recovered > 0) logger.info(`[Backup] Recovered ${recovered} project-team definitions`);
  return recovered;
}
