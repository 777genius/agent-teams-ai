/** Load the exact-scope durable CodeMirror manual-edit history. */
export const REVIEW_LOAD_DRAFT_HISTORY = 'review:loadDraftHistory';

/** Atomically publish one file's latest durable editor-history checkpoint. */
export const REVIEW_SAVE_DRAFT_HISTORY_ENTRY = 'review:saveDraftHistoryEntry';

/** Remove one file (or the whole exact scope) from durable editor history. */
export const REVIEW_CLEAR_DRAFT_HISTORY = 'review:clearDraftHistory';

/** Load/resolve durable manual-editor branches preserved after draft CAS conflicts. */
export const REVIEW_LOAD_DRAFT_HISTORY_CONFLICT_CANDIDATES =
  'review:loadDraftHistoryConflictCandidates';
export const REVIEW_RESOLVE_DRAFT_HISTORY_CONFLICT_CANDIDATE =
  'review:resolveDraftHistoryConflictCandidate';
export const REVIEW_REPLACE_DRAFT_HISTORY_CONFLICT_CANDIDATE =
  'review:replaceDraftHistoryConflictCandidate';

export const REVIEW_DRAFT_HISTORY_IPC_CHANNELS = [
  REVIEW_LOAD_DRAFT_HISTORY,
  REVIEW_LOAD_DRAFT_HISTORY_CONFLICT_CANDIDATES,
  REVIEW_RESOLVE_DRAFT_HISTORY_CONFLICT_CANDIDATE,
  REVIEW_REPLACE_DRAFT_HISTORY_CONFLICT_CANDIDATE,
  REVIEW_SAVE_DRAFT_HISTORY_ENTRY,
  REVIEW_CLEAR_DRAFT_HISTORY,
] as const;
