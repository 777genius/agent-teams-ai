import { createHash } from 'crypto';

import type {
  TokenUsageEventDto,
  TokenUsageGatewayDegradedReason,
  TokenUsageGatewaySourceStateDto,
  TokenUsageRunDto,
  TokenUsageTokenBreakdownDto,
} from '../../contracts';
import type {
  TokenUsageGatewayModelUsage,
  TokenUsageGatewayUsagePort,
  TokenUsageGatewayUsageSource,
  TokenUsageImportBatch,
  TokenUsageImporterPort,
  TokenUsageLedgerRepositoryPort,
  TokenUsageLoggerPort,
} from '../../core/application';

const STABILIZATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const ZERO_TOKENS: TokenUsageTokenBreakdownDto = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  reasoningTokens: 0,
  audioTokens: 0,
  imageTokens: 0,
  totalTokens: 0,
};

export interface GatewayUsageImporterDeps {
  usage: TokenUsageGatewayUsagePort;
  ledger: Pick<TokenUsageLedgerRepositoryPort, 'readSnapshot'>;
  clock: { now(): Date };
  logger?: TokenUsageLoggerPort;
}

interface SourceImportResult {
  events: TokenUsageEventDto[];
  state: TokenUsageGatewaySourceStateDto;
}

/** Gateway imports always carry per-source states (CLI importers leave them unset). */
export interface GatewayImportBatch extends TokenUsageImportBatch {
  sourceStates: readonly TokenUsageGatewaySourceStateDto[];
}

export class GatewayUsageImporter implements TokenUsageImporterPort {
  readonly includesGatewayRuns = true;

  constructor(private readonly deps: GatewayUsageImporterDeps) {}

  async importUsage(runs: readonly TokenUsageRunDto[]): Promise<GatewayImportBatch> {
    let sources: TokenUsageGatewayUsageSource[];
    try {
      sources = await this.deps.usage.listSources();
    } catch (error) {
      this.deps.logger?.warn('Failed to list gateway usage sources', error);
      return { events: [], sourceStates: [] };
    }
    if (sources.length === 0) return { events: [], sourceStates: [] };

    const ledger = await this.deps.ledger.readSnapshot();
    const previousStates = new Map(
      ledger.sourceStates.map((state) => [state.gatewayUsageRef, state])
    );
    const previousEvents = new Map<string, TokenUsageEventDto[]>();
    for (const event of ledger.events) {
      if (event.usageSourceKind !== 'gateway_exact' || !event.gatewayUsageRef) continue;
      const current = previousEvents.get(event.gatewayUsageRef) ?? [];
      current.push(event);
      previousEvents.set(event.gatewayUsageRef, current);
    }

    const events: TokenUsageEventDto[] = [];
    const sourceStates: TokenUsageGatewaySourceStateDto[] = [];
    for (const source of sources) {
      const result = await this.importSource(
        source,
        runs,
        previousStates.get(source.gatewayUsageRef),
        previousEvents.get(source.gatewayUsageRef) ?? []
      );
      events.push(...result.events);
      sourceStates.push(result.state);
    }
    return { events, sourceStates };
  }

  private async importSource(
    source: TokenUsageGatewayUsageSource,
    runs: readonly TokenUsageRunDto[],
    previousState: TokenUsageGatewaySourceStateDto | undefined,
    previousEvents: readonly TokenUsageEventDto[]
  ): Promise<SourceImportResult> {
    const now = this.deps.clock.now();
    const nowIso = now.toISOString();
    const today = utcDay(now);
    const linkedRuns = runs.filter((run) => run.gatewayUsageRef === source.gatewayUsageRef);
    const agentId =
      linkedRuns.find(
        (run) =>
          run.agentId &&
          run.teamName === source.teamName &&
          run.agentName === source.memberName &&
          run.sources.length > 0
      )?.agentId ??
      source.agentId ??
      `${source.teamName}:${source.memberName}`;
    const attributedSource = { ...source, agentId };
    const lastUsedAt = latestIso([
      source.lastUnboundAt,
      source.runtimeArtifactRetiredAt,
      ...linkedRuns.map((run) => run.endedAt ?? run.startedAt),
    ]);
    const active =
      source.hasActiveBinding ||
      source.hasRuntimeArtifact ||
      linkedRuns.some(
        (run) => run.status === 'running' || run.status === 'unknown' || !run.endedAt
      );
    const finalUsageDay =
      !active && lastUsedAt !== undefined ? utcDay(new Date(lastUsedAt)) : undefined;

    const watermark = previousState?.watermarkDay;
    const endDay = finalUsageDay !== undefined && finalUsageDay < today ? finalUsageDay : today;
    const startDay =
      watermark !== undefined
        ? minDay(addUtcDays(watermark, 1), addUtcDays(today, -1))
        : source.firstUsageDay;

    const events: TokenUsageEventDto[] = [];
    let degradedReason: TokenUsageGatewayDegradedReason | undefined;
    let cursor = watermark;

    if (startDay <= endDay) {
      for (let day = startDay; day <= endDay; day = addUtcDays(day, 1)) {
        let usage: TokenUsageGatewayModelUsage[];
        try {
          usage = await this.deps.usage.readUsageDay(source.gatewayUsageRef, day);
        } catch (error) {
          degradedReason = readCredentialReason(error) ?? 'http_unavailable';
          this.deps.logger?.warn('Failed to read gateway usage day', error);
          continue;
        }
        events.push(...buildDayEvents(attributedSource, day, usage, previousEvents, nowIso));
        if (
          now.getTime() >= dayEndMs(day) + STABILIZATION_WINDOW_MS &&
          (cursor === undefined ? day === source.firstUsageDay : day === addUtcDays(cursor, 1))
        ) {
          cursor = day;
        }
      }
    }

    // Repair identity on stabilized ledger days without refetching or changing their amounts.
    const refreshedIds = new Set(events.map((event) => event.id));
    for (const previous of previousEvents) {
      if (previous.agentId !== agentId && !refreshedIds.has(previous.id))
        events.push({ ...previous, agentId, createdAt: nowIso });
    }
    const degraded = degradedReason !== undefined;
    return {
      events,
      state: {
        gatewayUsageRef: source.gatewayUsageRef,
        teamName: source.teamName,
        agentName: source.memberName,
        agentId,
        watermarkDay: cursor,
        lastUsedAt,
        finalUsageDay,
        degraded,
        degradedReason,
        lastSuccessfulAt: degraded ? previousState?.lastSuccessfulAt : nowIso,
      },
    };
  }
}

function buildDayEvents(
  source: TokenUsageGatewayUsageSource,
  day: string,
  usage: readonly TokenUsageGatewayModelUsage[],
  previousEvents: readonly TokenUsageEventDto[],
  nowIso: string
): TokenUsageEventDto[] {
  const events: TokenUsageEventDto[] = [];
  const seen = new Set<string>();
  for (const stat of usage) {
    seen.add(stat.model);
    events.push(toGatewayEvent(source, day, stat, nowIso));
  }
  for (const previous of previousEvents) {
    if (previous.gatewayDay !== day || !previous.model || seen.has(previous.model)) continue;
    events.push(zeroOutEvent({ ...previous, agentId: source.agentId }, nowIso));
  }
  return events;
}

function toGatewayEvent(
  source: TokenUsageGatewayUsageSource,
  day: string,
  stat: TokenUsageGatewayModelUsage,
  nowIso: string
): TokenUsageEventDto {
  return {
    id: gatewayEventId(source.gatewayUsageRef, day, stat.model),
    appRunId: `gateway:${source.gatewayUsageRef}:${day}`,
    teamName: source.teamName,
    agentId: source.agentId,
    agentName: source.memberName,
    runtimeKind: 'unknown',
    billingMode: 'api',
    model: stat.model,
    tokens: {
      inputTokens: stat.inputTokens,
      outputTokens: stat.outputTokens,
      cacheCreationTokens: stat.cacheCreationTokens,
      cacheReadTokens: stat.cacheReadTokens,
      reasoningTokens: 0,
      audioTokens: 0,
      imageTokens: 0,
      totalTokens: stat.totalTokens,
    },
    cost: {
      estimatedUsd: stat.apiEquivalentUsd,
      billableUsd: stat.billableUsd,
      apiEquivalentUsd: stat.apiEquivalentUsd,
      source: 'gateway',
      billingMode: 'api',
    },
    usageSourceKind: 'gateway_exact',
    gatewayUsageRef: source.gatewayUsageRef,
    gatewayDay: day,
    requestCount: stat.requests,
    occurredAt: `${day}T00:00:00.000Z`,
    createdAt: nowIso,
  };
}

function zeroOutEvent(previous: TokenUsageEventDto, nowIso: string): TokenUsageEventDto {
  return {
    ...previous,
    tokens: { ...ZERO_TOKENS },
    cost: {
      estimatedUsd: 0,
      billableUsd: 0,
      apiEquivalentUsd: 0,
      source: 'gateway',
      billingMode: 'api',
    },
    requestCount: 0,
    createdAt: nowIso,
  };
}

function gatewayEventId(gatewayUsageRef: string, day: string, model: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([gatewayUsageRef, day, model]))
    .digest('hex');
  return `gateway:${digest}`;
}

function readCredentialReason(error: unknown): TokenUsageGatewayDegradedReason | undefined {
  const reason =
    error !== null && typeof error === 'object'
      ? (error as { reason?: unknown }).reason
      : undefined;
  return reason === 'credential_changed' || reason === 'credential_missing' ? reason : undefined;
}

function latestIso(values: readonly (string | undefined)[]): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const time = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(time) && time > latestMs) {
      latest = value;
      latestMs = time;
    }
  }
  return latest;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayEndMs(day: string): number {
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, date) + DAY_MS;
}

function addUtcDays(day: string, days: number): string {
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number);
  return utcDay(new Date(Date.UTC(year, month - 1, date + days)));
}

function minDay(left: string, right: string): string {
  return left <= right ? left : right;
}
