import type { Event } from '@agent-teams/provider-session-contracts';
import type { RuntimeProviderActivity } from './providerActivityContracts.js';
import { RuntimeOwnerError } from './contracts.js';
import type { JsonValue } from '../contracts.js';
import { normalizeBinding, runtimeDigest } from './identity.js';
import { normalizeActivity } from './normalizeActivity.js';
import type {
  RuntimeBinding,
  RuntimeOwnerOptions,
  RuntimeSessionRecord,
  RuntimeStore,
  RuntimeTransaction,
} from './contracts.js';
import type {
  RuntimeActivityCursor,
  RuntimeActivityEvent,
  RuntimeActivityFeed,
  RuntimeActivityRecord,
  RuntimeActivitySnapshot,
  RuntimeActivityState,
} from './activityContracts.js';

/** The sole event writer shares the existing member fence; projections never own business outcomes. */
export class RuntimeActivityCoordinator implements RuntimeStore {
  private readonly degraded = new Set<string>();
  constructor(
    private readonly options: Pick<
      RuntimeOwnerOptions,
      'store' | 'events' | 'hostIncarnation' | 'authorize' | 'contextObserved'
    >
  ) {
    if (options.events && options.events.activityLimits.maxEventBytes > 64 * 1024)
      throw new RuntimeOwnerError('invalid');
  }

  fenced<T>(binding: RuntimeBinding, action: (transaction: RuntimeTransaction) => T): T {
    return this.options.store.fenced(binding, (tx) =>
      action({
        ...tx,
        put: (record, purpose) => {
          if (!this.options.events) {
            tx.put(record, purpose);
            return;
          }
          const prepared = this.prepare(
            record,
            [{ data: { kind: 'state', state: this.state(record) as unknown as JsonValue } }],
            this.unprojected(tx.get())
          );
          tx.put(record, purpose); // Includes the bounded high-water scalar before projection publication.
          this.persist(record, prepared);
        },
      })
    );
  }

  observe(
    binding: RuntimeBinding,
    sessionRef: string,
    event: Event,
    apply: (record: RuntimeSessionRecord) => void
  ): void {
    this.options.store.fenced(binding, (tx) => {
      const record = tx.get();
      if (
        !record ||
        record.hostIncarnation !== this.options.hostIncarnation ||
        record.sessionRef !== sessionRef ||
        event.sessionRef !== sessionRef
      )
        return;
      const paired =
        typeof event.inputId === 'string' &&
        typeof event.operationRef === 'string' &&
        record.inputs.some(
          (input) =>
            input.intent.inputId === event.inputId &&
            input.operationRef === event.operationRef &&
            ['claimed', 'consumed', 'terminal', 'unknown'].includes(input.phase)
        );
      const sessionLevel =
        event.kind === 'diagnostic' ||
        (event.inputId === undefined &&
          event.operationRef === undefined &&
          event.kind === 'compaction');
      if (!paired && !sessionLevel) {
        if (this.options.events) {
          const prepared = this.prepare(record, [
            { data: { kind: 'gap', reason: 'unattributed' } },
          ]);
          tx.put(record);
          this.persist(record, prepared);
        }
        return;
      }
      const before = this.digest(record);
      const interactionCount = record.interactions.length;
      const compaction = event.kind === 'compaction' && normalizeActivity(event).kind === 'compaction';
      if (compaction || (paired && this.controlShape(event))) apply(record);
      if (compaction && !record.sealed && record.phase === 'allocated' && record.custody === 'owned') {
        const epoch = record.contextEpochs?.find(value => value.sourceRef === event.sourceRef && value.sessionRef === event.sessionRef);
        if (epoch) {
          try { this.options.contextObserved?.(binding, structuredClone(epoch)); }
          catch (error) { tx.put(record); throw error; } // Preserve the original technical boundary if Team publication is unavailable.
        }
      }
      if (!this.options.events) {
        if (event.kind === 'result' || event.kind === 'interaction' || compaction)
          tx.put(record, record.interactions.length > interactionCount ? 'growth' : undefined);
        return;
      }
      const entries: Entry[] = [];
      if (this.digest(record) !== before)
        entries.push({
          data: { kind: 'state', state: this.state(record) as unknown as JsonValue },
        });
      entries.push({
        ...(paired ? { inputId: event.inputId!, operationRef: event.operationRef! } : {}),
        data: normalizeActivity(event),
      });
      const prepared = this.prepare(record, entries, this.unprojected(record));
      tx.put(record, record.interactions.length > interactionCount ? 'growth' : undefined); // Terminal/interaction facts survive projection IO or normalization failures.
      this.persist(record, prepared);
    });
  }

  /** Provider-owned observations share this writer/fence but never apply Runtime state transitions. */
  observeProviderActivity(binding: RuntimeBinding, sessionRef: string, observation: RuntimeProviderActivity): void {
    this.options.store.fenced(binding, tx => {
      const record = tx.get();
      if (!record || record.hostIncarnation !== this.options.hostIncarnation || record.sessionRef !== sessionRef || record.sealed) return;
      const paired = typeof observation.inputId === 'string' && typeof observation.operationRef === 'string' &&
        record.inputs.some(input => input.intent.inputId === observation.inputId && input.operationRef === observation.operationRef &&
          ['claimed', 'consumed', 'terminal', 'unknown'].includes(input.phase));
      if (!this.options.events) return;
      const entry: Entry = paired ? { inputId: observation.inputId!, operationRef: observation.operationRef!, data: structuredClone(observation.data) }
        : { data: { kind: 'gap', reason: 'unattributed' } };
      const prepared = this.prepare(record, [entry], this.unprojected(record));
      tx.put(record); this.persist(record, prepared);
    });
  }

  snapshot(raw: RuntimeBinding): RuntimeActivitySnapshot {
    const binding = normalizeBinding(raw);
    return this.options.store.fenced(binding, (tx) => {
      this.authorize(binding);
      const record = tx.get(),
        feed = this.read(binding, record);
      const latest: RuntimeActivitySnapshot['latest'] = {
        text: [],
        tools: [],
        usage: [],
        compaction: null,
        subagents: [],
        interactions: [],
      };
      const text = new Map<string, RuntimeActivityEvent>(),
        tools = new Map<string, RuntimeActivityEvent>(),
        usage = new Map<string, RuntimeActivityEvent>(),
        interactions = new Map<string, RuntimeActivityEvent>();
      for (const event of feed.events) {
        const data = event.data;
        if (data.kind === 'subagent') latest.subagents.push(event);
        else if (data.kind === 'text')
          text.set(`${event.operationRef}:${String(data.messageRef)}:${String(data.block)}`, event);
        else if (data.kind === 'tool' || data.kind === 'tool-result')
          tools.set(`${event.operationRef}:${String(data.toolRef)}:${data.kind}`, event);
        else if (data.kind === 'usage') usage.set(event.operationRef ?? 'session', event);
        else if (data.kind === 'compaction') latest.compaction = event;
        else if (data.kind === 'interaction') interactions.set(String(data.interactionRef), event);
      }
      latest.text = [...text.values()];
      latest.tools = [...tools.values()];
      latest.usage = [...usage.values()];
      latest.interactions = [...interactions.values()];
      const state = record ? this.state(record) : null;
      let bytes = 0,
        partial = false;
      for (const group of ['usage', 'interactions', 'tools', 'text', 'subagents'] as const) {
        latest[group] = latest[group]
          .reverse()
          .filter((event) => {
            bytes += Buffer.byteLength(JSON.stringify(event));
            if (bytes > 256 * 1024) {
              partial = true;
              return false;
            }
            return true;
          })
          .reverse();
      }
      return {
        ...feed,
        events: [],
        state,
        latest,
        ...((state?.partial || partial) && !feed.gap
          ? { gap: { reason: 'retention' as const } }
          : {}),
      };
    });
  }

  feed(raw: RuntimeBinding, cursor: RuntimeActivityCursor): RuntimeActivityFeed {
    const binding = normalizeBinding(raw);
    return this.options.store.fenced(binding, (tx) => {
      this.authorize(binding);
      const current = this.read(binding, tx.get());
      if (
        !cursor ||
        cursor.resource !== current.cursor.resource ||
        !Number.isSafeInteger(cursor.sequence) ||
        cursor.sequence < 0 ||
        cursor.sequence > current.cursor.sequence
      )
        return { ...current, events: [], gap: { reason: 'cursor' } };
      if (cursor.hostIncarnation !== this.options.hostIncarnation)
        return { ...current, events: [], gap: { reason: 'incarnation' } };
      if (cursor.sequence < current.retainedFrom - 1)
        return { ...current, events: [], gap: { reason: 'retention' } };
      const available = current.events.filter((event) => event.sequence > cursor.sequence),
        events: RuntimeActivityEvent[] = [];
      let bytes = 0;
      for (const event of available) {
        const size = Buffer.byteLength(JSON.stringify(event));
        if (events.length >= 64 || bytes + size > 128 * 1024) break;
        events.push(event);
        bytes += size;
      }
      const hasMore = events.length < available.length;
      const marker = events.find((event) => event.data.kind === 'gap');
      const unstable =
        !this.options.events ||
        current.gap?.reason === 'state-unpublished' ||
        this.degraded.has(current.cursor.resource);
      const gap = unstable
        ? current.gap
        : marker
          ? { reason: this.gapReason(marker.data.reason) }
          : undefined;
      const { gap: previousGap, ...rest } = current;
      void previousGap;
      return {
        ...rest,
        events,
        hasMore,
        cursor: {
          ...current.cursor,
          sequence: hasMore ? events.at(-1)!.sequence : current.cursor.sequence,
        },
        ...(gap ? { gap } : {}),
      };
    });
  }

  private read(
    binding: RuntimeBinding,
    record: RuntimeSessionRecord | undefined
  ): RuntimeActivityFeed {
    const resource = runtimeDigest(binding);
    if (!this.options.events)
      return {
        binding,
        cursor: {
          resource,
          hostIncarnation: this.options.hostIncarnation,
          sequence: record?.activitySequence ?? 0,
        },
        retainedFrom: 1,
        events: [],
        hasMore: false,
        gap: { reason: 'unsupported' },
      };
    const stored = this.options.events.readActivity(binding); // Corrupt/unreadable storage is HOLD, never an empty/reset cursor.
    if (!stored && record?.activitySequence) throw new RuntimeOwnerError('hold');
    const sequence = Math.max(stored?.sequence ?? 0, record?.activitySequence ?? 0);
    const events = stored?.events ?? [];
    const reason = this.degraded.has(resource)
      ? 'storage'
      : (stored && record && stored.stateDigest !== this.digest(record)) ||
          sequence !== (stored?.sequence ?? 0)
        ? 'state-unpublished'
        : stored && stored.writerIncarnation !== this.options.hostIncarnation
          ? 'incarnation'
          : events.some((event) => event.data.kind === 'gap')
            ? this.gapReason(
                events.filter((event) => event.data.kind === 'gap').at(-1)!.data.reason
              )
            : (events[0]?.sequence ?? 1) > 1
              ? 'retention'
              : this.unprojected(record) && !stored
                ? 'retention'
                : undefined;
    return {
      binding,
      cursor: { resource, hostIncarnation: this.options.hostIncarnation, sequence },
      retainedFrom: events[0]?.sequence ?? sequence + 1,
      events,
      hasMore: false,
      ...(reason ? { gap: { reason } } : {}),
    };
  }

  private prepare(
    record: RuntimeSessionRecord,
    entries: Entry[],
    historical = false
  ): RuntimeActivityRecord | undefined {
    const storage = this.options.events!;
    const key = runtimeDigest(record.binding);
    const highWater = record.activitySequence ?? 0;
    try {
      const stored = storage.readActivity(record.binding);
      let sequence = Math.max(highWater, stored?.sequence ?? 0);
      if (!Number.isSafeInteger(sequence + entries.length + 1)) throw new RuntimeOwnerError('hold');
      const events = [...(stored?.events ?? [])];
      if (highWater > (stored?.sequence ?? 0) || (!stored && historical))
        entries = [
          { data: { kind: 'gap', reason: highWater > 0 ? 'storage' : 'retention' } },
          ...entries,
        ];
      for (const entry of entries) {
        let event: RuntimeActivityEvent = {
          ...entry,
          sequence: ++sequence,
          eventId: `${key}:${sequence}`,
          observedAt: new Date().toISOString(),
        };
        if (Buffer.byteLength(JSON.stringify(event)) > storage.activityLimits.maxEventBytes)
          event = {
            sequence,
            eventId: `${key}:${sequence}`,
            data: { kind: 'gap', reason: 'oversized' },
          };
        events.push(event);
      }
      record.activitySequence = sequence;
      const result: RuntimeActivityRecord = {
        schemaVersion: 1,
        binding: record.binding,
        sequence,
        writerIncarnation: this.options.hostIncarnation,
        stateDigest: this.digest(record),
        digest: '0'.repeat(64),
        events,
      };
      while (
        events.length > storage.activityLimits.maxEvents ||
        Buffer.byteLength(JSON.stringify(result, null, 2)) > storage.activityLimits.maxBytes
      ) {
        if (events.length <= 1) throw new RuntimeOwnerError('hold');
        events.shift();
      }
      const { digest: placeholder, ...body } = result;
      void placeholder;
      result.digest = runtimeDigest(body);
      return result;
    } catch {
      record.activitySequence = Number.isSafeInteger(highWater + 1) ? highWater + 1 : highWater;
      this.degraded.add(key);
      return undefined;
    }
  }
  private persist(
    record: RuntimeSessionRecord,
    projection: RuntimeActivityRecord | undefined
  ): void {
    if (!projection) return;
    const key = runtimeDigest(record.binding);
    try {
      this.options.events!.writeActivity(projection);
      this.degraded.delete(key);
    } catch {
      this.degraded.add(key);
    }
  }
  private controlShape(event: Event): boolean {
    if (event.kind === 'result')
      return ['succeeded', 'failed', 'cancelled', 'unknown'].includes(event.outcome);
    return (
      event.kind === 'interaction' &&
      typeof event.interactionRef === 'string' &&
      event.interactionRef.length > 0 &&
      event.interactionRef.length <= 1024 &&
      !!event.request &&
      ['permission', 'question'].includes(event.request.kind)
    );
  }
  private gapReason(
    value: unknown
  ): 'unsupported' | 'oversized' | 'unattributed' | 'storage' | 'retention' {
    return ['oversized', 'unattributed', 'storage', 'retention'].includes(String(value))
      ? (value as 'oversized' | 'unattributed' | 'storage' | 'retention')
      : 'unsupported';
  }
  private unprojected(record: RuntimeSessionRecord | undefined): boolean {
    return (
      !!record &&
      !record.activitySequence &&
      (record.config !== null || record.inputs.length > 0 || record.interactions.length > 0)
    );
  }
  private state(record: RuntimeSessionRecord): RuntimeActivityState {
    const bounded = (value: string, limit: number): boolean =>
      typeof value === 'string' && value.length > 0 && value.length <= limit;
    const visible = record.interactions.filter(
      (item) =>
        bounded(item.interactionRef, 1024) &&
        bounded(item.inputId, 256) &&
        bounded(item.operationRef, 256)
    );
    const control =
      record.control &&
      bounded(record.control.inputId, 256) &&
      bounded(record.control.operationRef, 256)
        ? record.control
        : undefined;
    const diagnostic =
      record.diagnostic &&
      [
        'open-unknown',
        'observe-ended',
        'observe-failed',
        'readiness-unavailable',
        'close-unknown',
      ].includes(record.diagnostic)
        ? record.diagnostic
        : null;
    return {
      phase: record.phase,
      custody: record.custody,
      sealed: record.sealed,
      nativeReady: record.nativeReady,
      control: control
        ? {
            inputId: control.inputId,
            operationRef: control.operationRef,
            phase: control.phase,
          }
        : null,
      diagnostic,
      queuedInputs: record.inputs.filter((input) => input.phase === 'admitted').length,
      activeInputs: record.inputs.filter((input) =>
        ['claimed', 'consumed', 'unknown'].includes(input.phase)
      ).length,
      interactions: visible.slice(-32).map((item) => ({
        interactionRef: item.interactionRef,
        inputId: item.inputId,
        operationRef: item.operationRef,
        kind: item.kind,
        expiresAt: item.expiresAt,
        phase: item.phase,
      })),
      checkpoints: (record.checkpoints ?? []).slice(-32).map((item) => ({
        checkpointId: item.checkpointId,
        status: item.status,
        ...(item.reference ? { reference: item.reference } : {}),
      })),
      partial:
        record.interactions.length > 32 ||
        (record.checkpoints?.length ?? 0) > 32 ||
        visible.length !== record.interactions.length ||
        (!!record.control && !control) ||
        (record.diagnostic !== undefined && !diagnostic),
    };
  }
  private digest(record: RuntimeSessionRecord): string {
    return runtimeDigest(this.state(record));
  }
  private authorize(binding: RuntimeBinding): void {
    if (!this.options.authorize(binding, 'read')) throw new RuntimeOwnerError('forbidden');
  }
}
type Entry = Omit<RuntimeActivityEvent, 'sequence' | 'eventId'>;
