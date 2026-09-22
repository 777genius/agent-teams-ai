import type {
  CreateTeamImportDraftRequest,
  CreateTeamImportDraftResult,
  TeamImportPreview,
} from './dto';

export interface TeamImportApi {
  chooseFolderAndPreview(): Promise<TeamImportPreview | null>;
  createDraft(request: CreateTeamImportDraftRequest): Promise<CreateTeamImportDraftResult>;
}
