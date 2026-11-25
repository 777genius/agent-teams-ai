import type { BackendCrossTeamOutboxRow } from './crossTeam';
import type { BackendProcess } from './processes';
import type { BackendTeamConversation, BackendTeamPosition } from './teamChanges';
import type { BackendTeamLifecycle } from './teamLifecycle';
import type { InboxMessage, KanbanState, TeamTaskWithKanban } from '@shared/types/team';

/** Consumer-owned product read; runtime/process readiness is a separate conversation. */
/** Original Owner-authorized page; cursor is opaque, signed and revision-bound. */
export interface BackendTeamMessagesPage {
  teamName: string;
  revision: string;
  messages: BackendTeamSnapshot['messages'];
  nextCursor: string | null;
  hasMore: boolean;
  /** Present only while the Owner is sending a large message in bounded parts. */
  messageTotal?: number;
  messageParts?: { index: number; part: number; total: number }[];
  conversation?: BackendTeamConversation;
}

export interface BackendTeamSnapshot {
  teamName: string;
  revision: string;
  /** Authenticated Owner continuation; never expose a partial team to consumers. */
  nextCursor?: string | null;
  /** Present only for nested task-history pages; parts match page.tasks in order. */
  taskTotal?: number;
  taskParts?: {
    index: number;
    part: number;
    total: number;
    /** Present only when an individual comment's text spans multiple task parts. */
    commentPart?: { index: number; part: number; total: number };
  }[];
  /** Message text parts remain private to paged reads until reassembled. */
  messageTotal?: number;
  messageParts?: { index: number; part: number; total: number }[];
  lifecycle?: BackendTeamLifecycle;
  /** Selected owner has no current/retained native capture, original binding or pending cleanup. */
  runtimeNeverLaunched?: true;
  /** Product configuration read together with this snapshot, for coherent dialog hydration. */
  configurationRevision?: string;
  feed: BackendTeamPosition;
  members: { name: string; role: 'lead' | 'member' }[];
  tasks: TeamTaskWithKanban[];
  processes?: BackendProcess[];
  messages: (InboxMessage & {
    crossTeamOrigin?: Pick<
      BackendCrossTeamOutboxRow,
      | 'fromHandleId'
      | 'toHandleId'
      | 'fromTeamResourceRef'
      | 'toTeamResourceRef'
      | 'fromTeamName'
      | 'toTeamName'
    >;
  })[];
  kanbanState: KanbanState;
}
