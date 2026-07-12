import type { TeamProvisioningMemberInput } from '@shared/types/team';

export interface TeamImportPreview {
  reviewId: string;
  suggestedTeamName: string;
  projectPath: string;
  members: TeamProvisioningMemberInput[];
  prompt?: string;
  skillsFound: string[];
  warnings: string[];
  blockingErrors: string[];
}

export interface CreateTeamImportDraftRequest {
  reviewId: string;
  teamName: string;
}

export interface CreateTeamImportDraftResult {
  teamName: string;
}
