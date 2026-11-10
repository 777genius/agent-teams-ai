import type { InlineChip } from '@renderer/types/inlineChip';
import type {
  EffortLevel,
  TeamFastMode,
  TeamMemberMcpPolicy,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

export interface MemberDraft {
  id: string;
  name: string;
  originalName?: string;
  roleSelection: string;
  customRole: string;
  workflow?: string;
  workflowChips?: InlineChip[];
  isolation?: 'worktree';
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
  mcpPolicy?: TeamMemberMcpPolicy;
  removedAt?: number | string | null;
}

export interface MembersEditorValue {
  members: MemberDraft[];
}
