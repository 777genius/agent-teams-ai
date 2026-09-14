import { getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { renamePathWithRetry } from './atomicWrite';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamTaskReader } from './TeamTaskReader';

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Rename a draft team (team.meta.json without config.json) so the final create
 * uses the final team name for the directory.
 *
 * Drafts only: once config.json exists the directory name is the team's runtime
 * identity and must not change. The tasks directory moves with the team
 * directory, and a failure to move it rolls the team directory back so the
 * draft is never left split across two names.
 */
export async function renameDraftTeamDirectory(
  oldTeamName: string,
  newTeamName: string
): Promise<void> {
  if (oldTeamName === newTeamName) {
    return;
  }

  const oldTeamDir = path.join(getTeamsBasePath(), oldTeamName);
  const newTeamDir = path.join(getTeamsBasePath(), newTeamName);
  const oldTasksDir = path.join(getTasksBasePath(), oldTeamName);
  const newTasksDir = path.join(getTasksBasePath(), newTeamName);

  if (!(await pathExists(oldTeamDir))) {
    throw new Error(`Team not found: ${oldTeamName}`);
  }
  if (await pathExists(path.join(oldTeamDir, 'config.json'))) {
    throw new Error(`Cannot rename non-draft team: ${oldTeamName}`);
  }
  if ((await pathExists(newTeamDir)) || (await pathExists(newTasksDir))) {
    throw new Error(`Team already exists: ${newTeamName}`);
  }

  await renamePathWithRetry(oldTeamDir, newTeamDir);
  try {
    if (await pathExists(oldTasksDir)) {
      await renamePathWithRetry(oldTasksDir, newTasksDir);
    }
  } catch (error) {
    await renamePathWithRetry(newTeamDir, oldTeamDir).catch(() => undefined);
    throw error;
  }

  TeamConfigReader.invalidateTeam(oldTeamName);
  TeamConfigReader.invalidateTeam(newTeamName);
  TeamConfigReader.invalidateListTeamsCache();
  TeamTaskReader.invalidateAllTasksCache();
}
