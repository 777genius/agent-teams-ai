export type TeamDraftState = 'draft' | 'materialized';

export interface TeamDraftRepositoryPort {
  getDraftState(teamName: string): Promise<TeamDraftState>;
  permanentlyDeleteTeam(teamName: string): Promise<void>;
}
