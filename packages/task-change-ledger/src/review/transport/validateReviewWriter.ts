import { BOUND_REVIEW_TEAM } from './contracts.js';
import type { ReviewOriginScope, ReviewWriterMethod, ReviewWriterRequest } from './contracts.js';

/** Includes before/after text and bounded durable history; actual Host framing must admit this limit. */
export const REVIEW_TRANSPORT_LIMITS = Object.freeze({
  bytes: 32 * 1024 * 1024,
  depth: 48,
  nodes: 400_000,
  collection: 100_000,
});
export class InvalidReviewTransport extends Error {
  constructor() {
    super('Invalid captured review request');
  }
}
export function reviewObject(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new InvalidReviewTransport();
  return value as Record<string, unknown>;
}
export function reviewText(value: unknown, max = 8192): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > max)
    throw new InvalidReviewTransport();
  return value;
}
function textContent(value: unknown, nullable = false): void {
  if (!(nullable && value === null) && typeof value !== 'string')
    throw new InvalidReviewTransport();
}
function integer(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new InvalidReviewTransport();
}
function list(value: unknown, max: number = REVIEW_TRANSPORT_LIMITS.collection): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new InvalidReviewTransport();
  return value;
}
/** Only transport safety here; snapshot, reviewKey, revision, path and history rules stay in writer. */
export function assertBoundedReviewValue(value: unknown): void {
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > REVIEW_TRANSPORT_LIMITS.nodes || depth > REVIEW_TRANSPORT_LIMITS.depth)
      throw new InvalidReviewTransport();
    if (item === undefined || item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') {
      if (item.length > REVIEW_TRANSPORT_LIMITS.bytes) throw new InvalidReviewTransport();
      return;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) {
      for (const entry of list(item)) visit(entry, depth + 1);
      return;
    }
    const row = reviewObject(item);
    const entries = Object.entries(row);
    if (entries.length > REVIEW_TRANSPORT_LIMITS.collection) throw new InvalidReviewTransport();
    for (const [key, entry] of entries) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype' || key.includes('\0'))
        throw new InvalidReviewTransport();
      visit(entry, depth + 1);
    }
  };
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > REVIEW_TRANSPORT_LIMITS.bytes)
    throw new InvalidReviewTransport();
}
export function parseReviewOriginScope(value: unknown): ReviewOriginScope {
  const row = reviewObject(value);
  if (Object.keys(row).some((key) => key !== 'taskId' && key !== 'memberName'))
    throw new InvalidReviewTransport();
  return {
    ...(row.taskId === undefined ? {} : { taskId: reviewText(row.taskId, 256) }),
    ...(row.memberName === undefined ? {} : { memberName: reviewText(row.memberName, 256) }),
  };
}
const arities: Record<ReviewWriterMethod, readonly [number, number]> = {
  checkConflict: [3, 3],
  rejectHunks: [3, 3],
  rejectFile: [2, 2],
  previewReject: [5, 5],
  applyDecisions: [1, 1],
  executeReviewMutation: [1, 1],
  restoreReviewHistory: [1, 1],
  getFileContent: [3, 4],
  saveEditedFile: [4, 4],
  deleteEditedFile: [3, 3],
  restoreRejectedRename: [3, 3],
  reapplyRejectedRename: [3, 3],
  retryReviewMutationRecovery: [1, 1],
  loadDecisions: [2, 3],
  loadDecisionConflictCandidates: [3, 3],
  resolveDecisionConflictCandidate: [6, 6],
  saveDecisions: [5, 9],
  clearDecisions: [2, 4],
  loadDraftHistory: [3, 3],
  loadDraftHistoryConflictCandidates: [3, 3],
  resolveDraftHistoryConflictCandidate: [7, 7],
  replaceDraftHistoryConflictCandidate: [7, 7],
  saveDraftHistoryEntry: [6, 6],
  clearDraftHistory: [3, 6],
};
export function isReviewWriterMethod(value: unknown): value is ReviewWriterMethod {
  return typeof value === 'string' && Object.hasOwn(arities, value);
}
const nullAsUndefined: Partial<Record<ReviewWriterMethod, readonly number[]>> = {
  getFileContent: [1, 3],
  saveDecisions: [6, 7, 8],
  clearDecisions: [3],
  clearDraftHistory: [3, 4],
};
function boundScope(value: unknown): void {
  const scope = reviewObject(value);
  if (scope.teamName !== BOUND_REVIEW_TEAM) throw new InvalidReviewTransport();
  if (Object.keys(scope).some((key) => !['teamName', 'taskId', 'memberName'].includes(key)))
    throw new InvalidReviewTransport();
  if (scope.taskId !== undefined) reviewText(scope.taskId, 256);
  if (scope.memberName !== undefined) reviewText(scope.memberName, 256);
}
function persistenceArgs(args: unknown[], scopeTokenRequired: boolean): void {
  if (args[0] !== BOUND_REVIEW_TEAM) throw new InvalidReviewTransport();
  reviewText(args[1], 512);
  if (scopeTokenRequired || (args[2] !== undefined && args[2] !== null)) reviewText(args[2], 4096);
}
/** Finite method/tuple validation before the original writer's authoritative input validation. */
export function parseReviewWriterRequest(value: unknown): ReviewWriterRequest {
  assertBoundedReviewValue(value);
  const raw = reviewObject(value);
  if (
    Object.keys(raw).some((key) => key !== 'method' && key !== 'args') ||
    !isReviewWriterMethod(raw.method)
  )
    throw new InvalidReviewTransport();
  const method = raw.method as ReviewWriterMethod;
  const args = [...list(raw.args, 9)];
  const [min, max] = arities[method];
  if (args.length < min || args.length > max) throw new InvalidReviewTransport();
  for (const index of nullAsUndefined[method] ?? [])
    if (args[index] === null) args[index] = undefined;
  switch (method) {
    case 'checkConflict':
      boundScope(args[0]);
      reviewText(args[1]);
      textContent(args[2]);
      break;
    case 'rejectHunks':
      boundScope(args[0]);
      reviewText(args[1]);
      for (const index of list(args[2])) integer(index);
      break;
    case 'rejectFile':
      boundScope(args[0]);
      reviewText(args[1]);
      break;
    case 'saveEditedFile':
      boundScope(args[0]);
      reviewText(args[1]);
      textContent(args[2]);
      textContent(args[3], true);
      break;
    case 'deleteEditedFile':
      boundScope(args[0]);
      reviewText(args[1]);
      textContent(args[2]);
      break;
    case 'restoreRejectedRename':
    case 'reapplyRejectedRename':
      boundScope(args[0]);
      reviewText(args[1]);
      reviewObject(args[2]);
      break;
    case 'previewReject':
      reviewText(args[0]);
      textContent(args[1]);
      textContent(args[2]);
      for (const index of list(args[3])) integer(index);
      list(args[4], 10_000);
      break;
    case 'getFileContent':
      if (args[0] !== BOUND_REVIEW_TEAM) throw new InvalidReviewTransport();
      if (args[1] !== undefined) reviewText(args[1], 256);
      reviewText(args[2]);
      if (args[3] !== undefined) list(args[3], 10_000);
      break;
    case 'applyDecisions': {
      const request = reviewObject(args[0]);
      if (request.teamName !== BOUND_REVIEW_TEAM) throw new InvalidReviewTransport();
      list(request.decisions, 2_000);
      break;
    }
    case 'executeReviewMutation':
    case 'restoreReviewHistory':
    case 'retryReviewMutationRecovery': {
      const request = reviewObject(args[0]);
      boundScope(request.scope);
      reviewObject(request.decisionPersistenceScope);
      if (method === 'executeReviewMutation') {
        list(request.diskSteps, 2_000);
        reviewObject(request.persistedState);
      }
      break;
    }
    default:
      persistenceArgs(args, method !== 'loadDecisions' && method !== 'clearDecisions');
      if (method === 'saveDecisions') {
        reviewObject(args[3]);
        reviewObject(args[4]);
        if (args[5] !== undefined && args[5] !== null) reviewObject(args[5]);
        if (args[6] !== undefined) list(args[6]);
        if (args[7] !== undefined) integer(args[7]);
        if (args[8] !== undefined) list(args[8]);
      } else if (method === 'clearDecisions') {
        if (args[3] !== undefined) integer(args[3]);
      } else if (
        method === 'resolveDecisionConflictCandidate' ||
        method === 'resolveDraftHistoryConflictCandidate'
      ) {
        reviewText(args[3], 512);
        if (args[4] !== 'recover-candidate' && args[4] !== 'keep-current')
          throw new InvalidReviewTransport();
        integer(args[5]);
        if (method === 'resolveDraftHistoryConflictCandidate' && args[6] !== null)
          reviewText(args[6], 512);
      } else if (method === 'saveDraftHistoryEntry') {
        reviewObject(args[3]);
        integer(args[4]);
        if (args[5] !== null) reviewText(args[5], 512);
      } else if (method === 'replaceDraftHistoryConflictCandidate') {
        reviewObject(args[3]);
        reviewObject(args[4]);
        integer(args[5]);
        if (args[6] !== null) reviewText(args[6], 512);
      } else if (method === 'clearDraftHistory') {
        if (args[3] !== undefined) reviewText(args[3]);
        if (args[4] !== undefined) integer(args[4]);
        if (args[5] !== undefined && args[5] !== null) reviewText(args[5], 512);
      }
  }
  // Rich nested DTOs are consumed only by existing writer validators, before their filesystem effects.
  return { method, args } as ReviewWriterRequest;
}
