import {
  createSafeAppError,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
  type Revision,
  type SafeAppError,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

export const HOSTED_PROMOTION_ROUTE = '/api/hosted/v1/team-configuration/draft/promote';

export interface HostedPromoteDraftRequest {
  readonly schemaVersion: 1;
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly expectedRevision: Revision;
  readonly idempotencyKey: string;
}
export type HostedPromoteDraftResult =
  | {
      readonly schemaVersion: 1;
      readonly kind: 'promoted';
      readonly teamId: TeamId;
      readonly operationId: string;
      readonly planGeneration: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: 'error';
      readonly error: SafeAppError;
      readonly retryable: boolean;
    };

export function parseHostedPromoteDraftRequest(value: unknown): HostedPromoteDraftRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('promotion-request-invalid');
  const input = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(input).sort().join(',') !==
      'expectedRevision,idempotencyKey,schemaVersion,teamId,workspaceId' ||
    input.schemaVersion !== 1 ||
    typeof input.idempotencyKey !== 'string' ||
    !/^idempotency_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(input.idempotencyKey)
  ) {
    throw new TypeError('promotion-request-invalid');
  }
  return {
    schemaVersion: 1,
    workspaceId: parseWorkspaceId(input.workspaceId),
    teamId: parseTeamId(input.teamId),
    expectedRevision: parseRevision(input.expectedRevision),
    idempotencyKey: input.idempotencyKey,
  };
}

export function promotionError(
  code: SafeAppError['code'],
  reason: string,
  retryable: boolean
): HostedPromoteDraftResult {
  return {
    schemaVersion: 1,
    kind: 'error',
    error: createSafeAppError({ code, reason }),
    retryable,
  };
}
