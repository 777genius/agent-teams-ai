import { randomUUID } from 'node:crypto';
import { TeamOwnerError } from './contracts.js';

export interface TeamProductPosition {
  streamId: string;
  sequence: number;
  cursor: string;
}
export interface TeamProductChangeFeed extends TeamProductPosition {
  events: { sequence: number; eventId: string; kind: 'invalidate' }[];
  gap?: { reason: 'initial' | 'cursor' | 'retention' };
}

/** Volatile read-side invalidations only. The caller holds the product authority fence. */
export class TeamProductChanges {
  private readonly streamId = randomUUID();
  private sequence = 0;
  private exhausted = false;
  private readonly events: TeamProductChangeFeed['events'] = [];
  private readonly cursors = new Map<string, { principalId: string; sequence: number }>();
  private readonly observed = new Map<string, { revision: string; sequence: number }>();

  constructor(private readonly capacity = 128) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096)
      throw new Error('Invalid feed capacity');
  }

  /** Never throw into a business command after its effects have been committed. */
  invalidate(): void {
    if (this.sequence === Number.MAX_SAFE_INTEGER) {
      this.exhausted = true;
      return;
    }
    this.sequence++;
    this.events.push({
      sequence: this.sequence,
      eventId: `${this.streamId}:${this.sequence}`,
      kind: 'invalidate',
    });
    if (this.events.length > this.capacity) this.events.shift();
  }

  snapshot(principalId: string, revision: string): TeamProductPosition {
    if (this.exhausted || !/^[a-f0-9]{64}$/.test(revision)) throw new TeamOwnerError('hold');
    const prior = this.observed.get(principalId);
    // Also observe changes published by a recovery path before its callback returns.
    if (prior && prior.revision !== revision && prior.sequence === this.sequence) this.invalidate();
    if (this.exhausted) throw new TeamOwnerError('hold');
    this.observed.set(principalId, { revision, sequence: this.sequence });
    while (this.observed.size > this.capacity)
      this.observed.delete(this.observed.keys().next().value!);
    let cursor = [...this.cursors].find(
      ([, value]) => value.principalId === principalId && value.sequence === this.sequence
    )?.[0];
    if (!cursor) {
      cursor = randomUUID();
      this.cursors.set(cursor, { principalId, sequence: this.sequence });
      while (this.cursors.size > this.capacity)
        this.cursors.delete(this.cursors.keys().next().value!);
    }
    return { streamId: this.streamId, sequence: this.sequence, cursor };
  }

  read(principalId: string, revision: string, cursor?: string): TeamProductChangeFeed {
    const previous = cursor === undefined ? undefined : this.cursors.get(cursor);
    const position = this.snapshot(principalId, revision);
    if (!previous || previous.principalId !== principalId)
      return {
        ...position,
        events: [],
        gap: { reason: cursor === undefined ? 'initial' : 'cursor' },
      };
    if (previous.sequence < (this.events[0]?.sequence ?? this.sequence + 1) - 1)
      return { ...position, events: [], gap: { reason: 'retention' } };
    return {
      ...position,
      events: this.events
        .filter((event) => event.sequence > previous.sequence)
        .map((event) => ({ ...event })),
    };
  }
}
