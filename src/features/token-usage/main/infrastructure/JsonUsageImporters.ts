import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';

import { normalizeTokenBreakdown } from '../../core/domain';

import { estimateTokenUsageCost } from './TokenUsageCostEstimator';

import type {
  TokenUsageBillingMode,
  TokenUsageEventDto,
  TokenUsageRunDto,
  TokenUsageRuntimeKind,
  TokenUsageSourceKind,
} from '../../contracts';
import type { TokenUsageImporterPort } from '../../core/application';

type UnknownRecord = Record<string, unknown>;
type UsageImportSourceName = 'ccusage' | 'tokscale';
const MAX_IMPORT_JSON_BYTES = 24 * 1024 * 1024;

export function createJsonFileUsageImporter(
  sourceName: UsageImportSourceName,
  filePath: string
): TokenUsageImporterPort {
  return new StaticJsonUsageImporter(sourceName, async () => {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size > MAX_IMPORT_JSON_BYTES) {
      throw new Error(`Token usage import JSON is not a readable bounded file: ${filePath}`);
    }
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  });
}

export class StaticJsonUsageImporter implements TokenUsageImporterPort {
  constructor(
    private readonly sourceName: UsageImportSourceName,
    private readonly loadJson: () => Promise<unknown>
  ) {}

  async importUsage(runs: readonly TokenUsageRunDto[]): Promise<TokenUsageEventDto[]> {
    const raw = await this.loadJson();
    const importedAt = new Date().toISOString();
    const records = extractRecords(raw).flatMap((record) =>
      expandUsageRecord(this.sourceName, record)
    );
    const runByNativeSession = indexRunsByNativeSession(runs);
    const events: TokenUsageEventDto[] = [];

    for (const record of records) {
      const match = findRunMatch(record, runByNativeSession);
      if (!match) continue;
      const { run, sessionId } = match;
      if (!run) continue;
      const occurredAt = readOccurredAt(record, run);
      const model = readModel(record) ?? run.model;
      const tokens = normalizeTokenBreakdown({
        inputTokens: readFirstNumber(record, ['inputTokens', 'input_tokens', 'input']),
        outputTokens: readFirstNumber(record, ['outputTokens', 'output_tokens', 'output']),
        cacheCreationTokens: readFirstNumber(record, [
          'cacheCreationTokens',
          'cache_creation_input_tokens',
          'cacheWriteTokens',
          'cacheWrite',
          'cache_write',
        ]),
        cacheReadTokens: readFirstNumber(record, [
          'cacheReadTokens',
          'cache_read_input_tokens',
          'cacheRead',
          'cache_read',
        ]),
        reasoningTokens: readFirstNumber(record, [
          'reasoningTokens',
          'reasoning_tokens',
          'reasoning',
        ]),
        totalTokens: readFirstNumber(record, ['totalTokens', 'total_tokens', 'tokens', 'total']),
      });
      if (tokens.totalTokens <= 0) continue;
      const rawCostUsd = readFirstNumber(record, ['costUsd', 'cost_usd', 'totalCost', 'cost']);
      const billingMode = readBillingMode(record) ?? run.billingMode ?? 'unknown';

      events.push({
        id: buildImportedEventId(run.appRunId, sessionId, model),
        appRunId: run.appRunId,
        teamName: run.teamName,
        agentId: run.agentId,
        agentName: run.agentName,
        commandId: run.commandId,
        commandInvocationId: run.commandInvocationId,
        runtimeKind: run.runtimeKind,
        providerId: readString(record.provider) ?? run.providerId,
        providerBackendId: run.providerBackendId,
        billingMode,
        model,
        nativeSessionId: sessionId,
        tokens,
        cost: estimateTokenUsageCost(model, tokens, rawCostUsd, billingMode),
        usageSourceKind: sourceKindForRuntime(run.runtimeKind),
        rawUsageJson: {
          sourceName: this.sourceName,
          record,
        },
        occurredAt,
        createdAt: importedAt,
      });
    }

    return events;
  }
}

function extractRecords(raw: unknown): UnknownRecord[] {
  if (Array.isArray(raw)) {
    return raw.map(asRecord).filter((record): record is UnknownRecord => !!record);
  }
  const record = asRecord(raw);
  if (!record) return [];
  for (const key of ['data', 'items', 'sessions', 'session', 'usage', 'records', 'entries']) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.map(asRecord).filter((item): item is UnknownRecord => !!item);
    }
  }
  return [record];
}

function expandUsageRecord(
  sourceName: UsageImportSourceName,
  record: UnknownRecord
): UnknownRecord[] {
  const modelBreakdowns = readRecordArray(record.modelBreakdowns);
  const sessionId = readSessionId(record);
  if (sourceName === 'ccusage' && sessionId && modelBreakdowns.length > 0) {
    return modelBreakdowns.map((breakdown) => ({
      ...breakdown,
      sessionId,
      timestamp: readOccurredAtValue(record),
      provider: readString(record.provider),
    }));
  }
  return [record];
}

function indexRunsByNativeSession(
  runs: readonly TokenUsageRunDto[]
): Map<string, TokenUsageRunDto> {
  const index = new Map<string, TokenUsageRunDto>();
  for (const run of runs) {
    for (const source of run.sources) {
      for (const candidate of sessionIdCandidates(source.nativeSessionId)) {
        index.set(candidate, run);
      }
    }
  }
  return index;
}

function findRunMatch(
  record: UnknownRecord,
  runByNativeSession: Map<string, TokenUsageRunDto>
): { run: TokenUsageRunDto; sessionId: string } | undefined {
  for (const candidate of sessionIdCandidates(readSessionId(record))) {
    const run = runByNativeSession.get(candidate);
    if (run) return { run, sessionId: candidate };
  }
  return undefined;
}

function buildImportedEventId(
  appRunId: string,
  sessionId: string,
  model: string | undefined
): string {
  return createHash('sha256')
    .update([appRunId, sessionId, model ?? '', 'session-model-total'].join('\0'))
    .digest('hex');
}

function sourceKindForRuntime(runtimeKind: TokenUsageRuntimeKind): TokenUsageSourceKind {
  return runtimeKind === 'codex' || runtimeKind === 'opencode' || runtimeKind === 'anthropic'
    ? 'log_parsed'
    : 'tokenizer_estimated';
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function readSessionId(record: UnknownRecord): string | undefined {
  return (
    readString(record.sessionId) ??
    readString(record.session_id) ??
    readString(record.period) ??
    readString(record.session) ??
    readString(record.id)
  );
}

function sessionIdCandidates(value: string | undefined): string[] {
  if (!value) return [];
  const candidates = new Set([value]);
  const pathSegments = value.split(/[\\/]/).filter(Boolean);
  const lastSegment = pathSegments.at(-1);
  if (lastSegment) candidates.add(lastSegment);
  return [...candidates];
}

function readModel(record: UnknownRecord): string | undefined {
  return (
    readModelString(record.model) ??
    readModelString(record.modelName) ??
    readModelString(record.model_name) ??
    readFirstModelString(record.modelsUsed)
  );
}

function readBillingMode(record: UnknownRecord): TokenUsageBillingMode | undefined {
  const value = readString(record.billingMode) ?? readString(record.billing_mode);
  return value === 'api' || value === 'subscription' || value === 'free' || value === 'unknown'
    ? value
    : undefined;
}

function readOccurredAt(record: UnknownRecord, run: TokenUsageRunDto): string {
  return readOccurredAtValue(record) ?? run.endedAt ?? run.startedAt;
}

function readOccurredAtValue(record: UnknownRecord): string | undefined {
  const metadata = asRecord(record.metadata);
  return (
    readString(record.timestamp) ??
    readString(record.date) ??
    readString(record.createdAt) ??
    readString(record.created_at) ??
    readString(record.lastActivity) ??
    readString(metadata?.lastActivity)
  );
}

function readRecordArray(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((record): record is UnknownRecord => record !== null);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readModelString(value: unknown): string | undefined {
  const model = readString(value);
  if (!model || model === '<synthetic>' || model === 'synthetic') return undefined;
  return model;
}

function readFirstModelString(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const model = readModelString(item);
    if (model) return model;
  }
  return undefined;
}

function readFirstNumber(record: UnknownRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = readNumber(record[key]);
    if (value !== undefined) return value;
  }
  for (const containerKey of ['tokens', 'usage', 'totals']) {
    const container = asRecord(record[containerKey]);
    if (!container) continue;
    for (const key of keys) {
      const value = readNumber(container[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
