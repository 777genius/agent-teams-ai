import {
  COORDINATION_EVENT_SCOPE_KINDS,
  COORDINATION_SNAPSHOT_SCHEMA_VERSION,
  type CoordinationEventScope,
  type CoordinationResourceRevision,
  HOSTED_COORDINATION_EVENT_SSE_EVENT,
  HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION,
  HOSTED_COORDINATION_RESYNC_SSE_EVENT,
  type HostedCoordinationEventEnvelope,
  type HostedCoordinationEventStreamMessage,
  type ReplayCursor,
} from '@features/coordination-events/contracts';

import type {
  TeamTransportBootstrapSnapshot,
  TeamTransportProjectionToken,
  TeamTransportReconcilerFailure,
  TeamTransportReconcilerFailureReason,
  TeamTransportReconcilerPorts,
  TeamTransportReconciliationTarget,
  TeamTransportStreamSubscription,
} from '../ports/TeamTransportReconcilerPorts';

const DEFAULT_MAX_PROCESSED_EVENT_IDS = 2_048;
const MAX_PROCESSED_EVENT_IDS = 10_000;
const DEFAULT_MAX_PENDING_MESSAGES = 256;
const MAX_PENDING_MESSAGES = 10_000;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_REBOOTSTRAPS = 1;

export type TeamTransportReconcilerStatus =
  | 'idle'
  | 'bootstrapping'
  | 'live'
  | 'resyncing'
  | 'failed'
  | 'closed';

export interface TeamTransportReconcilerOptions<
  TSnapshot,
> extends TeamTransportReconciliationTarget {
  readonly ports: TeamTransportReconcilerPorts<TSnapshot>;
  readonly maxProcessedEventIds?: number;
  readonly maxPendingMessages?: number;
}

interface ValidatedSnapshot<TSnapshot> {
  readonly snapshot: TSnapshot;
  readonly deploymentId: string;
  readonly eventEpoch: string;
  readonly eventCursor: ReplayCursor;
  readonly revisionVector: Map<string, CoordinationResourceRevision>;
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

function validGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sameScope(left: CoordinationEventScope, right: CoordinationEventScope): boolean {
  return left.kind === right.kind && left.scopeId === right.scopeId;
}

function materializeRevisionVector(
  revisions: readonly CoordinationResourceRevision[]
): Map<string, CoordinationResourceRevision> | null {
  const vector = new Map<string, CoordinationResourceRevision>();
  for (const revision of revisions) {
    if (
      !validIdentifier(revision?.resourceKey) ||
      !validGeneration(revision.generation) ||
      !validGeneration(revision.revision) ||
      vector.has(revision.resourceKey)
    ) {
      return null;
    }
    vector.set(revision.resourceKey, Object.freeze({ ...revision }));
  }
  return vector;
}

function boundedProcessedEventCount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PROCESSED_EVENT_IDS) {
    throw new Error('invalid_team_transport_reconciler_event_id_limit');
  }
  return value;
}

function boundedPendingMessageCount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PENDING_MESSAGES) {
    throw new Error('invalid_team_transport_reconciler_pending_message_limit');
  }
  return value;
}

/**
 * Entity-agnostic snapshot/SSE coordinator. Its only state is per-instance,
 * bounded reconciliation evidence; durable authority remains on the server.
 */
export class TeamTransportReconciler<TSnapshot> {
  private readonly maxProcessedEventIds: number;
  private readonly maxPendingMessages: number;
  private readonly processedEventIds = new Map<string, true>();
  private readonly target: TeamTransportReconciliationTarget;
  private statusValue: TeamTransportReconcilerStatus = 'idle';
  private startPromise: Promise<void> | null = null;
  private operation: Promise<void> = Promise.resolve();
  private operationCycle = 0;
  private pendingMessageCount = 0;
  private subscription: TeamTransportStreamSubscription | null = null;
  private activeAbort: AbortController | null = null;
  private revisionVector = new Map<string, CoordinationResourceRevision>();
  private deploymentId: string | null = null;
  private eventEpoch: string | null = null;
  private eventCursor: ReplayCursor | null = null;
  private cycle = 0;
  private rebootstrapCount = 0;

  constructor(private readonly options: TeamTransportReconcilerOptions<TSnapshot>) {
    if (
      !options?.ports?.bootstrap ||
      !options.ports.stream ||
      !options.ports.projection ||
      !options.scope ||
      !COORDINATION_EVENT_SCOPE_KINDS.includes(options.scope.kind) ||
      !validIdentifier(options.scope?.scopeId) ||
      !validGeneration(options.scopeGeneration)
    ) {
      throw new Error('invalid_team_transport_reconciler_options');
    }
    this.target = Object.freeze({
      scope: Object.freeze({ ...options.scope }),
      scopeGeneration: options.scopeGeneration,
    });
    this.maxProcessedEventIds = boundedProcessedEventCount(
      options.maxProcessedEventIds ?? DEFAULT_MAX_PROCESSED_EVENT_IDS
    );
    this.maxPendingMessages = boundedPendingMessageCount(
      options.maxPendingMessages ?? DEFAULT_MAX_PENDING_MESSAGES
    );
  }

  get status(): TeamTransportReconcilerStatus {
    return this.statusValue;
  }

  start(): Promise<void> {
    if (this.statusValue === 'closed') return Promise.resolve();
    if (this.startPromise !== null) return this.startPromise;
    this.statusValue = 'bootstrapping';
    this.startPromise = this.bootstrap(this.nextCycle()).catch((cause: unknown) => {
      this.fail({ reason: 'bootstrap_failed', cause });
    });
    return this.startPromise;
  }

  close(): void {
    if (this.statusValue === 'closed') return;
    this.statusValue = 'closed';
    this.cycle += 1;
    this.closeActiveTransport();
    this.processedEventIds.clear();
    this.revisionVector.clear();
    this.deploymentId = null;
    this.eventEpoch = null;
    this.eventCursor = null;
    this.resetMessageQueue(this.cycle);
  }

  private nextCycle(): number {
    this.cycle += 1;
    return this.cycle;
  }

  private async bootstrap(cycle: number): Promise<void> {
    if (!this.isCurrent(cycle)) return;
    const abortController = new AbortController();
    this.activeAbort = abortController;
    let candidate: TeamTransportBootstrapSnapshot<TSnapshot>;
    try {
      candidate = await this.options.ports.bootstrap.loadSnapshot({
        ...this.target,
        signal: abortController.signal,
      });
    } catch (cause) {
      if (!this.isCurrent(cycle) || abortController.signal.aborted) return;
      await this.rebootstrapOrFail('bootstrap_failed', cycle, cause);
      return;
    }
    if (!this.isCurrent(cycle)) return;

    const validated = this.validateSnapshot(candidate);
    if ('reason' in validated) {
      await this.rebootstrapOrFail(validated.reason, cycle);
      return;
    }

    try {
      await this.options.ports.projection.replaceSnapshot({
        ...this.target,
        deploymentId: validated.deploymentId,
        eventEpoch: validated.eventEpoch,
        eventCursor: validated.eventCursor,
        revisionVector: [...validated.revisionVector.values()],
        snapshot: validated.snapshot,
      });
    } catch (cause) {
      if (this.isCurrent(cycle)) {
        await this.rebootstrapOrFail('projection_failed', cycle, cause);
      }
      return;
    }
    if (!this.isCurrent(cycle)) return;

    this.deploymentId = validated.deploymentId;
    this.eventEpoch = validated.eventEpoch;
    this.eventCursor = validated.eventCursor;
    this.revisionVector = validated.revisionVector;
    this.processedEventIds.clear();
    this.resetMessageQueue(cycle);

    let subscription: TeamTransportStreamSubscription;
    try {
      subscription = await this.options.ports.stream.subscribe({
        ...this.target,
        deploymentId: validated.deploymentId,
        eventEpoch: validated.eventEpoch,
        after: validated.eventCursor,
        signal: abortController.signal,
        onMessage: (message) => this.enqueueMessage(cycle, message),
      });
    } catch (cause) {
      if (this.isCurrent(cycle)) {
        await this.rebootstrapOrFail('stream_failed', cycle, cause);
      }
      return;
    }
    if (!this.isCurrent(cycle)) {
      subscription.close();
      return;
    }
    this.subscription = subscription;
    this.statusValue = 'live';
  }

  private validateSnapshot(
    candidate: TeamTransportBootstrapSnapshot<TSnapshot>
  ): ValidatedSnapshot<TSnapshot> | { readonly reason: TeamTransportReconcilerFailureReason } {
    if (!candidate || !candidate.envelope?.metadata) return { reason: 'invalid_snapshot' };
    if (!sameScope(candidate.scope, this.target.scope)) return { reason: 'scope_mismatch' };
    if (candidate.scopeGeneration !== this.target.scopeGeneration) {
      return { reason: 'generation_mismatch' };
    }
    const { metadata } = candidate.envelope;
    if (
      metadata.schemaVersion !== COORDINATION_SNAPSHOT_SCHEMA_VERSION ||
      !validIdentifier(metadata.deploymentId) ||
      !validIdentifier(metadata.eventEpoch) ||
      !validIdentifier(metadata.replayCursor) ||
      (metadata.handoffMode !== 'same_transaction' && metadata.handoffMode !== 'lower_barrier') ||
      !Array.isArray(metadata.revisionVector)
    ) {
      return { reason: 'invalid_snapshot' };
    }
    const revisionVector = materializeRevisionVector(metadata.revisionVector);
    if (revisionVector === null) return { reason: 'invalid_snapshot' };
    return {
      snapshot: candidate.envelope.snapshot,
      deploymentId: metadata.deploymentId,
      eventEpoch: metadata.eventEpoch,
      eventCursor: metadata.replayCursor,
      revisionVector,
    };
  }

  private enqueueMessage(
    cycle: number,
    message: HostedCoordinationEventStreamMessage
  ): Promise<void> {
    if (!this.isCurrent(cycle)) return Promise.resolve();
    if (this.operationCycle !== cycle) this.resetMessageQueue(cycle);
    if (this.pendingMessageCount >= this.maxPendingMessages) {
      return this.rebootstrapOrFail('pending_queue_overflow', cycle);
    }
    this.pendingMessageCount += 1;
    const next = this.operation
      .then(() => this.processMessage(cycle, message))
      .finally(() => {
        if (this.operationCycle === cycle) this.pendingMessageCount -= 1;
      });
    this.operation = next.catch(() => undefined);
    return next;
  }

  private resetMessageQueue(cycle: number): void {
    this.operationCycle = cycle;
    this.pendingMessageCount = 0;
    this.operation = Promise.resolve();
  }

  private async processMessage(
    cycle: number,
    message: HostedCoordinationEventStreamMessage
  ): Promise<void> {
    if (!this.isCurrent(cycle) || this.statusValue !== 'live') return;
    if (!message || message.schemaVersion !== HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION) {
      await this.rebootstrapOrFail('invalid_message', cycle);
      return;
    }
    if (message.kind === HOSTED_COORDINATION_RESYNC_SSE_EVENT) {
      await this.rebootstrapOrFail('resync_required', cycle);
      return;
    }
    if (message.kind !== HOSTED_COORDINATION_EVENT_SSE_EVENT) {
      await this.rebootstrapOrFail('invalid_message', cycle);
      return;
    }
    await this.processEvent(cycle, message);
  }

  private async processEvent(cycle: number, event: HostedCoordinationEventEnvelope): Promise<void> {
    const identityFailure = this.eventIdentityFailure(event);
    if (identityFailure !== null) {
      await this.rebootstrapOrFail(identityFailure, cycle);
      return;
    }
    if (this.processedEventIds.has(event.eventId)) return;
    if (event.previousEventCursor !== this.eventCursor || event.eventCursor === this.eventCursor) {
      await this.rebootstrapOrFail('cursor_gap', cycle);
      return;
    }

    const revisionDecision = this.revisionDecision(event.resourceRevision);
    if (revisionDecision === 'gap') {
      await this.rebootstrapOrFail('revision_gap', cycle);
      return;
    }
    if (revisionDecision === 'stale') {
      this.commitEventEvidence(event);
      return;
    }

    try {
      const result = await this.options.ports.projection.applyEvent({
        ...this.target,
        event,
        projectionToken: this.projectionToken(cycle),
      });
      if (!this.isCurrent(cycle)) return;
      if (result === 'refresh_required') {
        await this.rebootstrapOrFail('projection_failed', cycle);
        return;
      }
      if (result !== 'applied') {
        await this.rebootstrapOrFail('projection_failed', cycle);
        return;
      }
    } catch (cause) {
      if (this.isCurrent(cycle)) {
        await this.rebootstrapOrFail('projection_failed', cycle, cause);
      }
      return;
    }
    if (!this.isCurrent(cycle)) return;
    if (event.resourceRevision) {
      this.revisionVector.set(
        event.resourceRevision.resourceKey,
        Object.freeze({ ...event.resourceRevision })
      );
    }
    this.commitEventEvidence(event);
  }

  private eventIdentityFailure(
    event: HostedCoordinationEventEnvelope
  ): TeamTransportReconcilerFailureReason | null {
    if (
      !validIdentifier(event.eventId) ||
      !validIdentifier(event.eventCursor) ||
      !validIdentifier(event.previousEventCursor) ||
      !validIdentifier(event.eventType) ||
      !validGeneration(event.eventSequence) ||
      !event.scope ||
      !validIdentifier(event.scope.scopeId)
    ) {
      return 'invalid_message';
    }
    if (!sameScope(event.scope, this.target.scope)) return 'scope_mismatch';
    if (event.deploymentId !== this.deploymentId) return 'deployment_mismatch';
    if (event.eventEpoch !== this.eventEpoch) return 'epoch_mismatch';
    return null;
  }

  private revisionDecision(
    revision: CoordinationResourceRevision | undefined
  ): 'apply' | 'stale' | 'gap' {
    if (revision === undefined) return 'apply';
    if (
      !validIdentifier(revision.resourceKey) ||
      !validGeneration(revision.generation) ||
      !validGeneration(revision.revision)
    ) {
      return 'gap';
    }
    const current = this.revisionVector.get(revision.resourceKey);
    if (!current) return 'apply';
    if (revision.generation < current.generation) return 'stale';
    if (revision.generation > current.generation) return 'apply';
    if (revision.revision <= current.revision) return 'stale';
    return revision.revision === current.revision + 1 ? 'apply' : 'gap';
  }

  private commitEventEvidence(event: HostedCoordinationEventEnvelope): void {
    this.eventCursor = event.eventCursor;
    this.processedEventIds.delete(event.eventId);
    this.processedEventIds.set(event.eventId, true);
    const oldest = this.processedEventIds.keys().next();
    if (this.processedEventIds.size > this.maxProcessedEventIds && !oldest.done) {
      this.processedEventIds.delete(oldest.value);
    }
  }

  private projectionToken(cycle: number): TeamTransportProjectionToken {
    return Object.freeze({
      cycle,
      commitIfCurrent: (commit: () => void): boolean => {
        if (!this.isCurrent(cycle)) return false;
        commit();
        return true;
      },
    });
  }

  private async rebootstrapOrFail(
    reason: TeamTransportReconcilerFailureReason,
    cycle: number,
    cause?: unknown
  ): Promise<void> {
    if (!this.isCurrent(cycle)) return;
    if (this.rebootstrapCount >= MAX_REBOOTSTRAPS) {
      this.fail({ reason, ...(cause === undefined ? {} : { cause }) });
      return;
    }
    this.rebootstrapCount += 1;
    this.statusValue = 'resyncing';
    this.closeActiveTransport();
    this.processedEventIds.clear();
    this.revisionVector.clear();
    this.deploymentId = null;
    this.eventEpoch = null;
    this.eventCursor = null;
    const nextCycle = this.nextCycle();
    this.resetMessageQueue(nextCycle);
    await this.bootstrap(nextCycle);
  }

  private closeActiveTransport(): void {
    this.activeAbort?.abort();
    this.activeAbort = null;
    const subscription = this.subscription;
    this.subscription = null;
    try {
      subscription?.close();
    } catch {
      // Closing is best effort and must remain idempotent for stale cycles.
    }
  }

  private fail(failure: TeamTransportReconcilerFailure): void {
    if (this.statusValue === 'closed' || this.statusValue === 'failed') return;
    this.statusValue = 'failed';
    this.cycle += 1;
    this.closeActiveTransport();
    this.resetMessageQueue(this.cycle);
    this.options.ports.observer?.onFailure?.(Object.freeze(failure));
  }

  private isCurrent(cycle: number): boolean {
    return cycle === this.cycle && this.statusValue !== 'closed' && this.statusValue !== 'failed';
  }
}
