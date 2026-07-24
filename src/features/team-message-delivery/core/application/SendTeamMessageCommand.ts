import type { AgentActionMode, AttachmentPayload, TaskRef } from '@shared/types';

export interface SendTeamMessageCommand {
  teamName: string;
  memberName: string;
  text: string;
  summary?: string;
  from?: string;
  actionMode?: AgentActionMode;
  taskRefs?: TaskRef[];
  attachments?: AttachmentPayload[];
}

export interface DelegateRecipientPrevalidation {
  leadName: string | null;
  isLeadRecipient: boolean;
}
