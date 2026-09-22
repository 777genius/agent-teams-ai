import type {
  HostedPromotionBegin, HostedPromotionBeginResult, HostedPromotionLookup, HostedPromotionRecord,
  HostedPromotionStorageGateway,
} from '@features/internal-storage/contracts';

/** Captured by host composition from authenticated attribution and an admitted mount.
 * Kept separate from request fields so a future HTTP adapter cannot forward authority.
 */
export interface HostedPromotionFence {
  readonly binding: Pick<HostedPromotionBegin, 'actorId' | 'deploymentId' | 'runtimeWorkspaceId' |
    'bindingGeneration' | 'createOperationId' | 'admittedWorkspaceRoot'>;
  revalidate(): Promise<void>;
}
export interface HostedPromotionPrerequisitePorts {
  readonly storage: HostedPromotionStorageGateway;
  capture(request: HostedPromotionRequest, signal: AbortSignal): Promise<HostedPromotionFence>;
}
export type HostedPromotionRequest = Pick<HostedPromotionBegin,
  'workspaceId' | 'teamId' | 'expectedRevision' | 'idempotencyKey'>;
export interface HostedPromotionStatus {
  readonly operationId: string;
  readonly teamId: HostedPromotionRecord['teamId'];
  readonly revision: HostedPromotionRecord['expectedRevision'];
  readonly state: 'frozen_awaiting_owner_adapter';
}

/** Source prerequisite only: deliberately has no publish, launch, readiness or unfreeze method.
 * Future actual-admission/reconciliation consumes the retained record by exact operation.
 * Idle reconfiguration requires an append-only journal transition with an Owner-serialized
 * revocation/drain receipt before the SQL freeze predicate can change. Deleting state is invalid.
 */
export class FreezeHostedPromotion {
  constructor(private readonly ports: HostedPromotionPrerequisitePorts) {}

  async execute(request: HostedPromotionRequest, context: { readonly signal: AbortSignal; readonly deadlineAtMs: number }):
    Promise<HostedPromotionStatus | Exclude<HostedPromotionBeginResult, { kind: 'frozen' }>> {
    if (context.signal.aborted) throw new Error('promotion-cancelled');
    const fence = await this.ports.capture(request, context.signal);
    await fence.revalidate();
    if (context.signal.aborted) throw new Error('promotion-cancelled');
    // These async fences protect request/response projection only. The storage
    // worker must also retain current host authority inside its IMMEDIATE commit;
    // its default composition refuses begin until that real adapter is supplied.
    const result = await this.ports.storage.begin({ workspaceId: request.workspaceId, teamId: request.teamId,
      expectedRevision: request.expectedRevision, idempotencyKey: request.idempotencyKey,
      ...fence.binding, deadlineAtMs: context.deadlineAtMs }, { signal: context.signal });
    // Lost authority after commit retains the immutable operation; it never compensates by deletion.
    await fence.revalidate();
    return result.kind === 'frozen' ? promotionStatus(result.operation) : result;
  }

  /** Caller obtains fresh authorization before supplying this host-only lookup scope. */
  async status(input: HostedPromotionLookup): Promise<HostedPromotionStatus | null> {
    const operation = await this.ports.storage.lookup(input);
    return operation ? promotionStatus(operation) : null;
  }
}

function promotionStatus(operation: HostedPromotionRecord): HostedPromotionStatus {
  return { operationId: operation.operationId, teamId: operation.teamId,
    revision: operation.expectedRevision, state: 'frozen_awaiting_owner_adapter' };
}
