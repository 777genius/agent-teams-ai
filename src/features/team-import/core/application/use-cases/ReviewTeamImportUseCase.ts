import { buildTeamImportPreview } from '../../domain/teamImportPolicy';

import type { TeamImportFolderPickerPort } from '../ports/TeamImportFolderPickerPort';
import type { TeamImportFolderSourcePort } from '../ports/TeamImportFolderSourcePort';
import type { TeamImportReviewStorePort } from '../ports/TeamImportReviewStorePort';
import type { TeamImportPreview } from '@features/team-import/contracts';

export class ReviewTeamImportUseCase {
  constructor(
    private readonly folderPicker: TeamImportFolderPickerPort,
    private readonly folderSource: TeamImportFolderSourcePort,
    private readonly reviewStore: TeamImportReviewStorePort
  ) {}

  async execute(): Promise<TeamImportPreview | null> {
    const selectedFolder = await this.folderPicker.chooseFolder();
    if (!selectedFolder) return null;

    const snapshot = await this.folderSource.inspect(selectedFolder);
    return this.reviewStore.save(buildTeamImportPreview(snapshot));
  }
}
