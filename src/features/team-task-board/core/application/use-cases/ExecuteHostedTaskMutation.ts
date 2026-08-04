import { parseRevision, type QueryContext } from '@shared/contracts/hosted';

import {
  type ExecuteHostedTaskMutationResult,
  type HostedTaskMutationConflictReason,
  parseHostedTaskBoardSourceGeneration,
} from '../../../contracts/hosted';
import {
  normalizeHostedTaskMutationReceipt,
  parseHostedTaskMutationCommand,
} from '../../domain/policies/hostedTaskBoardPolicy';

import type { HostedTaskMutationAdmissionPort } from '../ports/HostedTeamTaskBoardPorts';

const CONFLICT_REASONS = new Set<HostedTaskMutationConflictReason>([
  'idempotency_mismatch',
  'relationship_conflict',
  'state_conflict',
]);

function unavailable(retryAfterMs?: number): ExecuteHostedTaskMutationResult {
  return retryAfterMs === undefined
    ? Object.freeze({ kind: 'unavailable' })
    : Object.freeze({ kind: 'unavailable', retryAfterMs });
}

function validRetryAfterMs(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 60_000
    ? (value as number)
    : undefined;
}

export class ExecuteHostedTaskMutation {
  constructor(private readonly admission: HostedTaskMutationAdmissionPort) {}

  async execute(
    commandValue: unknown,
    context: QueryContext
  ): Promise<ExecuteHostedTaskMutationResult> {
    const command = parseHostedTaskMutationCommand(commandValue);
    if (!command.ok) return Object.freeze({ kind: 'invalid_request' });
    if (context.signal.aborted) return unavailable();

    try {
      const result = await this.admission.admit(command.value, context);
      if (context.signal.aborted) return unavailable();
      switch (result.kind) {
        case 'committed': {
          const receipt = normalizeHostedTaskMutationReceipt(
            result.receipt,
            'committed',
            command.value.commandId,
            command.value.teamId,
            command.value.expectedSourceGeneration
          );
          if (!receipt.ok || receipt.value.outcome !== 'committed') return unavailable();
          return Object.freeze({ kind: result.kind, receipt: receipt.value });
        }
        case 'idempotent_replay': {
          const receipt = normalizeHostedTaskMutationReceipt(
            result.receipt,
            'idempotent_replay',
            command.value.commandId,
            command.value.teamId,
            command.value.expectedSourceGeneration
          );
          if (!receipt.ok || receipt.value.outcome !== 'idempotent_replay') {
            return unavailable();
          }
          return Object.freeze({ kind: result.kind, receipt: receipt.value });
        }
        case 'stale_generation': {
          const currentSourceGeneration = parseHostedTaskBoardSourceGeneration(
            result.currentSourceGeneration
          );
          if (currentSourceGeneration === command.value.expectedSourceGeneration) {
            return unavailable();
          }
          return Object.freeze({ kind: result.kind, currentSourceGeneration });
        }
        case 'stale_revision': {
          const currentRevision = parseRevision(result.currentRevision);
          return currentRevision === command.value.expectedRevision
            ? unavailable()
            : Object.freeze({ kind: result.kind, currentRevision });
        }
        case 'conflict': {
          if (!CONFLICT_REASONS.has(result.reason)) return unavailable();
          if (result.reason === 'idempotency_mismatch') {
            return result.currentRevision === undefined
              ? Object.freeze({ kind: result.kind, reason: result.reason })
              : unavailable();
          }
          if (result.reason === 'relationship_conflict') {
            const currentRevision =
              result.currentRevision === undefined
                ? undefined
                : parseRevision(result.currentRevision);
            return Object.freeze({
              kind: result.kind,
              reason: result.reason,
              ...(currentRevision === undefined ? {} : { currentRevision }),
            });
          }
          if (result.currentRevision === undefined) return unavailable();
          const currentRevision = parseRevision(result.currentRevision);
          if (currentRevision === command.value.expectedRevision) return unavailable();
          return Object.freeze({
            kind: result.kind,
            reason: result.reason,
            currentRevision,
          });
        }
        case 'not_found':
        case 'unsafe_active':
          return Object.freeze({ kind: result.kind });
        case 'unavailable':
          return unavailable(validRetryAfterMs(result.retryAfterMs));
        default:
          return unavailable();
      }
    } catch {
      return unavailable();
    }
  }
}
