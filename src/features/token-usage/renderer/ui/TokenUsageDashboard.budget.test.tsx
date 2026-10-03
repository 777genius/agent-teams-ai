import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenUsageDashboard } from './TokenUsageDashboard';

import type { TokenUsageBudgetStatusDto } from '../../contracts';

const budget = vi.hoisted(() => ({ value: 0 }));
vi.mock('@features/localization/renderer', () => {
  const translate = (key: string): string => key;
  return { useAppTranslation: () => ({ t: translate, resolvedLanguage: 'en' }) };
});
vi.mock('../hooks/useOpenTokenUsageTeam', () => ({ useOpenTokenUsageTeam: () => vi.fn() }));
vi.mock('../hooks/useOpenTokenUsageTask', () => ({ useOpenTokenUsageTask: () => vi.fn() }));
vi.mock('../hooks/useOpenTokenUsageNotificationSettings', () => ({
  useOpenTokenUsageNotificationSettings: () => vi.fn(),
}));
vi.mock('../hooks/useTokenUsageSnapshot', async () => {
  const { toTokenUsageDashboardViewModel } = await import('../view-models/tokenUsageViewModel');
  const emptyViewModel = toTokenUsageDashboardViewModel(null);
  return {
    useTokenUsageSnapshot: () => ({
      viewModel: emptyViewModel,
      loading: false,
      refreshing: false,
      error: null,
      refresh: vi.fn(),
    }),
  };
});
vi.mock('@renderer/api', () => ({
  api: {
    tokenUsage: {
      getBudgetSettings: async () => ({
        global: { monthlyTokenLimit: 100, thresholds: [50, 100], notificationsEnabled: true },
      }),
      getBudgetStatus: async (): Promise<TokenUsageBudgetStatusDto> => ({
        period: {
          key: '2026-10',
          from: '2026-10-01T00:00:00.000Z',
          to: '2026-11-01T00:00:00.000Z',
          timeZone: 'UTC',
        },
        computedAt: '2026-10-03T00:00:00.000Z',
        stale: false,
        degraded: false,
        notificationPolicy: { enabled: true, nativeToasts: false },
        options: [{ scope: 'global', id: 'global', label: 'All teams' }],
        targets: [
          {
            scope: 'global',
            id: 'global',
            label: 'All teams',
            thresholds: [50, 100],
            notificationsEnabled: true,
            metrics: [
              {
                metric: 'tokens',
                value: budget.value,
                limit: 100,
                percent: budget.value,
                remaining: 100 - budget.value,
                incomplete: false,
              },
            ],
          },
        ],
      }),
      onBudgetStatusChanged: () => () => undefined,
    },
  },
}));
beforeEach(() => {
  budget.value = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe('Budget outside empty analytics results', () => {
  it('keeps configured zero-budget card and four tabs when analytics filter has no usage', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <TooltipProvider>
            <TokenUsageDashboard initialTeamName="sandbox-filter-no-events" />
          </TooltipProvider>
        )
      );
      expect(container.textContent).toContain('tokenUsage.panels.budgetAlerts');
      expect(container.textContent).toContain('0.0%');
      expect(container.textContent).toContain('tokenUsage.budgets.editor.title');
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(4);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
  it('keeps nonzero canonical Budget usage unchanged when cache display toggles', async () => {
    budget.value = 75;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <TooltipProvider>
            <TokenUsageDashboard />
          </TooltipProvider>
        )
      );
      expect(container.textContent).toContain('75.0%');
      const toggle = container.querySelector<HTMLButtonElement>(
        '[role="checkbox"][aria-label="tokenUsage.controls.includeCacheTokens"]'
      )!;
      await act(async () => toggle.click());
      expect(container.textContent).toContain('75.0%');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
