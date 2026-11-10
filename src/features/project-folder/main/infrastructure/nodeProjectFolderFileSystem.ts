import { readDirectoryPresence } from '@main/utils/directoryPresence';
import { promises as fs } from 'fs';

import type { ProjectFolderFileSystem } from '../application/ProjectFolderService';

export const nodeProjectFolderFileSystem: ProjectFolderFileSystem = {
  readPresence: readDirectoryPresence,
  createDirectory: async (directoryPath) => {
    await fs.mkdir(directoryPath, { recursive: true });
  },
};
