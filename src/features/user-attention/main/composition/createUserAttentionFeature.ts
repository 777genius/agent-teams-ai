import { GetAttentionSnapshot } from '../../core/application/GetAttentionSnapshot';
import { TeamDataAttentionSource } from '../adapters/output/TeamDataAttentionSource';

import type { UserAttentionApi } from '../../contracts';
import type { TeamDataService } from '@main/services/team/TeamDataService';

export type UserAttentionFeatureFacade = UserAttentionApi;

/** Main composition root; no domain policy or transport-specific behavior. */
export function createUserAttentionFeature(deps: {
  getContextId(): string;
  listGroupNames?: (teamName: string) => Promise<Record<string, string>>;
  getTeamDataService(): Pick<TeamDataService,
    'listTeams' | 'getUserAttentionTasks' | 'getMessageFeed'>;
}): UserAttentionFeatureFacade {
  const source = new TeamDataAttentionSource(deps);
  return new GetAttentionSnapshot(source);
}
