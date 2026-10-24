import { normalizeRuntimeDelivery, findRuntimeInput, runtimeAdmission } from './runtimeDelivery.js';
import { prepareSessionOpen } from './prepareSessionOpen.js';
import { preparedInputProof, prepareRuntimeInput, recordContextEpoch } from './inputPreparation.js';
import { randomUUID } from 'node:crypto';

import type { RuntimeProviderActivity } from './providerActivityContracts.js';
import { RuntimeOwnerError } from './contracts.js';
import { CheckpointCoordinator } from './CheckpointCoordinator.js';
import { RuntimeActivityCoordinator } from './RuntimeActivityCoordinator.js';
import type {
  RuntimeActivityCursor,
  RuntimeActivityFeed,
  RuntimeActivitySnapshot,
} from './activityContracts.js';
import {
  activeInput as active,
  emptySession,
  normalizeOpenConfig,
} from './sessionState.js';
import type {
  CheckpointAvailability,
  CheckpointReceipt,
  RestoreSessionRequest,
} from './checkpointContracts.js';
import { deliveryFingerprint, normalizeBinding, runtimeDigest } from './identity.js';
import type {
  RuntimeAdmission,
  RuntimeBinding,
  RuntimeDelivery,
  RuntimeInput,
  RuntimeOwnerOptions,
  RuntimeSessionRecord,
  RuntimeTransaction,
} from './contracts.js';
import type {
  Event,
  InteractionReply,
  OpenConfig,
  Session,
} from '@agent-teams/provider-session-contracts';

/** One durable technical dispatch owner; no Task policy or provider protocol implementation. */
export class RuntimeOwner {
  private readonly drivers = new Map<string, Session>();
  private readonly closes = new Map<string, Promise<RuntimeSessionRecord>>();
  private readonly controls = new Map<string, Set<Promise<unknown>>>();
  private readonly checkpoints: CheckpointCoordinator;
  private readonly activity: RuntimeActivityCoordinator;
  private readonly maxQueued: number;
  private readonly maxBytes: number;
  private readonly maxInteractions: number;
  private readonly interactionTtl: number;

  constructor(private readonly options: RuntimeOwnerOptions) {
    this.maxQueued = options.maxQueuedInputs ?? 128;
    this.maxBytes = options.maxInputBytes ?? 64 * 1024;
    this.maxInteractions = options.maxPendingInteractions ?? 32;
    this.interactionTtl = options.interactionTtlMs ?? 300_000;
    if (
      !options.profileId ||
      !options.hostIncarnation ||
      [this.maxQueued, this.maxBytes, this.maxInteractions, this.interactionTtl].some(
        (value) => !Number.isSafeInteger(value) || value <= 0
      )
    )
      throw new RuntimeOwnerError('invalid');
    this.activity = new RuntimeActivityCoordinator(options);
    this.checkpoints = new CheckpointCoordinator({
      store: this.activity,
      profileId: options.profileId,
      hostIncarnation: options.hostIncarnation,
      authorize: options.authorize,
      driver: (binding) => this.drivers.get(this.key(binding)),
      ...(options.checkpoints ? { storage: options.checkpoints } : {}),
      ...(options.checkpointIdleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: options.checkpointIdleTimeoutMs }),
    });
  }

  readActivitySnapshot(binding: RuntimeBinding): RuntimeActivitySnapshot {
    return this.activity.snapshot(binding);
  }
  readActivityFeed(binding: RuntimeBinding, cursor: RuntimeActivityCursor): RuntimeActivityFeed {
    return this.activity.feed(binding, cursor);
  }

  /** Private Host composition input, not exposed by RPC or the provider Session SPI. */
  observeProviderActivity(binding: RuntimeBinding, sessionRef: string, observation: RuntimeProviderActivity): void {
    this.activity.observeProviderActivity(normalizeBinding(binding), sessionRef, observation);
  }

  captureCheckpoint(input: {
    binding: RuntimeBinding;
    checkpointId: string;
  }, assertAuthority?: () => void): Promise<CheckpointReceipt> {
    return this.checkpoints.capture(input.binding, input.checkpointId, assertAuthority);
  }
  lookupCheckpoint(binding: RuntimeBinding, checkpointId: string): CheckpointReceipt {
    return this.checkpoints.lookup(binding, checkpointId);
  }
  readCheckpoints(binding: RuntimeBinding, nextConfig: OpenConfig): CheckpointAvailability {
    return this.checkpoints.readAvailable(binding, nextConfig);
  }
  /** Private DriverHost callback; never expose opaque checkpoint bytes through RPC. */
  readCheckpoint(reference: string, request: OpenConfig): Promise<unknown> {
    return this.checkpoints.readCheckpoint(reference, request);
  }
  validateRestoreSource(request: RestoreSessionRequest): void {
    this.checkpoints.validateRestoreSource(request);
  }
  async restoreSession(request: RestoreSessionRequest, assertAuthority?: () => void): Promise<RuntimeSessionRecord> {
    assertAuthority?.();
    const prepared = this.checkpoints.prepareRestore(request);
    return prepared.allocate
      ? this.allocate(prepared.record.binding, prepared.config, assertAuthority)
      : prepared.record;
  }

  readSession(binding: RuntimeBinding): {
    record: RuntimeSessionRecord | undefined;
    attached: boolean;
  } {
    binding = normalizeBinding(binding);
    return this.activity.fenced(binding, (tx) => {
      this.authorize(binding, 'read');
      return { record: tx.get(), attached: this.drivers.has(this.key(binding)) };
    });
  }

  /** Trusted composition custody inspection, like stopCapturedSession; never expose over RPC. */
  readCapturedSession(binding: RuntimeBinding): {
    record: RuntimeSessionRecord | undefined;
    attached: boolean;
  } {
    binding = normalizeBinding(binding);
    return this.activity.fenced(binding, (tx) => ({
      record: tx.get(),
      attached: this.drivers.has(this.key(binding)),
    }));
  }

  fingerprintDelivery(intent: RuntimeDelivery): string {
    return deliveryFingerprint(normalizeRuntimeDelivery(intent, this.maxBytes));
  }

  async openSession(
    input: { binding: RuntimeBinding; config: OpenConfig },
    assertAuthority?: () => void
  ): Promise<RuntimeSessionRecord> {
    return this.open(input, assertAuthority);
  }
  /** Private explicit fresh intent only. Ordinary open/restore retain unresolved-history guards. */
  async openFreshMemberSession(
    input: {
      sourceBinding: RuntimeBinding;
      binding: RuntimeBinding;
      config: OpenConfig;
    },
    assertAuthority: () => void
  ): Promise<RuntimeSessionRecord> {
    const source = normalizeBinding(input.sourceBinding),
      target = normalizeBinding(input.binding);
    if (
      typeof assertAuthority !== 'function' ||
      source.generation === target.generation ||
      ['backendId', 'teamId', 'runId', 'memberId'].some(
        (k) => source[k as 'memberId'] !== target[k as 'memberId']
      )
    )
      throw new RuntimeOwnerError('invalid');
    return this.open(input, assertAuthority, source);
  }
  private async open(
    input: { binding: RuntimeBinding; config: OpenConfig },
    assertAuthority?: () => void,
    freshSource?: RuntimeBinding
  ): Promise<RuntimeSessionRecord> {
    const binding = normalizeBinding(input.binding);
    const config = normalizeOpenConfig(input.config);
    const fingerprint = runtimeDigest({
      profileId: this.options.profileId,
      config,
    });
    const prepared = this.activity.fenced(binding, (tx) => {
      assertAuthority?.();
      this.authorize(binding, 'admit');
      return prepareSessionOpen({
        tx,
        binding,
        config,
        fingerprint,
        hostIncarnation: this.options.hostIncarnation,
        empty: () => this.empty(binding),
        ...(freshSource ? { freshSource } : {}),
        hasInFlight: (sibling) =>
          this.drivers.has(this.key(sibling)) ||
          !!this.controls.get(this.key(sibling))?.size ||
          this.closes.has(this.key(sibling)),
      });
    });
    if (!prepared.allocate) return prepared.record;
    return this.allocate(binding, config, assertAuthority);
  }

  private async allocate(
    binding: RuntimeBinding,
    config: OpenConfig,
    assertAuthority?: () => void
  ): Promise<RuntimeSessionRecord> {
    try {
      assertAuthority?.();
      const opened = await this.options.driverFactory.open(config, assertAuthority);
      this.drivers.set(this.key(binding), opened.driver);
      if (
        typeof opened.driver.sessionRef !== 'string' ||
        !opened.driver.sessionRef ||
        opened.driver.sessionRef.length > 1024
      )
        throw new RuntimeOwnerError('hold');
      let record = this.publish(binding, (current) => {
        if (!this.options.authorize(binding, 'admit') || !this.authorityCurrent(assertAuthority)) current.sealed = true;
        current.sessionRef = opened.driver.sessionRef;
        current.custody = 'owned';
        current.phase = current.sealed ? 'closing' : 'allocated';
      });
      void this.observe(binding, opened.driver);
      if (record.sealed) return await this.stopOwned(binding, true);
      const ready = await opened.driver.checkReadiness();
      record = this.publish(binding, (current) => {
        if (current.phase !== 'allocated' || current.sealed) return;
        current.nativeReady =
          ready.ok &&
          config.requiredCapabilities.every((capability) =>
            opened.capabilities.includes(capability)
          );
        if (!current.nativeReady) current.diagnostic = 'readiness-unavailable';
      });
      return record;
    } catch {
      return this.publish(binding, (current) => {
        if (current.phase === 'closed') return;
        current.phase = 'held';
        current.nativeReady = false;
        current.custody = 'unknown';
        current.diagnostic = 'open-unknown';
      });
    }
  }

  async admitDelivery(raw: RuntimeDelivery): Promise<RuntimeAdmission> {
    const intent = normalizeRuntimeDelivery(raw, this.maxBytes);
    return this.activity.fenced(intent.binding, (tx) => {
      this.authorize(intent.binding, 'admit', intent);
      const record = tx.get() ?? this.empty(intent.binding);
      const existing = findRuntimeInput(record, intent);
      if (existing) return runtimeAdmission(existing);
      if (record.sealed) return { inputId: intent.inputId, outcome: 'not_admitted' };
      if (
        record.inputs.filter((input) => input.phase === 'admitted' || active(input)).length >=
        this.maxQueued
      ) {
        throw new RuntimeOwnerError('busy');
      }
      const input: RuntimeInput = {
        intent,
        fingerprint: deliveryFingerprint(intent),
        operationRef: randomUUID(),
        phase: 'admitted',
      };
      record.inputs.push(input);
      tx.put(record, 'growth');
      return runtimeAdmission(input);
    });
  }

  async lookupDelivery(raw: RuntimeDelivery): Promise<RuntimeAdmission> {
    const intent = normalizeRuntimeDelivery(raw, this.maxBytes);
    return this.activity.fenced(intent.binding, (tx) => {
      this.authorize(intent.binding, 'read', intent);
      const record = tx.get();
      const input = record && findRuntimeInput(record, intent);
      return input ? runtimeAdmission(input) : { inputId: intent.inputId, outcome: 'not_admitted' };
    });
  }

  async cancelDelivery(raw: RuntimeDelivery): Promise<RuntimeAdmission> {
    const intent = normalizeRuntimeDelivery(raw, this.maxBytes);
    return this.activity.fenced(intent.binding, (tx) => {
      this.authorize(intent.binding, 'control', intent);
      const record = tx.get() ?? this.empty(intent.binding);
      let input = findRuntimeInput(record, intent);
      const unseen = !input;
      if (!input) {
        input = {
          intent,
          fingerprint: deliveryFingerprint(intent),
          operationRef: randomUUID(),
          phase: 'cancelled',
        };
        record.inputs.push(input);
      } else if (input.phase === 'admitted') input.phase = 'cancelled';
      tx.put(record, unseen ? 'growth' : undefined); // Includes unseen delivery IDs: a late outbox admission cannot resurrect them.
      return active(input)
        ? { inputId: input.intent.inputId, outcome: 'unknown' }
        : runtimeAdmission(input);
    });
  }

  async dispatchNext(binding: RuntimeBinding): Promise<RuntimeSessionRecord> {
    binding = normalizeBinding(binding);
    const claimed = this.activity.fenced(binding, (tx) => {
      const record = this.record(tx);
      const next = record.inputs.find((item) => item.phase === 'admitted');
      if (!this.options.authorize(normalizeBinding(binding), 'dispatch', next?.intent)) {
        for (const input of record.inputs) {
          if (
            input.phase === 'admitted' &&
            !this.options.authorize(normalizeBinding(binding), 'dispatch', input.intent)
          )
            input.phase = 'rejected';
        }
        tx.put(record);
        throw new RuntimeOwnerError('forbidden');
      }
      const driver = this.ownedDriver(record);
      if (
        record.sealed ||
        record.phase !== 'allocated' ||
        !record.nativeReady ||
        record.control ||
        record.checkpoints?.some((attempt) => attempt.status === 'capturing') ||
        record.inputs.some(active)
      ) {
        throw new RuntimeOwnerError('hold');
      }
      const input = record.inputs.find((item) => item.phase === 'admitted');
      if (!input) return { record, driver, input: undefined };
      if (!this.options.canDispatch?.(binding, input.intent)) throw new RuntimeOwnerError('hold');
      const selected = this.options.prepareInput?.(binding, {
        sessionRef: record.sessionRef!, inputId: input.intent.inputId, operationRef: input.operationRef,
        intentFingerprint: input.fingerprint, originalContentBytes: Buffer.byteLength(input.intent.content), epochs: structuredClone(record.contextEpochs ?? []),
        priorProofs: record.inputs.flatMap(value => value.preparation ? [preparedInputProof(value.preparation)] : []),
      });
      if (selected) input.preparation = prepareRuntimeInput(binding, input, selected, this.maxBytes);
      input.phase = 'claimed';
      tx.put(record); // The only submit claim; exact native supplement is durable before handoff.
      if (input.preparation) this.options.inputPrepared?.(binding, preparedInputProof(input.preparation));
      return { record, driver, input };
    });
    const input = claimed.input;
    if (!input) return claimed.record;
    let phase: RuntimeInput['phase'] = 'unknown';
    try {
      const reply = await claimed.driver.submit({
        inputId: input.intent.inputId,
        operationRef: input.operationRef,
        content: (input.preparation?.prefix ?? '') + input.intent.content,
        ...(input.intent.attachments?.length ? { attachments: input.intent.attachments } : {}),
      });
      if (
        reply.ok &&
        reply.value.inputId === input.intent.inputId &&
        reply.value.operationRef === input.operationRef
      )
        phase = 'consumed';
      else if (!reply.ok && reply.delivery === 'known-not-sent') phase = 'not-sent';
    } catch {
      /* Uncertain native handoff remains held, never a second submit. */
    }
    return this.publish(binding, (record) => {
      const current = record.inputs.find((item) => item.operationRef === input.operationRef);
      if (current?.phase === 'claimed') current.phase = phase;
    });
  }

  async interrupt(binding: RuntimeBinding, inputId: string, assertAuthority?: () => void): Promise<RuntimeSessionRecord> {
    binding = normalizeBinding(binding);
    const target = this.activity.fenced(binding, (tx) => {
      assertAuthority?.();
      this.authorize(binding, 'control');
      const record = this.record(tx);
      const driver = this.ownedDriver(record);
      const input = record.inputs.find((item) => item.intent.inputId === inputId);
      if (!input || !active(input)) return { record, driver, operationRef: undefined };
      if (record.control || record.closeClaimed) throw new RuntimeOwnerError('hold');
      record.control = { inputId, operationRef: input.operationRef, phase: 'pending' };
      tx.put(record);
      return { record, driver, operationRef: input.operationRef };
    });
    if (!target.operationRef) return target.record; // Late interrupt A cannot become interrupt B.
    const operationRef = target.operationRef;
    return this.trackControl(
      binding,
      Promise.resolve().then(async () => {
        let requested = false;
        try {
          const permitted = this.activity.fenced(binding, (tx) => {
            const record = this.record(tx);
            return !record.sealed && record.phase === 'allocated' &&
              record.control?.operationRef === operationRef &&
              record.control.phase === 'pending' &&
              record.inputs.some((input) => input.operationRef === operationRef && active(input)) &&
              this.options.authorize(binding, 'control') && this.authorityCurrent(assertAuthority);
          });
          if (permitted) requested = (await target.driver.interrupt(operationRef)).ok;
        } catch {
          /* held */
        }
        return this.publish(binding, (record) => {
          if (record.control?.operationRef !== operationRef) return;
          if (requested) delete record.control;
          else record.control.phase = 'unknown';
        });
      })
    );
  }

  async respondToInteraction(
    binding: RuntimeBinding,
    inputId: string,
    interactionRef: string,
    reply: InteractionReply,
    assertAuthority?: () => void
  ): Promise<RuntimeSessionRecord> {
    binding = normalizeBinding(binding);
    const target = this.activity.fenced(binding, (tx) => {
      assertAuthority?.();
      this.authorize(binding, 'control');
      const record = this.record(tx);
      const driver = this.ownedDriver(record);
      const interaction = record.interactions.find(
        (item) => item.interactionRef === interactionRef
      );
      const input = record.inputs.find((item) => item.intent.inputId === inputId);
      if (
        record.sealed ||
        !interaction ||
        interaction.inputId !== inputId ||
        interaction.kind !== reply.kind ||
        interaction.phase !== 'pending' ||
        interaction.expiresAt <= Date.now() ||
        !input ||
        !active(input)
      ) {
        throw new RuntimeOwnerError('hold');
      }
      interaction.phase = 'responding';
      tx.put(record);
      return driver;
    });
    return this.trackControl(
      binding,
      Promise.resolve().then(async () => {
        let accepted = false;
        const permitted = this.activity.fenced(binding, (tx) => {
          const current = this.record(tx);
          const interaction = current.interactions.find(
            (item) => item.interactionRef === interactionRef
          );
          const input = current.inputs.find((item) => item.intent.inputId === inputId);
          return (
            !current.sealed &&
            current.phase === 'allocated' &&
            !current.control &&
            interaction?.phase === 'responding' &&
            interaction.inputId === inputId &&
            interaction.kind === reply.kind &&
            interaction.expiresAt > Date.now() &&
            input !== undefined &&
            input.operationRef === interaction.operationRef &&
            active(input) &&
            this.options.authorize(binding, 'control') &&
            this.authorityCurrent(assertAuthority)
          );
        });
        try {
          if (permitted) accepted = (await target.respondToInteraction(interactionRef, reply)).ok;
        } catch {
          /* held */
        }
        return this.publish(binding, (record) => {
          const interaction = record.interactions.find(
            (item) => item.interactionRef === interactionRef
          );
          if (interaction?.phase === 'responding')
            interaction.phase = accepted ? 'resolved' : 'unknown';
        });
      })
    );
  }

  async stopSession(binding: RuntimeBinding, assertAuthority?: () => void): Promise<RuntimeSessionRecord> {
    return this.stopOwned(normalizeBinding(binding), false, assertAuthority);
  }

  /** Trusted composition shutdown only; never register as a business RPC or MCP tool. */
  async stopCapturedSession(binding: RuntimeBinding): Promise<RuntimeSessionRecord> {
    return this.stopOwned(normalizeBinding(binding), true);
  }

  private async stopOwned(
    binding: RuntimeBinding,
    capturedCleanup = false,
    assertAuthority?: () => void
  ): Promise<RuntimeSessionRecord> {
    const target = this.activity.fenced<{
      record: RuntimeSessionRecord;
      driver: Session | undefined;
      wait?: Promise<unknown>;
    }>(binding, (tx) => {
      assertAuthority?.();
      if (!capturedCleanup) this.authorize(binding, 'control');
      const saved = tx.get();
      const record = saved ?? (capturedCleanup ? this.empty(binding) : this.record(tx));
      const before = saved ? runtimeDigest(saved) : undefined;
      // Repeated cleanup preserves settled debt bytes without skipping any owned control/close work.
      const persistStop = () => { if (runtimeDigest(record) !== before) tx.put(record); };
      if (record.phase === 'closed' && record.sealed && !record.nativeReady &&
        !record.inputs.some(input => input.phase === 'admitted') &&
        !record.interactions.some(interaction => interaction.phase === 'pending'))
        return { record, driver: undefined };
      record.sealed = true;
      record.nativeReady = false;
      for (const input of record.inputs) if (input.phase === 'admitted') input.phase = 'cancelled';
      for (const interaction of record.interactions)
        if (interaction.phase === 'pending') interaction.phase = 'unknown';
      if (record.phase === 'closed') {
        persistStop();
        return { record, driver: undefined };
      }
      if (record.phase === 'unopened') {
        record.phase = 'closed';
        record.custody = 'released';
        persistStop();
        return { record, driver: undefined };
      }
      if (record.closeClaimed && !this.closes.has(this.key(binding))) {
        // A settled/abandoned close claim cannot become a new close or appear in flight again.
        record.phase = 'held';
        record.custody = 'unknown';
        persistStop();
        return { record, driver: undefined };
      }
      record.phase = 'closing';
      const driver =
        record.hostIncarnation === this.options.hostIncarnation
          ? this.drivers.get(this.key(binding))
          : undefined;
      if (!driver) {
        record.phase = 'held';
        record.custody = 'unknown';
      }
      const controls = this.controls.get(this.key(binding));
      if (!record.closeClaimed && controls?.size) {
        persistStop();
        return { record, driver: undefined, wait: Promise.allSettled([...controls]) };
      }
      if (record.closeClaimed || record.control?.phase === 'pending') {
        persistStop();
        return { record, driver: undefined };
      }
      if (driver) record.closeClaimed = true;
      persistStop();
      return { record, driver };
    });
    if (target.wait) {
      await target.wait;
      return this.stopOwned(binding, true, assertAuthority); // Continue this stop intent after its accepted controls settle.
    }
    if (!target.driver) return this.closes.get(this.key(binding)) ?? target.record;
    const driver = target.driver;
    const closing = (async () => {
      let confirmed = false;
      try {
        assertAuthority?.();
        this.checkpoints.captureBeforeClose(binding);
        assertAuthority?.();
        confirmed = (await driver.close()).cleanup === 'confirmed';
      } catch {
        /* custody retained */
      }
      const result = this.publish(binding, (record) => {
        record.phase = confirmed ? 'closed' : 'held';
        record.custody = confirmed ? 'released' : 'unknown';
        if (!confirmed) record.diagnostic = 'close-unknown';
        for (const input of record.inputs) if (active(input)) input.phase = 'unknown';
      });
      if (confirmed && this.drivers.get(this.key(binding)) === driver)
        this.drivers.delete(this.key(binding));
      return result;
    })();
    this.closes.set(this.key(binding), closing);
    void closing.then(
      () => this.closes.delete(this.key(binding)),
      () => this.closes.delete(this.key(binding))
    );
    return closing;
  }

  /** Explicit recovery command. Never adopts a driver or replays a claimed effect. */
  reconcileSession(binding: RuntimeBinding): RuntimeSessionRecord {
    binding = normalizeBinding(binding);
    return this.activity.fenced(binding, (tx) => {
      this.authorize(binding, 'control');
      const record = this.record(tx);
      if (
        record.phase === 'unopened' ||
        (record.phase === 'closed' && record.custody === 'released')
      )
        return record;
      if (
        record.hostIncarnation === this.options.hostIncarnation &&
        this.drivers.has(this.key(binding))
      )
        return record;
      record.phase = 'held';
      record.custody = 'unknown';
      record.nativeReady = false;
      for (const input of record.inputs) if (active(input)) input.phase = 'unknown';
      for (const interaction of record.interactions)
        if (interaction.phase !== 'resolved') interaction.phase = 'unknown';
      if (record.control) record.control.phase = 'unknown';
      tx.put(record);
      return record;
    });
  }

  private async observe(binding: RuntimeBinding, driver: Session): Promise<void> {
    let diagnostic: RuntimeSessionRecord['diagnostic'] = 'observe-ended';
    try {
      for await (const event of driver.observe()) {
        this.activity.observe(binding, driver.sessionRef, event, (record) => {
          this.applyEvent(record, event);
          this.checkpoints.signal(binding);
        });
      }
    } catch {
      diagnostic = 'observe-failed';
    }
    try {
      this.activity.fenced(binding, (tx) => {
        const record = this.record(tx);
        if (record.hostIncarnation !== this.options.hostIncarnation || record.phase === 'closed')
          return;
        record.diagnostic = diagnostic;
        record.nativeReady = false;
        for (const input of record.inputs) if (active(input)) input.phase = 'unknown';
        tx.put(record);
      });
    } catch {
      /* Store failures are not converted to successful outcomes or new dispatch. */
    }
  }

  private trackControl<T>(binding: RuntimeBinding, work: Promise<T>): Promise<T> {
    const key = this.key(binding);
    const pending = this.controls.get(key) ?? new Set<Promise<unknown>>();
    pending.add(work);
    this.controls.set(key, pending);
    const release = (): void => {
      pending.delete(work);
      if (!pending.size && this.controls.get(key) === pending) this.controls.delete(key);
    };
    void work.then(release, release);
    return work;
  }

  private applyEvent(record: RuntimeSessionRecord, event: Event): void {
    if (event.kind === 'compaction') { recordContextEpoch(record, event); return; }
    const input = record.inputs.find(
      (item) => item.intent.inputId === event.inputId && item.operationRef === event.operationRef
    );
    if (!input || !active(input)) return;
    if (event.kind === 'result') {
      if (event.outcome === 'unknown') input.phase = 'unknown';
      else {
        input.phase = 'terminal';
        input.terminal = event.outcome;
      }
      for (const interaction of record.interactions)
        if (interaction.inputId === input.intent.inputId && interaction.phase !== 'resolved')
          interaction.phase = 'unknown';
    } else if (event.kind === 'interaction' && !record.sealed) {
      if (record.interactions.some((item) => item.interactionRef === event.interactionRef)) return;
      if (
        record.interactions.filter((item) => ['pending', 'responding'].includes(item.phase))
          .length >= this.maxInteractions
      ) {
        record.nativeReady = false;
        return;
      }
      record.interactions.push({
        interactionRef: event.interactionRef,
        inputId: input.intent.inputId,
        operationRef: input.operationRef,
        kind: event.request.kind,
        expiresAt: Date.now() + this.interactionTtl,
        phase: 'pending',
      });
    }
  }

  private publish(
    binding: RuntimeBinding,
    mutate: (record: RuntimeSessionRecord) => void
  ): RuntimeSessionRecord {
    return this.activity.fenced(binding, (tx) => {
      const record = this.record(tx);
      mutate(record);
      tx.put(record);
      this.checkpoints.signal(binding);
      return record;
    });
  }
  private authorityCurrent(assertAuthority?: () => void): boolean {
    try { assertAuthority?.(); return true; }
    catch { return false; }
  }
  private authorize(
    binding: RuntimeBinding,
    action: 'read' | 'admit' | 'dispatch' | 'control',
    intent?: RuntimeDelivery
  ): void {
    if (!this.options.authorize(normalizeBinding(binding), action, intent))
      throw new RuntimeOwnerError('forbidden');
  }
  private ownedDriver(record: RuntimeSessionRecord): Session {
    const driver = this.drivers.get(this.key(record.binding));
    if (record.hostIncarnation !== this.options.hostIncarnation || !driver)
      throw new RuntimeOwnerError('hold');
    return driver;
  }
  private record(tx: RuntimeTransaction): RuntimeSessionRecord {
    const record = tx.get();
    if (!record) throw new RuntimeOwnerError('hold');
    return record;
  }
  private empty(binding: RuntimeBinding): RuntimeSessionRecord {
    return emptySession(binding, this.options.profileId, this.options.hostIncarnation);
  }
  private key(binding: RuntimeBinding): string {
    return runtimeDigest(normalizeBinding(binding));
  }

}
