import {
  getAppDataPath,
  getBackupsBasePath,
  getTasksBasePath,
  getTeamsBasePath,
} from '@main/utils/pathDecoder';
import type { LifecycleDirectories } from '@agent-teams/legacy-agent-host/lifecycle';
/** Shipping Desktop paths remain selected only by this legacy composition. */
export function legacyLifecycleRoots(): LifecycleDirectories {
  return {
    teams: getTeamsBasePath(),
    tasks: getTasksBasePath(),
    appData: getAppDataPath(),
    backups: getBackupsBasePath(),
  };
}
