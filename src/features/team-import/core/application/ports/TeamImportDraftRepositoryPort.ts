import type { TeamImportPreview } from '@features/team-import/contracts';

export interface TeamImportDraftRepositoryPort {
  createDraft(teamName: string, preview: TeamImportPreview): Promise<void>;
}
