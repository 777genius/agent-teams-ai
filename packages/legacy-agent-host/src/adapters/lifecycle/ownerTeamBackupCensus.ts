import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { collectRecursiveFilesSync } from './TeamBackupFileCollection.js';
import { assertSafeTeamName } from './TeamPermanentDeletionTypes.js';
import type { BackupFileDescriptor } from './TeamBackupFileCollection.js';
import type { LifecycleDirectories } from './lifecycleRoots.js';

/** Existing Desktop backup product census; private Host control/checkpoint/profile roots are excluded. */
export const TEAM_ROOT_FILES = ['config.json', 'team.meta.json', 'launch-state.json', 'launch-summary.json',
  'launch-stopped.json', 'kanban-state.json', 'sentMessages.json', 'sent-cross-team.json', 'members.meta.json', 'comment-notification-journal.json'];
export const TEAM_SUBDIRS = ['inboxes', 'review-decisions'];
export const TEAM_RECURSIVE_SUBDIRS = ['.opencode-runtime', 'members', '.member-work-sync'];
export const APP_DATA_SUBDIRS = ['attachments'];
export const APP_DATA_DEEP_SUBDIRS = ['task-attachments'];
export function collectOwnerTeamBackupFiles(roots: LifecycleDirectories, teamName: string): { files: BackupFileDescriptor[]; hasErrors: boolean } {
  assertSafeTeamName(teamName);
  const files: BackupFileDescriptor[] = [];
  let hasErrors = false;
  function attempt(action: () => void): void {
    try { action(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') hasErrors = true; }
  }
  function flat(directory: string, prefix: string, jsonOnly: boolean): void {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe backup directory');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Unsafe backup file');
      if (entry.isFile() && (!jsonOnly || entry.name.endsWith('.json'))) files.push({ sourcePath: join(directory, entry.name), relPath: `${prefix}/${entry.name}` });
    }
  }
  const team = join(roots.teams, teamName);
  for (const name of TEAM_ROOT_FILES) attempt(() => {
    const sourcePath = join(team, name), stat = lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe backup root file');
    files.push({ sourcePath, relPath: name });
  });
  for (const name of TEAM_SUBDIRS) attempt(() => flat(join(team, name), name, true));
  for (const name of TEAM_RECURSIVE_SUBDIRS) attempt(() => {
    const directory = join(team, name), stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe backup subtree');
    files.push(...collectRecursiveFilesSync(directory, name));
  });
  for (const name of APP_DATA_SUBDIRS) attempt(() => flat(join(roots.appData, name, teamName), name, false));
  for (const name of APP_DATA_DEEP_SUBDIRS) attempt(() => {
    const parent = join(roots.appData, name, teamName), stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe attachment subtree');
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Unsafe task attachment');
      if (entry.isDirectory()) attempt(() => flat(join(parent, entry.name), `${name}/${entry.name}`, false));
    }
  });
  attempt(() => flat(join(roots.tasks, teamName), 'tasks', true));
  return { files, hasErrors };
}
