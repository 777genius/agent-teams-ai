import {
  assertBoundedReviewValue,
  InvalidReviewTransport,
  parseReviewOriginScope,
  parseReviewWriterRequest,
  parseReviewQuery,
} from '@agent-teams/task-change-ledger/review-transport';
import { TeamOwnerError } from '../team/contracts.js';
import type { HostMethod } from '../index.js';
import type { JsonValue } from '../contracts.js';
import type { createHostTeamReview } from '../composition/HostTeamReview.js';

type Review = ReturnType<typeof createHostTeamReview>;
export interface SelectedTeamReview {
  commandId: string;
  payload: unknown;
  review: Review;
}
function row(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new InvalidReviewTransport();
  return value as Record<string, unknown>;
}
function json(value: unknown): JsonValue {
  assertBoundedReviewValue(value);
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** TeamHost supplies its existing private-envelope/lease/current-owner selector, never a raw path. */
export function createTeamReviewMethods(options: {
  select(raw: unknown): SelectedTeamReview;
}): Record<string, HostMethod> {
  const methods: Record<string, HostMethod> = {};
  for (const operation of [
    'invoke',
    'lookup',
    'recovery.read',
    'getTaskChanges',
    'getTaskSummaries',
    'getAgentChanges',
    'getChangeStats',
    'invalidateSummaries',
    'authorizeWatch',
    'getGitFileLog',
  ] as const) {
    methods[`team.review.${operation}`] = {
      lane: operation === 'invoke' ? 'work' : 'control',
      async handle(raw): Promise<JsonValue> {
        let invokedWriter = false;
        try {
          const selected = options.select(raw);
          let value: unknown;
          switch (operation) {
            case 'recovery.read': {
              const payload = parseReviewQuery(operation, selected.payload);
              value = await selected.review.recoveryRead(payload.scope);
              break;
            }
            case 'lookup': {
              const payload = row(selected.payload, ['scope', 'expected']);
              value = await selected.review.lookupCommand(
                selected.commandId,
                parseReviewOriginScope(payload.scope),
                payload.expected === undefined
                  ? undefined
                  : parseReviewWriterRequest(payload.expected)
              );
              break;
            }
            case 'invoke': {
              const payload = row(selected.payload, ['scope', 'request']);
              const scope = parseReviewOriginScope(payload.scope);
              const request = parseReviewWriterRequest(payload.request);
              invokedWriter = true;
              value = await selected.review.invoke(request, scope, {
                commandId: selected.commandId,
              });
              break;
            }
            case 'getTaskChanges': {
              const payload = parseReviewQuery(operation, selected.payload);
              value = {
                kind: 'review-task-changes',
                value: await selected.review.getTaskChanges(payload.taskId, payload.options),
              };
              break;
            }
            case 'getTaskSummaries': {
              const payload = parseReviewQuery(operation, selected.payload);
              value = {
                kind: 'review-task-summaries',
                value: await selected.review.getTaskSummaries(payload.requests),
              };
              break;
            }
            case 'getAgentChanges': {
              const payload = parseReviewQuery(operation, selected.payload);
              value = {
                kind: 'review-agent-changes',
                value: await selected.review.getAgentChanges(payload.memberName),
              };
              break;
            }
            case 'getChangeStats': {
              const payload = parseReviewQuery(operation, selected.payload);
              value = {
                kind: 'review-change-stats',
                value: await selected.review.getChangeStats(payload.memberName),
              };
              break;
            }
            case 'invalidateSummaries': {
              const payload = parseReviewQuery(operation, selected.payload);
              await selected.review.invalidateSummaries(payload.taskIds);
              value = { kind: 'review-invalidated' };
              break;
            }
            case 'authorizeWatch':
              value = await selected.review.authorizeWatch(
                parseReviewQuery(operation, selected.payload)
              );
              break;
            case 'getGitFileLog': {
              const payload = parseReviewQuery(operation, selected.payload);
              value = {
                kind: 'review-git-log',
                value: await selected.review.getGitFileLog(payload.projectPath, payload.filePath, payload.scope),
              };
              break;
            }
          }
          return { ok: true, value: json(value) };
        } catch (error) {
          // Once the original writer may have run, only its retained receipt/WAL can settle uncertainty.
          if (invokedWriter) return { ok: false, code: 'hold', outcome: 'unknown' };
          const code =
            error instanceof TeamOwnerError
              ? error.code
              : error instanceof InvalidReviewTransport
                ? 'invalid'
                : 'hold';
          return {
            ok: false,
            code,
            outcome: code === 'hold' ? 'unknown' : 'rejected',
          };
        }
      },
    };
  }
  return methods;
}
