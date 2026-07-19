import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { mkdir, readFile, stat } from 'fs/promises';
import { dirname } from 'path';

import { normalizeCostBreakdown, normalizeTokenBreakdown } from '../../core/domain';

import type {
  TokenUsageEventDto,
  TokenUsageRunDto,
  TokenUsageRunSourceDto,
  TokenUsageRunStatus,
  TokenUsageRuntimeKind,
  TokenUsageSourceKind,
} from '../../contracts';
import type { TokenUsageLedgerRepositoryPort } from '../../core/application';

interface TokenUsageLedgerFile {
  schemaVersion: 1;
  runs: Record<string, TokenUsageRunDto>;
  events: Record<string, TokenUsageEventDto>;
}

const MAX_LEDGER_BYTES = 64 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readRuntimeKind(value: unknown): TokenUsageRuntimeKind {
  return value === 'anthropic' || value === 'codex' || value === 'gemini' || value === 'opencode'
    ? value
    : 'unknown';
}

function readRunStatus(value: unknown): TokenUsageRunStatus {
  return value === 'running' || value === 'completed' || value === 'failed' ? value : 'unknown';
}

function readSourceKind(value: unknown): TokenUsageSourceKind {
  return value === 'sdk_exact' ||
    value === 'gateway_exact' ||
    value === 'log_parsed' ||
    value === 'tokenizer_estimated' ||
    value === 'cost_estimated'
    ? value
    : 'log_parsed';
}

function normalizeRunSource(value: unknown): TokenUsageRunSourceDto | null {
  const record = asRecord(value);
  const id = readString(record?.id);
  const appRunId = readString(record?.appRunId);
  const discoveredAt = readString(record?.discoveredAt);
  if (!id || !appRunId || !discoveredAt) return null;

  return {
    id,
    appRunId,
    sourceType:
      record?.sourceType === 'runtime_trace' ||
      record?.sourceType === 'gateway' ||
      record?.sourceType === 'sdk' ||
      record?.sourceType === 'manual_import'
        ? record.sourceType
        : 'cli_log',
    nativeSessionId: readString(record?.nativeSessionId),
    nativeLogPath: readString(record?.nativeLogPath),
    nativeProjectKey: readString(record?.nativeProjectKey),
    parserName: readString(record?.parserName),
    parserVersion: readString(record?.parserVersion),
    discoveredAt,
  };
}

function normalizeRun(value: unknown): TokenUsageRunDto | null {
  const record = asRecord(value);
  const appRunId = readString(record?.appRunId);
  const startedAt = readString(record?.startedAt);
  if (!appRunId || !startedAt) return null;
  const rawSources = Array.isArray(record?.sources) ? record.sources : [];

  return {
    appRunId,
    parentAppRunId: readString(record?.parentAppRunId),
    teamName: readString(record?.teamName),
    agentId: readString(record?.agentId),
    agentName: readString(record?.agentName),
    commandId: readString(record?.commandId),
    commandInvocationId: readString(record?.commandInvocationId),
    runtimeKind: readRuntimeKind(record?.runtimeKind),
    providerId: readString(record?.providerId),
    providerBackendId: readString(record?.providerBackendId),
    billingMode:
      record?.billingMode === 'api' ||
      record?.billingMode === 'subscription' ||
      record?.billingMode === 'free' ||
      record?.billingMode === 'unknown'
        ? record.billingMode
        : undefined,
    model: readString(record?.model),
    workspacePathHash: readString(record?.workspacePathHash),
    workspaceLabel: readString(record?.workspaceLabel),
    commandHash: readString(record?.commandHash),
    startedAt,
    endedAt: readString(record?.endedAt),
    status: readRunStatus(record?.status),
    source:
      record?.source === 'team_launch_state' || record?.source === 'manual_import'
        ? record.source
        : 'app_launcher',
    sources: rawSources
      .map((source) => normalizeRunSource(source))
      .filter((source): source is TokenUsageRunSourceDto => source !== null),
  };
}

function normalizeEvent(value: unknown): TokenUsageEventDto | null {
  const record = asRecord(value);
  const id = readString(record?.id);
  const appRunId = readString(record?.appRunId);
  const occurredAt = readString(record?.occurredAt);
  const createdAt = readString(record?.createdAt);
  if (!id || !appRunId || !occurredAt || !createdAt) return null;
  const rawProviderUsage = asRecord(record?.providerUsage);
  const rawKiroUsage = asRecord(rawProviderUsage?.kiro);
  const kiroCredits =
    typeof rawKiroUsage?.credits === 'number' &&
    Number.isFinite(rawKiroUsage.credits) &&
    rawKiroUsage.credits >= 0
      ? rawKiroUsage.credits
      : null;
  const kiroCreditsUnit = readString(rawKiroUsage?.creditsUnit);

  return {
    id,
    appRunId,
    requestId: readString(record?.requestId),
    spanId: readString(record?.spanId),
    stepIndex:
      typeof record?.stepIndex === 'number' && Number.isFinite(record.stepIndex)
        ? record.stepIndex
        : undefined,
    teamName: readString(record?.teamName),
    agentId: readString(record?.agentId),
    agentName: readString(record?.agentName),
    commandId: readString(record?.commandId),
    commandInvocationId: readString(record?.commandInvocationId),
    runtimeKind: readRuntimeKind(record?.runtimeKind),
    providerId: readString(record?.providerId),
    providerBackendId: readString(record?.providerBackendId),
    billingMode:
      record?.billingMode === 'api' ||
      record?.billingMode === 'subscription' ||
      record?.billingMode === 'free' ||
      record?.billingMode === 'unknown'
        ? record.billingMode
        : undefined,
    model: readString(record?.model),
    nativeSessionId: readString(record?.nativeSessionId),
    nativeLogPath: readString(record?.nativeLogPath),
    tokens: normalizeTokenBreakdown(asRecord(record?.tokens) ?? {}),
    cost: normalizeCostBreakdown(asRecord(record?.cost) ?? {}),
    providerUsage:
      kiroCredits !== null && kiroCreditsUnit
        ? { kiro: { credits: kiroCredits, creditsUnit: kiroCreditsUnit } }
        : undefined,
    usageSourceKind: readSourceKind(record?.usageSourceKind),
    rawUsageJson: record?.rawUsageJson,
    occurredAt,
    createdAt,
  };
}

function emptyLedger(): TokenUsageLedgerFile {
  return { schemaVersion: 1, runs: {}, events: {} };
}

export class JsonTokenUsageLedgerRepository implements TokenUsageLedgerRepositoryPort {
  constructor(private readonly filePath: string) {}

  async listRuns(): Promise<TokenUsageRunDto[]> {
    const ledger = await this.readLedger();
    return Object.values(ledger.runs).sort((left, right) =>
      left.startedAt.localeCompare(right.startedAt)
    );
  }

  async listEvents(): Promise<TokenUsageEventDto[]> {
    const ledger = await this.readLedger();
    return Object.values(ledger.events).sort((left, right) =>
      left.occurredAt.localeCompare(right.occurredAt)
    );
  }

  async upsertRuns(runs: readonly TokenUsageRunDto[]): Promise<void> {
    if (runs.length === 0) return;
    const ledger = await this.readLedger();
    for (const run of runs) {
      const existing = ledger.runs[run.appRunId];
      ledger.runs[run.appRunId] = existing ? mergeRun(existing, run) : run;
    }
    await this.writeLedger(ledger);
  }

  async replaceRunsForSource(
    source: TokenUsageRunDto['source'],
    runs: readonly TokenUsageRunDto[]
  ): Promise<void> {
    const ledger = await this.readLedger();
    const nextRunIds = new Set(runs.map((run) => run.appRunId));
    const eventRunIds = new Set(Object.values(ledger.events).map((event) => event.appRunId));

    for (const [appRunId, run] of Object.entries(ledger.runs)) {
      if (run.source !== source || nextRunIds.has(appRunId) || eventRunIds.has(appRunId)) {
        continue;
      }
      delete ledger.runs[appRunId];
    }

    for (const run of runs) {
      const existing = ledger.runs[run.appRunId];
      ledger.runs[run.appRunId] = existing ? mergeRun(existing, run) : run;
    }
    await this.writeLedger(ledger);
  }

  async upsertEvents(events: readonly TokenUsageEventDto[]): Promise<void> {
    if (events.length === 0) return;
    const ledger = await this.readLedger();
    for (const event of events) {
      ledger.events[event.id] = event;
    }
    await this.writeLedger(ledger);
  }

  private async readLedger(): Promise<TokenUsageLedgerFile> {
    try {
      const fileStat = await stat(this.filePath);
      if (!fileStat.isFile() || fileStat.size > MAX_LEDGER_BYTES) {
        return emptyLedger();
      }
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const record = asRecord(parsed);
      const runsRecord = asRecord(record?.runs) ?? {};
      const eventsRecord = asRecord(record?.events) ?? {};
      const runs: Record<string, TokenUsageRunDto> = {};
      const events: Record<string, TokenUsageEventDto> = {};

      for (const value of Object.values(runsRecord)) {
        const run = normalizeRun(value);
        if (run) runs[run.appRunId] = run;
      }
      for (const value of Object.values(eventsRecord)) {
        const event = normalizeEvent(value);
        if (event) events[event.id] = event;
      }

      return { schemaVersion: 1, runs, events };
    } catch {
      return emptyLedger();
    }
  }

  private async writeLedger(ledger: TokenUsageLedgerFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await atomicWriteAsync(this.filePath, `${JSON.stringify(ledger, null, 2)}\n`);
  }
}

function mergeRun(existing: TokenUsageRunDto, next: TokenUsageRunDto): TokenUsageRunDto {
  const sourceById = new Map(existing.sources.map((source) => [source.id, source]));
  for (const source of next.sources) {
    sourceById.set(source.id, source);
  }
  return {
    ...existing,
    ...next,
    sources: [...sourceById.values()],
  };
}
