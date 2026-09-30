import { parseRunId, parseTeamId, type RunId, type TeamId } from '@shared/contracts/hosted';

import { snapshotExactDataRecord } from './exactDataSnapshot';
import {
  type DiagnosticId,
  type OperationCorrelationId,
  parseDiagnosticId,
  parseOperationCorrelationId,
  parseSseConnectionId,
  type SseConnectionId,
} from './identifiers';

export interface OperationCorrelationContext {
  readonly requestId: OperationCorrelationId;
  readonly sseConnectionId?: SseConnectionId;
  readonly runId?: RunId;
  readonly teamId?: TeamId;
  readonly diagnosticId?: DiagnosticId;
}

export type OperationCorrelationExtension = Partial<Omit<OperationCorrelationContext, 'requestId'>>;

const CORRELATION_EXTENSION_KEYS = Object.freeze([
  'sseConnectionId',
  'runId',
  'teamId',
  'diagnosticId',
] as const);

export function createOperationCorrelationContext(value: unknown): OperationCorrelationContext {
  const input = snapshotExactDataRecord(
    value,
    ['requestId'],
    'hosted-operations-correlation-invalid',
    { optionalKeys: CORRELATION_EXTENSION_KEYS }
  );

  try {
    const requestId = parseOperationCorrelationId(input.requestId);
    const sseConnectionId =
      input.sseConnectionId === undefined ? undefined : parseSseConnectionId(input.sseConnectionId);
    const runId = input.runId === undefined ? undefined : parseRunId(input.runId);
    const teamId = input.teamId === undefined ? undefined : parseTeamId(input.teamId);
    const diagnosticId =
      input.diagnosticId === undefined ? undefined : parseDiagnosticId(input.diagnosticId);

    return Object.freeze({
      requestId,
      ...(sseConnectionId === undefined ? {} : { sseConnectionId }),
      ...(runId === undefined ? {} : { runId }),
      ...(teamId === undefined ? {} : { teamId }),
      ...(diagnosticId === undefined ? {} : { diagnosticId }),
    });
  } catch {
    throw new TypeError('hosted-operations-correlation-invalid');
  }
}

export function propagateOperationCorrelation(
  parent: OperationCorrelationContext,
  extension: OperationCorrelationExtension
): OperationCorrelationContext {
  const trustedParent = createOperationCorrelationContext(parent);
  const extensionRecord = snapshotExactDataRecord(
    extension,
    [],
    'hosted-operations-correlation-extension-invalid',
    { optionalKeys: CORRELATION_EXTENSION_KEYS }
  );
  const merged: Record<string, unknown> = { ...trustedParent };

  for (const key of CORRELATION_EXTENSION_KEYS) {
    const current = trustedParent[key as keyof OperationCorrelationContext];
    const next = extensionRecord[key];
    if (current !== undefined && next !== undefined && current !== next) {
      throw new TypeError('hosted-operations-correlation-conflict');
    }
    if (next !== undefined) merged[key] = next;
  }

  return createOperationCorrelationContext(merged);
}
