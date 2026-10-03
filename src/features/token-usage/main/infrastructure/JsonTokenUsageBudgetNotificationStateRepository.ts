import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { mkdir, readFile, stat } from 'fs/promises';
import { dirname } from 'path';

import { SerialQueue } from '../../core/application/SerialQueue';
import { budgetCoverageKey } from '../../core/domain';

import type {
  TokenUsageBudgetNotificationRecord,
  TokenUsageBudgetNotificationStateRepositoryPort,
} from '../../core/application';

interface State {
  schemaVersion: 2;
  sent: Record<string, TokenUsageBudgetNotificationRecord>;
}
const MAX_NOTIFICATION_STATE_BYTES = 512 * 1024;

export class JsonTokenUsageBudgetNotificationStateRepository implements TokenUsageBudgetNotificationStateRepositoryPort {
  private readonly queue = new SerialQueue();
  constructor(private readonly filePath: string) {}

  hasSent(dedupeKey: string): Promise<boolean> {
    return this.queue.run(async () => Boolean((await this.readState()).sent[dedupeKey]));
  }

  markCovered(records: readonly TokenUsageBudgetNotificationRecord[]): Promise<void> {
    return this.queue.run(async () => {
      const state = await this.readState();
      for (const record of records) {
        const validated = validateRecord(record);
        state.sent[budgetCoverageKey(validated)] = validated;
      }
      await this.writeState(state);
    });
  }

  pruneBeforePeriod(periodKey: string): Promise<void> {
    return this.queue.run(async () => {
      const state = await this.readState();
      let changed = false;
      for (const [key, record] of Object.entries(state.sent)) {
        if (record.periodKey < periodKey) {
          delete state.sent[key];
          changed = true;
        }
      }
      if (changed) await this.writeState(state);
    });
  }

  private async readState(): Promise<State> {
    let source: { schemaVersion?: unknown; sent?: unknown };
    try {
      const fileStat = await stat(this.filePath);
      if (!fileStat.isFile() || fileStat.size > MAX_NOTIFICATION_STATE_BYTES)
        throw new Error('Budget coverage exceeds its size limit or is not a file');
      source = JSON.parse(await readFile(this.filePath, 'utf8')) as typeof source;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 2, sent: {} };
      throw error;
    }
    if (
      !source ||
      (source.schemaVersion !== 1 && source.schemaVersion !== 2) ||
      !source.sent ||
      typeof source.sent !== 'object' ||
      Array.isArray(source.sent)
    )
      throw new Error('Invalid budget coverage schema');
    const state: State = { schemaVersion: 2, sent: {} };
    for (const item of Object.values(source.sent)) {
      const record = validateRecord(item);
      if (source.schemaVersion === 1 && record.threshold !== 80 && record.threshold !== 100)
        throw new Error('Invalid legacy budget threshold');
      state.sent[budgetCoverageKey(record)] = { ...record, dedupeKey: budgetCoverageKey(record) };
      if (source.schemaVersion === 1 && record.threshold === 100) {
        const warning = { ...record, threshold: 80 };
        state.sent[budgetCoverageKey(warning)] = {
          ...warning,
          dedupeKey: budgetCoverageKey(warning),
        };
      }
    }
    if (source.schemaVersion === 1) await this.writeState(state);
    return state;
  }

  private async writeState(state: State): Promise<void> {
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_NOTIFICATION_STATE_BYTES)
      throw new Error('Budget coverage exceeds its size limit');
    await mkdir(dirname(this.filePath), { recursive: true });
    await atomicWriteAsync(this.filePath, serialized);
  }
}

function validateRecord(value: unknown): TokenUsageBudgetNotificationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid budget coverage record');
  const item = value as TokenUsageBudgetNotificationRecord;
  if (
    !['global', 'team', 'project'].includes(item.scope) ||
    !['tokens', 'apiEquivalentCostUsd'].includes(item.metric) ||
    !Number.isInteger(item.threshold) ||
    item.threshold < 1 ||
    item.threshold > 100 ||
    typeof item.id !== 'string' ||
    !item.id ||
    typeof item.periodKey !== 'string' ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(item.periodKey) ||
    !Number.isFinite(Date.parse(item.sentAt)) ||
    ![item.value, item.limit, item.percent].every(Number.isFinite) ||
    item.limit <= 0 ||
    item.value < 0 ||
    item.percent < 0
  )
    throw new Error('Invalid budget coverage record');
  return { ...item, dedupeKey: budgetCoverageKey(item) };
}
