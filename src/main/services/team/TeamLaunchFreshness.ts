import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { getTeamsBasePath } from '@main/utils/pathDecoder';

/** Live authority, deliberately not restored from backups. Missing retains legacy restore. */
export const TEAM_LAUNCH_FRESHNESS_FILE = 'launch-freshness.json';
export type TeamLaunchFreshness =
  | { version: 1; teamName: string; kind: 'launch'; runId: string }
  | { version: 1; teamName: string; kind: 'stop'; stopId: string; stoppedRunId?: string };

export function getTeamLaunchFreshnessPath(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, TEAM_LAUNCH_FRESHNESS_FILE);
}

export function parseTeamLaunchFreshness(
  teamName: string,
  value: unknown
): TeamLaunchFreshness | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as {
    version?: unknown;
    teamName?: unknown;
    kind?: unknown;
    runId?: unknown;
    stopId?: unknown;
    stoppedRunId?: unknown;
  };
  if (record.version !== 1 || record.teamName !== teamName) {
    return null;
  }
  if (record.kind === 'launch' && typeof record.runId === 'string' && record.runId) {
    return { version: 1, teamName, kind: 'launch', runId: record.runId };
  }
  if (record.kind === 'stop' && typeof record.stopId === 'string' && record.stopId) {
    return {
      version: 1,
      teamName,
      kind: 'stop',
      stopId: record.stopId,
      ...(typeof record.stoppedRunId === 'string' && record.stoppedRunId
        ? { stoppedRunId: record.stoppedRunId }
        : {}),
    };
  }
  return null;
}

export function isStopLaunchFreshness(value: TeamLaunchFreshness | null | undefined): boolean {
  return value?.kind === 'stop';
}

export async function readTeamLaunchFreshness(
  teamName: string
): Promise<TeamLaunchFreshness | null> {
  let raw: string;
  try {
    raw = await fs.readFile(getTeamLaunchFreshnessPath(teamName), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = parseTeamLaunchFreshness(teamName, JSON.parse(raw));
  if (!parsed) {
    throw new Error('Invalid launch freshness authority');
  }
  return parsed;
}

export async function readTeamLaunchFreshnessFromTeamDir(
  teamDir: string,
  teamName: string
): Promise<TeamLaunchFreshness | null> {
  try {
    const raw = await fs.readFile(path.join(teamDir, TEAM_LAUNCH_FRESHNESS_FILE), 'utf8');
    return parseTeamLaunchFreshness(teamName, JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function canRestoreTeamStopMarker(
  teamName: string,
  content: Buffer
): Promise<boolean> {
  const freshness = await readTeamLaunchFreshness(teamName);
  if (!freshness) return true;
  if (freshness.kind === 'launch') return false;
  const marker = JSON.parse(content.toString('utf8'));
  return marker.teamName === teamName && marker.stopId === freshness.stopId;
}
