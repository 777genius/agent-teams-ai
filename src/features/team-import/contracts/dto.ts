import type { TeamProvisioningMemberInput } from '@shared/types/team';

export type TeamImportWarning =
  | { code: 'unsafeTaskCall'; call: string }
  | { code: 'unknownTaskOwner'; description: string; owner: string }
  | { code: 'memberReserved'; fileName: string; name: string }
  | { code: 'memberInvalid'; fileName: string; name: string }
  | { code: 'memberReservedSuffix'; fileName: string; name: string }
  | { code: 'duplicateMember'; fileName: string; name: string }
  | { code: 'missingClaudeMd' };

export interface TeamImportPreview {
  reviewId: string;
  suggestedTeamName: string;
  projectPath: string;
  members: TeamProvisioningMemberInput[];
  prompt?: string;
  skillsFound: string[];
  warnings: TeamImportWarning[];
  blockingErrors: string[];
}

export interface CreateTeamImportDraftRequest {
  reviewId: string;
  teamName: string;
}

export interface CreateTeamImportDraftResult {
  teamName: string;
}
