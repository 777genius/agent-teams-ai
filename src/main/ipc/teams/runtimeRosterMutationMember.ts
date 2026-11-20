import type {
  EffortLevel,
  TeamFastMode,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';
import type { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';

/** A roster member as the live roster mutation handlers read and roll it back. */
export interface RuntimeRosterMutationMember {
  name: string;
  role?: string;
  workflow?: string;
  isolation?: 'worktree';
  cwd?: string;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
  mcpPolicy?: ReturnType<typeof normalizeTeamMemberMcpPolicy>;
  removedAt?: number | string | null;
}
