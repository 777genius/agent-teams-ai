import { GetAttentionSnapshot } from '../../core/application/GetAttentionSnapshot';
import { HostRoutedAttentionSource } from '../adapters/output/HostRoutedAttentionSource';
import { TeamDataAttentionSource } from '../adapters/output/TeamDataAttentionSource';

import type { UserAttentionApi } from '../../contracts';
import type { CaptureHostTeamReads } from '@features/agent-backend/main';
import type { TeamDataService } from '@main/services/team/TeamDataService';

export type UserAttentionFeatureFacade = UserAttentionApi;

/** Main composition root; no domain policy or transport-specific behavior. */
export function createUserAttentionFeature(deps: {
  captureHost?: CaptureHostTeamReads;
  getContextId(): string;
  listGroupNames?: (teamName: string) => Promise<Record<string, string>>;
  getTeamDataService(): Pick<TeamDataService,
    'listTeams' | 'getUserAttentionTasks' | 'getMessageFeed'>;
}): UserAttentionFeatureFacade {
  const source = new TeamDataAttentionSource(deps);
  return {
    async getUserAttentionSnapshot(teamName) {
      const host = await deps.captureHost?.();
      const result = await new GetAttentionSnapshot(new HostRoutedAttentionSource(source, host))
        .getUserAttentionSnapshot(teamName);
      host?.assertCurrent();
      return { ...result, complete: result.complete && !(host?.unavailableOwners.length) };
    },
  };
}
