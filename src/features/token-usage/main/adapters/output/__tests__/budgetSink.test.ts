import { describe, expect, it, vi } from 'vitest';

import { createBudgetNotificationSink } from '../createBudgetNotificationSink';

import type { TeamNotificationPayload } from '@main/utils/teamNotificationBuilder';

describe('real Budget notification formatter adapter', () => {
  it('accepts manager null/dedup and renders both reasons into one in-app payload', async () => {
    const manager = {
      addTeamNotification: vi.fn(async (_payload: TeamNotificationPayload) => null),
    };
    const base = {
      dedupeKey: 'coverage',
      sentAt: '2026-10-03T00:00:00.000Z',
      periodKey: '2026-10',
      scope: 'global' as const,
      id: 'global',
      threshold: 100,
      value: 110,
      limit: 100,
      percent: 110,
    };
    await createBudgetNotificationSink(manager).notifyBudgetThreshold({
      ...base,
      label: 'Sandbox',
      severity: 'critical',
      suppressToast: true,
      reasons: [
        { ...base, metric: 'tokens' },
        { ...base, metric: 'apiEquivalentCostUsd', value: 22, limit: 20 },
      ],
    });
    expect(manager.addTeamNotification).toHaveBeenCalledTimes(1);
    expect(manager.addTeamNotification.mock.calls[0][0]).toMatchObject({
      teamEventType: 'usage_budget_exceeded',
      target: { kind: 'token_usage', focus: 'budgets' },
      suppressToast: true,
      dedupeKey: 'coverage',
    });
    const payload = manager.addTeamNotification.mock.calls[0][0];
    expect(payload.body).toContain('110 tokens');
    expect(payload.body).toContain('$22');
    expect(payload.body).toContain('API-equivalent estimate');
  });
});
