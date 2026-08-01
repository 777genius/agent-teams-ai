export type AgentActionMode = 'do' | 'ask' | 'delegate';
export type TeamProviderId = 'anthropic' | 'codex' | 'gemini' | 'opencode';

export interface TaskRef {
  taskId: string;
  displayId: string;
  teamName: string;
}

// eslint-disable-next-line sonarjs/redundant-type-aliases -- semantic feature contract
export type AttachmentMediaType = string;

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: AttachmentMediaType;
  size: number;
  filePath?: string;
}

export interface AttachmentPayload extends AttachmentMeta {
  data: string;
}

export interface AttachmentFileData {
  id: string;
  data: string;
  mimeType: AttachmentMediaType;
  filePath?: string;
}

export interface SlashCommandMeta {
  name: string;
  command: `/${string}`;
  args?: string;
  knownDescription?: string;
}

export interface InboxMessage {
  from: string;
  to?: string;
  text: string;
  timestamp: string;
  read: boolean;
  taskRefs?: TaskRef[];
  actionMode?: AgentActionMode;
  summary?: string;
  messageId?: string;
  source?: 'user_sent';
  attachments?: AttachmentMeta[];
  messageKind?: 'slash_command';
  slashCommand?: SlashCommandMeta;
}

/** Persistence command containing only fields the delivery application owns. */
export interface SendMessageRequest {
  member: string;
  text: string;
  taskRefs?: TaskRef[];
  actionMode?: AgentActionMode;
  summary?: string;
  from?: string;
  messageId?: string;
  attachments?: AttachmentPayload[];
  source?: 'user_sent';
}

export interface SendMessageResult {
  deliveredToInbox: boolean;
  deliveredViaStdin?: boolean;
  messageId: string;
  deduplicated?: boolean;
}
