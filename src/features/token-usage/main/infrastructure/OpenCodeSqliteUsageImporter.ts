import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import { normalizeCostBreakdown, normalizeTokenBreakdown } from '../../core/domain';

import { estimateTokenUsageCost } from './TokenUsageCostEstimator';

import type { TokenUsageBillingMode, TokenUsageEventDto, TokenUsageRunDto } from '../../contracts';
import type { TokenUsageImporterPort, TokenUsageLoggerPort } from '../../core/application';

type UnknownRecord = Record<string, unknown>;

const PARSER_VERSION = 'opencode-sqlite-v1';
const DEFAULT_RUN_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const MAX_SESSION_IDS_PER_QUERY = 400;

interface OpenCodeSqliteUsageImporterOptions {
  runLookbackMs?: number;
  logger?: Pick<TokenUsageLoggerPort, 'warn'>;
}

interface OpenCodeRunSource {
  run: TokenUsageRunDto;
  sessionId: string;
  databasePath: string;
}

interface OpenCodeMessageRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface OpenCodePartRow {
  message_id: string;
  data: string;
}

export class OpenCodeSqliteUsageImporter implements TokenUsageImporterPort {
  readonly #runLookbackMs: number;
  readonly #logger?: Pick<TokenUsageLoggerPort, 'warn'>;

  constructor(options: OpenCodeSqliteUsageImporterOptions = {}) {
    this.#runLookbackMs = options.runLookbackMs ?? DEFAULT_RUN_LOOKBACK_MS;
    this.#logger = options.logger;
  }

  async importUsage(runs: readonly TokenUsageRunDto[]): Promise<TokenUsageEventDto[]> {
    const sources = collectOpenCodeRunSources(runs, this.#runLookbackMs);
    if (sources.length === 0) return [];

    const sourcesByDatabase = new Map<string, OpenCodeRunSource[]>();
    for (const source of sources) {
      const group = sourcesByDatabase.get(source.databasePath) ?? [];
      group.push(source);
      sourcesByDatabase.set(source.databasePath, group);
    }

    const importedAt = new Date().toISOString();
    const events: TokenUsageEventDto[] = [];
    for (const [databasePath, databaseSources] of sourcesByDatabase) {
      try {
        events.push(...(await importDatabaseUsage(databasePath, databaseSources, importedAt)));
      } catch (error) {
        this.#logger?.warn('Failed to parse OpenCode token usage database', {
          databasePath,
          error,
        });
      }
    }
    return events;
  }
}

function collectOpenCodeRunSources(
  runs: readonly TokenUsageRunDto[],
  runLookbackMs: number
): OpenCodeRunSource[] {
  const minStartedAtMs = Date.now() - runLookbackMs;
  const sources: OpenCodeRunSource[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    if (run.runtimeKind !== 'opencode' && run.providerId !== 'opencode') continue;
    const startedAtMs = Date.parse(run.startedAt);
    if (!Number.isFinite(startedAtMs) || startedAtMs < minStartedAtMs) continue;
    for (const source of run.sources) {
      const sessionId = source.nativeSessionId?.trim();
      const databasePath = source.nativeLogPath?.trim();
      if (!sessionId || !databasePath?.endsWith('opencode.db')) continue;
      const key = `${run.appRunId}\0${sessionId}\0${databasePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ run, sessionId, databasePath });
    }
  }
  return sources;
}

async function importDatabaseUsage(
  databasePath: string,
  sources: readonly OpenCodeRunSource[],
  importedAt: string
): Promise<TokenUsageEventDto[]> {
  const databaseStat = await stat(databasePath).catch(() => null);
  if (!databaseStat?.isFile() || databaseStat.size <= 0) return [];

  const sourceBySessionId = new Map(sources.map((source) => [source.sessionId, source]));
  const rows: OpenCodeMessageRow[] = [];
  const kiroCreditsByMessageId = new Map<
    string,
    NonNullable<TokenUsageEventDto['providerUsage']>['kiro']
  >();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const sessionIds = [...sourceBySessionId.keys()];
    for (let index = 0; index < sessionIds.length; index += MAX_SESSION_IDS_PER_QUERY) {
      const batch = sessionIds.slice(index, index + MAX_SESSION_IDS_PER_QUERY);
      const placeholders = batch.map(() => '?').join(',');
      const statement = database.prepare(
        `SELECT id, session_id, time_created, data FROM message WHERE session_id IN (${placeholders}) ORDER BY time_created, id`
      );
      rows.push(...(statement.all(...batch) as unknown as OpenCodeMessageRow[]));
    }
    collectKiroCredits(database, rows, kiroCreditsByMessageId);
  } finally {
    database.close();
  }

  const events: TokenUsageEventDto[] = [];
  const seenEventIds = new Set<string>();
  for (const row of rows) {
    const source = sourceBySessionId.get(row.session_id);
    if (!source) continue;
    const event = toUsageEvent(
      row,
      source,
      databasePath,
      importedAt,
      kiroCreditsByMessageId.get(row.id)
    );
    if (!event || seenEventIds.has(event.id)) continue;
    seenEventIds.add(event.id);
    events.push(event);
  }
  return events;
}

function toUsageEvent(
  row: OpenCodeMessageRow,
  source: OpenCodeRunSource,
  databasePath: string,
  importedAt: string,
  kiroCredits: NonNullable<TokenUsageEventDto['providerUsage']>['kiro'] | undefined
): TokenUsageEventDto | null {
  const data = safeParseRecord(row.data);
  if (data?.role !== 'assistant') return null;
  const rawTokens = asRecord(data.tokens);
  const rawCache = asRecord(rawTokens?.cache);
  const tokens = normalizeTokenBreakdown({
    inputTokens: readNumber(rawTokens?.input ?? rawTokens?.inputTokens ?? rawTokens?.input_tokens),
    outputTokens: readNumber(
      rawTokens?.output ?? rawTokens?.outputTokens ?? rawTokens?.output_tokens
    ),
    reasoningTokens: readNumber(
      rawTokens?.reasoning ?? rawTokens?.reasoningTokens ?? rawTokens?.reasoning_tokens
    ),
    cacheCreationTokens: readNumber(
      rawCache?.write ?? rawTokens?.cacheCreationTokens ?? rawTokens?.cache_creation_tokens
    ),
    cacheReadTokens: readNumber(
      rawCache?.read ?? rawTokens?.cacheReadTokens ?? rawTokens?.cache_read_tokens
    ),
    totalTokens: readNumber(rawTokens?.total ?? rawTokens?.totalTokens ?? rawTokens?.total_tokens),
  });
  const providerId = readString(data.providerID ?? data.providerId);
  const modelId = readString(data.modelID ?? data.modelId);
  const model = providerId && modelId ? `${providerId}/${modelId}` : source.run.model;
  const billingMode = source.run.billingMode ?? 'unknown';
  const rawCostUsd = readNumber(data.cost);
  const rawTime = asRecord(data.time);
  const occurredAt = readIsoTimestamp(rawTime?.completed ?? rawTime?.created ?? row.time_created);
  if (!occurredAt) return null;
  const modelUsesKiro = providerId === 'kiro' || model?.toLowerCase().startsWith('kiro/');
  const providerUsage = modelUsesKiro && kiroCredits ? { kiro: kiroCredits } : undefined;
  if (tokens.totalTokens <= 0 && !providerUsage) return null;

  return {
    id: createHash('sha256')
      .update(`${source.run.appRunId}\0${row.id}\0${model ?? ''}`)
      .digest('hex'),
    appRunId: source.run.appRunId,
    requestId: row.id,
    teamName: source.run.teamName,
    agentId: source.run.agentId,
    agentName: source.run.agentName,
    commandId: source.run.commandId,
    commandInvocationId: source.run.commandInvocationId,
    runtimeKind: 'opencode',
    providerId: source.run.providerId,
    providerBackendId: source.run.providerBackendId,
    billingMode,
    model,
    nativeSessionId: row.session_id,
    nativeLogPath: databasePath,
    tokens,
    cost: buildCost(model, tokens, rawCostUsd, billingMode),
    providerUsage,
    usageSourceKind: 'sdk_exact',
    rawUsageJson: {
      sourceName: 'opencode-sqlite',
      parserVersion: PARSER_VERSION,
      messageId: row.id,
      providerId,
      finish: readString(data.finish),
      kiroCredits: providerUsage?.kiro.credits,
      kiroCreditsUnit: providerUsage?.kiro.creditsUnit,
    },
    occurredAt,
    createdAt: importedAt,
  };
}

function collectKiroCredits(
  database: DatabaseSync,
  messages: readonly OpenCodeMessageRow[],
  destination: Map<string, NonNullable<TokenUsageEventDto['providerUsage']>['kiro']>
): void {
  const messageIds = messages.map((message) => message.id);
  try {
    for (let index = 0; index < messageIds.length; index += MAX_SESSION_IDS_PER_QUERY) {
      const batch = messageIds.slice(index, index + MAX_SESSION_IDS_PER_QUERY);
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => '?').join(',');
      const rows = database
        .prepare(`SELECT message_id, data FROM part WHERE message_id IN (${placeholders})`)
        .all(...batch) as unknown as OpenCodePartRow[];
      for (const row of rows) {
        const data = safeParseRecord(row.data);
        const metadata = asRecord(data?.metadata ?? data?.providerMetadata);
        const kiro = asRecord(metadata?.kiro);
        const credits = readNonNegativeNumber(kiro?.credits);
        if (credits === null) continue;
        const creditsUnit = readString(kiro?.creditsUnit) ?? 'credit';
        const current = destination.get(row.message_id);
        if (!current || credits > current.credits) {
          destination.set(row.message_id, { credits, creditsUnit });
        }
      }
    }
  } catch {
    // Older OpenCode databases may not have a part table yet. Token usage still imports.
  }
}

function buildCost(
  model: string | undefined,
  tokens: TokenUsageEventDto['tokens'],
  rawCostUsd: number,
  billingMode: TokenUsageBillingMode
): TokenUsageEventDto['cost'] {
  if (rawCostUsd > 0 && billingMode === 'api') {
    return normalizeCostBreakdown({
      estimatedUsd: rawCostUsd,
      billableUsd: rawCostUsd,
      apiEquivalentUsd: rawCostUsd,
      source: 'provider',
      billingMode,
    });
  }
  return estimateTokenUsageCost(
    model,
    tokens,
    rawCostUsd > 0 ? rawCostUsd : undefined,
    billingMode
  );
}

function safeParseRecord(value: string): UnknownRecord | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}
