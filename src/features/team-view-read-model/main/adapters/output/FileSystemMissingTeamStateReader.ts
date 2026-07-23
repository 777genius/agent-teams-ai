import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { withTimeoutValue } from '@main/utils/withTimeoutValue';
import * as fs from 'fs';
import * as path from 'path';

import type {
  MissingTeamState,
  MissingTeamStateReaderPort,
} from '../../../core/application/ports/TeamViewReadModelPorts';

const ACCESS_TIMEOUT_MS = 250;

export class FileSystemMissingTeamStateReader implements MissingTeamStateReaderPort {
  private readonly teamMetaStore = new TeamMetaStore();

  constructor(
    private readonly provisioningRuns: {
      hasProvisioningRun(teamName: string): boolean;
    }
  ) {}

  async classifyBeforeRead(teamName: string): Promise<MissingTeamState> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    const configExists = await withTimeoutValue(
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
    if (configExists !== false) {
      return null;
    }
    return this.classifyAfterNotFound(teamName);
  }

  async classifyAfterNotFound(teamName: string): Promise<MissingTeamState> {
    if (this.provisioningRuns.hasProvisioningRun(teamName) === true) {
      return 'provisioning';
    }
    const meta = await withTimeoutValue(
      this.teamMetaStore.getMeta(teamName).catch(() => null),
      ACCESS_TIMEOUT_MS,
      null
    );
    return meta ? 'draft' : null;
  }
}
