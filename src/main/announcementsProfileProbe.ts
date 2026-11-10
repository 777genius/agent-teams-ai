import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export interface AnnouncementsProfileProbe {
  origin: 'fresh' | 'legacy' | 'unknown';
  reason: 'app-marker' | 'absent-profile' | 'ambiguous-profile';
}

/** Bounded app-owned checks only. Chromium files and directory timestamps prove nothing. */
export function probeAnnouncementsProfile(
  userDataPath: string,
  claudeRoot: string
): AnnouncementsProfileProbe {
  const markers = [
    join(userDataPath, 'data', 'announcements', 'initialized.json'),
    ...[
      'agent-teams-config.json',
      'claude-devtools-config.json',
      'claude-code-context-config.json',
    ].map((name) => join(claudeRoot, name)),
  ];
  for (const marker of markers) {
    try {
      if (lstatSync(marker).isFile()) return { origin: 'legacy', reason: 'app-marker' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { origin: 'unknown', reason: 'ambiguous-profile' };
      }
    }
  }
  // Only actual absence is evidence of freshness. Dev path setup already mkdirs
  // directories, so an empty explicit sandbox conservatively remains unknown.
  try {
    lstatSync(userDataPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { origin: 'fresh', reason: 'absent-profile' };
    }
  }
  return { origin: 'unknown', reason: 'ambiguous-profile' };
}
