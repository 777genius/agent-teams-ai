import type { ReviewWriterMethod } from '@agent-teams/task-change-ledger/review-transport';

/** Existing WAL recovery stays owner-controlled, but observers create no new user intent. */
const kinds = {
  getFileContent: 'read',
  checkConflict: 'read',
  previewReject: 'read',
  loadDecisions: 'observer',
  loadDecisionConflictCandidates: 'observer',
  loadDraftHistory: 'observer',
  loadDraftHistoryConflictCandidates: 'observer',
  retryReviewMutationRecovery: 'observer',
  rejectHunks: 'mutation',
  rejectFile: 'mutation',
  applyDecisions: 'mutation',
  executeReviewMutation: 'mutation',
  restoreReviewHistory: 'mutation',
  saveEditedFile: 'mutation',
  deleteEditedFile: 'mutation',
  restoreRejectedRename: 'mutation',
  reapplyRejectedRename: 'mutation',
  resolveDecisionConflictCandidate: 'mutation',
  saveDecisions: 'mutation',
  clearDecisions: 'mutation',
  resolveDraftHistoryConflictCandidate: 'mutation',
  replaceDraftHistoryConflictCandidate: 'mutation',
  saveDraftHistoryEntry: 'mutation',
  clearDraftHistory: 'mutation',
} as const satisfies Record<ReviewWriterMethod, 'read' | 'observer' | 'mutation'>;

export function reviewMethodKind(method: ReviewWriterMethod) {
  return kinds[method];
}
