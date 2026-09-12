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
  const value = JSON.parse(raw);
  if (
    value?.version !== 1 ||
    value.teamName !== teamName ||
    !(
      (value.kind === 'launch' && typeof value.runId === 'string' && value.runId) ||
      (value.kind === 'stop' && typeof value.stopId === 'string' && value.stopId)
    )
  ) {
    throw new Error('Invalid launch freshness authority');
  }
  return value;
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
