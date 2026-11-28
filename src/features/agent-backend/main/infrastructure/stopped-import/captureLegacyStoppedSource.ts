import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

import { getAppDataPath, getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';

import { LegacyStoppedImportHold } from './createLegacyStoppedTeamSource';

import type { CapturedLegacyStoppedSource } from './createLegacyStoppedTeamSource';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Existing local service roots only; capture immutable directory identity before the first await. */
export function captureLegacyStoppedSource(
  teamName: string,
  contextId: string,
  current: () => boolean
): CapturedLegacyStoppedSource {
  const teams = getTeamsBasePath(),
    tasks = getTasksBasePath(),
    app = getAppDataPath(),
    team = join(teams, teamName);
  const identity = () => {
    const stat = lstatSync(team);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new LegacyStoppedImportHold('source-unreadable');
    return [stat.dev, stat.ino, stat.birthtimeMs];
  };
  const original = identity(),
    sourceOwnerId = hash([contextId, teams, tasks, app]);
  return {
    sourceOwnerId,
    sourceId: hash([sourceOwnerId, teamName, original]),
    teamName,
    contextId,
    roots: [
      { category: 'team', path: team },
      { category: 'tasks', path: join(tasks, teamName) },
      { category: 'attachments', path: join(app, 'attachments', teamName) },
      { category: 'task-attachments', path: join(app, 'task-attachments', teamName) },
      // Retained review history/evidence are also covered by the exhaustive team-root census.
      { category: 'history', path: join(team, 'review-decisions') },
      { category: 'evidence', path: join(team, 'members') },
    ],
    isCurrent: () => {
      try {
        return (
          current() &&
          getTeamsBasePath() === teams &&
          getTasksBasePath() === tasks &&
          getAppDataPath() === app &&
          JSON.stringify(identity()) === JSON.stringify(original)
        );
      } catch {
        return false;
      }
    },
  };
}
