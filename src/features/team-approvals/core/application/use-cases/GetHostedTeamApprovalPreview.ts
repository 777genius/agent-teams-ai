import {
  type GetHostedTeamApprovalPreviewResult,
  parseHostedTeamApprovalGeneration,
  parseHostedTeamApprovalPreviewRequest,
} from '../../../contracts/hosted';
import {
  HOSTED_TEAM_APPROVAL_MAX_PREVIEW_BYTES,
  HOSTED_TEAM_APPROVAL_MAX_PREVIEW_TIME_MS,
  normalizeHostedTeamApprovalPreview,
  normalizeHostedTeamApprovalRetryAfterMs,
} from '../models/HostedTeamApprovalModels';

import type {
  HostedTeamApprovalClockPort,
  HostedTeamApprovalPreviewSourcePort,
} from '../ports/HostedTeamApprovalPorts';
import type { QueryContext } from '@shared/contracts/hosted';

function unavailable(retryAfterMs?: number): GetHostedTeamApprovalPreviewResult {
  return retryAfterMs === undefined
    ? Object.freeze({ kind: 'unavailable' })
    : Object.freeze({ kind: 'unavailable', retryAfterMs });
}

export class GetHostedTeamApprovalPreview {
  constructor(
    private readonly source: HostedTeamApprovalPreviewSourcePort,
    private readonly clock: HostedTeamApprovalClockPort
  ) {}

  async execute(
    requestValue: unknown,
    context: QueryContext
  ): Promise<GetHostedTeamApprovalPreviewResult> {
    const request = parseHostedTeamApprovalPreviewRequest(requestValue);
    if (!request.ok) return Object.freeze({ kind: 'invalid_request' });
    if (context.signal.aborted) return Object.freeze({ kind: 'cancelled' });

    const startedAtMs = this.clock.now();
    const deadlineAtMs = Math.min(
      context.deadlineAtMs,
      startedAtMs + HOSTED_TEAM_APPROVAL_MAX_PREVIEW_TIME_MS
    );
    try {
      const result = await this.source.readPreview(
        Object.freeze({
          teamId: request.value.teamId,
          approvalId: request.value.approvalId,
          expectedGeneration: request.value.expectedGeneration,
          previewRef: request.value.previewRef,
          byteLimit: HOSTED_TEAM_APPROVAL_MAX_PREVIEW_BYTES,
          deadlineAtMs,
        }),
        context
      );
      if (context.signal.aborted) return Object.freeze({ kind: 'cancelled' });
      if (result.kind === 'not_found') return Object.freeze({ kind: 'not_found' });
      if (result.kind === 'unavailable') {
        return unavailable(normalizeHostedTeamApprovalRetryAfterMs(result.retryAfterMs));
      }
      if (result.kind === 'stale_generation') {
        const currentGeneration = parseHostedTeamApprovalGeneration(result.currentGeneration);
        return currentGeneration === request.value.expectedGeneration
          ? unavailable()
          : Object.freeze({ kind: result.kind, currentGeneration });
      }
      if (result.kind !== 'found') return unavailable();

      const preview = normalizeHostedTeamApprovalPreview(result.preview, {
        teamId: request.value.teamId,
        approvalId: request.value.approvalId,
      });
      if (preview === null) return unavailable();
      if (preview.generation !== request.value.expectedGeneration) {
        return Object.freeze({
          kind: 'stale_generation',
          currentGeneration: preview.generation,
        });
      }
      return Object.freeze({ kind: 'success', preview });
    } catch {
      return unavailable();
    }
  }
}
