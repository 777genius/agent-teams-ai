import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { mkdir, readFile, stat } from 'fs/promises';
import { dirname } from 'path';

import { normalizeCostBreakdown, normalizeTokenBreakdown } from '../../core/domain';

import type {
  TokenUsageEventDto,
  TokenUsageGatewayDegradedReason,
  TokenUsageGatewaySourceStateDto,
  TokenUsageRunDto,
  TokenUsageRunSourceDto,
  TokenUsageRunStatus,
  TokenUsageRuntimeKind,
  TokenUsageSourceKind,
} from '../../contracts';
import type {
  TokenUsageImportBatch,
  TokenUsageLedgerRepositoryPort,
  TokenUsageLedgerSnapshot,
} from '../../core/application';

interface TokenUsageLedgerFile {
  schemaVersion: 1;
  runs: Record<string, TokenUsageRunDto>;
  events: Record<string, TokenUsageEventDto>;
  sourceStates: Record<string, TokenUsageGatewaySourceStateDto>;
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

function readUtcDay(value: unknown): string | undefined {
  const day = readString(value);
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
}

function readRequestCount(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    Number.isFinite(value)
    ? value
    : undefined;
}

function readDegradedReason(value: unknown): TokenUsageGatewayDegradedReason | undefined {
  return value === 'http_unavailable' ||
    value === 'credential_changed' ||
    value === 'credential_missing'
    ? value
    : undefined;
}

function normalizeSourceState(value: unknown): TokenUsageGatewaySourceStateDto | null {
  const record = asRecord(value);
  const gatewayUsageRef = readString(record?.gatewayUsageRef);
  const teamName = readString(record?.teamName);
  const agentName = readString(record?.agentName);
  if (!gatewayUsageRef || !teamName || !agentName) return null;
  return {
    gatewayUsageRef,
    teamName,
    agentName,
    agentId: readString(record?.agentId),
    watermarkDay: readString(record?.watermarkDay),
    lastUsedAt: readString(record?.lastUsedAt),
    finalUsageDay: readString(record?.finalUsageDay),
    degraded: record?.degraded === true,
    degradedReason: readDegradedReason(record?.degradedReason),
    lastSuccessfulAt: readString(record?.lastSuccessfulAt),
  };
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
    gatewayUsageRef: readString(record?.gatewayUsageRef),
    terminationConfirmed: record?.terminationConfirmed === true ? true : undefined,
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
    gatewayUsageRef: readString(record?.gatewayUsageRef),
    gatewayDay: readUtcDay(record?.gatewayDay),
    requestCount: readRequestCount(record?.requestCount),
    rawUsageJson: record?.rawUsageJson,
    occurredAt,
    createdAt,
  };
}

function emptyLedger(): TokenUsageLedgerFile {
  return { schemaVersion: 1, runs: {}, events: {}, sourceStates: {} };
}

function normalizeRuns(runs: readonly TokenUsageRunDto[]): TokenUsageRunDto[] {
  return runs.map((value) => {
    const run = normalizeRun(value);
    if (!run) throw new Error('Invalid token usage run entry');
    return run;
  });
}

export class JsonTokenUsageLedgerRepository implements TokenUsageLedgerRepositoryPort {
  constructor(private readonly filePath: string) {}

  async readSnapshot(): Promise<TokenUsageLedgerSnapshot> {
    const ledger = await this.readLedger();
    return {
      runs: Object.values(ledger.runs),
      events: Object.values(ledger.events),
      sourceStates: Object.values(ledger.sourceStates),
    };
  }

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
    const normalizedRuns = normalizeRuns(runs);
    const ledger = await this.readLedger();
    for (const run of normalizedRuns) {
      const existing = ledger.runs[run.appRunId];
      ledger.runs[run.appRunId] = existing ? mergeRun(existing, run) : run;
    }
    await this.writeLedger(ledger);
  }

  async replaceRunsForSource(
    source: TokenUsageRunDto['source'],
    runs: readonly TokenUsageRunDto[]
  ): Promise<void> {
    if (source !== 'app_launcher' && source !== 'team_launch_state' && source !== 'manual_import') {
      throw new Error('Invalid token usage run source');
    }
    const normalizedRuns = normalizeRuns(runs);
    const ledger = await this.readLedger();
    const nextRunIds = new Set(normalizedRuns.map((run) => run.appRunId));
    const eventRunIds = new Set(Object.values(ledger.events).map((event) => event.appRunId));

    for (const [appRunId, run] of Object.entries(ledger.runs)) {
      if (run.source !== source || nextRunIds.has(appRunId) || eventRunIds.has(appRunId)) {
        continue;
      }
      delete ledger.runs[appRunId];
    }

    for (const run of normalizedRuns) {
      const existing = ledger.runs[run.appRunId];
      ledger.runs[run.appRunId] = existing ? mergeRun(existing, run) : run;
    }
    await this.writeLedger(ledger);
  }

  async upsertEvents(events: readonly TokenUsageEventDto[]): Promise<void> {
    await this.commitImportBatch({ events });
  }

  async commitImportBatch(batch: TokenUsageImportBatch): Promise<void> {
    if (batch.events.length === 0 && (batch.sourceStates?.length ?? 0) === 0) return;
    const normalizedEvents = batch.events.map((value) => {
      const event = normalizeEvent(value);
      if (!event) throw new Error('Invalid token usage event entry');
      return event;
    });
    const normalizedStates = (batch.sourceStates ?? []).map((value) => {
      const state = normalizeSourceState(value);
      if (!state) throw new Error('Invalid gateway usage source state');
      return state;
    });
    const ledger = await this.readLedger();
    for (const event of normalizedEvents) {
      ledger.events[event.id] = event;
    }
    for (const state of normalizedStates) {
      ledger.sourceStates[state.gatewayUsageRef] = state;
    }
    await this.writeLedger(ledger);
  }

  private async readLedger(): Promise<TokenUsageLedgerFile> {
    try {
      const fileStat = await stat(this.filePath);
      if (!fileStat.isFile() || fileStat.size > MAX_LEDGER_BYTES) {
        throw new Error('Token usage ledger exceeds its size limit or is not a file');
      }
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const record = asRecord(parsed);
      if (record?.schemaVersion !== 1 || !asRecord(record.runs) || !asRecord(record.events))
        throw new Error('Invalid token usage ledger schema');
      const runsRecord = asRecord(record.runs)!;
      const eventsRecord = asRecord(record?.events) ?? {};
      const statesRecord = asRecord(record?.sourceStates) ?? {};
      const runs: Record<string, TokenUsageRunDto> = {};
      const events: Record<string, TokenUsageEventDto> = {};
      const sourceStates: Record<string, TokenUsageGatewaySourceStateDto> = {};

      for (const value of Object.values(runsRecord)) {
        const run = normalizeRun(value);
        if (!run) throw new Error('Invalid token usage run entry');
        runs[run.appRunId] = run;
      }
      for (const value of Object.values(eventsRecord)) {
        const event = normalizeEvent(value);
        if (!event) throw new Error('Invalid token usage event entry');
        events[event.id] = event;
      }
      for (const value of Object.values(statesRecord)) {
        const state = normalizeSourceState(value);
        if (!state) throw new Error('Invalid gateway usage source state');
        sourceStates[state.gatewayUsageRef] = state;
      }

      return { schemaVersion: 1, runs, events, sourceStates };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLedger();
      throw error;
    }
  }

  private async writeLedger(ledger: TokenUsageLedgerFile): Promise<void> {
    const serialized = `${JSON.stringify(ledger, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_LEDGER_BYTES) {
      throw new Error('Token usage ledger exceeds its size limit');
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    await atomicWriteAsync(this.filePath, serialized);
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
