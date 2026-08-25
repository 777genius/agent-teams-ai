import {
  type DecideHostedTeamApprovalResult,
  parseHostedTeamApprovalDecisionCommand,
  parseHostedTeamApprovalGeneration,
} from '../../../contracts/hosted';
import {
  normalizeHostedTeamApprovalDecision,
  normalizeHostedTeamApprovalReceipt,
  normalizeHostedTeamApprovalRetryAfterMs,
} from '../models/HostedTeamApprovalModels';

import type { HostedTeamApprovalDecisionAdmissionPort } from '../ports/HostedTeamApprovalPorts';
import type { QueryContext } from '@shared/contracts/hosted';

function unavailable(retryAfterMs?: number): DecideHostedTeamApprovalResult {
  return retryAfterMs === undefined
    ? Object.freeze({ kind: 'unavailable' })
    : Object.freeze({ kind: 'unavailable', retryAfterMs });
}

export class DecideHostedTeamApproval {
  constructor(private readonly admission: HostedTeamApprovalDecisionAdmissionPort) {}

  async execute(
    commandValue: unknown,
    context: QueryContext
  ): Promise<DecideHostedTeamApprovalResult> {
    const command = parseHostedTeamApprovalDecisionCommand(commandValue);
    if (!command.ok) return Object.freeze({ kind: 'invalid_request' });
    if (context.signal.aborted) return unavailable();

    try {
      const result = await this.admission.admit(command.value, context);
      switch (result.kind) {
        case 'committed': {
          const receipt = normalizeHostedTeamApprovalReceipt(result.receipt, {
            outcome: 'committed',
            teamId: command.value.teamId,
            runId: command.value.expectedRunId,
            approvalId: command.value.approvalId,
            generation: command.value.expectedGeneration,
            decision: command.value.decision,
          });
          if (receipt === null || receipt.outcome !== 'committed') return unavailable();
          return Object.freeze({ kind: 'committed', receipt });
        }
        case 'idempotent_replay': {
          const receipt = normalizeHostedTeamApprovalReceipt(result.receipt, {
            outcome: 'idempotent_replay',
            teamId: command.value.teamId,
            runId: command.value.expectedRunId,
            approvalId: command.value.approvalId,
            generation: command.value.expectedGeneration,
            decision: command.value.decision,
          });
          if (receipt === null || receipt.outcome !== 'idempotent_replay') return unavailable();
          return Object.freeze({ kind: 'idempotent_replay', receipt });
        }
        case 'already_resolved': {
          const generation = parseHostedTeamApprovalGeneration(result.generation);
          const decision = normalizeHostedTeamApprovalDecision(result.decision);
          if (decision === null) return unavailable();
          return Object.freeze({ kind: result.kind, generation, decision });
        }
        case 'stale_generation': {
          const currentGeneration = parseHostedTeamApprovalGeneration(result.currentGeneration);
          return currentGeneration === command.value.expectedGeneration
            ? unavailable()
            : Object.freeze({ kind: result.kind, currentGeneration });
        }
        case 'conflict':
          return result.reason === 'idempotency_mismatch'
            ? Object.freeze({ kind: result.kind, reason: result.reason })
            : unavailable();
        case 'expired':
        case 'not_found':
          return Object.freeze({ kind: result.kind });
        case 'unavailable':
          return unavailable(normalizeHostedTeamApprovalRetryAfterMs(result.retryAfterMs));
        default:
          return unavailable();
      }
    } catch {
      return unavailable();
    }
  }
}
