import type { TeamImportFolderSnapshot } from '../models/TeamImportFolderSnapshot';

export interface TeamImportFolderSourcePort {
  inspect(folderPath: string): Promise<TeamImportFolderSnapshot>;
}
