import type { RuntimeExecutionBackendKind } from '../../../contracts';
import type {
  LaneExecutionEffectLease,
  LaneExecutionReadinessReceipt,
  LaneExecutionRef,
  LaneExecutionScope,
} from './LaneExecutionBackend';

export type LaneExecutionMutationEffectKind = 'launch' | 'stop' | 'recover';

export type LaneExecutionMutationPayload =
  | {
      readonly effectKind: 'launch';
      readonly scope: LaneExecutionScope;
      readonly readiness: LaneExecutionReadinessReceipt;
    }
  | {
      readonly effectKind: 'stop';
      readonly scope: LaneExecutionScope;
      readonly executionRef: LaneExecutionRef;
      readonly mode: 'graceful' | 'immediate';
    }
  | {
      readonly effectKind: 'recover';
      readonly scope: LaneExecutionScope;
    };

export interface LaneExecutionMutationAuthorityRequest {
  readonly backend: RuntimeExecutionBackendKind;
  readonly effectKind: LaneExecutionMutationEffectKind;
  readonly operationId: string;
  readonly effectLease: LaneExecutionEffectLease;
  readonly payload: LaneExecutionMutationPayload;
}

/**
 * Core-owned exactly-once boundary for provider lifecycle mutations. Concrete
 * backends may call a compatibility mutation port only inside this callback.
 */
export interface LaneExecutionMutationAuthority {
  execute<TResult>(
    request: LaneExecutionMutationAuthorityRequest,
    effect: () => Promise<TResult>
  ): Promise<TResult>;
}
