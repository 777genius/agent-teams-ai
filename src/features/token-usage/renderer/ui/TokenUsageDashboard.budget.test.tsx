import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenUsageDashboard } from './TokenUsageDashboard';

import type {
  TokenUsageAnalyticsSnapshotDto,
  TokenUsageBudgetStatusDto,
  TokenUsageSnapshotRequest,
} from '../../contracts';

const budget = vi.hoisted(() => ({
  value: 0,
  snapshot: null as TokenUsageAnalyticsSnapshotDto | null,
  requests: [] as (TokenUsageSnapshotRequest | undefined)[],
  openTeam: vi.fn(),
  openTask: vi.fn(),
}));
vi.mock('@features/localization/renderer', () => {
  const translate = (key: string): string => key;
  return { useAppTranslation: () => ({ t: translate, resolvedLanguage: 'en' }) };
});
vi.mock('../hooks/useOpenTokenUsageTeam', () => ({ useOpenTokenUsageTeam: () => budget.openTeam }));
vi.mock('../hooks/useOpenTokenUsageTask', () => ({ useOpenTokenUsageTask: () => budget.openTask }));
vi.mock('../hooks/useOpenTokenUsageNotificationSettings', () => ({
  useOpenTokenUsageNotificationSettings: () => vi.fn(),
}));
vi.mock('../hooks/useTokenUsageSnapshot', async () => {
  const { toTokenUsageDashboardViewModel } = await import('../view-models/tokenUsageViewModel');
  const { useMemo } = await import('react');
  return {
    useTokenUsageSnapshot: ({ request }: { request?: TokenUsageSnapshotRequest }) => {
      budget.requests.push(request);
      return {
        viewModel: useMemo(
          () => toTokenUsageDashboardViewModel(budget.snapshot),
          [budget.snapshot]
        ),
        loading: false,
        refreshing: false,
        error: null,
        refresh: vi.fn(),
      };
    },
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
  budget.snapshot = null;
  budget.requests = [];
  budget.openTeam.mockClear();
  budget.openTask.mockClear();
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
      expect(budget.requests[0]?.teamIds).toEqual(['team:sandbox-filter-no-events']);
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
  // Separate choices and raw callbacks prevent opening anonymous/canonical IDs as teams.
  it('selects anonymous separately and navigates the real team named unassigned with its raw name', async () => {
    const { buildTokenUsageSnapshot } = await import('../../core/domain');
    const { testRun, testEvent } = await import('../../core/domain/__tests__/budgetFixtures');
    budget.snapshot = buildTokenUsageSnapshot({
      runs: [
        testRun({ appRunId: 'anonymous', teamName: undefined }),
        testRun({ appRunId: 'named', teamName: 'unassigned' }),
      ],
      events: [
        testEvent({ appRunId: 'anonymous' }),
        testEvent({ id: 'named-event', appRunId: 'named', teamName: 'unassigned' }),
      ],
      nowIso: '2026-10-04T00:00:00.000Z',
    });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <TooltipProvider>
            <TokenUsageDashboard initialTeamName="unassigned" />
          </TooltipProvider>
        )
      );
      expect(budget.requests[0]?.teamIds).toEqual(['team:unassigned']);
      const trigger =
        container.querySelector<HTMLButtonElement>(
          '[aria-label="tokenUsage.filters.filterTeams"]'
        ) ??
        [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
          button.textContent?.startsWith('unassigned')
        );
      expect(trigger).toBeDefined();
      await act(async () => trigger!.click());
      const anonymous = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        button.textContent?.startsWith('Anonymous runs')
      );
      expect(anonymous).toBeDefined();
      await act(async () => anonymous!.click());
      expect(budget.requests.at(-1)?.teamIds).toEqual(['team:unassigned', 'anonymous']);
      await act(async () =>
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      );
      const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (item) => item.textContent === 'tokenUsage.tabs.breakdowns'
      )!;
      await act(async () =>
        tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      );
      const teamPanel = [...container.querySelectorAll('h2')]
        .find((heading) => heading.textContent === 'tokenUsage.panels.teams')!
        .closest('section')!;
      const links = [...teamPanel.querySelectorAll<HTMLButtonElement>('button')];
      expect(links).toHaveLength(1);
      expect(teamPanel.querySelectorAll('div.usage-data-row')).toHaveLength(1);
      await act(async () => links[0].click());
      expect(budget.openTeam).toHaveBeenCalledWith('unassigned');
      expect(budget.openTeam).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
