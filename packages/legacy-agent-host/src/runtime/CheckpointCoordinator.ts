import type { OpenConfig } from '@agent-teams/provider-session-contracts';
import { RuntimeOwnerError } from './contracts.js';
import {
  checkpointFingerprint,
  checkpointJson,
  checkpointPayloadDigest,
  completedOperations,
} from './checkpointIdentity.js';
import { normalizeBinding, runtimeDigest } from './identity.js';
import {
  assertGenerationAvailable,
  emptySession,
  historyDigest,
  idle,
  normalizeOpenConfig,
} from './sessionState.js';
import type {
  CheckpointAttempt,
  CheckpointCoordinatorOptions,
  CheckpointPayload,
  CheckpointReceipt,
  RestoreSessionRequest,
} from './checkpointContracts.js';
import type { RuntimeBinding, RuntimeSessionRecord, RuntimeTransaction } from './contracts.js';

/** Private capture/publication and selected restore; no native token translation or backup adoption. */
export class CheckpointCoordinator {
  private readonly changed = new Map<string, Set<() => void>>();
  private readonly timeoutMs: number;
  constructor(private readonly options: CheckpointCoordinatorOptions) {
    this.timeoutMs = options.idleTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 0x7fffffff)
      throw new RuntimeOwnerError('invalid');
  }

  signal(binding: RuntimeBinding): void {
    for (const signal of this.changed.get(runtimeDigest(normalizeBinding(binding))) ?? []) signal();
  }

  lookup(binding: RuntimeBinding, checkpointId: string): CheckpointReceipt {
    this.id(checkpointId);
    return this.options.store.fenced(binding, (tx) => {
      this.authorize(binding, 'read');
      const attempt = tx.get()?.checkpoints?.find((item) => item.checkpointId === checkpointId);
      return attempt
        ? this.receipt(attempt)
        : { checkpointId, status: this.options.storage ? 'held' : 'unsupported' };
    });
  }

  async capture(binding: RuntimeBinding, checkpointId: string): Promise<CheckpointReceipt> {
    binding = normalizeBinding(binding);
    this.id(checkpointId);
    const deadline = performance.now() + this.timeoutMs;
    for (;;) {
      // Register before checking idle so terminal/control publication cannot fall into a lost-wakeup gap.
      const wait = this.wait(binding, Math.max(1, deadline - performance.now()));
      let result: CheckpointReceipt | undefined;
      try {
        result = this.captureNow(binding, checkpointId, false);
      } catch (error) {
        wait.cancel();
        throw error;
      }
      if (result) {
        wait.cancel();
        return result;
      }
      if (performance.now() >= deadline) {
        wait.cancel();
        return { checkpointId, status: 'held' };
      }
      await wait.promise;
      wait.cancel();
    }
  }

  captureBeforeClose(binding: RuntimeBinding): CheckpointReceipt {
    const checkpointId = `stop-${runtimeDigest(normalizeBinding(binding))}`;
    try {
      return (
        this.options.store.fenced(binding, (tx) => {
          const record = tx.get();
          if (
            record &&
            this.options.storage &&
            record.phase === 'closing' &&
            record.custody === 'owned' &&
            record.hostIncarnation === this.options.hostIncarnation &&
            idle(record)
          ) {
            const current = [...(record.checkpoints ?? [])]
              .reverse()
              .find(
                (item) =>
                  item.status === 'published' && item.historyDigest === historyDigest(record)
              );
            if (current?.reference) {
              try {
                const payload = this.options.storage.readCheckpointPayload(current.reference);
                if (payload.digest === current.payloadDigest) return this.receipt(current);
              } catch {
                /* Missing old payload does not become a new proof for that old reference. */
              }
            }
          }
          return undefined;
        }) ??
        this.captureNow(binding, checkpointId, true) ?? { checkpointId, status: 'held' }
      );
    } catch {
      return { checkpointId, status: 'held' };
    } // Capture failure must not skip physical cleanup.
  }

  prepareRestore(request: RestoreSessionRequest): {
    record: RuntimeSessionRecord;
    config: OpenConfig;
    allocate: boolean;
  } {
    if (!this.options.storage) throw new RuntimeOwnerError('hold');
    const binding = normalizeBinding(request.binding),
      sourceBinding = normalizeBinding(request.sourceBinding);
    this.sameMember(sourceBinding, binding);
    if (binding.generation === sourceBinding.generation) throw new RuntimeOwnerError('conflict');
    const config = { ...normalizeOpenConfig(request.config), checkpointRef: request.reference };
    const fingerprint = runtimeDigest({ profileId: this.options.profileId, config });
    return this.options.store.fenced(binding, (tx) => {
      this.authorize(binding, 'admit');
      this.authorize(sourceBinding, 'read');
      const prior = tx.get();
      if (prior?.openFingerprint) {
        if (
          prior.openFingerprint !== fingerprint ||
          prior.restoredFrom?.reference !== request.reference ||
          runtimeDigest(prior.restoredFrom.sourceBinding) !== runtimeDigest(sourceBinding)
        )
          throw new RuntimeOwnerError('conflict');
        return { record: prior, config, allocate: false };
      }
      if (prior) throw new RuntimeOwnerError('hold');
      const payload = this.options.storage!.readCheckpointPayload(request.reference);
      if (runtimeDigest(payload.sourceBinding) !== runtimeDigest(sourceBinding))
        throw new RuntimeOwnerError('conflict');
      this.source(tx, payload);
      this.compatible(payload, config);
      assertGenerationAvailable(tx, binding, config);
      const record = emptySession(binding, this.options.profileId, this.options.hostIncarnation);
      record.config = config;
      record.openFingerprint = fingerprint;
      record.phase = 'opening';
      record.custody = 'unknown';
      record.restoredFrom = { reference: request.reference, sourceBinding };
      tx.put(record, 'growth'); // The original selected opening intent precedes factory/native effects.
      return { record, config, allocate: true };
    });
  }

  /** Only the trusted driver host calls this; never register it as a public RPC method. */
  async readCheckpoint(reference: string, request: OpenConfig): Promise<unknown> {
    if (!this.options.storage || request.checkpointRef !== reference)
      throw new RuntimeOwnerError('hold');
    const config = normalizeOpenConfig(request, true);
    const payload = this.options.storage.readCheckpointPayload(reference);
    return this.options.store.fenced(payload.sourceBinding, (tx) => {
      this.authorize(payload.sourceBinding, 'read');
      this.source(tx, payload);
      this.compatible(payload, config);
      const targets = tx
        .siblings()
        .filter(
          (record) =>
            record.phase === 'opening' &&
            record.custody === 'unknown' &&
            record.restoredFrom?.reference === reference &&
            runtimeDigest(record.restoredFrom.sourceBinding) ===
              runtimeDigest(payload.sourceBinding) &&
            runtimeDigest(record.config) === runtimeDigest(config) &&
            record.hostIncarnation === this.options.hostIncarnation
        );
      if (targets.length !== 1) throw new RuntimeOwnerError('hold');
      this.authorize(targets[0]!.binding, 'admit');
      return checkpointJson(payload.opaque);
    });
  }

  private captureNow(
    binding: RuntimeBinding,
    checkpointId: string,
    stopping: boolean
  ): CheckpointReceipt | undefined {
    return this.options.store.fenced(binding, (tx) => {
      if (!stopping) this.authorize(binding, 'control');
      if (!this.options.storage) return { checkpointId, status: 'unsupported' };
      const record = tx.get();
      const existing = record?.checkpoints?.find((item) => item.checkpointId === checkpointId);
      if (existing) return this.receipt(existing); // Includes uncertain capture: never call SPI twice for one intent.
      const driver = this.options.driver(binding);
      if (
        !record?.config ||
        !driver ||
        record.hostIncarnation !== this.options.hostIncarnation ||
        record.sessionRef !== driver.sessionRef ||
        record.custody !== 'owned' ||
        (!stopping && (record.phase !== 'allocated' || record.sealed)) ||
        (stopping && record.phase !== 'closing')
      )
        return { checkpointId, status: 'held' };
      if (!idle(record)) return undefined;
      const attempt: CheckpointAttempt = {
        checkpointId,
        fingerprint: checkpointFingerprint(binding, record.profileId, record.config, checkpointId),
        hostIncarnation: this.options.hostIncarnation,
        status: 'capturing',
      };
      record.checkpoints ??= [];
      record.checkpoints.push(attempt);
      tx.put(record, 'growth'); // No native checkpoint call without the durable stable intent.
      try {
        const captured = driver.checkpoint();
        if (!captured.ok) {
          attempt.status = captured.code === 'unsupported' ? 'unsupported' : 'held';
          tx.put(record);
          return this.receipt(attempt);
        }
        const reference = `cp1-${runtimeDigest({ binding, checkpointId })}`;
        const body: Omit<CheckpointPayload, 'digest'> = {
          schemaVersion: 1,
          reference,
          checkpointId,
          fingerprint: attempt.fingerprint,
          sourceBinding: binding,
          profileId: record.profileId,
          sourceConfig: record.config,
          sourceSessionRef: record.sessionRef!,
          historyDigest: historyDigest(record),
          completedOperations: completedOperations(record),
          opaque: checkpointJson(captured.value),
        };
        const payload = { ...body, digest: checkpointPayloadDigest(body) };
        this.options.storage.writeCheckpoint(payload);
        attempt.status = 'published';
        attempt.reference = reference;
        attempt.historyDigest = payload.historyDigest;
        attempt.payloadDigest = payload.digest;
        tx.put(record); // Reference is visible only after complete payload publication.
        return this.receipt(attempt);
      } catch {
        const current = tx.get();
        const persisted = current?.checkpoints?.find((item) => item.checkpointId === checkpointId);
        if (persisted?.status === 'published') return this.receipt(persisted);
        if (persisted && current) {
          persisted.status = 'held';
          tx.put(current);
        }
        return { checkpointId, status: 'held' };
      }
    });
  }

  private source(tx: RuntimeTransaction, payload: CheckpointPayload): RuntimeSessionRecord {
    const source = tx
      .siblings()
      .find((record) => runtimeDigest(record.binding) === runtimeDigest(payload.sourceBinding));
    const published = source?.checkpoints?.find(
      (item) => item.reference === payload.reference && item.status === 'published'
    );
    if (
      !source ||
      !published ||
      published.payloadDigest !== payload.digest ||
      published.fingerprint !== payload.fingerprint ||
      source.phase !== 'closed' ||
      source.custody !== 'released' ||
      !idle(source) ||
      historyDigest(source) !== payload.historyDigest ||
      source.sessionRef !== payload.sourceSessionRef ||
      runtimeDigest(source.config) !== runtimeDigest(payload.sourceConfig)
    )
      throw new RuntimeOwnerError('hold');
    return source;
  }

  private compatible(payload: CheckpointPayload, config: OpenConfig): void {
    const effective = (value: OpenConfig): unknown => ({
      tenantId: value.tenantId,
      projectId: value.projectId,
      sessionId: value.sessionId,
      configRevision: value.configRevision,
      requiredCapabilities: value.requiredCapabilities,
    });
    if (
      payload.profileId !== this.options.profileId ||
      config.generation <= payload.sourceConfig.generation ||
      runtimeDigest(effective(config)) !== runtimeDigest(effective(payload.sourceConfig))
    )
      throw new RuntimeOwnerError('conflict');
    // Native engine/account/workspace/history compatibility is additionally validated by the driver factory.
  }
  private sameMember(source: RuntimeBinding, target: RuntimeBinding): void {
    if (
      source.backendId !== target.backendId ||
      source.teamId !== target.teamId ||
      source.memberId !== target.memberId
    )
      throw new RuntimeOwnerError('conflict');
  }
  private receipt(attempt: CheckpointAttempt): CheckpointReceipt {
    return attempt.status === 'published' && attempt.reference
      ? { checkpointId: attempt.checkpointId, status: 'published', reference: attempt.reference }
      : {
          checkpointId: attempt.checkpointId,
          status: attempt.status === 'unsupported' ? 'unsupported' : 'held',
        };
  }
  private authorize(binding: RuntimeBinding, action: 'read' | 'admit' | 'control'): void {
    if (!this.options.authorize(normalizeBinding(binding), action))
      throw new RuntimeOwnerError('forbidden');
  }
  private id(value: string): void {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value))
      throw new RuntimeOwnerError('invalid');
  }
  private wait(
    binding: RuntimeBinding,
    timeout: number
  ): { promise: Promise<void>; cancel(): void } {
    const key = runtimeDigest(binding);
    const listeners = this.changed.get(key) ?? new Set<() => void>();
    let signal!: () => void;
    const promise = new Promise<void>((resolve) => {
      signal = resolve;
    });
    listeners.add(signal);
    this.changed.set(key, listeners);
    const timer = setTimeout(signal, timeout);
    return {
      promise,
      cancel: () => {
        clearTimeout(timer);
        listeners.delete(signal);
        if (!listeners.size) this.changed.delete(key);
      },
    };
  }
}
