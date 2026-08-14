import { createHash, randomUUID } from 'node:crypto';

import { parseCursor, parseRunId, parseTeamId, type QueryContext } from '@shared/contracts/hosted';

import {
  parseHostedTeamApprovalGeneration,
  parseHostedTeamApprovalId,
  parseHostedTeamApprovalPreviewRef,
} from '../../../contracts/hosted';

import type {
  HostedTeamApprovalDecision,
  HostedTeamApprovalDecisionCommand,
  HostedTeamApprovalDecisionReceipt,
} from '../../../contracts/hosted';
import type {
  HostedTeamApprovalClockPort,
  HostedTeamApprovalDecisionAdmissionResult,
  HostedTeamApprovalPageSourceRequest,
  HostedTeamApprovalPageSourceResult,
  HostedTeamApprovalPreviewSourceRequest,
  HostedTeamApprovalPreviewSourceResult,
} from '../../../core/application/ports/HostedTeamApprovalPorts';
import type { HostedTeamApprovalAuthorityPort } from '../../ports/HostedTeamApprovalAuthorityPort';
import type {
  HostedTeamApprovalAuthorityScopeResolverPort,
  HostedTeamApprovalDeliveryOutboxPort,
  HostedTeamApprovalPendingIngressPort,
} from '../../ports/HostedTeamApprovalAuthorityStoragePort';
import type {
  HostedTeamApprovalAuthorityScope,
  HostedTeamApprovalAuthorityStorageGateway,
  HostedTeamApprovalDeliveryAcknowledgeRequest,
  HostedTeamApprovalDeliveryClaimRequest,
  HostedTeamApprovalDeliveryRecord,
  HostedTeamApprovalPendingReadRecord,
  HostedTeamApprovalPendingStorageRecord,
} from '@features/internal-storage/contracts';

const CURSOR_PREFIX = 'cursor_';

export interface HostedTeamApprovalAuthorityIdFactory {
  nextAuditId(): string;
  nextDeliveryId(): string;
}

export interface InternalStorageHostedTeamApprovalAuthorityDependencies {
  readonly storage: HostedTeamApprovalAuthorityStorageGateway;
  readonly scopeResolver: HostedTeamApprovalAuthorityScopeResolverPort;
  readonly clock?: HostedTeamApprovalClockPort;
  readonly ids?: HostedTeamApprovalAuthorityIdFactory;
}

function defaultIds(): HostedTeamApprovalAuthorityIdFactory {
  return Object.freeze({
    nextAuditId: () => `approval_audit_${randomUUID().replaceAll('-', '')}`,
    nextDeliveryId: () => `approval_delivery_${randomUUID().replaceAll('-', '')}`,
  });
}

function unavailable(): HostedTeamApprovalDecisionAdmissionResult {
  return Object.freeze({ kind: 'unavailable' });
}

function pageUnavailable(): HostedTeamApprovalPageSourceResult {
  return Object.freeze({ kind: 'unavailable' });
}

function previewUnavailable(): HostedTeamApprovalPreviewSourceResult {
  return Object.freeze({ kind: 'unavailable' });
}

function contextOpen(
  context: QueryContext,
  clock: HostedTeamApprovalClockPort,
  deadlineAtMs: number
): boolean {
  try {
    const now = clock.now();
    return (
      context.signal instanceof AbortSignal &&
      !context.signal.aborted &&
      Number.isSafeInteger(context.deadlineAtMs) &&
      context.deadlineAtMs >= 0 &&
      Number.isSafeInteger(deadlineAtMs) &&
      deadlineAtMs >= 0 &&
      deadlineAtMs <= context.deadlineAtMs &&
      Number.isSafeInteger(now) &&
      now >= 0 &&
      now < deadlineAtMs
    );
  } catch {
    return false;
  }
}

function generationHash(generation: string): string {
  return createHash('sha256').update(generation).digest('hex');
}

function parseAfterApprovalCursor(cursor: string | null): {
  readonly approvalId: string | null;
  readonly approvalGenerationHash: string | null;
} {
  if (cursor === null) return { approvalId: null, approvalGenerationHash: null };
  const parsed = parseCursor(cursor);
  if (!parsed.startsWith(CURSOR_PREFIX)) {
    throw new TypeError('hosted-team-approval-authority-cursor-invalid');
  }
  const separator = parsed.lastIndexOf('.');
  const approvalId = parseHostedTeamApprovalId(parsed.slice(CURSOR_PREFIX.length, separator));
  const approvalGenerationHash = parsed.slice(separator + 1);
  if (
    !/^[a-f0-9]{64}$/.test(approvalGenerationHash) ||
    `${CURSOR_PREFIX}${approvalId}.${approvalGenerationHash}` !== parsed
  ) {
    throw new TypeError('hosted-team-approval-authority-cursor-invalid');
  }
  return { approvalId, approvalGenerationHash };
}

function cursorForApproval(
  approvalId: string,
  approvalGeneration: string
): ReturnType<typeof parseCursor> {
  return parseCursor(
    `${CURSOR_PREFIX}${parseHostedTeamApprovalId(approvalId)}.${generationHash(approvalGeneration)}`
  );
}

function receipt(
  outcome: 'committed' | 'idempotent_replay',
  command: HostedTeamApprovalDecisionCommand
): HostedTeamApprovalDecisionReceipt {
  return Object.freeze({
    schemaVersion: command.schemaVersion,
    outcome,
    teamId: command.teamId,
    runId: command.expectedRunId,
    approvalId: command.approvalId,
    generation: command.expectedGeneration,
    decision: command.decision,
  });
}

function parseDecision(value: unknown): HostedTeamApprovalDecision {
  if (value !== 'allow' && value !== 'deny') {
    throw new TypeError('hosted-team-approval-authority-decision-invalid');
  }
  return value;
}

function browserDecisionIntentHash(
  scope: HostedTeamApprovalAuthorityScope,
  command: HostedTeamApprovalDecisionCommand
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        teamId: scope.teamId,
        expectedRunId: command.expectedRunId,
        approvalId: command.approvalId,
        approvalGeneration: command.expectedGeneration,
        decision: command.decision,
      })
    )
    .digest('hex');
}

function scopeMatches(
  scope: HostedTeamApprovalAuthorityScope,
  teamId: string,
  context: QueryContext
): boolean {
  return scope.principalId === context.actorId && scope.teamId === teamId;
}

/**
 * Concrete durable authority. It binds browser context to a trusted scope,
 * while lifecycle ingress and outbox delivery remain explicit external-owner
 * operations. It deliberately has no process or provider capability.
 */
export class InternalStorageHostedTeamApprovalAuthority
  implements
    HostedTeamApprovalAuthorityPort,
    HostedTeamApprovalPendingIngressPort,
    HostedTeamApprovalDeliveryOutboxPort
{
  private readonly clock: HostedTeamApprovalClockPort;
  private readonly ids: HostedTeamApprovalAuthorityIdFactory;

  constructor(
    private readonly dependencies: InternalStorageHostedTeamApprovalAuthorityDependencies
  ) {
    this.clock = dependencies.clock ?? Object.freeze({ now: Date.now });
    this.ids = dependencies.ids ?? defaultIds();
  }

  async observePending(
    record: HostedTeamApprovalPendingStorageRecord
  ): Promise<HostedTeamApprovalPendingReadRecord> {
    return this.dependencies.storage.hostedTeamApprovalObserve(record);
  }

  async claimDeliveries(
    request: HostedTeamApprovalDeliveryClaimRequest
  ): Promise<readonly HostedTeamApprovalDeliveryRecord[]> {
    return this.dependencies.storage.hostedTeamApprovalClaimDeliveries(request);
  }

  async acknowledgeDelivery(request: HostedTeamApprovalDeliveryAcknowledgeRequest): Promise<void> {
    await this.dependencies.storage.hostedTeamApprovalAcknowledgeDelivery(request);
  }

  async readPendingPage(
    request: HostedTeamApprovalPageSourceRequest,
    context: QueryContext
  ): Promise<HostedTeamApprovalPageSourceResult> {
    if (!contextOpen(context, this.clock, request.deadlineAtMs)) return pageUnavailable();
    try {
      const scope = await this.resolveScope(request.teamId, context, request.deadlineAtMs);
      if (scope === null) return Object.freeze({ kind: 'not_found' });
      const after = parseAfterApprovalCursor(request.cursor);
      const result = await this.dependencies.storage.hostedTeamApprovalReadPending({
        scope,
        afterApprovalId: after.approvalId,
        afterApprovalGenerationHash: after.approvalGenerationHash,
        limit: request.itemLimit,
        deadlineAtMs: request.deadlineAtMs,
      });
      if (!contextOpen(context, this.clock, request.deadlineAtMs)) return pageUnavailable();
      return Object.freeze({
        kind: 'found',
        teamId: request.teamId,
        candidates: Object.freeze(
          result.records.map((record) =>
            Object.freeze({
              item: Object.freeze({
                teamId: request.teamId,
                runId: parseRunId(record.runId),
                approvalId: parseHostedTeamApprovalId(record.approvalId),
                generation: parseHostedTeamApprovalGeneration(record.approvalGeneration),
                category: record.category,
                summary: record.summary,
                requestedAtMs: record.requestedAtMs,
                expiresAtMs: record.expiresAtMs,
                previewRef:
                  record.previewRef === null
                    ? null
                    : parseHostedTeamApprovalPreviewRef(record.previewRef),
              }),
              cursorAfter: cursorForApproval(record.approvalId, record.approvalGeneration),
            })
          )
        ),
        hasMore: result.hasMore,
      });
    } catch {
      return pageUnavailable();
    }
  }

  async readPreviewByOpaqueRef(
    request: HostedTeamApprovalPreviewSourceRequest,
    context: QueryContext
  ): Promise<HostedTeamApprovalPreviewSourceResult> {
    if (!contextOpen(context, this.clock, request.deadlineAtMs)) return previewUnavailable();
    try {
      const scope = await this.resolveScope(request.teamId, context, request.deadlineAtMs);
      if (scope === null) return Object.freeze({ kind: 'not_found' });
      const result = await this.dependencies.storage.hostedTeamApprovalReadPreview({
        scope,
        expectedRunId: request.expectedRunId,
        approvalId: request.approvalId,
        expectedApprovalGeneration: request.expectedGeneration,
        previewRef: request.previewRef,
        deadlineAtMs: request.deadlineAtMs,
      });
      if (!contextOpen(context, this.clock, request.deadlineAtMs)) return previewUnavailable();
      if (result.kind === 'not_found') return result;
      if (result.kind === 'stale_generation') {
        return Object.freeze({
          kind: 'stale_generation',
          currentGeneration: parseHostedTeamApprovalGeneration(result.currentApprovalGeneration),
        });
      }
      return Object.freeze({
        kind: 'found',
        preview: Object.freeze({
          teamId: request.teamId,
          runId: request.expectedRunId,
          approvalId: request.approvalId,
          generation: request.expectedGeneration,
          content: result.preview.content,
          byteLength: result.preview.byteLength,
          truncated: result.preview.truncated,
          isBinary: result.preview.isBinary,
        }),
      });
    } catch {
      return previewUnavailable();
    }
  }

  async compareAndClaimDecision(
    command: HostedTeamApprovalDecisionCommand,
    context: QueryContext
  ): Promise<HostedTeamApprovalDecisionAdmissionResult> {
    if (!contextOpen(context, this.clock, context.deadlineAtMs)) return unavailable();
    try {
      const scope = await this.resolveScope(command.teamId, context, context.deadlineAtMs);
      if (scope === null) return Object.freeze({ kind: 'not_found' });
      if (!contextOpen(context, this.clock, context.deadlineAtMs)) return unavailable();
      const result = await this.dependencies.storage.hostedTeamApprovalDecide({
        scope,
        expectedRunId: command.expectedRunId,
        approvalId: command.approvalId,
        expectedApprovalGeneration: command.expectedGeneration,
        idempotencyKey: command.idempotencyKey,
        decision: command.decision,
        payloadHash: browserDecisionIntentHash(scope, command),
        audit: {
          auditId: this.ids.nextAuditId(),
          principalId: context.actorId,
          sessionId: context.sessionId,
        },
        delivery: {
          deliveryId: this.ids.nextDeliveryId(),
        },
        deadlineAtMs: context.deadlineAtMs,
      });
      if (!contextOpen(context, this.clock, context.deadlineAtMs)) return unavailable();
      if (result.kind === 'committed' || result.kind === 'idempotent_replay') {
        if (
          result.receipt.approvalGeneration !== command.expectedGeneration ||
          result.receipt.decision !== command.decision
        ) {
          return unavailable();
        }
        return Object.freeze({ kind: result.kind, receipt: receipt(result.kind, command) });
      }
      if (result.kind === 'already_resolved') {
        return Object.freeze({
          kind: 'already_resolved',
          generation: parseHostedTeamApprovalGeneration(result.approvalGeneration),
          decision: parseDecision(result.decision),
        });
      }
      if (result.kind === 'stale_generation') {
        return Object.freeze({
          kind: 'stale_generation',
          currentGeneration: parseHostedTeamApprovalGeneration(result.currentApprovalGeneration),
        });
      }
      return result;
    } catch {
      return unavailable();
    }
  }

  private async resolveScope(
    teamId: string,
    context: QueryContext,
    deadlineAtMs: number
  ): Promise<HostedTeamApprovalAuthorityScope | null> {
    if (!contextOpen(context, this.clock, deadlineAtMs)) return null;
    const parsedTeamId = parseTeamId(teamId);
    const scope = await this.dependencies.scopeResolver.resolveScope(parsedTeamId, context);
    if (
      scope === null ||
      !scopeMatches(scope, parsedTeamId, context) ||
      !contextOpen(context, this.clock, deadlineAtMs)
    ) {
      return null;
    }
    return scope;
  }
}
