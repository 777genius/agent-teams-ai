import type { InboxMessage } from './team';

/** Cursor-based paginated messages response. */
export interface MessagesPage {
  messages: InboxMessage[];
  /** Opaque cursor string for fetching older messages. Null when no more pages. */
  nextCursor: string | null;
  hasMore: boolean;
  /**
   * Content-stable revision of the full normalized feed that produced this page.
   * Changes only when the semantic message feed changes.
   */
  feedRevision: string;
  /** Retained messages remain readable while their source reports incomplete history. */
  historyWarning?: string;
}
