import { createLogger } from '@shared/utils/logger';

import {
  normalizeTokenUsageBudgetSettings,
  normalizeTokenUsageSnapshot,
  TOKEN_USAGE_BUDGET_SETTINGS_ROUTE,
  TOKEN_USAGE_BUDGET_STATUS_ROUTE,
  TOKEN_USAGE_SNAPSHOT_ROUTE,
  type TokenUsageAnalyticsSnapshotDto,
  type TokenUsageBudgetSettingsUpdateRequestDto,
  type TokenUsageSnapshotRequest,
  validateBudgetUpdate,
} from '../../../../contracts';

import type { TokenUsageFeatureFacade } from '../../../composition/createTokenUsageFeature';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('Feature:TokenUsage:HTTP');

export function registerTokenUsageHttp(
  app: FastifyInstance,
  feature: TokenUsageFeatureFacade
): void {
  app.get(TOKEN_USAGE_SNAPSHOT_ROUTE, async (request): Promise<TokenUsageAnalyticsSnapshotDto> => {
    try {
      const snapshot = await feature.refreshSnapshot(readSnapshotRequest(request.query));
      return normalizeTokenUsageSnapshot(snapshot) ?? snapshot;
    } catch (error) {
      logger.error('Failed to load token usage snapshot via HTTP', error);
      const now = new Date().toISOString();
      return {
        updatedAt: now,
        stale: false,
        degraded: true,
        summary: {
          requestCount: 0,
          runCount: 0,
          runningRunCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          reasoningTokens: 0,
          estimatedCostUsd: 0,
          billableCostUsd: 0,
          apiEquivalentCostUsd: 0,
          costKnownEventCount: 0,
          billableEventCount: 0,
          apiBillingRequestCount: 0,
          subscriptionRequestCount: 0,
          freeRequestCount: 0,
          unknownBillingRequestCount: 0,
          apiBillingTokens: 0,
          subscriptionTokens: 0,
          freeTokens: 0,
          unknownBillingTokens: 0,
          exactEventCount: 0,
          estimatedEventCount: 0,
        },
        byTeam: [],
        byAgent: [],
        byCommand: [],
        bySession: [],
        byProject: [],
        byRuntime: [],
        byModel: [],
        byTask: [],
        commandRuns: [],
        sessionRuns: [],
        tokenTrend: [],
        usageHeatmap: [],
        recentRuns: [],
        expensiveRuns: [],
        unmappedEventCount: 0,
        sourceCounts: {
          sdk_exact: 0,
          gateway_exact: 0,
          log_parsed: 0,
          tokenizer_estimated: 0,
          cost_estimated: 0,
        },
      };
    }
  });

  app.get(TOKEN_USAGE_BUDGET_STATUS_ROUTE, async (_request, reply) => {
    try {
      return await feature.getBudgetStatus();
    } catch (error) {
      logger.error('Failed to load budget status', error);
      return reply.code(503).send({ error: 'Budget status unavailable' });
    }
  });
  app.get(TOKEN_USAGE_BUDGET_SETTINGS_ROUTE, async (_request, reply) => {
    try {
      return normalizeTokenUsageBudgetSettings(await feature.getBudgetSettings());
    } catch (error) {
      logger.error('Failed to load budget settings', error);
      return reply.code(503).send({ error: 'Budget settings unavailable' });
    }
  });
  app.put<{ Body: TokenUsageBudgetSettingsUpdateRequestDto }>(
    TOKEN_USAGE_BUDGET_SETTINGS_ROUTE,
    async (request, reply) => {
      try {
        return await feature.updateBudgetSettings(validateBudgetUpdate(request.body));
      } catch (error) {
        logger.error('Failed to save budget settings', error);
        const code = (error as { code?: string }).code;
        return reply
          .code(code === 'BUDGET_VALIDATION' ? 400 : code === 'BUDGET_CONFLICT' ? 409 : 503)
          .send({ error: error instanceof Error ? error.message : 'Budget settings unavailable' });
      }
    }
  );
}

function readSnapshotRequest(query: unknown): TokenUsageSnapshotRequest | undefined {
  const record =
    query !== null && typeof query === 'object' ? (query as Record<string, unknown>) : {};
  const request: TokenUsageSnapshotRequest = {};
  const teamNames = readStringList(record.teamNames);
  if (teamNames.length > 0) request.teamNames = teamNames;
  for (const key of [
    'teamName',
    'agentId',
    'commandId',
    'commandInvocationId',
    'nativeSessionId',
    'from',
    'to',
  ] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      request[key] = value.trim();
    }
  }
  return Object.keys(request).length > 0 ? request : undefined;
}

function readStringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item, index, items) => item.length > 0 && items.indexOf(item) === index);
}
