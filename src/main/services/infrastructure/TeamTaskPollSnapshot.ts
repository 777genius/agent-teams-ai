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
import type { PollSnapshotResult } from './CrossPlatformFileChangeSource';

export function isNotFoundError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === 'ENOENT' || code === '2' || code === 2;
}

async function listTeamDirectoryNames(root: string): Promise<string[]> {
  return (await readSnapshotDir(root))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Poll active teams every tick while spreading historical snapshots across ticks. */
export class ChunkedTeamTaskPollSnapshot {
  private cycle: { names: string[]; nextIndex: number } | null = null;

  constructor(
    private readonly root: string,
    private readonly collect: (
      root: string,
      teamNames?: readonly string[]
    ) => Promise<Map<string, string>>,
    private readonly maxTeamsPerTick = 64
  ) {}

  async snapshot(
    baselineReady: boolean,
    priorityTeams: ReadonlySet<string> | null
  ): Promise<PollSnapshotResult> {
    if (!baselineReady) {
      this.cycle = null;
      return { files: await this.collect(this.root), cycleComplete: true, deleteSafe: true };
    }

    const available = new Set(await listTeamDirectoryNames(this.root));
    const cycle = this.cycle ?? { names: [...available], nextIndex: 0 };
    const end = Math.min(cycle.nextIndex + this.maxTeamsPerTick, cycle.names.length);
    const names = new Set(
      cycle.names.slice(cycle.nextIndex, end).filter((name) => available.has(name))
    );
    for (const name of priorityTeams ?? []) {
      if (available.has(name)) names.add(name);
    }

    // Do not advance after a failed read. The next partial snapshot must
    // inspect the missing slice before it can report deleted files.
    const files = await this.collect(this.root, [...names]);
    cycle.nextIndex = end;
    const cycleComplete = end === cycle.names.length;
    this.cycle = cycleComplete ? null : cycle;
    return { files, cycleComplete, deleteSafe: cycleComplete };
  }
}

export async function collectTeamsPollSnapshot(
  teamsPath: string,
  teamNames?: readonly string[]
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const names = teamNames ?? (await listTeamDirectoryNames(teamsPath));

  // Fallback polling mirrors TeamTaskWatchRegistry. Do not recurse into members,
  // runtime, .opencode-runtime, logs, or other deep trees from here.
  for (const teamName of names) {
    const teamPath = path.join(teamsPath, teamName);
    await collectPolledDirectoryFiles(
      snapshot,
      teamPath,
      teamName,
      (fileName) => fileName.endsWith('.json'),
      { missingAsEmpty: teamNames !== undefined }
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

export async function collectTasksPollSnapshot(
  tasksPath: string,
  teamNames?: readonly string[]
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const names = teamNames ?? (await listTeamDirectoryNames(tasksPath));

  // Keep task fallback scoped to tasks/<team>/*.json. Hidden files and nested
  // runtime directories are intentionally outside the public team-change surface.
  for (const teamName of names) {
    await collectPolledDirectoryFiles(
      snapshot,
      path.join(tasksPath, teamName),
      teamName,
      (fileName) => !fileName.startsWith('.') && fileName.endsWith('.json'),
      { missingAsEmpty: teamNames !== undefined }
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
