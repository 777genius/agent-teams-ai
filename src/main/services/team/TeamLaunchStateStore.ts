import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';
import { normalizePersistedLaunchSnapshot } from './TeamLaunchStateEvaluator';
import {
  createPersistedLaunchSummaryProjection,
  TEAM_LAUNCH_SUMMARY_FILE,
} from './TeamLaunchSummaryProjection';

import type { PersistedTeamLaunchSnapshot } from '@shared/types';

const logger = createLogger('Service:TeamLaunchStateStore');
const TEAM_LAUNCH_STATE_FILE = 'launch-state.json';
const MAX_LAUNCH_STATE_BYTES = 256 * 1024;

export function getTeamLaunchStatePath(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, TEAM_LAUNCH_STATE_FILE);
}

export function getTeamLaunchSummaryPath(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, TEAM_LAUNCH_SUMMARY_FILE);
}

async function isMissingTeamDirectoryWriteRace(
  targetPath: string,
  error: unknown
): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== 'ENOENT' && code !== 'EINVAL') {
    return false;
  }
  const targetDir = path.dirname(targetPath);
  const errorPaths = [
    (error as NodeJS.ErrnoException).path,
    (error as NodeJS.ErrnoException & { dest?: string }).dest,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (code === 'ENOENT' && errorPaths.some((errorPath) => path.dirname(errorPath) === targetDir)) {
    return true;
  }
  try {
    await fs.promises.access(targetDir);
    return false;
  } catch {
    return true;
  }
}

export class TeamLaunchStateStore {
  async read(teamName: string): Promise<PersistedTeamLaunchSnapshot | null> {
    const targetPath = getTeamLaunchStatePath(teamName);
    try {
      const stat = await fs.promises.stat(targetPath);
      if (!stat.isFile() || stat.size > MAX_LAUNCH_STATE_BYTES) {
        return null;
      }
      const raw = await fs.promises.readFile(targetPath, 'utf8');
      return normalizePersistedLaunchSnapshot(teamName, JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async write(teamName: string, snapshot: PersistedTeamLaunchSnapshot): Promise<void> {
    const launchStatePath = getTeamLaunchStatePath(teamName);
    const launchSummaryPath = getTeamLaunchSummaryPath(teamName);
    try {
      await atomicWriteAsync(launchStatePath, `${JSON.stringify(snapshot, null, 2)}\n`);
      await atomicWriteAsync(
        launchSummaryPath,
        `${JSON.stringify(createPersistedLaunchSummaryProjection(snapshot), null, 2)}\n`
      );
    } catch (error) {
      if (await isMissingTeamDirectoryWriteRace(launchStatePath, error)) {
        return;
      }
      logger.warn(
        `[${teamName}] Failed to persist launch-state: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }
  }

  async clear(teamName: string): Promise<void> {
    try {
      await fs.promises.rm(getTeamLaunchStatePath(teamName), { force: true });
      await fs.promises.rm(getTeamLaunchSummaryPath(teamName), { force: true });
    } catch {
      // best-effort
    }
  }
}
