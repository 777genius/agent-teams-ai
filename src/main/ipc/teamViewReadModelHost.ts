import * as fs from 'node:fs';
import * as path from 'node:path';

import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { withTimeoutValue } from '@main/utils/withTimeoutValue';
import { app } from 'electron';

const ACCESS_TIMEOUT_MS = 250;

export function createDesktopTeamViewReadModelEnvironment(): { isPackaged(): boolean } {
  return { isPackaged: () => app.isPackaged };
}

export function createDesktopMissingTeamStateSources(): {
  configExists(teamName: string): Promise<boolean | null>;
  draftExists(teamName: string): Promise<boolean>;
} {
  const teamMetaStore = new TeamMetaStore();
  return {
    configExists(teamName): Promise<boolean | null> {
      const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
      return withTimeoutValue(
        fs.promises
          .access(configPath, fs.constants.F_OK)
          .then(() => true)
          .catch((error: unknown) => {
            const code =
              typeof error === 'object' && error ? (error as { code?: unknown }).code : null;
            return code === 'ENOENT' ? false : null;
          }),
        ACCESS_TIMEOUT_MS,
        null
      );
    },
    async draftExists(teamName): Promise<boolean> {
      const meta = await withTimeoutValue(
        teamMetaStore.getMeta(teamName).catch(() => null),
        ACCESS_TIMEOUT_MS,
        null
      );
      return meta !== null;
    },
  };
}
