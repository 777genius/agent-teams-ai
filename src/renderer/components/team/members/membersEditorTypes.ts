import type { InlineChip } from '@renderer/types/inlineChip';
import type { EffortLevel, TeamProviderId } from '@shared/types';

export interface MemberDraft {
  id: string;
  name: string;
  roleSelection: string;
  customRole: string;
  workflow?: string;
  workflowChips?: InlineChip[];
  providerId?: TeamProviderId;
  model?: string;
  effort?: EffortLevel;
}

export interface MembersEditorValue {
  members: MemberDraft[];
}
