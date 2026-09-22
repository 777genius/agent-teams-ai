import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { mkdir, readFile, stat } from 'fs/promises';
import { dirname } from 'path';

import type {
  TokenUsageBudgetNotificationRecord,
  TokenUsageBudgetNotificationStateRepositoryPort,
} from '../../core/application';

interface TokenUsageBudgetNotificationStateFile {
  schemaVersion: 1;
  sent: Record<string, TokenUsageBudgetNotificationRecord>;
}

const MAX_NOTIFICATION_STATE_BYTES = 512 * 1024;

export class JsonTokenUsageBudgetNotificationStateRepository implements TokenUsageBudgetNotificationStateRepositoryPort {
  constructor(private readonly filePath: string) {}

  async hasSent(dedupeKey: string): Promise<boolean> {
    const state = await this.readState();
    return Boolean(state.sent[dedupeKey]);
  }

  async markSent(record: TokenUsageBudgetNotificationRecord): Promise<void> {
    const state = await this.readState();
    state.sent[record.dedupeKey] = record;
    await this.writeState(state);
  }

  async pruneBeforePeriod(periodKey: string): Promise<void> {
    const state = await this.readState();
    let changed = false;
    for (const [key, record] of Object.entries(state.sent)) {
      if (record.periodKey < periodKey) {
        delete state.sent[key];
        changed = true;
      }
    }
    if (changed) await this.writeState(state);
  }

  private async readState(): Promise<TokenUsageBudgetNotificationStateFile> {
    try {
      const fileStat = await stat(this.filePath);
      if (!fileStat.isFile() || fileStat.size > MAX_NOTIFICATION_STATE_BYTES) return emptyState();
      const raw = await readFile(this.filePath, 'utf8');
      return normalizeState(JSON.parse(raw) as unknown);
    } catch {
      return emptyState();
    }
  }

  private async writeState(state: TokenUsageBudgetNotificationStateFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await atomicWriteAsync(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

function emptyState(): TokenUsageBudgetNotificationStateFile {
  return { schemaVersion: 1, sent: {} };
}

function normalizeState(value: unknown): TokenUsageBudgetNotificationStateFile {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const sentRecord =
    record.sent && typeof record.sent === 'object' && !Array.isArray(record.sent)
      ? (record.sent as Record<string, unknown>)
      : {};
  const sent: Record<string, TokenUsageBudgetNotificationRecord> = {};
  for (const [key, item] of Object.entries(sentRecord)) {
    const normalized = normalizeRecord(key, item);
    if (normalized) sent[key] = normalized;
  }
  return { schemaVersion: 1, sent };
}

function normalizeRecord(key: string, value: unknown): TokenUsageBudgetNotificationRecord | null {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const scope = record.scope;
  const metric = record.metric;
  const threshold = record.threshold;
  if (scope !== 'global' && scope !== 'team' && scope !== 'project') return null;
  if (metric !== 'tokens' && metric !== 'apiEquivalentCostUsd') return null;
  if (threshold !== 80 && threshold !== 100) return null;
  const sentAt = readString(record.sentAt);
  const periodKey = readString(record.periodKey);
  const id = readString(record.id);
  if (!sentAt || !periodKey || !id) return null;
  return {
    dedupeKey: readString(record.dedupeKey) ?? key,
    sentAt,
    periodKey,
    scope,
    id,
    metric,
    threshold,
    value: readNumber(record.value),
    limit: readNumber(record.limit),
    percent: readNumber(record.percent),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
