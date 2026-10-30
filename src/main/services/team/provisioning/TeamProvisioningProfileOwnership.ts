import { atomicWriteAsync } from '@main/utils/atomicWrite';
import {
  getAppDataBasePath,
  getClaudeBasePath,
  getTeamsBasePath as getDefaultTeamsBasePath,
} from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { buildOpenCodeAppProfileScope } from '../opencode/bridge/OpenCodeMcpBridgeEnv';

/**
 * The teams directory is shared by every copy of this app on the machine, by
 * e2e runs and by native Claude Code sessions. A team is managed by this app
 * profile only while this process tracks one of its runs or lanes, or when its
 * owner marker names this profile. Every other team is read-only for the
 * background passes: they must not stop, kill, rewrite or clean up anything in
 * it. A team without a marker - including every team created before markers
 * existed - stays untouched until it is explicitly launched again.
 */
export const TEAM_PROFILE_OWNER_MARKER_FILE = '.agent-teams-owner.json';

const TEAM_PROFILE_OWNER_MARKER_SCHEMA_VERSION = 1;
const TEAM_PROFILE_OWNER_MARKER_MAX_BYTES = 4 * 1024;

export type TeamProfileClaimReason = 'create' | 'launch';

export interface TeamProfileOwnerMarker {
  schemaVersion: typeof TEAM_PROFILE_OWNER_MARKER_SCHEMA_VERSION;
  profileScope: string;
  claimedAt: string;
  reason: TeamProfileClaimReason;
}

export interface TeamProfileOwnership {
  /** Never throws: anything that cannot be proven to be this profile's is foreign. */
  isManagedByThisProfile(teamName: string): Promise<boolean>;
}

export interface TeamProfileOwnershipPorts {
  isTrackedInThisProcess(teamName: string): boolean;
  getTeamsBasePath?(): string;
  getProfileScope?(): string;
}

/**
 * The scope that already bounds which OpenCode processes this app may reap:
 * a hash of the userData and Claude roots. Computed on every call, because the
 * marker lives under the Claude root it hashes - a team claimed under one root
 * is judged under that same root.
 */
export function resolveThisAppProfileScope(): string {
  return buildOpenCodeAppProfileScope(getAppDataBasePath(), getClaudeBasePath());
}

function isPlainTeamDirectoryName(teamName: string): boolean {
  return teamName.length > 0 && teamName !== '.' && teamName !== '..' && !/[\\/\0]/.test(teamName);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The profile scope recorded in the team's marker, or null when none can be trusted. */
export async function readTeamOwnerProfileScope(teamDir: string): Promise<string | null> {
  const markerPath = path.join(teamDir, TEAM_PROFILE_OWNER_MARKER_FILE);
  try {
    const stat = await fs.promises.lstat(markerPath);
    if (!stat.isFile() || stat.size > TEAM_PROFILE_OWNER_MARKER_MAX_BYTES) {
      return null;
    }
    const parsed = JSON.parse(await fs.promises.readFile(markerPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const marker = parsed as Partial<Record<keyof TeamProfileOwnerMarker, unknown>>;
    return marker.schemaVersion === TEAM_PROFILE_OWNER_MARKER_SCHEMA_VERSION &&
      typeof marker.profileScope === 'string' &&
      marker.profileScope.length > 0
      ? marker.profileScope
      : null;
  } catch {
    return null;
  }
}

export function createTeamProfileOwnership(ports: TeamProfileOwnershipPorts): TeamProfileOwnership {
  const getTeamsBasePath = ports.getTeamsBasePath ?? getDefaultTeamsBasePath;
  const getProfileScope = ports.getProfileScope ?? resolveThisAppProfileScope;
  return {
    async isManagedByThisProfile(teamName) {
      if (ports.isTrackedInThisProcess(teamName)) {
        return true;
      }
      if (!isPlainTeamDirectoryName(teamName)) {
        return false;
      }
      try {
        const ownerScope = await readTeamOwnerProfileScope(path.join(getTeamsBasePath(), teamName));
        return ownerScope !== null && ownerScope === getProfileScope();
      } catch {
        return false;
      }
    },
  };
}

/**
 * Records this profile as the team's owner. Callers do this before the first
 * spawn and abort the start when it fails, so every process this profile ever
 * starts for a team is reachable by its own cleanup after a crash. Rewriting a
 * marker of another profile is deliberate: an explicit create or launch takes
 * the team over.
 */
export async function claimTeamForThisProfile(input: {
  teamsBasePath: string;
  teamName: string;
  reason: TeamProfileClaimReason;
  profileScope?: string;
  now?: () => Date;
}): Promise<void> {
  try {
    if (!isPlainTeamDirectoryName(input.teamName)) {
      throw new Error('the team name is not a plain directory name');
    }
    const teamDir = path.join(input.teamsBasePath, input.teamName);
    if (!(await fs.promises.stat(teamDir)).isDirectory()) {
      throw new Error('the team path is not a directory');
    }
    const marker: TeamProfileOwnerMarker = {
      schemaVersion: TEAM_PROFILE_OWNER_MARKER_SCHEMA_VERSION,
      profileScope: input.profileScope ?? resolveThisAppProfileScope(),
      claimedAt: (input.now?.() ?? new Date()).toISOString(),
      reason: input.reason,
    };
    await atomicWriteAsync(
      path.join(teamDir, TEAM_PROFILE_OWNER_MARKER_FILE),
      `${JSON.stringify(marker, null, 2)}\n`
    );
  } catch (error) {
    throw new Error(
      `Team "${input.teamName}" was not started: this app could not record itself as the team owner (${getErrorMessage(error)})`
    );
  }
}

/**
 * Launch claims the team under the team lock before anything is spawned. A
 * team directory that does not exist is left alone: there is nothing to claim,
 * and both launch flows reject the missing config.json before spawning.
 */
export async function claimExistingTeamForLaunch(
  teamName: string,
  teamsBasePath: string = getDefaultTeamsBasePath()
): Promise<void> {
  try {
    await fs.promises.stat(path.join(teamsBasePath, teamName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return;
    }
  }
  await claimTeamForThisProfile({ teamsBasePath, teamName, reason: 'launch' });
}
