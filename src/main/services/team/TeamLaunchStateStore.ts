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
const publicationQueueByTeam = new Map<string, Promise<void>>();

export class UnsupportedTeamLaunchStateVersionError extends Error {
  constructor(readonly version: unknown) {
    super(`Unsupported launch-state version: ${String(version)}`);
    this.name = 'UnsupportedTeamLaunchStateVersionError';
  }
}

export class CorruptTeamLaunchStateError extends Error {
  constructor(cause?: unknown) {
    super(
      'Existing launch-state metadata is malformed',
      cause === undefined ? undefined : { cause }
    );
    this.name = 'CorruptTeamLaunchStateError';
  }
}

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
  try {
    await fs.promises.access(targetDir);
    return false;
  } catch (accessError) {
    return (accessError as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function enqueuePublication(teamName: string, operation: () => Promise<void>): Promise<void> {
  const previous = publicationQueueByTeam.get(teamName);
  const queued = (previous ?? Promise.resolve()).catch(() => undefined).then(operation);
  publicationQueueByTeam.set(teamName, queued);
  return queued.finally(() => {
    if (publicationQueueByTeam.get(teamName) === queued) {
      publicationQueueByTeam.delete(teamName);
    }
  });
}

function assertSupportedLaunchStateVersion(parsed: unknown): void {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CorruptTeamLaunchStateError();
  }
  const version = (parsed as { version?: unknown }).version;
  if (version !== undefined && version !== 1 && version !== 2 && version !== 3) {
    throw new UnsupportedTeamLaunchStateVersionError(version);
  }
}

async function assertSupportedLaunchStateVersionForMutation(targetPath: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(targetPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CorruptTeamLaunchStateError(error);
  }
  assertSupportedLaunchStateVersion(parsed);
}

export class TeamLaunchStateStore {
  async assertMutable(teamName: string): Promise<void> {
    await assertSupportedLaunchStateVersionForMutation(getTeamLaunchStatePath(teamName));
  }

  async read(teamName: string): Promise<PersistedTeamLaunchSnapshot | null> {
    const targetPath = getTeamLaunchStatePath(teamName);
    try {
      const stat = await fs.promises.stat(targetPath);
      if (!stat.isFile() || stat.size > MAX_LAUNCH_STATE_BYTES) {
        return null;
      }
      const raw = await fs.promises.readFile(targetPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      assertSupportedLaunchStateVersion(parsed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (
          (record.version === 2 || record.version === 3) &&
          (typeof record.teamName !== 'string' || record.teamName.trim() !== teamName)
        ) {
          return null;
        }
      }
      return normalizePersistedLaunchSnapshot(teamName, parsed);
    } catch (error) {
      if (error instanceof UnsupportedTeamLaunchStateVersionError) throw error;
      return null;
    }
  }

  async write(teamName: string, snapshot: PersistedTeamLaunchSnapshot): Promise<void> {
    await enqueuePublication(teamName, () => this.writeNow(teamName, snapshot));
  }

  private async writeNow(teamName: string, snapshot: PersistedTeamLaunchSnapshot): Promise<void> {
    const launchStatePath = getTeamLaunchStatePath(teamName);
    const launchSummaryPath = getTeamLaunchSummaryPath(teamName);
    try {
      await assertSupportedLaunchStateVersionForMutation(launchStatePath);
      await atomicWriteAsync(launchStatePath, `${JSON.stringify(snapshot, null, 2)}\n`);
      await atomicWriteAsync(
        launchSummaryPath,
        `${JSON.stringify(createPersistedLaunchSummaryProjection(snapshot), null, 2)}\n`
      );
    } catch (error) {
      if (await isMissingTeamDirectoryWriteRace(launchStatePath, error)) {
        return;
      }
      if (
        error instanceof UnsupportedTeamLaunchStateVersionError ||
        error instanceof CorruptTeamLaunchStateError
      ) {
        throw error;
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
    await enqueuePublication(teamName, async () => {
      await assertSupportedLaunchStateVersionForMutation(getTeamLaunchStatePath(teamName));
      const results = await Promise.allSettled([
        fs.promises.rm(getTeamLaunchStatePath(teamName), { force: true }),
        fs.promises.rm(getTeamLaunchSummaryPath(teamName), { force: true }),
      ]);
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, `[${teamName}] Failed to clear launch-state publication`);
      }
    });
  }
}
