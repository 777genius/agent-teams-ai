import { BOUND_REVIEW_TEAM } from './contracts.js';
import type { ReviewWriterRequest, ReviewWriterWireRequest } from './contracts.js';
import type { ReviewFileScope } from '../../contracts.js';
import { InvalidReviewTransport, parseReviewWriterRequest } from './validateReviewWriter.js';

function team(value: string, from: string, to: string): string {
  if (value !== from) throw new InvalidReviewTransport();
  return to;
}
function scope(value: ReviewFileScope, from: string, to: string): ReviewFileScope {
  return { ...value, teamName: team(value.teamName, from, to) };
}
/** Changes only the known Team selector slot; every review identity, revision and file byte survives. */
function mapTeam(request: ReviewWriterRequest, from: string, to: string): ReviewWriterRequest {
  switch (request.method) {
    case 'checkConflict':
      return {
        method: request.method,
        args: [scope(request.args[0], from, to), request.args[1], request.args[2]],
      };
    case 'rejectHunks':
      return {
        method: request.method,
        args: [scope(request.args[0], from, to), request.args[1], request.args[2]],
      };
    case 'rejectFile':
      return {
        method: request.method,
        args: [scope(request.args[0], from, to), request.args[1]],
      };
    case 'previewReject':
      return request;
    case 'applyDecisions':
      return {
        method: request.method,
        args: [
          {
            ...request.args[0],
            teamName: team(request.args[0].teamName, from, to),
          },
        ],
      };
    case 'executeReviewMutation':
      return {
        method: request.method,
        args: [{ ...request.args[0], scope: scope(request.args[0].scope, from, to) }],
      };
    case 'restoreReviewHistory':
      return {
        method: request.method,
        args: [{ ...request.args[0], scope: scope(request.args[0].scope, from, to) }],
      };
    case 'getFileContent':
      return {
        method: request.method,
        args: [team(request.args[0], from, to), request.args[1], request.args[2], request.args[3]],
      };
    case 'saveEditedFile':
      return {
        method: request.method,
        args: [scope(request.args[0], from, to), request.args[1], request.args[2], request.args[3]],
      };
    case 'deleteEditedFile':
      return {
        method: request.method,
        args: [scope(request.args[0], from, to), request.args[1], request.args[2]],
      };
    case 'restoreRejectedRename':
      return {
        method: request.method,
        args: [scope(request.args[0], from, to), request.args[1], request.args[2]],
      };
    case 'reapplyRejectedRename':
      return {
        method: request.method,
        args: [scope(request.args[0], from, to), request.args[1], request.args[2]],
      };
    case 'retryReviewMutationRecovery':
      return {
        method: request.method,
        args: [{ ...request.args[0], scope: scope(request.args[0].scope, from, to) }],
      };
    case 'loadDecisions':
      return {
        method: request.method,
        args: [team(request.args[0], from, to), request.args[1], request.args[2]],
      };
    case 'loadDecisionConflictCandidates':
      return {
        method: request.method,
        args: [team(request.args[0], from, to), request.args[1], request.args[2]],
      };
    case 'resolveDecisionConflictCandidate':
      return {
        method: request.method,
        args: [
          team(request.args[0], from, to),
          request.args[1],
          request.args[2],
          request.args[3],
          request.args[4],
          request.args[5],
        ],
      };
    case 'saveDecisions':
      return {
        method: request.method,
        args: [
          team(request.args[0], from, to),
          request.args[1],
          request.args[2],
          request.args[3],
          request.args[4],
          request.args[5],
          request.args[6],
          request.args[7],
          request.args[8],
        ],
      };
    case 'clearDecisions':
      return {
        method: request.method,
        args: [team(request.args[0], from, to), request.args[1], request.args[2], request.args[3]],
      };
    case 'loadDraftHistory':
      return {
        method: request.method,
        args: [team(request.args[0], from, to), request.args[1], request.args[2]],
      };
    case 'loadDraftHistoryConflictCandidates':
      return {
        method: request.method,
        args: [team(request.args[0], from, to), request.args[1], request.args[2]],
      };
    case 'resolveDraftHistoryConflictCandidate':
      return {
        method: request.method,
        args: [
          team(request.args[0], from, to),
          request.args[1],
          request.args[2],
          request.args[3],
          request.args[4],
          request.args[5],
          request.args[6],
        ],
      };
    case 'replaceDraftHistoryConflictCandidate':
      return {
        method: request.method,
        args: [
          team(request.args[0], from, to),
          request.args[1],
          request.args[2],
          request.args[3],
          request.args[4],
          request.args[5],
          request.args[6],
        ],
      };
    case 'saveDraftHistoryEntry':
      return {
        method: request.method,
        args: [
          team(request.args[0], from, to),
          request.args[1],
          request.args[2],
          request.args[3],
          request.args[4],
          request.args[5],
        ],
      };
    case 'clearDraftHistory':
      return {
        method: request.method,
        args: [
          team(request.args[0], from, to),
          request.args[1],
          request.args[2],
          request.args[3],
          request.args[4],
          request.args[5],
        ],
      };
  }
}
/** Renderer adapter captures the originating selection before entering the private wire format. */
export function captureReviewWriterRequest(
  request: ReviewWriterRequest,
  selection: string
): ReviewWriterWireRequest {
  const captured = parseReviewWriterRequest(mapTeam(request, selection, BOUND_REVIEW_TEAM));
  return JSON.parse(JSON.stringify(captured)) as ReviewWriterWireRequest;
}
/** Host composition calls this only after authenticating its original owner-qualified Team handle. */
export function bindReviewWriterRequest(
  request: ReviewWriterRequest | ReviewWriterWireRequest,
  canonicalTeamName: string
): ReviewWriterRequest {
  return mapTeam(parseReviewWriterRequest(request), BOUND_REVIEW_TEAM, canonicalTeamName);
}
