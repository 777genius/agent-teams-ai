import { normalizeCostBreakdown, normalizeTokenBreakdown } from '..';

import type { TokenUsageEventDto, TokenUsageRunDto } from '../../../contracts';

export const testRun = (patch: Partial<TokenUsageRunDto> = {}): TokenUsageRunDto => ({
  appRunId: 'sandbox-run',
  runtimeKind: 'codex',
  teamName: 'sandbox-team',
  workspacePathHash: 'sandbox:hash',
  workspaceLabel: 'Sandbox project',
  startedAt: '2026-08-01T00:00:00.000Z',
  status: 'running',
  source: 'manual_import',
  sources: [],
  ...patch,
});
export const testEvent = (patch: Partial<TokenUsageEventDto> = {}): TokenUsageEventDto => ({
  id: 'sandbox-event',
  appRunId: 'sandbox-run',
  runtimeKind: 'codex',
  tokens: normalizeTokenBreakdown({
    totalTokens: 100,
    inputTokens: 10,
    cacheReadTokens: 80,
    reasoningTokens: 99,
  }),
  cost: normalizeCostBreakdown({
    estimatedUsd: 2,
    source: 'provider',
    billingMode: 'subscription',
  }),
  usageSourceKind: 'log_parsed',
  occurredAt: '2026-10-03T12:00:00.000Z',
  createdAt: '2026-10-03T12:00:00.000Z',
  ...patch,
});
