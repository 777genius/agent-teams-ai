import type { BackendCrossTeamReceipt, BackendCrossTeamOutbox } from '../cross-team/contracts.js';
import type { TaskRef } from '../team/contracts.js';

/** Captured private endpoint actor, not a renderer-selected Team or ambient name lookup. */
export interface TeamMcpCrossTeamPort {
  listTargets(input?: { teamName?: string | undefined; excludeTeam?: string | undefined }): { resourceRef: string; teamResourceRef: string; teamName: string; recipientName: string }[];
  send(input: {
    commandId: string;
    teamName?: string | undefined;
    fromMember?: string | undefined;
    /** Exact opaque resourceRef from this captured Host catalog. */
    toTeam: string;
    text: string;
    summary?: string | undefined;
    conversationId?: string | undefined;
    replyToConversationId?: string | undefined;
    taskRefs?: TaskRef[] | undefined;
    chainDepth?: number | undefined;
  }): Promise<BackendCrossTeamReceipt>;
  lookup(commandId: string): unknown;
  getOutbox(input?: { teamName?: string | undefined }): Promise<BackendCrossTeamOutbox>;
}
