import type { GroupChatEnvelope } from './envelope.js';
import type { TaskRef } from '../team/contracts.js';
/** Existing inbox policy fields consumed by the shared group application. */
export interface GroupMessage extends GroupChatEnvelope {
  from: string;
  text: string;
  timestamp: string;
  read: boolean;
  to?: string;
  messageId?: string;
  summary?: string;
  taskRefs?: TaskRef[];
  source?:
    | 'inbox'
    | 'lead_session'
    | 'lead_process'
    | 'runtime_delivery'
    | 'user_sent'
    | 'system_notification'
    | 'cross_team'
    | 'cross_team_sent';
  relayOfMessageId?: string;
}
