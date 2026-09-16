/** A cancellation source supplied by the composition root. */
export interface LifecycleCancellation {
  isCancellationRequested(): boolean;
  whenCancellationRequested(): Promise<void>;
}

/** Monotonic time and deadline scheduling supplied by the composition root. */
export interface MonotonicClock {
  nowMs(): number;
  whenMsReached(monotonicTimeMs: number): Promise<void>;
}

export interface LifecycleOperationContext {
  readonly deadlineMs: number;
  readonly cancellation: LifecycleCancellation;
}

export interface RouteAdmissionPort {
  closeAdmission(context: LifecycleOperationContext): Promise<void>;
}

export interface ReadinessPublicationPort {
  publishNotReady(context: LifecycleOperationContext): Promise<void>;
}

/**
 * A single replacement-admission generation. Implementations must check
 * `isCurrent()` immediately before making an externally visible mutation.
 */
export interface AdmissionAttempt {
  readonly generation: number;
  isCurrent(): boolean;
}

export interface ReplacementAdmissionOperationContext extends LifecycleOperationContext {
  readonly attempt: AdmissionAttempt;
}

export interface AdmissionMutationAcknowledgement {
  readonly generation: number;
  readonly disposition: 'applied' | 'duplicate' | 'stale';
}

export interface ReplacementRouteAdmissionPort extends RouteAdmissionPort {
  /** A stale attempt must be acknowledged without opening admission. */
  openAdmission(
    context: ReplacementAdmissionOperationContext
  ): Promise<AdmissionMutationAcknowledgement>;
}

export interface ReplacementReadinessPublicationPort extends ReadinessPublicationPort {
  /** A stale attempt must be acknowledged without publishing readiness. */
  publishReady(
    context: ReplacementAdmissionOperationContext
  ): Promise<AdmissionMutationAcknowledgement>;
}

export interface ConnectionDrainingPort {
  drainHttpAndSse(context: LifecycleOperationContext): Promise<void>;
}

export interface DurableStateFlushPort {
  flushDurableState(context: LifecycleOperationContext): Promise<void>;
}

export interface AuditFlushPort {
  flushAudit(context: LifecycleOperationContext): Promise<void>;
}

/** Releases only runtime resources whose ownership was transferred to this host. */
export interface OwnedRuntimeReleasePort {
  releaseOwnedRuntime(context: LifecycleOperationContext): Promise<void>;
}
