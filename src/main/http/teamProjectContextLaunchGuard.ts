import {
  readTeamProjectContextMode,
  TeamMetadataUnreadableError,
} from '@features/team-project-context/main';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import type { TeamModeMetaReader } from '@features/team-project-context/main';

class UnsupportedProjectContextHttpLaunchError extends Error {
  readonly statusCode = 409;
}

/**
 * HTTP launching currently lacks the verified logical-to-physical context
 * admission fence. Fail closed instead of silently launching a shared session.
 * Existing shared-mode HTTP launch behavior remains unchanged.
 */
export async function rejectUnsupportedProjectContextHttpLaunch(
  teamName: string,
  meta: TeamModeMetaReader = new TeamMetaStore()
): Promise<string> {
  // Opaque project-native aliases are not public team identifiers.
  if (/^ptc-[a-f0-9]{24}$/.test(teamName)) {
    throw new UnsupportedProjectContextHttpLaunchError(
      'Project runtime aliases cannot be launched directly through HTTP'
    );
  }
  const mode = await readTeamProjectContextMode(
    meta,
    teamName,
    'Existing team metadata is unreadable; refusing shared-history fallback'
  ).catch((error: unknown) => {
    throw error instanceof TeamMetadataUnreadableError
      ? new UnsupportedProjectContextHttpLaunchError(error.message)
      : error;
  });
  if (mode === 'per_project') {
    throw new UnsupportedProjectContextHttpLaunchError(
      'Project-scoped team launch requires the desktop project-context API'
    );
  }
  return teamName;
}
