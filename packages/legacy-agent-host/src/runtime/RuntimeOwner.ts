import { randomUUID } from 'node:crypto';

import { RuntimeOwnerError } from './contracts.js';
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

const active = (input: RuntimeInput): boolean =>
  ['claimed', 'consumed', 'unknown'].includes(input.phase);

/** One durable technical dispatch owner; no Task policy or provider protocol implementation. */
export class RuntimeOwner {
  private readonly drivers = new Map<string, Session>();
  private readonly closes = new Map<string, Promise<RuntimeSessionRecord>>();
  private readonly controls = new Map<string, Set<Promise<unknown>>>();
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
  }

  readSession(binding: RuntimeBinding): {
    record: RuntimeSessionRecord | undefined;
    attached: boolean;
  } {
    binding = normalizeBinding(binding);
    return this.options.store.fenced(binding, (tx) => {
      this.authorize(binding, 'read');
      return { record: tx.get(), attached: this.drivers.has(this.key(binding)) };
    });
  }

  fingerprintDelivery(intent: RuntimeDelivery): string {
    return deliveryFingerprint(this.delivery(intent));
  }

  async openSession(input: {
    binding: RuntimeBinding;
    config: OpenConfig;
  }): Promise<RuntimeSessionRecord> {
    const binding = normalizeBinding(input.binding);
    const config = this.config(input.config);
    const fingerprint = runtimeDigest({ profileId: this.options.profileId, config });
    const prepared = this.options.store.fenced(binding, (tx) => {
      this.authorize(binding, 'admit');
      const prior = tx.get();
      if (prior?.openFingerprint) {
        if (prior.openFingerprint !== fingerprint) throw new RuntimeOwnerError('conflict');
        return { record: prior, allocate: false };
      }
      if (prior?.sealed) throw new RuntimeOwnerError('hold');
      for (const sibling of tx.siblings()) {
        if (
          sibling.config?.sessionId === config.sessionId &&
          config.generation <= sibling.config.generation
        ) {
          throw new RuntimeOwnerError('conflict');
        }
        if (
          this.key(sibling.binding) !== this.key(binding) &&
          (sibling.phase !== 'closed' ||
            sibling.custody !== 'released' ||
            sibling.control !== undefined ||
            sibling.inputs.some(active))
        ) {
          throw new RuntimeOwnerError('hold');
        }
      }
      const record = prior ?? this.empty(binding);
      record.hostIncarnation = this.options.hostIncarnation;
      record.config = config;
      record.openFingerprint = fingerprint;
      record.phase = 'opening';
      record.custody = 'unknown';
      tx.put(record); // Opening intent precedes native allocation.
      return { record, allocate: true };
    });
    if (!prepared.allocate) return prepared.record;
    try {
      const opened = await this.options.driverFactory.open(config);
      this.drivers.set(this.key(binding), opened.driver);
      let record = this.publish(binding, (current) => {
        if (!this.options.authorize(binding, 'admit')) current.sealed = true;
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
    const intent = this.delivery(raw);
    return this.options.store.fenced(intent.binding, (tx) => {
      this.authorize(intent.binding, 'admit', intent);
      const record = tx.get() ?? this.empty(intent.binding);
      const existing = this.find(record, intent);
      if (existing) return this.admission(existing);
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
      tx.put(record);
      return this.admission(input);
    });
  }

  async lookupDelivery(raw: RuntimeDelivery): Promise<RuntimeAdmission> {
    const intent = this.delivery(raw);
    return this.options.store.fenced(intent.binding, (tx) => {
      this.authorize(intent.binding, 'read', intent);
      const record = tx.get();
      const input = record && this.find(record, intent);
      return input ? this.admission(input) : { inputId: intent.inputId, outcome: 'not_admitted' };
    });
  }

  async cancelDelivery(raw: RuntimeDelivery): Promise<RuntimeAdmission> {
    const intent = this.delivery(raw);
    return this.options.store.fenced(intent.binding, (tx) => {
      this.authorize(intent.binding, 'control', intent);
      const record = tx.get() ?? this.empty(intent.binding);
      let input = this.find(record, intent);
      if (!input) {
        input = {
          intent,
          fingerprint: deliveryFingerprint(intent),
          operationRef: randomUUID(),
          phase: 'cancelled',
        };
        record.inputs.push(input);
      } else if (input.phase === 'admitted') input.phase = 'cancelled';
      tx.put(record); // Includes unseen delivery IDs: a late outbox admission cannot resurrect them.
      return active(input)
        ? { inputId: input.intent.inputId, outcome: 'unknown' }
        : this.admission(input);
    });
  }

  async dispatchNext(binding: RuntimeBinding): Promise<RuntimeSessionRecord> {
    binding = normalizeBinding(binding);
    const claimed = this.options.store.fenced(binding, (tx) => {
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
        record.inputs.some(active)
      ) {
        throw new RuntimeOwnerError('hold');
      }
      const input = record.inputs.find((item) => item.phase === 'admitted');
      if (!input) return { record, driver, input: undefined };
      if (!this.options.canDispatch?.(binding, input.intent)) throw new RuntimeOwnerError('hold');
      input.phase = 'claimed';
      tx.put(record); // The only submit claim; persisted before crossing the provider boundary.
      return { record, driver, input };
    });
    const input = claimed.input;
    if (!input) return claimed.record;
    let phase: RuntimeInput['phase'] = 'unknown';
    try {
      const reply = await claimed.driver.submit({
        inputId: input.intent.inputId,
        operationRef: input.operationRef,
        content: input.intent.content,
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

  async interrupt(binding: RuntimeBinding, inputId: string): Promise<RuntimeSessionRecord> {
    binding = normalizeBinding(binding);
    const target = this.options.store.fenced(binding, (tx) => {
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
          requested = (await target.driver.interrupt(operationRef)).ok;
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
    reply: InteractionReply
  ): Promise<RuntimeSessionRecord> {
    binding = normalizeBinding(binding);
    const target = this.options.store.fenced(binding, (tx) => {
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
        const permitted = this.options.store.fenced(binding, (tx) => {
          const current = this.record(tx);
          return !current.sealed && this.options.authorize(binding, 'control');
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

  async stopSession(binding: RuntimeBinding): Promise<RuntimeSessionRecord> {
    return this.stopOwned(normalizeBinding(binding));
  }

  private async stopOwned(
    binding: RuntimeBinding,
    capturedCleanup = false
  ): Promise<RuntimeSessionRecord> {
    const target = this.options.store.fenced<{
      record: RuntimeSessionRecord;
      driver: Session | undefined;
      wait?: Promise<unknown>;
    }>(binding, (tx) => {
      if (!capturedCleanup) this.authorize(binding, 'control');
      const record = this.record(tx);
      record.sealed = true;
      record.nativeReady = false;
      for (const input of record.inputs) if (input.phase === 'admitted') input.phase = 'cancelled';
      for (const interaction of record.interactions)
        if (interaction.phase === 'pending') interaction.phase = 'unknown';
      if (record.phase === 'closed') {
        tx.put(record);
        return { record, driver: undefined };
      }
      if (record.phase === 'unopened') {
        record.phase = 'closed';
        record.custody = 'released';
        tx.put(record);
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
        tx.put(record);
        return { record, driver: undefined, wait: Promise.allSettled([...controls]) };
      }
      if (record.closeClaimed || record.control?.phase === 'pending') {
        tx.put(record);
        return { record, driver: undefined };
      }
      if (driver) record.closeClaimed = true;
      tx.put(record);
      return { record, driver };
    });
    if (target.wait) {
      await target.wait;
      return this.stopOwned(binding, true); // Continue this stop intent after its accepted controls settle.
    }
    if (!target.driver) return this.closes.get(this.key(binding)) ?? target.record;
    const driver = target.driver;
    const closing = (async () => {
      let confirmed = false;
      try {
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
    return this.options.store.fenced(binding, (tx) => {
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
        // This checkpoint persists control/terminal facts, not text/tool projections.
        if (event.kind !== 'result' && event.kind !== 'interaction') continue;
        this.options.store.fenced(binding, (tx) => {
          const record = this.record(tx);
          if (
            record.hostIncarnation !== this.options.hostIncarnation ||
            record.sessionRef !== event.sessionRef
          )
            return;
          this.applyEvent(record, event);
          tx.put(record);
        });
      }
    } catch {
      diagnostic = 'observe-failed';
    }
    try {
      this.options.store.fenced(binding, (tx) => {
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
    return this.options.store.fenced(binding, (tx) => {
      const record = this.record(tx);
      mutate(record);
      tx.put(record);
      return record;
    });
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
    return {
      schemaVersion: 1,
      binding,
      profileId: this.options.profileId,
      config: null,
      openFingerprint: null,
      hostIncarnation: this.options.hostIncarnation,
      phase: 'unopened',
      sealed: false,
      custody: 'released',
      nativeReady: false,
      inputs: [],
      interactions: [],
    };
  }
  private key(binding: RuntimeBinding): string {
    return runtimeDigest(normalizeBinding(binding));
  }
  private delivery(raw: RuntimeDelivery): RuntimeDelivery {
    const intent = {
      binding: normalizeBinding(raw.binding),
      deliveryId: raw.deliveryId,
      inputId: raw.inputId,
      messageId: raw.messageId,
      content: raw.content,
    };
    if (
      intent.inputId !== intent.deliveryId ||
      [intent.inputId, intent.messageId].some(
        (value) => typeof value !== 'string' || !value || value.length > 256
      ) ||
      typeof intent.content !== 'string' ||
      Buffer.byteLength(intent.content) > this.maxBytes
    )
      throw new RuntimeOwnerError('invalid');
    return intent;
  }
  private find(record: RuntimeSessionRecord, intent: RuntimeDelivery): RuntimeInput | undefined {
    const input = record.inputs.find((item) => item.intent.inputId === intent.inputId);
    if (input && input.fingerprint !== deliveryFingerprint(intent))
      throw new RuntimeOwnerError('conflict');
    return input;
  }
  private admission(input: RuntimeInput): RuntimeAdmission {
    return {
      inputId: input.intent.inputId,
      outcome: ['cancelled', 'rejected'].includes(input.phase) ? 'not_admitted' : 'admitted',
      receipt: {
        schemaVersion: 1,
        inputId: input.intent.inputId,
        binding: { ...input.intent.binding },
        fingerprint: input.fingerprint,
        operationRef: input.operationRef,
        phase: input.phase,
      },
    };
  }
  private config(config: OpenConfig): OpenConfig {
    // Restore requires host-owned checkpoint/history/custody publication, not an arbitrary token.
    if (config?.checkpointRef !== undefined) throw new RuntimeOwnerError('hold');
    if (
      !config ||
      [config.tenantId, config.projectId, config.sessionId, config.configRevision].some(
        (value) => typeof value !== 'string' || !value || value.length > 256
      ) ||
      !Number.isSafeInteger(config.generation) ||
      config.generation < 0 ||
      !Array.isArray(config.requiredCapabilities) ||
      config.requiredCapabilities.some(
        (capability) => typeof capability !== 'string' || !capability
      )
    )
      throw new RuntimeOwnerError('invalid');
    return {
      tenantId: config.tenantId,
      projectId: config.projectId,
      sessionId: config.sessionId,
      generation: config.generation,
      configRevision: config.configRevision,
      requiredCapabilities: [...config.requiredCapabilities].sort(),
      ...(config.checkpointRef ? { checkpointRef: config.checkpointRef } : {}),
    };
  }
}
