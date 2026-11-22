import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { syncDirectoryDurably } from '@main/utils/atomicWrite';
import { syncFile } from '@main/utils/durableFileSync';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('TeamProjectLiveEditJournal');

/**
 * Presence means an edit may have reached only one of the definition and runtime.
 * The caller holds the logical-team operation lock and has proved team ownership.
 * The marker contains no roster data; the saved definition remains authoritative.
 */
export class TeamProjectLiveEditJournal {
  constructor(
    private readonly synchronizeFile: (
      filePath: string,
      strict: boolean
    ) => Promise<void> = syncFile,
    private readonly synchronizeDirectory: (dirPath: string) => Promise<void> = syncDirectoryDurably
  ) {}

  private marker(teamName: string): string {
    const valid = validateTeamName(teamName);
    if (!valid.valid || !valid.value) throw new Error('Invalid team identifier');
    return path.join(getTeamsBasePath(), valid.value, 'project-live-edit.pending');
  }

  async hasPending(teamName: string): Promise<boolean> {
    try {
      // Treat every existing entry, including a corrupt file or symlink, as pending.
      await fs.lstat(this.marker(teamName));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async begin(teamName: string): Promise<void> {
    // Exclusive creation prevents replacing a prior incomplete operation.
    const marker = this.marker(teamName);
    const file = await fs.open(marker, 'wx', 0o600);
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectoryDurably(path.dirname(marker));
  }

  async clear(teamName: string, activeTeamName?: string): Promise<void> {
    const marker = this.marker(teamName);
    const stat = await fs.lstat(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 0) {
      throw new Error('The project team edit marker is unreadable; restore it before retrying');
    }
    // The ordinary writers use atomic rename but do not all request strict durability.
    // Synchronize their final files and directory entries before removing the durable fence.
    for (const name of [teamName, ...(activeTeamName ? [activeTeamName] : [])]) {
      const dir = path.dirname(this.marker(name));
      for (const filename of ['team.meta.json', 'members.meta.json', 'config.json']) {
        const filePath = path.join(dir, filename);
        let fileStat;
        try {
          fileStat = await fs.lstat(filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
          throw new Error(`Cannot synchronize team definition file: ${filename}`);
        }
        await this.synchronizeFile(filePath, true);
      }
      await this.synchronizeDirectory(dir);
    }
    await fs.unlink(marker);
    try {
      await this.synchronizeDirectory(path.dirname(marker));
    } catch (error) {
      // Both writes are already durable. A crash may restore the removed marker, which
      // only causes conservative recovery; do not report a partial write after unlink.
      logger.warn('Could not synchronize removal of the completed live-edit marker', error);
    }
  }
}
