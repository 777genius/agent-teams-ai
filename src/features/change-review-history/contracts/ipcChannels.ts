/** Load persisted review decisions from disk. */
export const REVIEW_LOAD_DECISIONS = 'review:loadDecisions';

/** Save review decisions to disk. */
export const REVIEW_SAVE_DECISIONS = 'review:saveDecisions';

/** Clear review decisions from disk. */
export const REVIEW_CLEAR_DECISIONS = 'review:clearDecisions';

/** Load/resolve durable renderer branches preserved after decision CAS conflicts. */
export const REVIEW_LOAD_DECISION_CONFLICT_CANDIDATES = 'review:loadDecisionConflictCandidates';
export const REVIEW_RESOLVE_DECISION_CONFLICT_CANDIDATE = 'review:resolveDecisionConflictCandidate';

export const REVIEW_DECISION_HISTORY_IPC_CHANNELS = [
  REVIEW_LOAD_DECISIONS,
  REVIEW_LOAD_DECISION_CONFLICT_CANDIDATES,
  REVIEW_RESOLVE_DECISION_CONFLICT_CANDIDATE,
  REVIEW_SAVE_DECISIONS,
  REVIEW_CLEAR_DECISIONS,
] as const;

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
