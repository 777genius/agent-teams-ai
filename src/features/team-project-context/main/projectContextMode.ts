import { parsePersistedTeamProjectContextMode } from '../core';

import type { TeamMetaFile } from '@main/services/team/TeamMetaStore';
import type { TeamProjectContextMode } from '@shared/types';

/** The part of the team metadata store the mode needs. */
export interface TeamModeMetaReader {
  getMeta(teamName: string): Promise<TeamMetaFile | null>;
  metadataFileExists(teamName: string): Promise<boolean>;
}

export const TEAM_METADATA_UNREADABLE_MESSAGE =
  'Team metadata is unreadable; refusing shared-history fallback';

/** Thrown when a team has a metadata file that cannot be read; callers map it to their own refusal. */
export class TeamMetadataUnreadableError extends Error {
  readonly code = 'TEAM_METADATA_UNREADABLE';
}

/**
 * The one place that turns saved team metadata into a project-context mode.
 * It fails closed: a metadata file that exists but cannot be read is not proof
 * that the team is an ordinary shared one, so it throws instead of guessing.
 * A team without metadata is the legacy shared mode.
 *
 * `unreadableMessage` lets a caller say what it refuses; the decision is the same.
 */
export async function readTeamProjectContextMode(
  reader: TeamModeMetaReader,
  teamName: string,
  unreadableMessage: string = TEAM_METADATA_UNREADABLE_MESSAGE
): Promise<TeamProjectContextMode> {
  const meta = await reader.getMeta(teamName);
  if (meta === null && (await reader.metadataFileExists(teamName))) {
    throw new TeamMetadataUnreadableError(unreadableMessage);
  }
  return parsePersistedTeamProjectContextMode(
    meta?.projectContextMode,
    meta !== null && Object.hasOwn(meta, 'projectContextMode')
  );
}
