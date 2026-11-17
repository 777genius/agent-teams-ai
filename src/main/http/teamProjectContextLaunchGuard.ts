import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import type { TeamMetaFile } from '@main/services/team/TeamMetaStore';

interface MetadataReader {
  getMeta(teamName: string): Promise<TeamMetaFile | null>;
  metadataFileExists(teamName: string): Promise<boolean>;
}

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
  meta: MetadataReader = new TeamMetaStore()
): Promise<string> {
  // Opaque project-native aliases are not public team identifiers.
  if (/^ptc-[a-f0-9]{24}$/.test(teamName)) {
    throw new UnsupportedProjectContextHttpLaunchError(
      'Project runtime aliases cannot be launched directly through HTTP'
    );
  }
  const saved = await meta.getMeta(teamName);
  if (!saved && await meta.metadataFileExists(teamName)) {
    throw new UnsupportedProjectContextHttpLaunchError(
      'Existing team metadata is unreadable; refusing shared-history fallback'
    );
  }
  if (saved?.projectContextMode === 'per_project') {
    throw new UnsupportedProjectContextHttpLaunchError(
      'Project-scoped team launch requires the desktop project-context API'
    );
  }
  return teamName;
}
