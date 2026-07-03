import { createHash } from 'crypto';
import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';

import { normalizeTokenBreakdown } from '../../core/domain';

import { estimateTokenUsageCost } from './TokenUsageCostEstimator';

import type { TokenUsageEventDto, TokenUsageRunDto } from '../../contracts';
import type { TokenUsageImporterPort, TokenUsageLoggerPort } from '../../core/application';

type UnknownRecord = Record<string, unknown>;

const DEFAULT_MAX_LOG_BYTES = 64 * 1024 * 1024;
const CLAUDE_JSONL_IMPORTER_VERSION = 'claude-jsonl-v1';

interface ClaudeJsonlUsageImporterOptions {
  projectsBasePath: string;
  maxLogBytes?: number;
  enableSessionIdIndexFallback?: boolean;
  runLookbackMs?: number;
  logger?: Pick<TokenUsageLoggerPort, 'warn'>;
}

interface RunSessionSource {
  run: TokenUsageRunDto;
  sessionId: string;
  nativeLogPath?: string;
}

interface ClaudeUsageRecord {
  requestKey: string;
  requestId?: string;
  messageId?: string;
  sessionId: string;
  model?: string;
  tokens: TokenUsageEventDto['tokens'];
  occurredAt: string;
}

export class ClaudeJsonlUsageImporter implements TokenUsageImporterPort {
  readonly #projectsBasePath: string;
  readonly #maxLogBytes: number;
  readonly #enableSessionIdIndexFallback: boolean;
  readonly #runLookbackMs: number;
  readonly #logger?: Pick<TokenUsageLoggerPort, 'warn'>;

  constructor(options: ClaudeJsonlUsageImporterOptions) {
    this.#projectsBasePath = options.projectsBasePath;
    this.#maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.#enableSessionIdIndexFallback = options.enableSessionIdIndexFallback ?? true;
    this.#runLookbackMs = options.runLookbackMs ?? Number.POSITIVE_INFINITY;
    this.#logger = options.logger;
  }

  async importUsage(runs: readonly TokenUsageRunDto[]): Promise<TokenUsageEventDto[]> {
    const sources = collectClaudeRunSources(runs, this.#runLookbackMs);
    if (sources.length === 0) return [];

    const sessionIdsNeedingIndex = this.#enableSessionIdIndexFallback
      ? sources.filter((source) => !source.nativeLogPath).map((source) => source.sessionId)
      : [];
    const indexedLogPaths =
      sessionIdsNeedingIndex.length > 0
        ? await buildSessionLogPathIndex(this.#projectsBasePath, new Set(sessionIdsNeedingIndex))
        : new Map<string, string>();

    const events: TokenUsageEventDto[] = [];
    const importedAt = new Date().toISOString();
    const seenEventIds = new Set<string>();
    for (const source of sources) {
      const logPath = source.nativeLogPath ?? indexedLogPaths.get(source.sessionId);
      if (!logPath) continue;

      let records: ClaudeUsageRecord[];
      try {
        records = await parseClaudeUsageJsonl(logPath, source.sessionId, this.#maxLogBytes);
      } catch (error) {
        this.#logger?.warn('Failed to parse Claude token usage JSONL', { logPath, error });
        continue;
      }

      for (const record of records) {
        const model = record.model ?? source.run.model;
        const billingMode = source.run.billingMode ?? 'unknown';
        const eventId = buildClaudeJsonlEventId(source.run.appRunId, record.requestKey, model);
        if (seenEventIds.has(eventId)) continue;
        seenEventIds.add(eventId);

        events.push({
          id: eventId,
          appRunId: source.run.appRunId,
          requestId: record.requestId,
          teamName: source.run.teamName,
          agentId: source.run.agentId,
          agentName: source.run.agentName,
          commandId: source.run.commandId,
          commandInvocationId: source.run.commandInvocationId,
          runtimeKind: source.run.runtimeKind,
          providerId: source.run.providerId,
          providerBackendId: source.run.providerBackendId,
          billingMode,
          model,
          nativeSessionId: record.sessionId,
          nativeLogPath: logPath,
          tokens: record.tokens,
          cost: estimateTokenUsageCost(model, record.tokens, undefined, billingMode),
          usageSourceKind: 'log_parsed',
          rawUsageJson: {
            sourceName: 'claude-jsonl',
            parserVersion: CLAUDE_JSONL_IMPORTER_VERSION,
            requestKey: record.requestKey,
            messageId: record.messageId,
          },
          occurredAt: record.occurredAt,
          createdAt: importedAt,
        });
      }
    }

    return events;
  }
}

function collectClaudeRunSources(
  runs: readonly TokenUsageRunDto[],
  runLookbackMs: number
): RunSessionSource[] {
  const sources: RunSessionSource[] = [];
  const seen = new Set<string>();
  const minStartedAtMs = Number.isFinite(runLookbackMs) ? Date.now() - runLookbackMs : null;
  for (const run of runs) {
    if (run.runtimeKind !== 'anthropic' && run.providerId !== 'anthropic') continue;
    if (minStartedAtMs !== null) {
      const startedAtMs = Date.parse(run.startedAt);
      if (!Number.isFinite(startedAtMs) || startedAtMs < minStartedAtMs) continue;
    }
    for (const source of run.sources) {
      for (const sessionId of sessionIdCandidates(source.nativeSessionId)) {
        const key = `${run.appRunId}\0${sessionId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sources.push({
          run,
          sessionId,
          nativeLogPath: source.nativeLogPath,
        });
      }
    }
  }
  return sources;
}

async function buildSessionLogPathIndex(
  projectsBasePath: string,
  neededSessionIds: ReadonlySet<string>
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  if (neededSessionIds.size === 0) return index;

  const projectDirs = await readdir(projectsBasePath, { withFileTypes: true }).catch(() => []);
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    const projectPath = join(projectsBasePath, projectDir.name);
    const files = await readdir(projectPath, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const sessionId = file.name.slice(0, -'.jsonl'.length);
      if (!neededSessionIds.has(sessionId) || index.has(sessionId)) continue;
      index.set(sessionId, join(projectPath, file.name));
      if (index.size === neededSessionIds.size) return index;
    }
  }

  return index;
}

async function parseClaudeUsageJsonl(
  logPath: string,
  fallbackSessionId: string,
  maxLogBytes: number
): Promise<ClaudeUsageRecord[]> {
  const fileStat = await stat(logPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!fileStat) return [];
  if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > maxLogBytes) {
    return [];
  }

  const bestByRequest = new Map<string, ClaudeUsageRecord>();
  const text = await readFile(logPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = safeParseRecord(line);
    if (!record) continue;

    const usageRecord = readClaudeUsageRecord(record, fallbackSessionId);
    if (!usageRecord || usageRecord.tokens.totalTokens <= 0) continue;

    const existing = bestByRequest.get(usageRecord.requestKey);
    if (!existing || isBetterClaudeUsageRecord(usageRecord, existing)) {
      bestByRequest.set(usageRecord.requestKey, usageRecord);
    }
  }

  return [...bestByRequest.values()].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt)
  );
}

function readClaudeUsageRecord(
  record: UnknownRecord,
  fallbackSessionId: string
): ClaudeUsageRecord | null {
  const message = asRecord(record.message);
  const usage = asRecord(message?.usage);
  if (!usage) return null;

  const sessionId = readString(record.sessionId) ?? fallbackSessionId;
  const requestId = readString(record.requestId);
  const messageId = readString(message?.id);
  const uuid = readString(record.uuid);
  const requestKey = requestId ?? messageId ?? uuid;
  if (!requestKey) return null;

  const occurredAt = readString(record.timestamp);
  if (!occurredAt) return null;

  return {
    requestKey,
    requestId,
    messageId,
    sessionId,
    model: readString(message?.model) ?? readString(record.model),
    tokens: normalizeTokenBreakdown({
      inputTokens: readNumber(usage.input_tokens),
      outputTokens: readNumber(usage.output_tokens),
      cacheCreationTokens: readNumber(usage.cache_creation_input_tokens),
      cacheReadTokens: readNumber(usage.cache_read_input_tokens),
      reasoningTokens: readNumber(usage.reasoning_tokens),
    }),
    occurredAt,
  };
}

function isBetterClaudeUsageRecord(
  candidate: ClaudeUsageRecord,
  current: ClaudeUsageRecord
): boolean {
  if (candidate.tokens.outputTokens !== current.tokens.outputTokens) {
    return candidate.tokens.outputTokens > current.tokens.outputTokens;
  }
  if (candidate.tokens.totalTokens !== current.tokens.totalTokens) {
    return candidate.tokens.totalTokens > current.tokens.totalTokens;
  }
  return candidate.occurredAt > current.occurredAt;
}

function buildClaudeJsonlEventId(
  appRunId: string,
  requestKey: string,
  model: string | undefined
): string {
  return createHash('sha256')
    .update([appRunId, requestKey, model ?? '', CLAUDE_JSONL_IMPORTER_VERSION].join('\0'))
    .digest('hex');
}

function safeParseRecord(line: string): UnknownRecord | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

function sessionIdCandidates(value: string | undefined): string[] {
  if (!value) return [];
  const candidates = new Set([value]);
  const lastSegment = basename(value);
  if (lastSegment) candidates.add(lastSegment.replace(/\.jsonl$/i, ''));
  return [...candidates];
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
