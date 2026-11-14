/** Browser-safe projection only. Native IDs and provider SDK handles stay in Host. */
export type NativeNextPromptProvider = 'claude' | 'codex';

export interface NativeNextPromptIdentity {
  /** An opaque owner-qualified UI handle, never a filesystem path. */
  readonly ownerHandle: string;
  readonly teamId: string;
  readonly runId: string;
  readonly memberId: string;
  readonly generation: string;
  /** Exact private-chat identifier, not the member's display name. */
  readonly conversationRef: string;
}

export interface NativeNextPromptCandidate extends NativeNextPromptIdentity {
  readonly suggestionId: string;
  readonly provider: NativeNextPromptProvider;
  /** Verified original successful Host input; not a UI run ordinal. */
  readonly operationRef: string;
  readonly completedTurnRef: string;
  readonly text: string;
}

export interface NativeNextPromptViewContext extends NativeNextPromptIdentity {
  readonly provider: NativeNextPromptProvider | 'unsupported';
  readonly latestExecutedOperationRef: string | null;
  readonly latestCompletedTurnRef: string | null;
  readonly userEnabled: boolean;
  readonly isHumanDirectConversation: boolean;
  readonly isEditable: boolean;
  readonly hasAttachments: boolean;
  readonly hasChips: boolean;
  readonly isEditingQueueOrRevision: boolean;
  readonly hasOpenMentionOrCommand: boolean;
  readonly draftText: string;
}
