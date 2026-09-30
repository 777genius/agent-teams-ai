import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  getAppDataPath,
  getTasksBasePath,
  getTeamsBasePath,
} from '@main/utils/pathDecoder';

import {
  type BackupFileDescriptor,
  collectRecursiveFiles,
  collectRecursiveFilesSync,
} from './TeamBackupFileCollection';
import { TEAM_LAUNCH_STOPPED_MARKER_FILE } from './TeamLaunchStateStore';

const TEAM_ROOT_FILES = [
  'config.json',
  'team.meta.json',
  'launch-state.json',
  'launch-summary.json',
  TEAM_LAUNCH_STOPPED_MARKER_FILE,
  'kanban-state.json',
  'sentMessages.json',
  'sent-cross-team.json',
  'members.meta.json',
  'comment-notification-journal.json',
];

// Subdirs under ~/.claude/teams/{teamName}/
const TEAM_SUBDIRS = ['inboxes', 'review-decisions'];
const TEAM_RECURSIVE_SUBDIRS = ['.opencode-runtime', 'members'];
// Subdirs under getAppDataPath() (our own storage, not in ~/.claude/)
const APP_DATA_SUBDIRS = ['attachments'];
const APP_DATA_DEEP_SUBDIRS = ['task-attachments'];

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export async function enumerateTeamFilesWithErrors(
  teamName: string
): Promise<{ files: BackupFileDescriptor[]; hasErrors: boolean }> {
  const files: BackupFileDescriptor[] = [];
  let hasErrors = false;
  const teamDir = path.join(getTeamsBasePath(), teamName);
  const tasksDir = path.join(getTasksBasePath(), teamName);

  for (const fileName of TEAM_ROOT_FILES) {
    const sourcePath = path.join(teamDir, fileName);
    try {
      const stat = await fs.promises.stat(sourcePath);
      if (stat.isFile()) files.push({ sourcePath, relPath: fileName });
    } catch (error: unknown) {
      if (!isEnoent(error)) hasErrors = true;
    }
  }

  for (const subdir of TEAM_SUBDIRS) {
    const dirPath = path.join(teamDir, subdir);
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.json')) {
          files.push({
            sourcePath: path.join(dirPath, entry.name),
            relPath: `${subdir}/${entry.name}`,
          });
        }
      }
    } catch (error: unknown) {
      if (!isEnoent(error)) hasErrors = true;
    }
  }

  for (const subdir of TEAM_RECURSIVE_SUBDIRS) {
    const dirPath = path.join(teamDir, subdir);
    try {
      files.push(...(await collectRecursiveFiles(dirPath, subdir)));
    } catch (error: unknown) {
      if (!isEnoent(error)) hasErrors = true;
    }
  }

  const appDataDir = getAppDataPath();
  for (const subdir of APP_DATA_SUBDIRS) {
    const dirPath = path.join(appDataDir, subdir, teamName);
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          files.push({
            sourcePath: path.join(dirPath, entry.name),
            relPath: `${subdir}/${entry.name}`,
          });
        }
      }
    } catch (error: unknown) {
      if (!isEnoent(error)) hasErrors = true;
    }
  }

  for (const subdir of APP_DATA_DEEP_SUBDIRS) {
    const dirPath = path.join(appDataDir, subdir, teamName);
    try {
      const taskDirs = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const taskDir of taskDirs) {
        if (!taskDir.isDirectory()) continue;
        const taskDirPath = path.join(dirPath, taskDir.name);
        try {
          const attachments = await fs.promises.readdir(taskDirPath, { withFileTypes: true });
          for (const attachment of attachments) {
            if (attachment.isFile()) {
              files.push({
                sourcePath: path.join(taskDirPath, attachment.name),
                relPath: `${subdir}/${taskDir.name}/${attachment.name}`,
              });
            }
          }
        } catch (error: unknown) {
          if (!isEnoent(error)) hasErrors = true;
        }
      }
    } catch (error: unknown) {
      if (!isEnoent(error)) hasErrors = true;
    }
  }

  try {
    const entries = await fs.promises.readdir(tasksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push({
          sourcePath: path.join(tasksDir, entry.name),
          relPath: `tasks/${entry.name}`,
        });
      }
      // Skip _internal/ directory.
    }
  } catch (error: unknown) {
    if (!isEnoent(error)) hasErrors = true;
  }

  return { files, hasErrors };
}

export function enumerateTeamFilesSync(teamName: string): BackupFileDescriptor[] {
  const files: BackupFileDescriptor[] = [];
  const teamDir = path.join(getTeamsBasePath(), teamName);
  const tasksDir = path.join(getTasksBasePath(), teamName);

  for (const fileName of TEAM_ROOT_FILES) {
    const sourcePath = path.join(teamDir, fileName);
    try {
      const stat = fs.statSync(sourcePath);
      if (stat.isFile()) files.push({ sourcePath, relPath: fileName });
    } catch {
      // skip
    }
  }

  for (const subdir of TEAM_SUBDIRS) {
    try {
      const entries = fs.readdirSync(path.join(teamDir, subdir), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.json')) {
          files.push({
            sourcePath: path.join(teamDir, subdir, entry.name),
            relPath: `${subdir}/${entry.name}`,
          });
        }
      }
    } catch {
      // skip
    }
  }

  for (const subdir of TEAM_RECURSIVE_SUBDIRS) {
    try {
      files.push(...collectRecursiveFilesSync(path.join(teamDir, subdir), subdir));
    } catch {
      // skip
    }
  }

  const appDataDir = getAppDataPath();
  for (const subdir of APP_DATA_SUBDIRS) {
    try {
      const entries = fs.readdirSync(path.join(appDataDir, subdir, teamName), {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.isFile()) {
          files.push({
            sourcePath: path.join(appDataDir, subdir, teamName, entry.name),
            relPath: `${subdir}/${entry.name}`,
          });
        }
      }
    } catch {
      // skip
    }
  }

  for (const subdir of APP_DATA_DEEP_SUBDIRS) {
    try {
      const taskDirs = fs.readdirSync(path.join(appDataDir, subdir, teamName), {
        withFileTypes: true,
      });
      for (const taskDir of taskDirs) {
        if (!taskDir.isDirectory()) continue;
        try {
          const attachments = fs.readdirSync(
            path.join(appDataDir, subdir, teamName, taskDir.name),
            { withFileTypes: true }
          );
          for (const attachment of attachments) {
            if (attachment.isFile()) {
              files.push({
                sourcePath: path.join(
                  appDataDir,
                  subdir,
                  teamName,
                  taskDir.name,
                  attachment.name
                ),
                relPath: `${subdir}/${taskDir.name}/${attachment.name}`,
              });
            }
          }
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }

  try {
    const entries = fs.readdirSync(tasksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push({
          sourcePath: path.join(tasksDir, entry.name),
          relPath: `tasks/${entry.name}`,
        });
      }
    }
  } catch {
    // skip
  }

  return files;
}

export async function enumerateBackupFiles(backupDir: string): Promise<string[]> {
  const results: string[] = [];

  const walk = async (dir: string, prefix: string): Promise<void> => {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isFile()) {
          results.push(relPath);
        } else if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name), relPath);
        }
      }
    } catch {
      // skip
    }
  };

  await walk(backupDir, '');
  return results;
}

export function getBackupSourcePath(teamName: string, relPath: string): string {
  if (relPath.startsWith('tasks/')) {
    return path.join(getTasksBasePath(), teamName, relPath.slice('tasks/'.length));
  }
  if (relPath.startsWith('attachments/')) {
    return path.join(
      getAppDataPath(),
      'attachments',
      teamName,
      relPath.slice('attachments/'.length)
    );
  }
  if (relPath.startsWith('task-attachments/')) {
    return path.join(
      getAppDataPath(),
      'task-attachments',
      teamName,
      relPath.slice('task-attachments/'.length)
    );
  }
  return path.join(getTeamsBasePath(), teamName, relPath);
}
