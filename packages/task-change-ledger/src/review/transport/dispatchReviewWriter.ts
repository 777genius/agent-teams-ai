import type { ReviewWriter } from '../writer/createReviewWriter.js';
import type { ReviewWriterRequest, ReviewWriterResponse } from './contracts.js';

/** Finite original writer API; no reflective method dispatch or replacement owner lookup. */
export async function dispatchReviewWriter(
  writer: ReviewWriter,
  request: ReviewWriterRequest
): Promise<ReviewWriterResponse> {
  switch (request.method) {
    case 'checkConflict':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.checkConflict(...request.args),
      };
    case 'rejectHunks':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.rejectHunks(...request.args),
      };
    case 'rejectFile':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.rejectFile(...request.args),
      };
    case 'previewReject':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.previewReject(...request.args),
      };
    case 'applyDecisions':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.applyDecisions(...request.args),
      };
    case 'executeReviewMutation':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.executeReviewMutation(...request.args),
      };
    case 'restoreReviewHistory':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.restoreReviewHistory(...request.args),
      };
    case 'getFileContent':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.getFileContent(...request.args),
      };
    case 'saveEditedFile':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.saveEditedFile(...request.args),
      };
    case 'deleteEditedFile':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.deleteEditedFile(...request.args),
      };
    case 'restoreRejectedRename':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.restoreRejectedRename(...request.args),
      };
    case 'reapplyRejectedRename':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.reapplyRejectedRename(...request.args),
      };
    case 'retryReviewMutationRecovery':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.retryReviewMutationRecovery(...request.args),
      };
    case 'loadDecisions':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.loadDecisions(...request.args),
      };
    case 'loadDecisionConflictCandidates':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.loadDecisionConflictCandidates(...request.args),
      };
    case 'resolveDecisionConflictCandidate':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.resolveDecisionConflictCandidate(...request.args),
      };
    case 'saveDecisions':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.saveDecisions(...request.args),
      };
    case 'clearDecisions':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.clearDecisions(...request.args),
      };
    case 'loadDraftHistory':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.loadDraftHistory(...request.args),
      };
    case 'loadDraftHistoryConflictCandidates':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.loadDraftHistoryConflictCandidates(...request.args),
      };
    case 'resolveDraftHistoryConflictCandidate':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.resolveDraftHistoryConflictCandidate(...request.args),
      };
    case 'replaceDraftHistoryConflictCandidate':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.replaceDraftHistoryConflictCandidate(...request.args),
      };
    case 'saveDraftHistoryEntry':
      return {
        kind: 'review-writer',
        method: request.method,
        result: await writer.saveDraftHistoryEntry(...request.args),
      };
    case 'clearDraftHistory':
      await writer.clearDraftHistory(...request.args);
      return { kind: 'review-writer', method: request.method, result: null };
  }
}
