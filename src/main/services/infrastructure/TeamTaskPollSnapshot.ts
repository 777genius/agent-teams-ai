/**
 * Fallback poll snapshots for the teams and tasks watch roots.
 *
 * FileWatcher falls back to polling when the OS watcher hits its limits. These
 * helpers build the `path -> stat fingerprint` maps that the fallback compares
 * between ticks, deliberately scoped to `teams/<team>/*.json`,
 * `teams/<team>/inboxes/*.json` and `tasks/<team>/*.json`.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';

import type { Dirent } from 'fs';

export function isNotFoundError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === 'ENOENT' || code === '2' || code === 2;
}

export async function collectTeamsPollSnapshot(teamsPath: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const teamEntries = await readSnapshotDir(teamsPath);

  // Fallback polling mirrors TeamTaskWatchRegistry. Do not recurse into members,
  // runtime, .opencode-runtime, logs, or other deep trees from here.
  for (const teamEntry of teamEntries) {
    if (!teamEntry.isDirectory()) {
      continue;
    }

    const teamName = teamEntry.name;
    const teamPath = path.join(teamsPath, teamName);
    await collectPolledDirectoryFiles(
      snapshot,
      teamPath,
      teamName,
      (fileName) => fileName.endsWith('.json'),
      { missingAsEmpty: false }
    );

    await collectPolledDirectoryFiles(
      snapshot,
      path.join(teamPath, 'inboxes'),
      `${teamName}/inboxes`,
      (fileName) => fileName.endsWith('.json'),
      { missingAsEmpty: true }
    );
  }

  return snapshot;
}

export async function collectTasksPollSnapshot(tasksPath: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const teamEntries = await readSnapshotDir(tasksPath);

  // Keep task fallback scoped to tasks/<team>/*.json. Hidden files and nested
  // runtime directories are intentionally outside the public team-change surface.
  for (const teamEntry of teamEntries) {
    if (!teamEntry.isDirectory()) {
      continue;
    }

    const teamName = teamEntry.name;
    await collectPolledDirectoryFiles(
      snapshot,
      path.join(tasksPath, teamName),
      teamName,
      (fileName) => !fileName.startsWith('.') && fileName.endsWith('.json'),
      { missingAsEmpty: false }
    );
  }

  return snapshot;
}

async function collectPolledDirectoryFiles(
  snapshot: Map<string, string>,
  dirPath: string,
  relativeRoot: string,
  shouldInclude: (fileName: string) => boolean,
  options: { missingAsEmpty?: boolean } = {}
): Promise<void> {
  const entries = await readSnapshotDir(dirPath, options);
  for (const entry of entries) {
    if (!entry.isFile() || !shouldInclude(entry.name)) {
      continue;
    }
    await addPolledFile(snapshot, path.join(dirPath, entry.name), `${relativeRoot}/${entry.name}`);
  }
}

async function addPolledFile(
  snapshot: Map<string, string>,
  absolutePath: string,
  relativePath: string
): Promise<void> {
  const stats = await fsp.stat(absolutePath);
  if (!stats.isFile()) {
    return;
  }
  snapshot.set(
    relativePath,
    `${stats.dev}:${stats.ino}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`
  );
}

async function readSnapshotDir(
  dirPath: string,
  options: { missingAsEmpty?: boolean } = {}
): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error) && options.missingAsEmpty) {
      return [];
    }
    throw error;
  }
}
